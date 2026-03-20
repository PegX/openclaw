#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from sklearn.metrics import accuracy_score, classification_report
from sklearn.preprocessing import LabelEncoder
from torch import nn


TOKEN_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_:/.-]*")
PAD = "<pad>"
UNK = "<unk>"


class EmbeddingBagClassifier(nn.Module):
    def __init__(self, vocab_size: int, embed_dim: int, out_dim: int) -> None:
        super().__init__()
        self.embedding = nn.Embedding(vocab_size, embed_dim, padding_idx=0)
        self.proj = nn.Sequential(
            nn.Linear(embed_dim, embed_dim),
            nn.ReLU(),
            nn.Dropout(p=0.2),
            nn.Linear(embed_dim, out_dim),
        )

    def encode(self, tokens: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        emb = self.embedding(tokens)
        masked = emb * mask.unsqueeze(-1)
        denom = mask.sum(dim=1, keepdim=True).clamp(min=1.0)
        return masked.sum(dim=1) / denom

    def forward(self, tokens: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        pooled = self.encode(tokens, mask)
        return self.proj(pooled)


class TinyGCN(nn.Module):
    def __init__(self, in_dim: int, hidden_dim: int, out_dim: int) -> None:
        super().__init__()
        self.lin1 = nn.Linear(in_dim, hidden_dim)
        self.lin2 = nn.Linear(hidden_dim, out_dim)

    def forward(self, x: torch.Tensor, adj: torch.Tensor) -> torch.Tensor:
        x = adj @ x
        x = F.relu(self.lin1(x))
        x = F.dropout(x, p=0.2, training=self.training)
        x = adj @ x
        return self.lin2(x)


class TextGCNClassifier(nn.Module):
    def __init__(self, vocab_size: int, embed_dim: int, hidden_dim: int, out_dim: int) -> None:
        super().__init__()
        self.encoder = EmbeddingBagClassifier(vocab_size, embed_dim, hidden_dim)
        self.gcn = TinyGCN(hidden_dim, hidden_dim, out_dim)

    def forward(self, tokens: torch.Tensor, mask: torch.Tensor, adj: torch.Tensor) -> torch.Tensor:
        node_x = self.encoder.encode(tokens, mask)
        return self.gcn(node_x, adj)


def load_dataset(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def stable_split(event_id: str) -> str:
    acc = 0
    for ch in str(event_id):
        acc = (acc + ord(ch)) % 100
    if acc < 70:
        return "train"
    if acc < 85:
        return "val"
    return "test"


def tokenize(text: str) -> list[str]:
    return TOKEN_RE.findall(text.lower())


def build_vocab(texts: list[str], train_mask: np.ndarray, max_vocab: int = 1024) -> dict[str, int]:
    counter: Counter[str] = Counter()
    for text, is_train in zip(texts, train_mask):
        if is_train:
            counter.update(tokenize(text))
    vocab = {PAD: 0, UNK: 1}
    for token, _ in counter.most_common(max_vocab - 2):
        vocab[token] = len(vocab)
    return vocab


def encode_texts(texts: list[str], vocab: dict[str, int], max_len: int = 64) -> tuple[torch.Tensor, torch.Tensor]:
    ids = []
    masks = []
    for text in texts:
        token_ids = [vocab.get(token, vocab[UNK]) for token in tokenize(text)[:max_len]]
        length = len(token_ids)
        if length < max_len:
            token_ids.extend([vocab[PAD]] * (max_len - length))
        ids.append(token_ids)
        masks.append([1.0] * length + [0.0] * (max_len - length))
    return torch.tensor(ids, dtype=torch.long), torch.tensor(masks, dtype=torch.float32)


def build_normalized_adjacency(num_nodes: int, edges: list[tuple[int, int]]) -> torch.Tensor:
    adj = torch.zeros((num_nodes, num_nodes), dtype=torch.float32)
    for src, dst in edges:
        adj[src, dst] = 1.0
        adj[dst, src] = 1.0
    adj += torch.eye(num_nodes, dtype=torch.float32)
    degree = adj.sum(dim=1)
    degree_inv_sqrt = torch.pow(degree.clamp(min=1.0), -0.5)
    d_mat = torch.diag(degree_inv_sqrt)
    return d_mat @ adj @ d_mat


def split_masks(samples):
    labels = [sample["label"] for sample in samples]
    texts = [sample.get("text", "") for sample in samples]
    train = np.array([sample.get("split") == "train" for sample in samples])
    val = np.array([sample.get("split") == "val" for sample in samples])
    test = np.array([sample.get("split") == "test" for sample in samples])
    return train, val, test, labels, texts


def evaluate_logits(logits: torch.Tensor, y_tensor: torch.Tensor, idx_tensor: torch.Tensor, label_encoder: LabelEncoder):
    pred = logits[idx_tensor].argmax(dim=1).cpu().numpy()
    gold = y_tensor[idx_tensor].cpu().numpy()
    names = list(label_encoder.classes_)
    return {
        "accuracy": float(accuracy_score(gold, pred)),
        "report": classification_report(
            gold,
            pred,
            output_dict=True,
            zero_division=0,
            target_names=names,
        ),
    }


def train_text_encoder(texts, labels, train_mask, val_mask, test_mask):
    if not train_mask.any():
        return {"skipped": "no train samples"}
    vocab = build_vocab(texts, train_mask)
    tokens, mask = encode_texts(texts, vocab)
    label_encoder = LabelEncoder()
    y = label_encoder.fit_transform(labels)
    y_tensor = torch.tensor(y, dtype=torch.long)

    model = EmbeddingBagClassifier(len(vocab), embed_dim=64, out_dim=len(label_encoder.classes_))
    optimizer = torch.optim.Adam(model.parameters(), lr=0.01, weight_decay=1e-4)

    train_idx = torch.tensor(np.where(train_mask)[0], dtype=torch.long)
    val_idx = torch.tensor(np.where(val_mask)[0], dtype=torch.long)
    test_idx = torch.tensor(np.where(test_mask)[0], dtype=torch.long)

    best_state = None
    best_val = -1.0
    for _ in range(120):
        model.train()
        optimizer.zero_grad()
        logits = model(tokens, mask)
        loss = F.cross_entropy(logits[train_idx], y_tensor[train_idx])
        loss.backward()
        optimizer.step()

        if val_idx.numel() > 0:
            model.eval()
            with torch.no_grad():
                val_logits = model(tokens, mask)
                val_acc = float((val_logits[val_idx].argmax(dim=1) == y_tensor[val_idx]).float().mean().item())
            if val_acc >= best_val:
                best_val = val_acc
                best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}

    if best_state is not None:
        model.load_state_dict(best_state)

    model.eval()
    with torch.no_grad():
        logits = model(tokens, mask)

    result = {"metadata": {"vocabSize": len(vocab), "encoder": "embedding_bag_mlp"}}
    for split_name, idx_tensor in [("train", train_idx), ("val", val_idx), ("test", test_idx)]:
        if idx_tensor.numel() == 0:
            continue
        result[split_name] = evaluate_logits(logits, y_tensor, idx_tensor, label_encoder)
    return result


def train_graph_model(nodes, edges, samples):
    node_to_idx = {node["id"]: idx for idx, node in enumerate(nodes)}
    sample_by_event = {sample["eventId"]: sample for sample in samples if sample["eventId"] in node_to_idx}
    ordered_nodes = [node for node in nodes if node["id"] in sample_by_event]
    ordered_samples = [sample_by_event[node["id"]] for node in ordered_nodes]
    if len(ordered_nodes) < 4:
        return {"skipped": "insufficient labeled nodes for graph training"}

    train_mask, val_mask, test_mask, labels, texts = split_masks(ordered_samples)
    if not train_mask.any():
        return {"skipped": "no train samples"}

    vocab = build_vocab(texts, train_mask)
    tokens, mask = encode_texts(texts, vocab)
    label_encoder = LabelEncoder()
    y = label_encoder.fit_transform(labels)
    y_tensor = torch.tensor(y, dtype=torch.long)

    full_indices = [node_to_idx[node["id"]] for node in ordered_nodes]
    selected_index_map = {old: new for new, old in enumerate(full_indices)}
    edge_pairs = []
    for edge in edges:
        src = edge.get("source")
        dst = edge.get("target")
        if src in node_to_idx and dst in node_to_idx:
            src_idx = node_to_idx[src]
            dst_idx = node_to_idx[dst]
            if src_idx in selected_index_map and dst_idx in selected_index_map:
                edge_pairs.append((selected_index_map[src_idx], selected_index_map[dst_idx]))
    if not edge_pairs:
        edge_pairs = [(idx, idx) for idx in range(len(ordered_nodes))]
    adj = build_normalized_adjacency(len(ordered_nodes), edge_pairs)

    model = TextGCNClassifier(
        vocab_size=len(vocab),
        embed_dim=64,
        hidden_dim=64,
        out_dim=len(label_encoder.classes_),
    )
    optimizer = torch.optim.Adam(model.parameters(), lr=0.01, weight_decay=5e-4)

    train_idx = torch.tensor(np.where(train_mask)[0], dtype=torch.long)
    val_idx = torch.tensor(np.where(val_mask)[0], dtype=torch.long)
    test_idx = torch.tensor(np.where(test_mask)[0], dtype=torch.long)

    best_state = None
    best_val = -1.0
    for _ in range(160):
        model.train()
        optimizer.zero_grad()
        logits = model(tokens, mask, adj)
        loss = F.cross_entropy(logits[train_idx], y_tensor[train_idx])
        loss.backward()
        optimizer.step()

        if val_idx.numel() > 0:
            model.eval()
            with torch.no_grad():
                val_logits = model(tokens, mask, adj)
                val_acc = float((val_logits[val_idx].argmax(dim=1) == y_tensor[val_idx]).float().mean().item())
            if val_acc >= best_val:
                best_val = val_acc
                best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}

    if best_state is not None:
        model.load_state_dict(best_state)

    model.eval()
    with torch.no_grad():
        logits = model(tokens, mask, adj)

    result = {
        "metadata": {
            "vocabSize": len(vocab),
            "encoder": "embedding_bag",
            "graphModel": "tiny_gcn",
        }
    }
    for split_name, idx_tensor in [("train", train_idx), ("val", val_idx), ("test", test_idx)]:
        if idx_tensor.numel() == 0:
            continue
        result[split_name] = evaluate_logits(logits, y_tensor, idx_tensor, label_encoder)
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", default="/tmp/dual-identity-model-results.json")
    args = parser.parse_args()

    dataset = load_dataset(Path(args.input))
    nodes = dataset.get("nodes", [])
    edges = dataset.get("edges", [])
    samples = dataset.get("attributionSamples", [])
    for sample in samples:
        sample["split"] = sample.get("split") or stable_split(sample["eventId"])

    labeled_ids = {sample["eventId"] for sample in samples}
    labeled_nodes = [node for node in nodes if node["id"] in labeled_ids]

    train_mask, val_mask, test_mask, labels, texts = split_masks(samples)
    result = {
        "metadata": {
            "source": str(Path(args.input).resolve()),
            "sampleCount": len(samples),
            "nodeCount": len(nodes),
            "edgeCount": len(edges),
            "labeledNodeCount": len(labeled_nodes),
        },
        "text_encoder_mlp": train_text_encoder(texts, labels, train_mask, val_mask, test_mask),
        "small_graph_gcn": train_graph_model(nodes, edges, samples),
    }

    output_path = Path(args.output)
    output_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(output_path)


if __name__ == "__main__":
    main()
