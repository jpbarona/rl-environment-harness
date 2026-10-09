# Version inventory

Recorded 2026-10-08 by direct inspection on macOS (Darwin). Commands
and outputs cited per line. Container and model tooling are recorded
as prerequisites; none were validated.

| Component | Version | Evidence |
|---|---|---|
| OpenCode | v2.0.18 | `~/.opencode/bin/opencode --version` printed `opencode v2.0.18`. Binary lives at `~/.opencode/bin/opencode`; it is not on `PATH`. |
| Node.js | v25.8.0 | `node --version`. Note: v25 is a non-LTS line. The project pins `engines.node >= 22`; the installed 25.x satisfies it. No global upgrade was performed. |
| npm | 11.11.0 | `npm --version`. |
| pnpm | not installed | `pnpm --version` returned `command not found`. npm is therefore the selected package manager. |
| Git | 2.50.1 (Apple Git-155) | `git --version`. |
| Docker | 28.5.1, build e180ab8 | `docker --version`. Client only; the daemon and image builds are prerequisites for Step 3 and were not exercised. |

## Isolation variables (verified against installed OpenCode)

Verified 2026-10-08 against the installed binary using
`~/.opencode/bin/opencode --help`:

- `OPENCODE_CONFIG=<path>` — path to a config file. Output text:
  "path to config file".
- `OPENCODE_PERMISSION=<json>` — inline permission JSON. Output text:
  "json permissions". This allows project-local tool permissions
  without touching global configuration.

Open Questions (not verified against v2.0.18 source):

- The data-directory override (for isolating the session store) has
  not been confirmed for the installed version. Candidate variables
  are `XDG_DATA_HOME`/`XDG_CONFIG_HOME`; confirm against the v2.0.18
  source tree before Step 2.
- Plugin API surface of v2.0.18 has not been inspected. Pin the exact
  source revision from https://github.com/anomalyco/opencode at tag or
  commit corresponding to v2.0.18 before implementing the plugin.