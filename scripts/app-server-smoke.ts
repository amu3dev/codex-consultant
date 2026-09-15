import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { CODEX_BINARY } from "../src/config.js";

type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function stringProperty(value: unknown, key: string): string | undefined {
  const property = record(value)[key];
  return typeof property === "string" ? property : undefined;
}

function spawnServer(): ChildProcessWithoutNullStreams {
  return spawn(CODEX_BINARY, ["app-server", "--stdio"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

const child = spawnServer();
let buffer = "";
let nextId = 1;
let threadId: string | undefined;
let turnId: string | undefined;
let finished = false;
let resolveDone!: () => void;
let rejectDone!: (error: Error) => void;
const done = new Promise<void>((resolve, reject) => {
  resolveDone = resolve;
  rejectDone = reject;
});
const timeout = setTimeout(() => rejectDone(new Error("app-server smoke timed out")), 60_000);

function send(message: JsonObject): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function fail(error: Error): void {
  if (finished) return;
  finished = true;
  rejectDone(error);
}

function handle(message: JsonObject): void {
  if (message.error) {
    const error = record(message.error);
    fail(new Error(`${String(message.method ?? "request")} failed: ${String(error.message ?? "unknown error")}`));
    return;
  }

  if (message.id === 1 && message.result) {
    console.log(`initialize: ok (${stringProperty(message.result, "userAgent") ?? "unknown user agent"})`);
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "thread/start",
      params: { cwd: process.cwd(), approvalPolicy: "never", sandbox: "read-only" },
    });
    return;
  }

  if (message.id === 2 && message.result) {
    threadId = stringProperty(record(message.result).thread, "id");
    if (!threadId) return fail(new Error("thread/start returned no thread id"));
    console.log(`thread/start: ok (${threadId})`);
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "turn/start",
      params: {
        threadId,
        input: [{ type: "text", text: "Reply with exactly: CODEX_BRIDGE_OK", text_elements: [] }],
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      },
    });
    return;
  }

  if (message.id === 3 && message.result) {
    turnId = stringProperty(record(message.result).turn, "id");
    if (!turnId) return fail(new Error("turn/start returned no turn id"));
    console.log(`turn/start: accepted (${turnId})`);
    return;
  }

  if (message.method === "item/completed") {
    const params = record(message.params);
    const item = record(params.item);
    if (params.threadId === threadId && params.turnId === turnId && item.type === "agentMessage") {
      const text = stringProperty(item, "text");
      if (text) console.log(`assistant: ${text}`);
    }
  }

  if (message.method === "turn/completed") {
    const params = record(message.params);
    const turn = record(params.turn);
    if (params.threadId === threadId && turn.id === turnId) {
      console.log(`turn/completed: ${String(turn.status ?? "unknown")}`);
      finished = true;
      resolveDone();
    }
  }
}

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += String(chunk);
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line) as JsonObject);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  }
});
child.stderr.on("data", (chunk) => process.stderr.write(`[app-server stderr] ${String(chunk)}`));
child.on("error", fail);
child.on("exit", (code, signal) => {
  if (!finished && code !== 0) fail(new Error(`app-server exited before completion (code=${code}, signal=${signal})`));
});

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    clientInfo: { name: "codex-consultant", version: "0.1.0" },
    capabilities: { experimentalApi: false, requestAttestation: false },
  },
});

try {
  await done;
  console.log("app-server smoke passed");
  process.exitCode = 0;
} catch (error) {
  console.error(`app-server smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  if (!child.stdin.destroyed) child.stdin.end();
  if (!child.killed) child.kill("SIGTERM");
}
