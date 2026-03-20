# Dual Identity

`dual-identity` is a non-invasive OpenClaw plugin that distinguishes:

- the **human authority owner** who supplied the originating request
- the **agent acting principal** that executes delegated steps
- the **trigger source** that caused a run or action (`human_direct`, `memory_replay`, `handoff_delegated`, and related machine-side sources)

At its core, `dual-identity` is a **deterministic runtime attribution system**.
Identity attribution is established from:

- typed OpenClaw hooks
- session and run context
- sender/channel metadata
- tool-call and tool-result events
- lineage propagation across memory and subagent boundaries

It is **not** primarily a model-driven identity classifier.

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

## Architecture layering

We intentionally treat the implementation as a layered system:

### 1. Runtime enforcement path (primary)

This is the main dual-identity mechanism.

- `index.ts`
- deterministic identity attribution
- hook-based lineage propagation
- stateful task-contract checks
- runtime decisions over outbound, persistence, and cross-agent sinks

This layer is the security boundary. It is the part that decides, records, and
enforces who owns authority, who acts, and what trigger lineage caused a step.

### 2. Offline analytics path (secondary)

This is an analysis and research layer built on top of the runtime audit.

- `export_execution_graph.mjs`
- `run_attribution_baselines.mjs`
- `train_attribution_models.py`

These tools consume the runtime audit after the fact. They help analyze
execution traces, prototype attribution models, and explore `LLM`/`GNN`
experiments. They do **not** replace runtime enforcement.

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
- `attributionKind`
- `delegationId`
- `sessionKey` / `childSessionKey`
- `toolName` / `toolCallId` when relevant
- `taskContractId` / `taskSummary`
- `expectedArtifactKinds` / `forbiddenInformationFlows`
- `lineageFlags` / `propertyTags`
- `lineageSourceEventIds` / `lineageSourceQueries` / `lineageSourcePaths`
- `sinkKind`

These fields are also the plugin's **learning-friendly export layer**. The
important ordering is:

1. the runtime plugin first records deterministic attribution and lineage
2. the graph/export layer turns that audit into an offline dataset
3. attribution baselines consume the dataset as downstream analytics

`triggerKind` captures the immediate runtime trigger. `attributionKind` captures
the stronger runtime lineage interpretation that downstream analysis should
prefer, for example:

- `memory_replay`
- `handoff_delegated`
- `cross_agent_derived`

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

This exported graph should be read as a ground-truth-like artifact derived from
the runtime plugin's deterministic audit, not as a substitute for the runtime
itself.

You can then run the first offline attribution baselines on top of that dataset:

```bash
node ./extensions/dual-identity/run_attribution_baselines.mjs \
  --input /tmp/dual-identity-graph.json
```

The current baseline layer is intentionally small:

- `rules_only`: graph- and lineage-aware heuristic attribution over exported traces
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

These are research-side models. They help us study whether attribution can be
refined further from the runtime-generated graph; they do not decide the live
OpenClaw identity boundary.

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

## Recording-friendly demo

For a lightweight recording/demo flow, use:

```bash
bash ./extensions/dual-identity/run_video_demo.sh
```

The script is now tuned for demo stability:

- it defaults to the dedicated `dual-identity` OpenClaw profile
- it reads audit output from the profile-local path:
  - `~/.openclaw-dual-identity/plugins/dual-identity/audit-YYYY-MM-DD.jsonl`
- it highlights the `dual-identity` plugin in `plugins list`
- it runs both demo turns with `--thinking off`
- it continues to print new audit events even if a demo run exits non-zero

This makes it much easier to record:

- a minimal delegated run
- a stronger cross-agent/tool-chain prompt
- the resulting dual-identity audit lines

You can override the defaults with environment variables when needed:

```bash
OPENCLAW_PROFILE=dual-identity \
OPENCLAW_AGENT=main \
THINKING_MODE=off \
bash ./extensions/dual-identity/run_video_demo.sh
```

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
