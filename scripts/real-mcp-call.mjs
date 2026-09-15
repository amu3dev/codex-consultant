import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import process from "node:process";

const entrypoint = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
await access(entrypoint);

const child = spawn(process.execPath, [entrypoint], {
  cwd: projectDirectory,
  env: { ...process.env, NODE_ENV: "production" },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
let initializeResponse;
let callResponse;
let failed = false;

function fail(message) {
  if (failed) return;
  failed = true;
  console.error(message);
  if (stderr.trim()) console.error(stderr.trim());
  child.kill("SIGTERM");
  process.exitCode = 1;
}

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  const lines = stdout.split("\n");
  stdout = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const response = JSON.parse(line);
      if (response.id === 1) {
        initializeResponse = response;
        if (response.error) return fail(`MCP initialize failed: ${JSON.stringify(response.error)}`);
        send({ jsonrpc: "2.0", method: "initialized", params: {} });
        send({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "codex_consult", arguments: { prompt: "Reply with exactly: MCP_CODEX_OK" } },
        });
      } else if (response.id === 2) {
        callResponse = response;
      }
    } catch {
      fail(`Non-JSON stdout frame: ${line}`);
    }
  }
});
child.stderr.on("data", (chunk) => { stderr += chunk; });
child.on("error", (error) => fail(`MCP server error: ${error.message}`));

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "codex-consultant-real-smoke", version: "1.0.0" },
  },
});

const deadline = Date.now() + 240_000;
while (!callResponse && !failed && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

if (!callResponse && !failed) fail("Timed out waiting for codex_consult");
if (callResponse?.error) fail(`MCP tools/call failed: ${JSON.stringify(callResponse.error)}`);

if (callResponse?.result && !failed) {
  const text = callResponse.result.content?.find((item) => item.type === "text")?.text;
  console.log(`MCP codex_consult text: ${text ?? "(no text)"}`);
  console.log(`MCP structured metadata: ${JSON.stringify(callResponse.result.structuredContent ?? {})}`);
  if (text !== "MCP_CODEX_OK") fail(`Unexpected semantic output: ${JSON.stringify(text)}`);
  else console.log("real MCP call passed");
}

if (!child.stdin.destroyed) child.stdin.end();
child.kill("SIGTERM");
