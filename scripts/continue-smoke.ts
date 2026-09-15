import { CodexAppServerClient } from "../src/codex-app-server.js";

const client = new CodexAppServerClient();

try {
  const first = await client.consult({
    prompt: "Reply with exactly: CONTINUE_FIRST",
    cwd: process.cwd(),
  });
  const second = await client.continue({
    threadId: first.threadId,
    prompt: "Reply with exactly: CONTINUE_SECOND",
  });
  console.log(`continue first: ${first.text}`);
  console.log(`continue second: ${second.text}`);
  console.log(`continue thread: ${second.threadId}`);
  if (first.text !== "CONTINUE_FIRST" || second.text !== "CONTINUE_SECOND") {
    throw new Error("unexpected continuation output");
  }
  console.log("continuation smoke passed");
} catch (error) {
  console.error(`continuation smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
