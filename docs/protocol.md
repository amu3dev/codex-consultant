# App-server protocol notes

This adapter targets the protocol emitted by `codex-cli 0.154.0`.

## Lifecycle

The client sends these frames over newline-delimited stdin:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"codex-consultant","version":"0.1.0"},"capabilities":{"experimentalApi":false,"requestAttestation":false}}}
{"jsonrpc":"2.0","method":"initialized","params":{}}
```

For a fresh consultation it then sends:

```json
{"jsonrpc":"2.0","id":2,"method":"thread/start","params":{"cwd":"/absolute/project","approvalPolicy":"never","sandbox":"read-only","allowProviderModelFallback":false}}
{"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"threadId":"THREAD_ID","input":[{"type":"text","text":"PROMPT","text_elements":[]}],"approvalPolicy":"never","sandboxPolicy":{"type":"readOnly","networkAccess":false}}}
```

Continuation first uses `thread/resume` with the existing `threadId`, then starts
another turn on the resumed thread.

## Event handling

`turn/start` acknowledges an in-progress turn. The adapter waits for matching
thread/turn notifications:

- `item/agentMessage/delta` for streaming text;
- `item/completed` for complete agent-message items;
- `turn/completed` for terminal status.

The completed `agentMessage` with `phase: "final_answer"` is preferred. The turn
payload is used as a fallback if item notifications arrive in a reduced form.

## 0.154.0 wire-format caveat

The installed app-server accepts standard JSON-RPC requests with
`"jsonrpc":"2.0"`, but server-emitted responses and notifications omit that
member. The inbound decoder therefore validates the message shape while allowing
the omitted field. This behavior is covered by deterministic tests.
