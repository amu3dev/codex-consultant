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
const responses = new Map();
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
      if (response.id !== undefined) responses.set(response.id, response);
      if (response.id === 1 && response.result) {
        send({ jsonrpc: "2.0", method: "initialized", params: {} });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
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
    clientInfo: { name: "codex-consultant-stdio-check", version: "1.0.0" },
  },
});

const deadline = Date.now() + 5_000;
while (!responses.has(2) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

const tools = responses.get(2)?.result?.tools?.map((tool) => tool.name).sort();
const expected = ["codex_consult", "codex_continue", "codex_review"].sort();
if (JSON.stringify(tools) !== JSON.stringify(expected)) {
  fail(`Unexpected MCP tools: ${JSON.stringify(tools)}`);
} else {
  console.log(`MCP STDIO check passed: ${tools.join(", ")}`);
}

if (!child.stdin.destroyed) child.stdin.end();
child.kill("SIGTERM");
