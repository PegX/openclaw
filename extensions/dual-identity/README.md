# Dual Identity

`dual-identity` is a non-invasive OpenClaw plugin that distinguishes:

- the **human authority owner** who supplied the originating request
- the **agent acting principal** that executes delegated steps
- the **trigger source** that caused a run or action (`human_direct`, `memory_replay`, `handoff_delegated`, and related machine-side sources)

It does not modify OpenClaw core. Instead, it uses typed plugin hooks to attach
dual-identity semantics to:

- inbound human messages
- delegated runs before prompt construction
- tool calls and tool-result persistence
- message persistence decisions
- subagent handoffs and child-session lineage

In the current version, the plugin also keeps a lightweight **stateful task
contract** per session. The contract is inferred from the current prompt and
shared across:

- `before_prompt_build`
- `before_tool_call`
- `before_message_write`
- `subagent_spawning`

This lets the plugin distinguish:

- memory-derived outbound flows
- unauthorized durable-note persistence
- cross-agent delegation that widens scope without explicit task intent

## What it records

The plugin writes JSONL audit events under:

- default: `~/.openclaw/plugins/dual-identity/`
- configurable via `plugins.entries["dual-identity"].config.auditDir`

For local or CLI-only runs that do not arrive through a chat channel, you can
configure a fallback human authority owner with:

- `plugins.entries["dual-identity"].config.defaultAuthorityOwnerId`
- `plugins.entries["dual-identity"].config.defaultAuthorityOwnerLabel`

Each audit line records:

- `authorityOwnerId` / `authorityOwnerLabel`
- `actingPrincipalId`
- `triggerKind`
- `delegationId`
- `sessionKey` / `childSessionKey`
- `toolName` / `toolCallId` when relevant
- `taskContractId` / `taskSummary`
- `expectedArtifactKinds` / `forbiddenInformationFlows`
- `lineageFlags` / `propertyTags`
- `lineageSourceEventIds` / `lineageSourceQueries` / `lineageSourcePaths`
- `sinkKind`

These fields double as the plugin's **learning-friendly export layer**. You can
convert the audit JSONL into an execution-graph dataset for later `LLM` or `GNN`
experiments:

```bash
node ./extensions/dual-identity/export_execution_graph.mjs
```

The exporter emits a JSON bundle with:

- event nodes
- causal, handoff, and `memory_lineage` edges
- attribution samples labeled by `triggerKind`

You can then run the first offline attribution baselines on top of that dataset:

```bash
node ./extensions/dual-identity/run_attribution_baselines.mjs \
  --input /tmp/dual-identity-graph.json
```

The current baseline layer is intentionally small:

- `rules_only`: graph- and lineage-aware heuristic attribution
- `text_only_semantic_proxy`: text-only attribution over event/task summaries
- `gnn_ready_split`: a deterministic train/val/test split summary for later graph models

To generate more real runtime samples around `memory_search/get -> sink` chains:

```bash
python3 ./extensions/dual-identity/generate_memory_lineage_traces.py \
  --repo /Users/xupeng/Projects/ai-agent/xclaw/clawGuard/openclaw \
  --repetitions 2
```

And to train the first actual learning baselines on the exported graph dataset:

```bash
python3 ./extensions/dual-identity/train_attribution_models.py \
  --input /tmp/dual-identity-graph.json
```

The training script currently exposes two stronger baselines:

- `text_encoder_mlp`: a learned embedding-bag text encoder with a small MLP head
- `small_graph_gcn`: a learned text encoder plus a small graph convolution network over the exported execution graph

## What it injects

When `injectSystemContext` is enabled, the plugin prepends a compact security
context before prompt construction so the agent sees:

- who owns authority
- which agent is acting on that authority
- what triggered the current run
- that memory/tool/handoff artifacts are not human approvals

## Enabling

As a bundled extension inside this repo, you can enable it with:

```json5
{
  plugins: {
    entries: {
      "dual-identity": {
        enabled: true,
        config: {
          injectSystemContext: true,
          trackSubagents: true,
          includeToolDerivedEvents: true,
          enforceStatefulChecks: true,
          defaultAuthorityOwnerId: "human://local/xupeng",
          defaultAuthorityOwnerLabel: "xupeng",
        },
      },
    },
  },
}
```

Or install it from this checkout:

```bash
openclaw plugins install ./extensions/dual-identity
```
