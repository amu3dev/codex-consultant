# Contributing

Thanks for helping improve `codex-consultant`. Keep changes focused, reviewable,
and compatible with the small MCP tool contract.

## Development setup

```bash
git clone https://github.com/amu3dev/codex-consultant.git
cd codex-consultant
npm ci
npm run check
```

The default check is offline and does not require a live Codex call. Live checks
require a locally installed and authenticated Codex CLI:

```bash
npm run smoke:app-server
npm run smoke:wrapper
npm run smoke:continue
npm run smoke:mcp
```

## Change guidelines

- Keep stdout reserved for MCP JSON-RPC; diagnostics belong on stderr.
- Do not reintroduce `codex mcp-server`; use the supported app-server lifecycle.
- Preserve the read-only sandbox and `approvalPolicy: "never"` defaults.
- Add deterministic tests for protocol or behavior changes.
- Do not expose arbitrary shell execution through MCP.
- Never commit credentials, private Codex configuration, personal absolute paths,
  generated `dist/`, or proprietary project context.
- Update `CHANGELOG.md` for user-visible behavior changes.

## Pull requests

Describe the user problem, contract impact, security impact, and verification
commands. Review the diff for secrets and private paths before submitting.
