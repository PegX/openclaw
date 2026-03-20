import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  OpenClawPluginApi,
  PluginHookHandlerMap,
  PluginHookName,
} from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import { createPluginRuntimeMock } from "../../test/helpers/extensions/plugin-runtime-mock.ts";
import registerDualIdentity from "./index.js";

function createApi() {
  const hooks = new Map<PluginHookName, Array<PluginHookHandlerMap[PluginHookName]>>();
  const stateDir = `${os.tmpdir()}/openclaw-dual-identity-test-${Math.random().toString(36).slice(2, 10)}`;
  const api: OpenClawPluginApi = {
    id: "dual-identity",
    name: "dual-identity",
    source: "test",
    config: {},
    pluginConfig: {
      injectSystemContext: true,
      trackSubagents: true,
      includeToolDerivedEvents: true,
    },
    runtime: createPluginRuntimeMock({
      state: {
        resolveStateDir: () => stateDir,
      },
    }),
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    registerTool() {},
    registerHook() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService() {},
    registerProvider() {},
    registerContextEngine() {},
    registerCommand() {},
    resolvePath(input: string) {
      return input;
    },
    on(hookName, handler) {
      const list = hooks.get(hookName) ?? [];
      list.push(handler as PluginHookHandlerMap[PluginHookName]);
      hooks.set(hookName, list);
    },
  };
  registerDualIdentity(api);
  return {
    api,
    stateDir,
    getHook<K extends PluginHookName>(name: K): PluginHookHandlerMap[K] {
      const handler = hooks.get(name)?.[0];
      if (!handler) {
        throw new Error(`missing hook: ${name}`);
      }
      return handler as PluginHookHandlerMap[K];
    },
  };
}

function createApiWithConfig(pluginConfig: Record<string, unknown>) {
  const hooks = new Map<PluginHookName, Array<PluginHookHandlerMap[PluginHookName]>>();
  const stateDir = `${os.tmpdir()}/openclaw-dual-identity-test-${Math.random().toString(36).slice(2, 10)}`;
  const api: OpenClawPluginApi = {
    id: "dual-identity",
    name: "dual-identity",
    source: "test",
    config: {},
    pluginConfig,
    runtime: createPluginRuntimeMock({
      state: {
        resolveStateDir: () => stateDir,
      },
    }),
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    registerTool() {},
    registerHook() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService() {},
    registerProvider() {},
    registerContextEngine() {},
    registerCommand() {},
    resolvePath(input: string) {
      return input;
    },
    on(hookName, handler) {
      const list = hooks.get(hookName) ?? [];
      list.push(handler as PluginHookHandlerMap[PluginHookName]);
      hooks.set(hookName, list);
    },
  };
  registerDualIdentity(api);
  return {
    stateDir,
    getHook<K extends PluginHookName>(name: K): PluginHookHandlerMap[K] {
      const handler = hooks.get(name)?.[0];
      if (!handler) {
        throw new Error(`missing hook: ${name}`);
      }
      return handler as PluginHookHandlerMap[K];
    },
  };
}

async function readAuditEvents(stateDir: string) {
  const auditFile = path.join(
    stateDir,
    "plugins",
    "dual-identity",
    `audit-${new Date().toISOString().slice(0, 10)}.jsonl`,
  );
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const content = await fs.readFile(auditFile, "utf8");
      return content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch (error) {
      if (attempt === 9) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  return [];
}

describe("dual-identity plugin", () => {
  it("injects a human-vs-agent system context before prompt build", async () => {
    const { getHook } = createApi();
    const onMessageReceived = getHook("message_received");
    const onSessionStart = getHook("session_start");
    const onBeforePromptBuild = getHook("before_prompt_build");

    await onMessageReceived(
      {
        from: "telegram:user-1",
        content: "ship it",
        metadata: {
          senderId: "user-1",
          senderName: "Alice",
        },
      },
      {
        channelId: "telegram",
        accountId: "default",
        conversationId: "user-1",
      },
    );

    await onSessionStart(
      {
        sessionId: "sess-1",
        sessionKey: "agent:main:telegram:direct:user-1",
      },
      {
        sessionId: "sess-1",
        sessionKey: "agent:main:telegram:direct:user-1",
        agentId: "main",
      },
    );

    const result = await onBeforePromptBuild(
      {
        prompt: "open the release checklist",
        messages: [],
      },
      {
        agentId: "main",
        sessionId: "sess-1",
        sessionKey: "agent:main:telegram:direct:user-1",
        trigger: "user",
        channelId: "telegram",
      },
    );

    expect(result?.prependSystemContext).toContain("Authority owner (human): Alice");
    expect(result?.prependSystemContext).toContain("Acting principal (agent): main");
    expect(result?.prependSystemContext).toContain("Current trigger source: human_direct");
    expect(result?.prependSystemContext).toContain("Current attribution lineage: human_direct");
  });

  it("propagates authority lineage into subagent handoffs", async () => {
    const { getHook } = createApi();
    const onMessageReceived = getHook("message_received");
    const onSessionStart = getHook("session_start");
    const onSubagentSpawning = getHook("subagent_spawning");
    const onBeforePromptBuild = getHook("before_prompt_build");

    await onMessageReceived(
      {
        from: "discord:user-9",
        content: "investigate the crash",
        metadata: {
          senderId: "user-9",
          senderName: "Riley",
        },
      },
      {
        channelId: "discord",
        accountId: "default",
        conversationId: "thread-1",
      },
    );

    await onSessionStart(
      {
        sessionId: "sess-parent",
        sessionKey: "agent:main:discord:channel:thread-1",
      },
      {
        sessionId: "sess-parent",
        sessionKey: "agent:main:discord:channel:thread-1",
        agentId: "main",
      },
    );

    await onSubagentSpawning(
      {
        childSessionKey: "agent:worker:subagent:child-1",
        agentId: "worker",
        mode: "session",
        threadRequested: false,
      },
      {
        requesterSessionKey: "agent:main:discord:channel:thread-1",
      },
    );

    const result = await onBeforePromptBuild(
      {
        prompt: "inspect the stack trace",
        messages: [],
      },
      {
        agentId: "worker",
        sessionKey: "agent:worker:subagent:child-1",
        trigger: "user",
      },
    );

    expect(result?.prependSystemContext).toContain("Authority owner (human): Riley");
    expect(result?.prependSystemContext).toContain("Acting principal (agent): worker");
    expect(result?.prependSystemContext).toContain("Current trigger source: handoff_delegated");
    expect(result?.prependSystemContext).toContain(
      "Current attribution lineage: cross_agent_derived",
    );
  });

  it("uses configured fallback authority owner for local sessions", async () => {
    const { getHook } = createApiWithConfig({
      injectSystemContext: true,
      defaultAuthorityOwnerId: "human://local/demo-user",
      defaultAuthorityOwnerLabel: "demo-user",
    });
    const onSessionStart = getHook("session_start");
    const onBeforePromptBuild = getHook("before_prompt_build");

    await onSessionStart(
      {
        sessionId: "sess-local",
        sessionKey: "agent:main:main",
      },
      {
        sessionId: "sess-local",
        sessionKey: "agent:main:main",
        agentId: "main",
      },
    );

    const result = await onBeforePromptBuild(
      {
        prompt: "say ok",
        messages: [],
      },
      {
        agentId: "main",
        sessionId: "sess-local",
        sessionKey: "agent:main:main",
        trigger: "user",
      },
    );

    expect(result?.prependSystemContext).toContain("Authority owner (human): demo-user");
    expect(result?.prependSystemContext).toContain("[human://local/demo-user]");
  });

  it("blocks memory-derived outbound flow shifts without explicit task authorization", async () => {
    const { getHook } = createApi();
    const onSessionStart = getHook("session_start");
    const onBeforePromptBuild = getHook("before_prompt_build");
    const onAfterToolCall = getHook("after_tool_call");
    const onBeforeToolCall = getHook("before_tool_call");

    await onSessionStart(
      {
        sessionId: "sess-flow",
        sessionKey: "agent:main:local:flow-shift",
      },
      {
        sessionId: "sess-flow",
        sessionKey: "agent:main:local:flow-shift",
        agentId: "main",
      },
    );

    await onBeforePromptBuild(
      {
        prompt: "Review the prior notes and summarize them for internal analysis only.",
        messages: [],
      },
      {
        agentId: "main",
        sessionId: "sess-flow",
        sessionKey: "agent:main:local:flow-shift",
        trigger: "user",
      },
    );

    await onAfterToolCall(
      {
        toolName: "memory_search",
        params: { query: "prior notes" },
        result: { hits: [] },
      },
      {
        agentId: "main",
        sessionId: "sess-flow",
        sessionKey: "agent:main:local:flow-shift",
        toolName: "memory_search",
      },
    );

    const decision = await onBeforeToolCall(
      {
        toolName: "message",
        params: { to: "peer", content: "share notes" },
      },
      {
        agentId: "main",
        sessionId: "sess-flow",
        sessionKey: "agent:main:local:flow-shift",
        toolName: "message",
      },
    );

    expect(decision?.block).toBe(true);
    expect(decision?.blockReason).toContain("memory-derived outbound flow");
  });

  it("blocks durable-note persistence cues from derived state without explicit persistence intent", async () => {
    const { getHook } = createApi();
    const onSessionStart = getHook("session_start");
    const onBeforePromptBuild = getHook("before_prompt_build");
    const onBeforeMessageWrite = getHook("before_message_write");

    await onSessionStart(
      {
        sessionId: "sess-persist",
        sessionKey: "agent:main:local:persist",
      },
      {
        sessionId: "sess-persist",
        sessionKey: "agent:main:local:persist",
        agentId: "main",
      },
    );

    await onBeforePromptBuild(
      {
        prompt: "Inspect the recalled context and answer the current task only.",
        messages: [],
      },
      {
        agentId: "main",
        sessionId: "sess-persist",
        sessionKey: "agent:main:local:persist",
        trigger: "memory",
      },
    );

    const decision = onBeforeMessageWrite(
      {
        sessionKey: "agent:main:local:persist",
        agentId: "main",
        message: {
          role: "assistant",
          content: "Remember this reusable guidance for future sessions.",
          timestamp: Date.now(),
        } as never,
      },
      {
        agentId: "main",
        sessionKey: "agent:main:local:persist",
      },
    );

    expect(decision?.block).toBe(true);
  });

  it("surfaces memory_replay as the attribution lineage for memory-triggered runs", async () => {
    const { getHook } = createApi();
    const onSessionStart = getHook("session_start");
    const onBeforePromptBuild = getHook("before_prompt_build");

    await onSessionStart(
      {
        sessionId: "sess-memory-lineage",
        sessionKey: "agent:main:local:memory-lineage",
      },
      {
        sessionId: "sess-memory-lineage",
        sessionKey: "agent:main:local:memory-lineage",
        agentId: "main",
      },
    );

    const result = await onBeforePromptBuild(
      {
        prompt: "Inspect the recalled context and answer the current task only.",
        messages: [],
      },
      {
        agentId: "main",
        sessionId: "sess-memory-lineage",
        sessionKey: "agent:main:local:memory-lineage",
        trigger: "memory",
      },
    );

    expect(result?.prependSystemContext).toContain("Current trigger source: memory_replay");
    expect(result?.prependSystemContext).toContain("Current attribution lineage: memory_replay");
  });

  it("blocks memory-influenced subagent spawning without explicit delegation intent", async () => {
    const { getHook } = createApi();
    const onSessionStart = getHook("session_start");
    const onBeforePromptBuild = getHook("before_prompt_build");
    const onSubagentSpawning = getHook("subagent_spawning");

    await onSessionStart(
      {
        sessionId: "sess-parent-block",
        sessionKey: "agent:main:local:handoff-parent",
      },
      {
        sessionId: "sess-parent-block",
        sessionKey: "agent:main:local:handoff-parent",
        agentId: "main",
      },
    );

    await onBeforePromptBuild(
      {
        prompt: "Review the recalled context and continue the current analysis yourself.",
        messages: [],
      },
      {
        agentId: "main",
        sessionId: "sess-parent-block",
        sessionKey: "agent:main:local:handoff-parent",
        trigger: "memory",
      },
    );

    const result = await onSubagentSpawning(
      {
        childSessionKey: "agent:worker:subagent:block-1",
        agentId: "worker",
        mode: "session",
        threadRequested: false,
      },
      {
        requesterSessionKey: "agent:main:local:handoff-parent",
      },
    );

    expect(result?.status).toBe("error");
    expect(result && "error" in result ? result.error : "").toContain(
      "does not explicitly authorize",
    );
  });

  it("keeps sessions_spawn attribution aligned across tool call, observed result, and persisted result", async () => {
    const { getHook, stateDir } = createApi();
    const onSessionStart = getHook("session_start");
    const onBeforePromptBuild = getHook("before_prompt_build");
    const onAfterToolCall = getHook("after_tool_call");
    const onBeforeToolCall = getHook("before_tool_call");
    const onToolResultPersist = getHook("tool_result_persist");

    await onSessionStart(
      {
        sessionId: "sess-cross-agent",
        sessionKey: "agent:main:local:cross-agent",
      },
      {
        sessionId: "sess-cross-agent",
        sessionKey: "agent:main:local:cross-agent",
        agentId: "main",
      },
    );

    await onBeforePromptBuild(
      {
        prompt: "Read the saved note and hand the exact summary to a worker agent.",
        messages: [],
      },
      {
        agentId: "main",
        sessionId: "sess-cross-agent",
        sessionKey: "agent:main:local:cross-agent",
        trigger: "memory",
      },
    );

    await onAfterToolCall(
      {
        toolName: "memory_get",
        toolCallId: "tool-memory-1",
        params: { path: "MEMORY.md" },
        result: { content: "delegate this summary" },
      },
      {
        agentId: "main",
        sessionId: "sess-cross-agent",
        sessionKey: "agent:main:local:cross-agent",
        toolName: "memory_get",
      },
    );

    await onBeforeToolCall(
      {
        toolName: "sessions_spawn",
        toolCallId: "tool-cross-agent-1",
        params: { agentId: "worker", task: "Summarize the recalled note." },
      },
      {
        agentId: "main",
        sessionId: "sess-cross-agent",
        sessionKey: "agent:main:local:cross-agent",
        toolName: "sessions_spawn",
      },
    );

    await onAfterToolCall(
      {
        toolName: "sessions_spawn",
        toolCallId: "tool-cross-agent-1",
        params: { agentId: "worker", task: "Summarize the recalled note." },
        result: { childSessionKey: "agent:worker:subagent:1" },
      },
      {
        agentId: "main",
        sessionId: "sess-cross-agent",
        sessionKey: "agent:main:local:cross-agent",
        toolName: "sessions_spawn",
      },
    );

    onToolResultPersist(
      {
        toolName: "sessions_spawn",
        toolCallId: "tool-cross-agent-1",
        isSynthetic: false,
      },
      {
        agentId: "main",
        sessionKey: "agent:main:local:cross-agent",
        toolName: "sessions_spawn",
        toolCallId: "tool-cross-agent-1",
      },
    );

    const events = await readAuditEvents(stateDir);
    const toolCallEvent = events.find(
      (event) => event.eventKind === "agent_tool_call" && event.toolCallId === "tool-cross-agent-1",
    );
    const observedEvent = events.find(
      (event) =>
        event.eventKind === "tool_result_observed" && event.toolCallId === "tool-cross-agent-1",
    );
    const persistedEvent = events.find(
      (event) =>
        event.eventKind === "tool_result_persisted" && event.toolCallId === "tool-cross-agent-1",
    );

    expect(toolCallEvent?.attributionKind).toBe("cross_agent_derived");
    expect(toolCallEvent?.sinkKind).toBe("cross_agent");
    expect(toolCallEvent?.lineageSourceEventIds).toBeTruthy();
    expect(observedEvent?.attributionKind).toBe("cross_agent_derived");
    expect(observedEvent?.sinkKind).toBe("cross_agent");
    expect(persistedEvent?.attributionKind).toBe("cross_agent_derived");
    expect(persistedEvent?.sinkKind).toBe("cross_agent");
  });
});
