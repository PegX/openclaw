#!/usr/bin/env node

// Offline analytics layer:
// These attribution baselines consume the exported execution graph after the
// runtime plugin has already recorded deterministic identity and lineage.
// They are useful for analysis and research, but they do not drive live
// OpenClaw enforcement decisions.

import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = { input: "", output: "" };
  for (let i = 2; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === "--input") {
      args.input = argv[i + 1] ?? "";
      i += 1;
    } else if (current === "--output") {
      args.output = argv[i + 1] ?? "";
      i += 1;
    }
  }
  return args;
}

function keywordScore(text, patterns) {
  return patterns.reduce((score, pattern) => (pattern.test(text) ? score + 1 : score), 0);
}

function rulesOnlyPredict(sample) {
  const node = sample.node;
  if (node.type?.includes("handoff") || node.sinkKind === "cross_agent") {
    return "handoff_delegated";
  }
  if (
    (node.lineageSourceEventIds ?? []).length > 0 ||
    (node.lineageFlags ?? []).includes("recent_memory_read")
  ) {
    return "memory_replay";
  }
  if (node.type === "tool_result_observed" || node.type === "tool_result_persisted") {
    return "tool_derived";
  }
  if (node.type === "human_identity_observed") {
    return "human_direct";
  }
  return "human_direct";
}

function textOnlyPredict(sample) {
  const text = `${sample.text ?? ""} ${sample.node.taskSummary ?? ""}`.toLowerCase();
  const handoff = keywordScore(text, [/\bhandoff\b/, /\bsubagent\b/, /\bcross-agent\b/]);
  const memory = keywordScore(text, [/\bmemory\b/, /\brecall/, /\bpersist/, /\bquery=/]);
  const tool = keywordScore(text, [/\btool\b/, /\bresult\b/, /\btool_derived\b/]);
  if (handoff >= 1) {
    return "handoff_delegated";
  }
  if (memory >= 1) {
    return "memory_replay";
  }
  if (tool >= 1) {
    return "tool_derived";
  }
  return "human_direct";
}

function evaluate(samples, predictor) {
  let correct = 0;
  const perLabel = {};
  for (const sample of samples) {
    const predicted = predictor(sample);
    const gold = sample.label;
    if (!perLabel[gold]) {
      perLabel[gold] = { total: 0, correct: 0 };
    }
    perLabel[gold].total += 1;
    if (predicted === gold) {
      correct += 1;
      perLabel[gold].correct += 1;
    }
  }
  return {
    accuracy: samples.length ? correct / samples.length : 0,
    total: samples.length,
    perLabel,
  };
}

function splitId(id) {
  const raw = String(id ?? "");
  let acc = 0;
  for (let i = 0; i < raw.length; i += 1) {
    acc = (acc + raw.charCodeAt(i)) % 100;
  }
  if (acc < 70) {
    return "train";
  }
  if (acc < 85) {
    return "val";
  }
  return "test";
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.input) {
    throw new Error("--input <execution-graph-dataset.json> is required");
  }
  const outputPath =
    args.output || path.join(path.dirname(args.input), "attribution-baselines.json");
  const dataset = JSON.parse(await fs.readFile(args.input, "utf8"));
  const samples = (dataset.attributionSamples ?? []).map((sample) => {
    const node = (dataset.nodes ?? []).find((entry) => entry.id === sample.eventId) ?? {};
    return {
      ...sample,
      node,
      split: splitId(sample.eventId),
    };
  });
  const rulesOnly = evaluate(samples, rulesOnlyPredict);
  const textOnly = evaluate(samples, textOnlyPredict);
  const splitSummary = samples.reduce(
    (acc, sample) => {
      acc[sample.split] = (acc[sample.split] ?? 0) + 1;
      return acc;
    },
    { train: 0, val: 0, test: 0 },
  );

  const result = {
    metadata: {
      generatedAt: new Date().toISOString(),
      source: args.input,
      sampleCount: samples.length,
      edgeCount: dataset.metadata?.edgeCount ?? 0,
      nodeCount: dataset.metadata?.nodeCount ?? 0,
    },
    baselines: {
      rules_only: rulesOnly,
      text_only_semantic_proxy: textOnly,
    },
    gnn_ready_split: splitSummary,
  };

  await fs.writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");
  process.stdout.write(`${outputPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
