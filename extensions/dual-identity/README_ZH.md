# Dual Identity 插件说明（中文）

`dual-identity` 是一个非侵入式的 `OpenClaw` 插件，用来在运行时区分：

- **人的身份**：真正拥有原始权限的 `human authority owner`
- **Agent 的身份**：实际执行动作的 `acting principal`
- **触发来源**：当前动作或运行是由什么链路触发的，例如
  - `human_direct`
  - `memory_replay`
  - `tool_derived`
  - `handoff_delegated`

它的核心首先是一个**确定性的运行时归因系统**。当前身份归因主要来自：

- OpenClaw 的 typed hooks
- session / run 上下文
- sender / channel metadata
- tool call / tool result 事件
- memory 与 subagent 边界上的 lineage propagation

也就是说，现在的双身份区分**主方案不是模型分类器**，而是强规则的运行时机制。

它不修改 `OpenClaw` core，而是通过插件 hook 把双身份语义接到真实运行路径中。

## 它解决什么问题

在 agent 系统里，如果不区分“谁拥有权限”和“谁在执行动作”，下面这些边界就会混在一起：

- 谁授权
- 谁执行
- 这一步是由什么链路诱发的

`dual-identity` 的目标，就是把这三件事在运行时分开记录，并继续传播到：

- delegated run
- tool call
- tool result persistence
- message persistence
- subagent handoff
- memory lineage

所以这里的正确语义不是：

`agent == human`

而是：

`agent acts on behalf of a human under explicit delegation`

## 当前插件已经具备的能力

当前版本除了记录双身份字段，还维护了一个轻量但共享的 `stateful task contract`。这套 contract 会在以下 hook 之间共享：

- `before_prompt_build`
- `before_tool_call`
- `before_message_write`
- `subagent_spawning`

它可以帮助插件识别：

- memory 派生的 outbound flow
- 未经授权的 durable note persistence
- 跨 agent delegation 的 scope widening

同时，这个插件现在也承担两种角色：

- 真实运行时里的安全/审计插件
- 面向 `LLM + GNN` 研究的 provenance-rich trace 数据来源

## 分层结构

我们现在明确把它分成两层：

### 1. 运行时强规则层（主方案）

这是双身份的主机制。

- `index.ts`
- 确定性的 identity attribution
- hook-based lineage propagation
- stateful task-contract 检查
- 对 outbound、persistence、cross-agent sink 的运行时约束

这一层才是真正的安全边界。它负责决定、记录和约束：

- 谁拥有 authority
- 谁在执行
- 这一步是由什么 lineage 触发的

### 2. 离线分析与研究层（辅助方案）

这是建立在运行时 audit 之上的增强层。

- `export_execution_graph.mjs`
- `run_attribution_baselines.mjs`
- `train_attribution_models.py`

这几部分做的是离线分析、图数据导出和研究型 attribution baseline。它们**不替代**运行时强制执行。

## 它会记录什么

插件会把 JSONL audit 写到：

- 默认 profile：`~/.openclaw/plugins/dual-identity/`
- 轻量采样 profile：`~/.openclaw-dual-identity/plugins/dual-identity/`

常见字段包括：

- `authorityOwnerId` / `authorityOwnerLabel`
- `actingPrincipalId`
- `triggerKind`
- `delegationId`
- `taskContractId` / `taskSummary`
- `expectedArtifactKinds`
- `forbiddenInformationFlows`
- `lineageFlags`
- `propertyTags`
- `lineageSourceEventIds`
- `lineageSourceQueries`
- `lineageSourcePaths`
- `sinkKind`

这些字段不仅用于审计，也直接构成后续学习模型的数据底座。

更准确地说，顺序应该是：

1. 运行时插件先产生确定性的身份归因和 lineage audit
2. 再把 audit 导出成 execution graph
3. 最后在图上跑 baseline 或学习模型

## 图数据与 attribution 基线

可以把 audit 导出成 execution graph：

```bash
node ./extensions/dual-identity/export_execution_graph.mjs
```

导出结果里会有：

- event nodes
- causal edges
- handoff edges
- `memory_lineage` edges
- 由 `triggerKind` 派生出的 attribution samples

这份图数据应该理解成“由运行时强规则审计导出的 ground-truth-like artifact”，而不是替代运行时机制本身。

在这个图上，可以先跑最小 attribution baseline：

```bash
node ./extensions/dual-identity/run_attribution_baselines.mjs \
  --input /tmp/dual-identity-graph.json
```

当前已经有三层基线：

- `rules_only`
- `text_only_semantic_proxy`
- `gnn_ready_split`

以及两个真实学习基线：

```bash
python3 ./extensions/dual-identity/train_attribution_models.py \
  --input /tmp/dual-identity-graph.json
```

- `text_encoder_mlp`
- `small_graph_gcn`

这些模型是研究侧的增强层。它们可以帮助我们研究 attribution 是否还能进一步细化，但它们不决定实时的身份边界。

## 推荐的轻量采样 profile

为了做 lineage 数据采样，建议单独使用一个轻量 profile，而不是直接复用你平时的默认 profile。

我们当前实际使用的是：

- `profile name`: `dual-identity`
- 配置文件：`~/.openclaw-dual-identity/openclaw.json`
- auth store：`~/.openclaw-dual-identity/agents/main/agent/auth-profiles.json`

这条 profile 推荐：

- 启用 `dual-identity` 插件
- 配置本地 fallback 的 human authority owner
- 使用较轻的本地模型，例如：
  - `ollama/hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:latest`
- 保持低并发，方便得到干净 trace

最小 smoke run：

```bash
openclaw --profile dual-identity agent --local \
  --agent main \
  --session-id dual-identity-profile-smoke \
  --message "Reply with exactly: ok" \
  --thinking off \
  --json
```

如果配置正常，audit 中至少应出现：

- `task_contract_refined`
- `delegated_run_started`

## 如何生成更多真实 lineage 样本

全量采样：

```bash
python3 ./extensions/dual-identity/generate_memory_lineage_traces.py \
  --repo /Users/xupeng/Projects/ai-agent/xclaw/clawGuard/openclaw \
  --profile dual-identity \
  --repetitions 2 \
  --thinking off \
  --pause-seconds 1
```

定向采样：

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

这几类场景最适合快速做厚：

- `memory_search/get -> outbound`
- `memory_search/get -> persistence`
- `memory_get -> cross-agent`

## 启用方式

可以直接从当前 checkout 安装：

```bash
openclaw plugins install ./extensions/dual-identity
```

也可以在配置中显式启用：

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

## 配套材料

- 英文说明：[README.md](./README.md)
- 中文录屏稿：[VIDEO_DEMO_ZH.md](./VIDEO_DEMO_ZH.md)
