import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { CodexAppServerClient, type CodexTurnResult } from "./codex-app-server.js";
import { SERVER_NAME, SERVER_VERSION } from "./config.js";
import {
  codexConsultInputSchema,
  codexContinueInputSchema,
  codexReviewInputSchema,
  type CodexConsultInput,
  type CodexContinueInput,
  type CodexReviewInput,
} from "./schemas.js";

function resultForMcp(result: CodexTurnResult) {
  return {
    content: [{ type: "text" as const, text: result.text }],
    structuredContent: {
      threadId: result.threadId,
      turnId: result.turnId,
      model: result.model ?? null,
      status: result.status,
      durationMs: result.durationMs ?? null,
      assistantMessageId: result.assistantMessageId ?? null,
    },
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Codex consultation failed unexpectedly. Check server diagnostics and retry.";
}

export function createServer(client: CodexAppServerClient): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "codex_consult",
    {
      title: "Consult Codex",
      description: "Ask Codex for a focused, read-only second opinion in a fresh thread.",
      inputSchema: codexConsultInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input: CodexConsultInput) => {
      try {
        return resultForMcp(await client.consult(input));
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: errorMessage(error) }] };
      }
    },
  );

  server.registerTool(
    "codex_continue",
    {
      title: "Continue Codex Thread",
      description: "Continue an existing Codex thread in the same read-only consultant mode.",
      inputSchema: codexContinueInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input: CodexContinueInput) => {
      try {
        return resultForMcp(await client.continue(input));
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: errorMessage(error) }] };
      }
    },
  );

  server.registerTool(
    "codex_review",
    {
      title: "Review Project with Codex",
      description: "Ask Codex for a focused, read-only code or project review rooted at the supplied cwd.",
      inputSchema: codexReviewInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input: CodexReviewInput) => {
      try {
        const prompt = [
          "Perform a read-only code/project review.",
          "Do not modify files, run destructive commands, or claim evidence you did not inspect.",
          "Return concrete findings with file paths and line references when available.",
          "User review request:",
          input.prompt,
        ].join("\n\n");
        return resultForMcp(await client.consult({ prompt, cwd: input.cwd }));
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: errorMessage(error) }] };
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  const client = new CodexAppServerClient();
  const server = createServer(client);
  const transport = new StdioServerTransport();
  let closing = false;

  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await Promise.allSettled([server.close(), client.close()]);
  };

  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  process.stdin.once("end", () => void close());

  try {
    await server.connect(transport);
  } catch (error) {
    await close();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(`[${SERVER_NAME}] failed to start: ${errorMessage(error)}`);
  process.exitCode = 1;
});
