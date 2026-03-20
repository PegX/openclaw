#!/usr/bin/env python3

from __future__ import annotations

import json
import sys
from pathlib import Path


def format_accuracy(value: float) -> str:
    return f"{value:.4f}"


def main() -> None:
    result_path = Path(
        sys.argv[1] if len(sys.argv) > 1 else "/tmp/dual-identity-model-results.json"
    ).expanduser().resolve()
    payload = json.loads(result_path.read_text(encoding="utf-8"))

    print("metadata")
    print(json.dumps(payload.get("metadata", {}), indent=2))

    for model_name in ("text_encoder_mlp", "small_graph_gcn"):
        model = payload.get(model_name, {})
        print(f"\n[{model_name}]")
        metadata = model.get("metadata")
        if metadata:
            print(json.dumps(metadata, indent=2))
        for split_name in ("train", "val", "test"):
            split = model.get(split_name)
            if not split:
                continue
            print(f"{split_name}: accuracy={format_accuracy(split['accuracy'])}")
            report = split.get("report", {})
            for label_name, label_metrics in report.items():
                if label_name in {"accuracy", "macro avg", "weighted avg"}:
                    continue
                support = label_metrics.get("support", 0.0)
                f1 = label_metrics.get("f1-score", 0.0)
                print(f"  {label_name}: support={support:.1f} f1={f1:.4f}")


if __name__ == "__main__":
    main()
