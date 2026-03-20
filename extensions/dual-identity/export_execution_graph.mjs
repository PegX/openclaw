#!/usr/bin/env node

// Offline analytics layer:
// This script exports a graph dataset from the runtime plugin's deterministic
// JSONL audit. It is intentionally downstream of runtime enforcement and should
// be read as a graph view over recorded lineage, not as a replacement for the
// live dual-identity mechanism.

import fs from "node:fs/promises";
import os from "node:os";
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

function defaultAuditDir() {
  return path.join(os.homedir(), ".openclaw", "plugins", "dual-identity");
}

function summarizeEvent(event) {
  return [
    `event=${event.eventKind}`,
    `authority=${event.authorityOwnerId ?? "unknown"}`,
    `acting=${event.actingPrincipalId ?? "unknown"}`,
    `trigger=${event.triggerKind ?? "unknown"}`,
    `attribution=${event.attributionKind ?? event.triggerKind ?? "unknown"}`,
    event.toolName ? `tool=${event.toolName}` : "",
    event.taskSummary ? `task=${event.taskSummary}` : "",
    event.note ? `note=${event.note}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

function timestampOf(event) {
  const millis = Date.parse(event.timestamp ?? "");
  return Number.isFinite(millis) ? millis : 0;
}

function toolCategory(toolName) {
  const name = String(toolName ?? "")
    .trim()
    .toLowerCase();
  if (["memory_search", "memory_get"].includes(name)) {
    return "memory";
  }
  if (["message", "sessions_send"].includes(name)) {
    return "outbound";
  }
  if (["write", "edit", "apply_patch", "exec"].includes(name)) {
    return "mutation";
  }
  if (["sessions_spawn", "subagents"].includes(name)) {
    return "cross_agent";
  }
  return "other";
}

function inferLegacyLineage(eventsWithIds) {
  const lastMemoryBySession = new Map();
  return eventsWithIds.map((event) => {
    const sessionKey = event.sessionKey ?? "__global__";
    const priorMemory = lastMemoryBySession.get(sessionKey);
    const current = {
      ...event,
      lineageSourceEventIds: [...(event.lineageSourceEventIds ?? [])],
      lineageSourceQueries: [...(event.lineageSourceQueries ?? [])],
      lineageSourcePaths: [...(event.lineageSourcePaths ?? [])],
      lineageInferred: false,
      sinkKind: event.sinkKind ?? null,
    };

    if (event.eventKind === "tool_result_observed" && toolCategory(event.toolName) === "memory") {
      lastMemoryBySession.set(sessionKey, {
        eventId: event.eventId,
        query:
          event.modelFeatures?.recentMemoryQueries?.at?.(-1) ??
          event.modelFeatures?.query ??
          undefined,
        path:
          event.modelFeatures?.recentMemoryPaths?.at?.(-1) ??
          event.modelFeatures?.path ??
          undefined,
      });
      return current;
    }

    if (
      priorMemory &&
      current.lineageSourceEventIds.length === 0 &&
      [
        "tool_result_persisted",
        "message_persist_blocked",
        "message_persist_observed",
        "subagent_handoff_declared",
        "cross_agent_handoff_blocked",
        "stateful_flow_blocked",
        "agent_tool_call",
      ].includes(String(event.eventKind))
    ) {
      const category =
        current.sinkKind ??
        (event.eventKind === "tool_result_persisted"
          ? "persistence"
          : event.eventKind === "subagent_handoff_declared" ||
              event.eventKind === "cross_agent_handoff_blocked"
            ? "cross_agent"
            : toolCategory(event.toolName));
      if (["outbound", "mutation", "persistence", "cross_agent"].includes(String(category))) {
        current.lineageSourceEventIds = [priorMemory.eventId];
        current.lineageSourceQueries = priorMemory.query ? [priorMemory.query] : [];
        current.lineageSourcePaths = priorMemory.path ? [priorMemory.path] : [];
        current.sinkKind = category;
        current.lineageInferred = true;
      }
    }

    return current;
  });
}

async function loadEvents(inputDir) {
  const entries = await fs.readdir(inputDir);
  const files = entries.filter((entry) => entry.startsWith("audit-") && entry.endsWith(".jsonl"));
  const events = [];
  for (const file of files) {
    const raw = await fs.readFile(path.join(inputDir, file), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      events.push(JSON.parse(trimmed));
    }
  }
  return events;
}

async function main() {
  const args = parseArgs(process.argv);
  const inputDir = args.input || defaultAuditDir();
  const outputPath = args.output || path.join(inputDir, "execution-graph-dataset.json");
  const events = await loadEvents(inputDir);

  const seenEventIds = new Map();
  const eventsWithIds = inferLegacyLineage(
    events
      .map((event, index) => {
        const baseId = event.eventId || `legacy-event-${index + 1}`;
        const seen = seenEventIds.get(baseId) ?? 0;
        seenEventIds.set(baseId, seen + 1);
        const uniqueId = seen === 0 ? baseId : `${baseId}@${seen + 1}`;
        return {
          ...event,
          originalEventId: event.eventId || null,
          eventId: uniqueId,
        };
      })
      .sort((left, right) => timestampOf(left) - timestampOf(right)),
  );

  const nodes = eventsWithIds.map((event) => ({
    id: event.eventId,
    type: event.eventKind,
    sessionKey: event.sessionKey ?? null,
    authorityOwnerId: event.authorityOwnerId ?? null,
    actingPrincipalId: event.actingPrincipalId ?? null,
    triggerKind: event.triggerKind ?? null,
    attributionKind: event.attributionKind ?? event.triggerKind ?? null,
    toolName: event.toolName ?? null,
    taskContractId: event.taskContractId ?? null,
    taskSummary: event.taskSummary ?? null,
    expectedArtifactKinds: event.expectedArtifactKinds ?? [],
    forbiddenInformationFlows: event.forbiddenInformationFlows ?? [],
    lineageFlags: event.lineageFlags ?? [],
    propertyTags: event.propertyTags ?? [],
    modelFeatures: event.modelFeatures ?? {},
    lineageSourceEventIds: event.lineageSourceEventIds ?? [],
    lineageSourceQueries: event.lineageSourceQueries ?? [],
    lineageSourcePaths: event.lineageSourcePaths ?? [],
    sinkKind: event.sinkKind ?? null,
    timestamp: event.timestamp,
    note: event.note ?? "",
    lineageInferred: Boolean(event.lineageInferred),
    originalEventId: event.originalEventId ?? null,
  }));

  const edges = [];
  for (const event of eventsWithIds) {
    if (event.parentEventId) {
      edges.push({
        source: event.parentEventId,
        target: event.eventId,
        type: "causal",
      });
    }
    for (const sourceEventId of event.lineageSourceEventIds ?? []) {
      edges.push({
        source: sourceEventId,
        target: event.eventId,
        type: "memory_lineage",
      });
    }
    if (event.parentSessionKey && event.childSessionKey) {
      edges.push({
        source: event.parentSessionKey,
        target: event.childSessionKey,
        type: "handoff_session",
      });
    }
  }

  const attributionSamples = eventsWithIds.map((event) => ({
    eventId: event.eventId,
    label: event.attributionKind ?? event.triggerKind ?? "unknown",
    text: summarizeEvent(event),
    sessionKey: event.sessionKey ?? null,
    propertyTags: event.propertyTags ?? [],
    lineageSourceEventIds: event.lineageSourceEventIds ?? [],
  }));

  const edgeTypeCounts = edges.reduce((acc, edge) => {
    acc[edge.type] = (acc[edge.type] ?? 0) + 1;
    return acc;
  }, {});
  const attributionLabelCounts = attributionSamples.reduce((acc, sample) => {
    acc[sample.label] = (acc[sample.label] ?? 0) + 1;
    return acc;
  }, {});

  await fs.writeFile(
    outputPath,
    JSON.stringify(
      {
        metadata: {
          generatedAt: new Date().toISOString(),
          sourceDir: inputDir,
          nodeCount: nodes.length,
          edgeCount: edges.length,
          sampleCount: attributionSamples.length,
        },
        edgeTypeCounts,
        attributionLabelCounts,
        nodes,
        edges,
        attributionSamples,
      },
      null,
      2,
    ),
    "utf8",
  );
  process.stdout.write(`${outputPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
