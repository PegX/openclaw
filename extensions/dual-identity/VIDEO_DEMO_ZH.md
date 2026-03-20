# Dual Identity 视频讲稿（中文，约 3 分钟）

## 开场（0:00 - 0:25）

今天这段演示想说明一个很具体的问题：

在 agent 系统里，真正拥有权限的是人，但真正执行动作的往往是 agent。如果系统不把这两者区分开，后面的授权、审计、memory replay，甚至 subagent handoff，都会混成一层。

所以我们在 OpenClaw 上做的，不是再加一个普通插件功能，而是把一种 **双身份运行时模型** 接进去。

## 核心概念（0:25 - 0:55）

这里的双身份，指的是三件事：

- 第一，**human authority owner**，也就是真正拥有原始权限的人。
- 第二，**agent principal**，也就是实际执行动作的 agent。
- 第三，**delegation**，表示 agent 为什么可以代表人行动，以及它是在什么边界内行动。

所以正确的语义不是 agent 等于 human，而是：

**agent acts on behalf of a human under explicit delegation.**

## 展示插件已加载（0:55 - 1:15）

现在先看 OpenClaw 的插件列表。

这里可以看到 `Dual Identity` 已经被加载，而且整个过程没有改 OpenClaw core，只是通过插件系统接入。

这说明双身份能力已经进入了 OpenClaw 的运行时，而不是停留在纸面设计。

## Demo 1：最小 delegated run（1:15 - 1:55）

接下来我跑一个最小的本地 agent turn。

这个场景里，用户发出一个简单请求，agent 代表用户执行。

这里重点不是回复内容本身，而是看运行时 audit 里记录下来的身份关系。

现在看 audit 文件，可以看到这几个字段：

- `authorityOwnerId`
- `actingPrincipalId`
- `delegationId`
- `triggerKind`

这就意味着系统已经知道：

- 谁拥有权限
- 谁在执行
- 这一步是怎么被触发的

在这个例子里，`triggerKind` 是 `human_direct`，说明这次 delegated run 是由人直接触发的。

## Demo 2：更强的链路场景（1:55 - 2:40）

第二个场景更重要。

这里我让 agent 去尝试调用 `sessions_spawn`，也就是启动一个 child run。即使当前本机 gateway 配置没有让这次 handoff 完整成功，dual-identity 插件依然把关键链路记了下来。

现在在 audit 里可以看到：

- `agent_tool_call`
- `tool_result_observed`
- `tool_result_persisted`

而且这些事件的 `triggerKind` 已经不再只是 `human_direct`，而是进入了 `tool_derived`。

这说明系统不只是知道“这件事是 agent 做的”，还知道：

**这是一个 agent 发起的工具链动作，并且后续状态是由工具结果派生出来的。**

这一步非常关键，因为后面无论是 memory replay 还是 subagent handoff，都是沿着这种 trigger provenance 往下走的。

## 总结（2:40 - 3:05）

所以双身份的价值，不是多记两个 ID。

它真正做的是把下面这三件事在运行时彻底分开：

- 谁授权
- 谁执行
- 这一步是由什么链路触发的

这会成为后续更强安全机制的基础，比如：

- memory replay attribution
- subagent handoff lineage
- delegated audit and accountability

也就是说，在 OpenClaw 里，双身份不是一个装饰性的概念，而是把 human authority 和 agent execution 分开的运行时基础设施。
