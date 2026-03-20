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

The current plugin now supports two practical modes:

- a live OpenClaw runtime/security plugin
- a provenance-rich trace source for offline `LLM` and `GNN` attribution work

## What it records

The plugin writes JSONL audit events under:

- default profile: `~/.openclaw/plugins/dual-identity/`
- custom profile: `~/.openclaw-<profile>/plugins/dual-identity/`
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

These fields are also the plugin's **learning-friendly export layer**.

## Execution-graph export and attribution baselines

You can convert the audit JSONL into an execution-graph dataset for later `LLM`
or `GNN` experiments:

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

To train the first actual learning baselines on the exported graph dataset:

```bash
python3 ./extensions/dual-identity/train_attribution_models.py \
  --input /tmp/dual-identity-graph.json
```

The training script currently exposes two stronger baselines:

- `text_encoder_mlp`: a learned embedding-bag text encoder with a small MLP head
- `small_graph_gcn`: a learned text encoder plus a small graph convolution network over the exported execution graph

## Lightweight sampling profile

For trace collection, we recommend a dedicated lightweight OpenClaw profile
instead of your default daily profile. This keeps sampling isolated and makes it
easy to point the plugin at a small local model.

The profile we use in practice is named `dual-identity` and typically lives
under:

- `~/.openclaw-dual-identity/openclaw.json`
- `~/.openclaw-dual-identity/agents/main/agent/auth-profiles.json`
- `~/.openclaw-dual-identity/plugins/dual-identity/`

This profile should:

- load the `dual-identity` plugin
- set a local fallback human authority owner
- use a low-cost local model, such as:
  - `ollama/hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:latest`
- keep concurrency low for cleaner traces

A minimal smoke run looks like this:

```bash
openclaw --profile dual-identity agent --local \
  --agent main \
  --session-id dual-identity-profile-smoke \
  --message "Reply with exactly: ok" \
  --thinking off \
  --json
```

If the profile is healthy, the plugin should emit:

- `task_contract_refined`
- `delegated_run_started`

under the profile-local audit path:

- `~/.openclaw-dual-identity/plugins/dual-identity/audit-YYYY-MM-DD.jsonl`

## Generating more live memory-lineage traces

To generate more real runtime samples around `memory_search/get -> sink` chains:

```bash
python3 ./extensions/dual-identity/generate_memory_lineage_traces.py \
  --repo /Users/xupeng/Projects/ai-agent/xclaw/clawGuard/openclaw \
  --profile dual-identity \
  --repetitions 2 \
  --thinking off \
  --pause-seconds 1
```

The trace generator supports selective sampling, so you can thicken only the
most valuable live paths:

```bash
python3 ./extensions/dual-identity/generate_memory_lineage_traces.py \
  --repo /Users/xupeng/Projects/ai-agent/xclaw/clawGuard/openclaw \
  --profile dual-identity \
  --only-kind memory_search_to_persistence \
  --only-kind memory_get_to_cross_agent
```

Or target the highest-value scenarios directly:

```bash
python3 ./extensions/dual-identity/generate_memory_lineage_traces.py \
  --repo /Users/xupeng/Projects/ai-agent/xclaw/clawGuard/openclaw \
  --profile dual-identity \
  --thinking off \
  --pause-seconds 1 \
  --only-scenario memory-search-outbound \
  --only-scenario memory-get-outbound \
  --only-scenario memory-search-persistence \
  --only-scenario memory-get-persistence \
  --only-scenario memory-get-handoff
```

These scenarios are the fastest way to thicken:

- `memory_search/get -> outbound`
- `memory_search/get -> persistence`
- `memory_get -> cross-agent`

and produce more real `memory_lineage` edges in the exported graph.

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

## Chinese documentation

For a Chinese explanation of the plugin, see:

- [README_ZH.md](./README_ZH.md)
- [VIDEO_DEMO_ZH.md](./VIDEO_DEMO_ZH.md)
