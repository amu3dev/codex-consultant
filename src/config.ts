export const SERVER_NAME = "codex-consultant";
export const SERVER_VERSION = "0.1.0";

export const CODEX_BINARY = "/opt/homebrew/bin/codex";
export const APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;
export const APP_SERVER_TURN_TIMEOUT_MS = 180_000;
export const APP_SERVER_SHUTDOWN_TIMEOUT_MS = 2_000;

export interface AppServerOptions {
  binaryPath?: string;
  defaultCwd?: string;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  log?: (message: string) => void;
}
