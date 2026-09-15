# Security Policy

## Supported versions

Security fixes target the latest release on the default branch. Users should
reproduce reports against the latest commit or release before submitting them.

## Reporting a vulnerability

Do not open a public issue for vulnerabilities, credentials, private client
configuration, or sensitive prompts. Use GitHub's private vulnerability
reporting: <https://github.com/amu3dev/codex-consultant/security/advisories/new>.

Include the affected version, impact, minimal reproduction, and proposed
mitigation. If private reporting is unavailable, open a public issue containing
no sensitive details and request a private reporting channel.

## Security boundary

The adapter:

- exposes only focused consultation and review tools;
- starts Codex with `approvalPolicy: "never"` and read-only sandbox settings;
- does not expose arbitrary shell execution through MCP;
- keeps app-server diagnostics off MCP stdout;
- passes caller-supplied prompts and optional working directories to Codex.

Read-only does not make a prompt or repository safe to disclose. Operators remain
responsible for choosing the working directory and minimizing sensitive context.
