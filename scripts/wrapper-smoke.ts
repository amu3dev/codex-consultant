import { askCodex } from "../src/codex-app-server.js";

try {
  const result = await askCodex({
    prompt: "Reply with exactly: CODEX_BRIDGE_OK",
    cwd: process.cwd(),
  });
  console.log(`wrapper answer: ${result.text}`);
  console.log(`wrapper metadata: thread=${result.threadId} turn=${result.turnId} model=${result.model ?? "unknown"}`);
  if (result.text !== "CODEX_BRIDGE_OK") {
    throw new Error(`unexpected semantic output: ${JSON.stringify(result.text)}`);
  }
  console.log("wrapper smoke passed");
} catch (error) {
  console.error(`wrapper smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
