import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, normalize, resolve } from "node:path";
import {
  APP_SERVER_REQUEST_TIMEOUT_MS,
  APP_SERVER_SHUTDOWN_TIMEOUT_MS,
  APP_SERVER_TURN_TIMEOUT_MS,
  CODEX_BINARY,
  SERVER_NAME,
  SERVER_VERSION,
  type AppServerOptions,
} from "./config.js";

type JsonRpcId = string | number;
type JsonObject = Record<string, unknown>;

export interface AppServerNotification {
  /** 0.154.0 omits this member on server-emitted lines. */
  readonly jsonrpc?: "2.0";
  readonly method: string;
  readonly params?: unknown;
  readonly emittedAtMs?: number;
}

interface AppServerResponse {
  /** 0.154.0 omits this member on server-emitted lines. */
  readonly jsonrpc?: "2.0";
  readonly id: JsonRpcId;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
}

interface AppServerRequest {
  readonly jsonrpc?: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

interface JsonRpcError {
  readonly code?: number;
  readonly message?: string;
  readonly data?: unknown;
}

type IncomingMessage = AppServerNotification | AppServerResponse | AppServerRequest;

export interface CodexTurnResult {
  readonly text: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly model?: string;
  readonly status: string;
  readonly durationMs?: number;
  readonly assistantMessageId?: string;
}

export interface CodexConsultRequest {
  readonly prompt: string;
  readonly cwd?: string;
  readonly model?: string;
}

export interface CodexContinueRequest {
  readonly threadId: string;
  readonly prompt: string;
}

export class CodexAppServerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexAppServerError";
  }
}

export class CodexAppServerProtocolError extends CodexAppServerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexAppServerProtocolError";
  }
}

export class CodexAppServerTimeoutError extends CodexAppServerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexAppServerTimeoutError";
  }
}

export function normalizeCwd(cwd: string): string {
  return isAbsolute(cwd) ? normalize(cwd) : resolve(cwd);
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const property = value[key];
  return typeof property === "string" ? property : undefined;
}

function objectProperty(value: unknown, key: string): JsonObject | undefined {
  if (!isRecord(value)) return undefined;
  const property = value[key];
  return isRecord(property) ? property : undefined;
}

function rpcId(value: unknown): JsonRpcId | undefined {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
    ? value
    : undefined;
}

export function parseAppServerMessage(line: string): IncomingMessage {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (error) {
    throw new CodexAppServerProtocolError("Codex app-server emitted malformed JSON.", { cause: error });
  }

  if (!isRecord(value) || (value.jsonrpc !== undefined && value.jsonrpc !== "2.0")) {
    throw new CodexAppServerProtocolError(
      `Codex app-server emitted a non-JSON-RPC message: ${line.slice(0, 240)}`,
    );
  }

  const method = value.method;
  const id = rpcId(value.id);
  if (typeof method === "string") {
    if (id !== undefined) return value as unknown as AppServerRequest;
    return value as unknown as AppServerNotification;
  }

  if (id !== undefined && (Object.hasOwn(value, "result") || Object.hasOwn(value, "error"))) {
    return value as unknown as AppServerResponse;
  }

  throw new CodexAppServerProtocolError(
    `Codex app-server emitted an invalid JSON-RPC message: ${line.slice(0, 240)}`,
  );
}

export class NdjsonDecoder {
  private buffer = "";

  push(chunk: string): IncomingMessage[] {
    this.buffer += chunk;
    const messages: IncomingMessage[] = [];
    let newlineIndex = this.buffer.indexOf("\n");

    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.trim()) messages.push(parseAppServerMessage(line));
      newlineIndex = this.buffer.indexOf("\n");
    }

    return messages;
  }

  finish(): void {
    if (this.buffer.trim()) {
      throw new CodexAppServerProtocolError("Codex app-server closed with an incomplete JSON-RPC line.");
    }
  }
}

interface PendingRequest {
  readonly method: string;
  readonly timer: NodeJS.Timeout;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface AgentMessageRecord {
  readonly id: string;
  text?: string;
  phase?: string;
  deltaText: string;
}

interface TurnPayload {
  readonly id?: string;
  readonly status?: string;
  readonly error?: unknown;
  readonly durationMs?: number;
  readonly items?: unknown;
}

class TurnCollector {
  private turnId: string | undefined;
  private settled = false;
  private completionResolve!: (result: CodexTurnResult) => void;
  private completionReject!: (error: Error) => void;
  private readonly completion: Promise<CodexTurnResult>;
  private readonly messages = new Map<string, AgentMessageRecord>();
  private readonly unsubscribe: () => void;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly client: CodexAppServerClient,
    private readonly threadId: string,
  ) {
    this.completion = new Promise<CodexTurnResult>((resolveCompletion, rejectCompletion) => {
      this.completionResolve = resolveCompletion;
      this.completionReject = rejectCompletion;
    });
    this.unsubscribe = client.onNotification((notification) => this.handle(notification));
  }

  setTurnId(turnId: string): void {
    if (this.turnId !== undefined && this.turnId !== turnId) {
      throw new CodexAppServerProtocolError(`Codex returned conflicting turn IDs: ${this.turnId} and ${turnId}.`);
    }
    this.turnId = turnId;
  }

  async wait(timeoutMs: number): Promise<CodexTurnResult> {
    if (this.settled) return this.completion;
    this.timer = setTimeout(() => {
      this.reject(new CodexAppServerTimeoutError(
        `Codex turn ${this.turnId ?? "(unknown)"} did not complete within ${timeoutMs} ms.`,
      ));
    }, timeoutMs);
    return this.completion;
  }

  fail(error: Error): void {
    this.reject(error);
  }

  dispose(): void {
    this.unsubscribe();
    if (this.timer) clearTimeout(this.timer);
  }

  private handle(notification: AppServerNotification): void {
    const params = isRecord(notification.params) ? notification.params : undefined;
    if (!params || stringProperty(params, "threadId") !== this.threadId) return;

    const eventTurnId = stringProperty(params, "turnId")
      ?? stringProperty(objectProperty(params, "turn"), "id");
    if (eventTurnId !== undefined && this.turnId === undefined) this.turnId = eventTurnId;
    if (eventTurnId !== undefined && this.turnId !== eventTurnId) return;

    if (notification.method === "item/started" || notification.method === "item/completed") {
      this.rememberItem(params["item"]);
      return;
    }

    if (notification.method === "item/agentMessage/delta") {
      const itemId = stringProperty(params, "itemId");
      const delta = stringProperty(params, "delta");
      if (!itemId || delta === undefined) return;
      const message = this.messages.get(itemId) ?? { id: itemId, deltaText: "" };
      message.deltaText += delta;
      this.messages.set(itemId, message);
      return;
    }

    if (notification.method === "error") {
      if (params.willRetry === true) return;
      const error = objectProperty(params, "error");
      const message = stringProperty(error, "message") ?? "Codex reported a turn error.";
      this.reject(new CodexAppServerError(message));
      return;
    }

    if (notification.method === "turn/completed") {
      const turn = objectProperty(params, "turn") ?? {};
      this.rememberItems(turn["items"]);
      this.complete(turn as TurnPayload);
    }
  }

  private rememberItems(items: unknown): void {
    if (!Array.isArray(items)) return;
    for (const item of items) this.rememberItem(item);
  }

  private rememberItem(value: unknown): void {
    if (!isRecord(value) || value.type !== "agentMessage") return;
    const id = stringProperty(value, "id");
    if (!id) return;
    const existing = this.messages.get(id) ?? { id, deltaText: "" };
    const text = stringProperty(value, "text");
    const phase = stringProperty(value, "phase");
    if (text !== undefined) existing.text = text;
    if (phase !== undefined) existing.phase = phase;
    this.messages.set(id, existing);
  }

  private complete(turn: TurnPayload): void {
    if (this.settled) return;
    const status = turn.status ?? "unknown";
    if (status !== "completed") {
      const errorMessage = stringProperty(turn.error, "message");
      this.reject(new CodexAppServerError(
        errorMessage ?? `Codex turn ${status}.`,
      ));
      return;
    }

    const records = [...this.messages.values()];
    const finalRecord = records.find((record) => record.phase === "final_answer")
      ?? records.at(-1);
    const text = finalRecord?.text || finalRecord?.deltaText;
    if (!text) {
      this.reject(new CodexAppServerProtocolError("Codex completed the turn without an assistant message."));
      return;
    }

    this.resolve({
      text,
      threadId: this.threadId,
      turnId: turn.id ?? this.turnId ?? "",
      status,
      durationMs: turn.durationMs,
      assistantMessageId: finalRecord?.id,
    });
  }

  private resolve(result: CodexTurnResult): void {
    if (this.settled) return;
    this.settled = true;
    if (this.timer) clearTimeout(this.timer);
    this.completionResolve(result);
  }

  private reject(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    if (this.timer) clearTimeout(this.timer);
    this.completionReject(error);
  }
}

export class CodexAppServerClient {
  private readonly binaryPath: string;
  private readonly defaultCwd: string;
  private readonly requestTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly log: (message: string) => void;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationListeners = new Set<(notification: AppServerNotification) => void>();
  private readonly collectors = new Set<TurnCollector>();
  private nextRequestId = 1;
  private child: ChildProcessWithoutNullStreams | undefined;
  private decoder: NdjsonDecoder | undefined;
  private childExited = true;
  private childExitPromise: Promise<void> | undefined;
  private childExitResolve: (() => void) | undefined;
  private ready = false;
  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;

  constructor(options: AppServerOptions = {}) {
    this.binaryPath = options.binaryPath ?? CODEX_BINARY;
    this.defaultCwd = normalizeCwd(options.defaultCwd ?? process.cwd());
    this.requestTimeoutMs = options.requestTimeoutMs ?? APP_SERVER_REQUEST_TIMEOUT_MS;
    this.turnTimeoutMs = options.turnTimeoutMs ?? APP_SERVER_TURN_TIMEOUT_MS;
    this.log = options.log ?? ((message) => console.error(`[${SERVER_NAME}] ${message}`));
  }

  async consult(request: CodexConsultRequest): Promise<CodexTurnResult> {
    await this.ensureReady();
    const cwd = normalizeCwd(request.cwd ?? this.defaultCwd);
    const thread = await this.startThread(cwd, request.model);
    return this.executeTurn(thread.threadId, request.prompt, request.model, thread.model);
  }

  async continue(request: CodexContinueRequest): Promise<CodexTurnResult> {
    await this.ensureReady();
    const result = await this.request("thread/resume", {
      threadId: request.threadId,
      approvalPolicy: "never",
      sandbox: "read-only",
      excludeTurns: true,
    });
    const thread = objectProperty(result, "thread");
    const threadId = stringProperty(thread, "id") ?? request.threadId;
    const model = stringProperty(result, "model");
    return this.executeTurn(threadId, request.prompt, undefined, model);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  private async ensureReady(): Promise<void> {
    if (this.ready) return;
    if (this.closed) throw new CodexAppServerError("Codex app-server client is closed.");
    if (!this.startPromise) {
      this.startPromise = this.start().then(() => {
        this.ready = true;
      }).catch((error: unknown) => {
        this.startPromise = undefined;
        throw error;
      });
    }
    return this.startPromise;
  }

  private async start(): Promise<void> {
    this.log(`starting ${this.binaryPath} app-server --stdio`);
    const child = spawn(this.binaryPath, ["app-server", "--stdio"], {
      cwd: this.defaultCwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.decoder = new NdjsonDecoder();
    this.childExited = false;
    this.childExitPromise = new Promise<void>((resolveExit) => {
      this.childExitResolve = resolveExit;
    });
    this.attachChild(child);

    try {
      await this.request("initialize", {
        clientInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      this.notify("initialized", {});
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private attachChild(child: ChildProcessWithoutNullStreams): void {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string | Buffer) => {
      try {
        const messages = this.decoder?.push(String(chunk)) ?? [];
        for (const message of messages) this.handleMessage(message);
      } catch (error) {
        this.handleFatal(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stderr.on("data", (chunk: string | Buffer) => {
      const diagnostic = String(chunk).trimEnd();
      if (diagnostic) this.log(`app-server stderr: ${diagnostic}`);
    });
    child.stdin.on("error", (error) => this.handleFatal(error));
    child.on("error", (error) => this.handleFatal(error));
    child.on("exit", (code, signal) => {
      this.childExited = true;
      this.childExitResolve?.();
      this.childExitResolve = undefined;
      this.ready = false;
      if (this.child === child) this.child = undefined;
      try {
        this.decoder?.finish();
      } catch (error) {
        this.handleFatal(error instanceof Error ? error : new Error(String(error)));
      }
      if (!this.closed) {
        this.startPromise = undefined;
        this.failAll(new CodexAppServerError(
          `Codex app-server exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
        ));
      }
    });
  }

  private handleMessage(message: IncomingMessage): void {
    if ("method" in message && "id" in message) {
      this.log(`rejecting unsupported app-server request: ${message.method}`);
      this.sendRaw({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Unsupported client request: ${message.method}` },
      });
      return;
    }

    if ("method" in message) {
      for (const listener of this.notificationListeners) {
        try {
          listener(message);
        } catch (error) {
          this.log(`notification handler failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      this.log(`ignoring response for unknown request id ${String(message.id)}`);
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const errorMessage = message.error.message ?? `Codex app-server request ${pending.method} failed.`;
      pending.reject(new CodexAppServerError(
        `${pending.method} failed${message.error.code !== undefined ? ` (${message.error.code})` : ""}: ${errorMessage}`,
      ));
      return;
    }
    pending.resolve(message.result);
  }

  private handleFatal(error: Error): void {
    this.log(error.message);
    this.failAll(error);
    const child = this.child;
    if (child && !this.childExited) child.kill("SIGTERM");
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    for (const collector of this.collectors) collector.fail(error);
  }

  private request<T = unknown>(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
    const child = this.child;
    if (!child || this.childExited || child.stdin.destroyed) {
      return Promise.reject(new CodexAppServerError("Codex app-server is not running."));
    }

    const id = this.nextRequestId++;
    return new Promise<T>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new CodexAppServerTimeoutError(
          `Codex app-server request ${method} (${id}) timed out after ${timeoutMs} ms.`,
        ));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        timer,
        resolve: (value) => resolveRequest(value as T),
        reject: rejectRequest,
      });
      try {
        this.sendRaw({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectRequest(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    this.sendRaw({ jsonrpc: "2.0", method, params });
  }

  private sendRaw(message: JsonObject): void {
    const child = this.child;
    if (!child || this.childExited || child.stdin.destroyed) {
      throw new CodexAppServerError("Cannot write to a stopped Codex app-server.");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async startThread(cwd: string, model: string | undefined): Promise<{ threadId: string; model?: string }> {
    const params: JsonObject = {
      cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      allowProviderModelFallback: false,
    };
    if (model !== undefined) params.model = model;
    const result = await this.request("thread/start", params);
    const thread = objectProperty(result, "thread");
    const threadId = stringProperty(thread, "id");
    if (!threadId) throw new CodexAppServerProtocolError("thread/start returned no thread id.");
    return { threadId, model: stringProperty(result, "model") };
  }

  private async executeTurn(
    threadId: string,
    prompt: string,
    model: string | undefined,
    threadModel: string | undefined,
  ): Promise<CodexTurnResult> {
    const collector = new TurnCollector(this, threadId);
    this.collectors.add(collector);
    let turnId: string | undefined;
    try {
      const params: JsonObject = {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      };
      if (model !== undefined) params.model = model;
      const response = await this.request("turn/start", params);
      const turn = objectProperty(response, "turn");
      turnId = stringProperty(turn, "id");
      if (!turnId) throw new CodexAppServerProtocolError("turn/start returned no turn id.");
      collector.setTurnId(turnId);
      const result = await collector.wait(this.turnTimeoutMs);
      return { ...result, model: threadModel ?? model };
    } catch (error) {
      if (error instanceof CodexAppServerTimeoutError) {
        if (turnId) {
          await this.interruptTurn(threadId, turnId);
        } else {
          await this.close();
        }
      }
      throw error;
    } finally {
      this.collectors.delete(collector);
      collector.dispose();
    }
  }

  private async interruptTurn(threadId: string, turnId: string): Promise<void> {
    try {
      await this.request("turn/interrupt", { threadId, turnId }, Math.min(this.requestTimeoutMs, 5_000));
    } catch (error) {
      this.log(`failed to interrupt timed-out turn ${turnId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async closeInternal(): Promise<void> {
    this.closed = true;
    this.ready = false;
    this.failAll(new CodexAppServerError("Codex app-server client is shutting down."));
    const child = this.child;
    if (!child) return;

    if (!child.stdin.destroyed) child.stdin.end();
    await this.waitForChildExit(child, APP_SERVER_SHUTDOWN_TIMEOUT_MS);
    if (this.child === child && !this.childExited) {
      child.kill("SIGTERM");
      await this.waitForChildExit(child, APP_SERVER_SHUTDOWN_TIMEOUT_MS);
    }
    if (this.child === child && !this.childExited) child.kill("SIGKILL");
  }

  private async waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
    if (this.child !== child || this.childExited) return;
    const exitPromise = this.childExitPromise ?? Promise.resolve();
    await Promise.race([exitPromise, new Promise<void>((resolveWait) => setTimeout(resolveWait, timeoutMs))]);
  }
}

export async function askCodex(
  request: CodexConsultRequest,
  options?: AppServerOptions,
): Promise<CodexTurnResult> {
  const client = new CodexAppServerClient(options);
  try {
    return await client.consult(request);
  } finally {
    await client.close();
  }
}
