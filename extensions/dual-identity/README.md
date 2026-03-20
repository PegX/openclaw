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
- subagent handoffs and child-session lineage

## What it records

The plugin writes JSONL audit events under:

- default: `~/.openclaw/plugins/dual-identity/`
- configurable via `plugins.entries["dual-identity"].config.auditDir`

Each audit line records:

- `authorityOwnerId` / `authorityOwnerLabel`
- `actingPrincipalId`
- `triggerKind`
- `delegationId`
- `sessionKey` / `childSessionKey`
- `toolName` / `toolCallId` when relevant

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
