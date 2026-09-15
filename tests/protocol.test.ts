import { describe, expect, it } from "vitest";
import {
  CodexAppServerProtocolError,
  NdjsonDecoder,
  parseAppServerMessage,
} from "../src/codex-app-server.js";

describe("app-server protocol framing", () => {
  it("accepts the 0.154.0 response and notification shape without jsonrpc", () => {
    expect(parseAppServerMessage('{"id":1,"result":{"ok":true}}')).toMatchObject({
      id: 1,
      result: { ok: true },
    });
    expect(parseAppServerMessage('{"method":"turn/completed","params":{}}')).toMatchObject({
      method: "turn/completed",
    });
  });

  it("decodes newline-delimited frames and rejects malformed messages", () => {
    const decoder = new NdjsonDecoder();
    const messages = decoder.push('{"id":1,"result":{}}\n{"method":"initialized"}\n');
    expect(messages).toHaveLength(2);
    expect(() => parseAppServerMessage("not json")).toThrow(CodexAppServerProtocolError);
    expect(() => parseAppServerMessage('{"jsonrpc":"2.0"}')).toThrow(CodexAppServerProtocolError);
  });
});
