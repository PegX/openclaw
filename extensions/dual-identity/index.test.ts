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
});
