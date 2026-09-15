# Changelog

All notable changes to this project will be documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-15

### Added

- Local stdio MCP server exposing `codex_consult`, `codex_continue`, and `codex_review`.
- JSON-RPC/NDJSON wrapper for `codex app-server --stdio`.
- Fresh read-only Codex threads with `approvalPolicy: "never"`.
- Streaming assistant-message collection and turn-completion tracking.
- Request timeouts, malformed-frame handling, child-exit handling, and graceful cleanup.
- Offline MCP verification plus direct, wrapper, continuation, and end-to-end smoke checks.

[0.1.0]: https://github.com/amu3dev/codex-consultant/releases/tag/v0.1.0
