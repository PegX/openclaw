import type {
  OpenClawPluginApi,
  PluginHookHandlerMap,
  PluginHookName,
} from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import { createPluginRuntimeMock } from "../test-utils/plugin-runtime-mock.js";
import registerDualIdentity from "./index.js";

function createApi() {
  const hooks = new Map<PluginHookName, Array<PluginHookHandlerMap[PluginHookName]>>();
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
        resolveStateDir: () => "/tmp/openclaw-dual-identity-test",
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
  const api: OpenClawPluginApi = {
    id: "dual-identity",
    name: "dual-identity",
    source: "test",
    config: {},
    pluginConfig,
    runtime: createPluginRuntimeMock({
      state: {
        resolveStateDir: () => "/tmp/openclaw-dual-identity-test",
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
    getHook<K extends PluginHookName>(name: K): PluginHookHandlerMap[K] {
      const handler = hooks.get(name)?.[0];
      if (!handler) {
        throw new Error(`missing hook: ${name}`);
      }
      return handler as PluginHookHandlerMap[K];
    },
  };
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
});
