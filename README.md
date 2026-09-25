# dsh-remote-explorer

**[English](README.md)** | [中文](README.cn.md)

Remote development launcher: install [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) on a remote host and use it from your local browser. LLM credentials never leave your machine.

Inspired by VS Code Remote-SSH, Zed, and JetBrains Gateway — **code and sessions live on the remote, the local machine only renders the UI**.

## Supported environments

- **Local (client)**: Windows / Linux / macOS. Node.js v20.19+ or v22+ and pnpm 11+ are only needed for the **source-run** mode (pnpm is the default dev package manager, pinned via `packageManager`); release packages bundle their own Node runtime.
- **Remote host**: Linux or macOS (POSIX); aarch64 (arm64) and x86_64 both work. No Node preinstalled required — the tool installs and self-checks it.
- **WSL (Windows Subsystem for Linux)**: On Windows, WSL2 distributions are supported as remote targets. dsh is auto-installed inside WSL, tunneled via localhost forwarding — no SSH setup needed. Click the "WSL Sessions" card in the panel to use; the entry is hidden on non-Windows platforms.
- **SSH authentication**: private key (`IdentityFile`, recommended); with no key configured, an interactive terminal prompts for a password (no echo); `--password` also works (leaks via process list / shell history — the CLI warns).
- Hosts come from `Host` entries in `~/.ssh/config`, or ad-hoc `user@host[:port]` (IPv6 must go through the config).

## Installation and running

The CLI has two run modes (identical commands and options); if you already run dsh locally, you can also install this tool as a **dsh plugin** (Option 3).

### Option 1: run from source

The repository has no build step; `.ts` source is executed directly via tsx. The dev environment defaults to **pnpm** (version pinned via `packageManager` in package.json). After fetching the source:

```bash
pnpm install
pnpm exec tsx src/cli/bin.ts list
```

### Option 2: run a release package

Download the archive for your platform from the release page (produced by the [packaging script](#packaging), named `dsh-remote-explorer-<version>-<platform>.<zip|tar.gz>`), unpack it, and run directly — no Node, npm, or network required on the target:

| Platform | Archive | How to run after unpacking |
|---|---|---|
| win32-x64 | `.zip` | `dsh-remote-explorer.cmd <command>` |
| linux-x64 / linux-arm64 | `.tar.gz` | `./dsh-remote-explorer <command>` |
| darwin-x64 / darwin-arm64 | `.tar.gz` | `./dsh-remote-explorer <command>` |

Each package bundles the official Node binary (SHASUMS256-verified at download time) and a single-file CLI `dsh-remote-explorer.cjs` (all dependencies bundled in). Verify the archive against the sha256 published with the release.

### Option 3: install as a dsh plugin

If you already run dsh (Web/Desktop) on this machine, install this tool into dsh and manage remote sessions from a settings panel, a slash command, and agent tools:

```bash
# Requires pnpm on PATH (the dsh plugin command forwards to pnpm verbatim)
dsh plugin --profile web add dsh-remote-explorer
# When dsh is not on PATH:
npx --yes @deepseek-ai/dsh plugin --profile web add dsh-remote-explorer
# From a GitHub source (pre-built artifacts are committed; no extra config needed):
dsh plugin --profile web add github:btsd321/dsh-remote-explorer
# From a local checkout (build the plugin artifacts first):
pnpm run build:plugin && dsh plugin --profile web add /path/to/repo
```

> **Note for pnpm 11.7+ users (build-script approval gate):** pnpm 11.7 treats *undecided* dependency build scripts as a hard failure, and this package's dependency tree carries three (`cpu-features`, `esbuild` via tsx, `ssh2`) — the first `dsh plugin add` fails with `ERR_PNPM_IGNORED_BUILDS` regardless of the install source. None of them are needed at plugin runtime: the artifacts are pre-built (`lib/`, committed) and ssh2 falls back to pure JS. **Recommended:** install through the dsh web GUI's plugin manager page — it offers a built-in approve-and-retry flow. **CLI alternative:** after the failed add, set the three pending `allowBuilds` entries to `false` in `~/.dsh/profiles/web/pnpm-workspace.yaml`, remove the half-committed `dsh-remote-explorer` entry from `dependencies` in `~/.dsh/profiles/web/package.json` (the failed add leaves it there, and a plain retry exits 0 without activating the plugin — a dsh CLI quirk present in 0.1.7-rc.1/rc.2), then re-run the add command.

Restart `dsh web` after installing. The plugin provides three surfaces:

- **"Remote SSH Sessions" global panel in the left navigation**: pick a host, connect in two window modes (enter current tab / open new tab), disconnect, manage remote plugins, live progress log; the remote window carries a status pill for returning to the manager or closing/stopping the connection
- **Slash command** `/remote-explorer`: `hosts | connect <alias> [remote-dir] | status | disconnect <alias|session-id> [--keep-remote]`
- **Agent tools** `remote_hosts_list / remote_connect / remote_status / remote_kill` (behind dsh's regular tool-approval gate)

The plugin shares the CLI's session orchestration and remote layout (`~/.dsh-remote-explorer/btsd321/`), and the session table is shared in both directions: `dsh-remote-explorer status` shows plugin-kept sessions, and the panel shows CLI-kept ones (read-only, marked "external"). Two differences: **session lifetime rides the host dsh process** — quitting dsh stops the remote dsh too by default (`keepRemoteOnDispose: true` in the profile patch keeps it); LLM keys are read from the environment of the process that launched dsh. See the [usage guide](docs/usage-en.md).

## Quick start

> Examples below use the **source-run** form. With a release package, replace `pnpm exec tsx src/cli/bin.ts` with `./dsh-remote-explorer` (Windows: `dsh-remote-explorer.cmd`) — the options are identical.

```bash
# List hosts from ~/.ssh/config
pnpm exec tsx src/cli/bin.ts list

# Diagnose a host's provisioning conditions (replace myhost with your alias or user@host[:port])
pnpm exec tsx src/cli/bin.ts doctor myhost
pnpm exec tsx src/cli/bin.ts doctor myhost --refresh-mirrors   # force re-benchmark mirrors

# Main command: provision → start remote dsh → build tunnel → open browser (long-running)
# Export the API key for whichever provider you use (provider list comes from ~/.dsh/settings.yaml)
DEEPSEEK_API_KEY=sk-xxx pnpm exec tsx src/cli/bin.ts connect myhost --cwd //home/youruser

# Show all sessions maintained on this machine
pnpm exec tsx src/cli/bin.ts status

# Stop remote dsh
pnpm exec tsx src/cli/bin.ts kill myhost --all

# Clean up stale remote resources (old versions, dead session dirs; running sessions are protected)
pnpm exec tsx src/cli/bin.ts clean myhost
pnpm exec tsx src/cli/bin.ts clean myhost --keep 2   # keep 2 versions per category

# Provision only, don't start services (idempotent; reuses installed versions)
pnpm exec tsx src/cli/bin.ts provision myhost --cwd //home/youruser

# Use a different ssh config file
pnpm exec tsx src/cli/bin.ts list --ssh-config /path/to/config
```

After `connect`, the process must stay running — the local tunnel listener and LLM proxy live inside it. **Ctrl-C stops the remote dsh as well** (disconnect = clean). To disconnect but keep the remote process for reuse, add `--keep-remote`. If the session enters a terminal state due to failure, the remote process is also preserved.

For a detailed walkthrough of every command and option, see [docs/usage-en.md](docs/usage-en.md).

## How credentials work

Model calls do not go directly to the public internet. Instead, they traverse a reverse SSH tunnel. **Multi-provider support**: the proxy routes by path prefix — DeepSeek's native channel uses `/anthropic`, and other locally configured providers each use `/r/<provider-name>`. Routing is extracted automatically — no manual configuration needed.

```
Remote dsh ──(placeholder token)──▶ Remote 127.0.0.1:<reverse-port>/r/<provider> ──SSH reverse tunnel──▶ Local proxy
                                                                         ├─ /anthropic → api.deepseek.com
                                                                         └─ /r/<provider> → corresponding upstream
                                                                            (real key injected per route)
```

- Each provider's real key (`DEEPSEEK_API_KEY`, etc.) **exists only in the local process** — never written to remote disk, never placed in the remote environment. The remote process environment contains proxy tokens (random values).
- **Real key resolution**: reads `process.env` first, falls back to `$DSH_HOME/.credentials.yaml` refs — aligned with dsh's own credential resolution priority. Keys stored via the dsh Models page work automatically without exporting to environment variables.
- **Provider configuration source**: read precisely per runtime form — Desktop dsh reads `profiles/desktop/cordis.patch.yml`, Web dsh reads `profiles/web/cordis.patch.yml`, CLI reads `$DSH_HOME/settings.yaml`. Configuration is **mirrored** into the remote session (keys like `agent-default-model` are mirrored so the remote default model matches local). Only provider `baseURL` is redirected into the tunnel. **Only configuration is mirrored (credential references, no secrets); `.credentials.yaml` is never mirrored** (it may contain real keys).
- Missing a provider's key only affects that provider (502 with clear guidance); others continue normally.
- The proxy token and reverse port are fixed per session, persisted to remote `.runtime/` (token at permission 600), and read back on reconnect and reuse.
- Multiple local CLIs sharing the same session share the credential path (reverse port is first-come-first-served; later views automatically yield).
- Known residual risk: a same-privilege user on the remote could consume your quota via your tunnel (they cannot extract the key itself). Be aware on multi-user remote hosts: the proxy raises the bar with per-session tokens, rate limiting, and a path allowlist, but cannot fully block same-privilege users.

### Remote proxy for GitHub access (DSH_REMOTE_PROXY)

The remote dsh is launched by this tool, so its environment carries no proxy variables by default — on a remote host without direct internet, installing a GitHub plugin (which uses HTTPS `git ls-remote`) times out even though SSH (port 22) works. Setting `DSH_REMOTE_PROXY` on the local machine fixes that: the launcher injects `http_proxy` / `https_proxy` / `ALL_PROXY` (both letter cases) into the remote dsh process, pointing at the proxy port your SSH reverse tunnel exposes on the remote (e.g. `http://127.0.0.1:18890`):

```bash
DSH_REMOTE_PROXY=http://127.0.0.1:18890 DEEPSEEK_API_KEY=sk-xxx pnpm exec tsx src/cli/bin.ts connect myhost
```

dsh itself passes proxy variables through to the `git`/`pnpm` child processes it spawns, so plugin installs and dependency fetches go through the same proxy. Leaving `DSH_REMOTE_PROXY` unset injects nothing — machines with direct internet are unaffected. In plugin form, per-host custom variables (the gear button on the panel, persisted in `~/.dsh/remote-host-env.json`) take precedence over this fallback.

## Remote disk isolation

Modeled after VS Code's `~/.vscode-server` single-root self-contained model: everything this tool writes on the remote is inside `~/.dsh-remote-explorer/btsd321/` (installations, per-session state, npm cache, temporary files). It **never writes to** remote `~/.dsh` (official dsh's home) or `~/.npm` (shared npm cache). The remote dsh's skill directory is also redirected into the session (`DSH_AGENTS_HOME`), not the machine-global `~/.agents`.

- Other users running official dsh on the same machine are not affected; `doctor`'s isolation check section reports usage.
- Full uninstall = `rm -rf ~/.dsh-remote-explorer/btsd321`, one command, clean.
- Known low-risk sharing: remote pnpm store — only touched if someone actively runs `dsh plugin` on the remote; content-addressed and concurrency-safe.

**When writing remote paths in Git Bash, use double slashes** (`--cwd //home/xxx`) or set `MSYS_NO_PATHCONV=1` first. MSYS rewrites `/home/xxx` into something like `D:/SoftWare/Git/home/xxx` before the argument reaches the program, which the CLI can only detect and reject.

`doctor` checks connectivity, platform, basic commands, disk space, installed runtimes, **Node runtime stability**, and live mirror latency. It is the first tool for troubleshooting remote environment issues — most remote development failures are environmental, not code.

## Multi-user and remote plugin management

The multi-user model follows VS Code Remote-SSH:

- **Different remote OS accounts** on the same host = fully isolated (separate remote roots, sessions, plugins)
- **Same remote account** = shared session root: same (host, remote directory) means the same remote session (multiple views), sessions see each other and the credential proxy belongs to the first view — expected behavior (VS Code shares one server per account likewise). Use separate remote accounts per person for full isolation
- `kill --all` and `clean` default to acting only on **sessions started from this machine** (owner fingerprint written to remote `.runtime/owner` at session start) plus process-less leftovers; other owners' sessions are skipped and listed, `--include-others` restores the old full-scope behavior

Remote plugin management, two surfaces (VS Code's "manage while connected"). The plugin store is **user-level** (one per remote OS account, shared by all its sessions — the counterpart of `~/.vscode-server/extensions/`; session profiles attach via symlink with zero copies):

- **Inside the remote window**: the remote dsh's own Settings plugin UI is fully functional (provisioning installs pnpm on the remote)
- **Local manager page**: the remote-session panel's "Remote plugins" section lists / installs / enables / disables / uninstalls; changes hot-apply to your own live session via remote hmr and reach other sessions at their next connect (VS Code's Reload Required equivalent — no automatic remote restart)

## Architecture

```
Local (Windows/Linux/macOS)                      Remote (Linux/macOS)
┌────────────────────────────────┐              ┌──────────────────────────────┐
│ Browser                        │              │ dsh (full npm install)        │
│ 127.0.0.1:<local-port>         │              │ webserver 127.0.0.1:<port>    │
└───────────────┬────────────────┘              │                              │
                │ HTTP / WS + session token     │  ├ session / agent           │
┌───────────────▼────────────────┐  forward     │  ├ fs / subprocess           │
│ dsh-remote-explorer CLI (long-running)  │══════════════▶│  ├ terminal / lsp            │
│ ├ transport  ssh2 conn & fwd   │              │  └ sandbox                    │
│ ├ provision  install Node & dsh│              │                              │
│ ├ tunnel     port forwarding   │  reverse     │                              │
│ ├ session    heartbeat & recon │◀═════════════│  baseURL → 127.0.0.1:<rev>   │
│ └ credential LLM proxy         │              │                              │
│   ▲ DEEPSEEK_API_KEY only here │              └──────────────────────────────┘
└───┼────────────────────────────┘
    │
Real LLM API (local direct egress)
```

Dependencies are strictly one-directional, top to bottom; lower layers must not import upper layers:

```
Entry        cli/
Orchestration session/
Capability   provision/   tunnel/   credential/
Transport    transport/
Foundation   hosts/   util/
```

| Module | Responsibility |
|---|---|
| [src/util/](src/util/) | Shell escaping, error types, interactive password prompt (no echo) |
| [src/hosts/ssh-config-parser.ts](src/hosts/ssh-config-parser.ts) | **Sole** source of host config: parses ssh config (plus ad-hoc `user@host[:port]`), recursively resolves ProxyJump, applies auth overrides |
| [src/transport/types.ts](src/transport/types.ts) | Transport abstraction (designed for multiple transports; Docker/WSL possible later) |
| [src/transport/ssh-transport.ts](src/transport/ssh-transport.ts) | ssh2 implementation: jump host chains, command execution, SFTP, forward/reverse forwarding, password auth (retries on rejection, up to 3) |
| [src/transport/channel-pool.ts](src/transport/channel-pool.ts) | SSH channel quota, avoids exceeding MaxSessions |
| [src/transport/platform.ts](src/transport/platform.ts) | Shared platform detection and command building: arch mapping, uname parsing, PATH assembly |
| [src/provision/probe.ts](src/provision/probe.ts) | Remote probe + **Node stability self-check** |
| [src/provision/mirror-selector.ts](src/provision/mirror-selector.ts) | Live mirror latency measurement and adaptive selection |
| [src/provision/remote-paths.ts](src/provision/remote-paths.ts) | Single source of truth for remote path rules |
| [src/provision/node-installer.ts](src/provision/node-installer.ts) | Install Node, version-isolated, self-checks after install |
| [src/provision/dsh-installer.ts](src/provision/dsh-installer.ts) | Install dsh, explicit version (no dist-tag reliance) |
| [src/provision/profile-writer.ts](src/provision/profile-writer.ts) | Per-session independent `DSH_HOME` and profile/patch generation |
| [src/provision/provisioner.ts](src/provision/provisioner.ts) | Provisioning orchestration, each step idempotent |
| [src/provision/remote-context.ts](src/provision/remote-context.ts) | Remote execution context: binds transport instance and path info |
| [src/util/session-id.ts](src/util/session-id.ts) | Deterministic session id from host alias + remote directory |
| [src/tunnel/port-allocator.ts](src/tunnel/port-allocator.ts) | Remote port allocation and listen confirmation |
| [src/tunnel/forward-local.ts](src/tunnel/forward-local.ts) | Forward tunneling, **listener survives reconnection** |
| [src/session/remote-process.ts](src/session/remote-process.ts) | Remote dsh detach launch, token capture, safe shutdown |
| [src/session/lifecycle-state.ts](src/session/lifecycle-state.ts) | Session state machine, pure functions |
| [src/session/heartbeat.ts](src/session/heartbeat.ts) | Heartbeat: process + port + HTTP application-level, single command |
| [src/session/reconnect.ts](src/session/reconnect.ts) | Bounded exponential backoff |
| [src/session/session-registry.ts](src/session/session-registry.ts) | Local session table, lock file + atomic replacement |
| [src/session/session-manager.ts](src/session/session-manager.ts) | Session orchestration: 5-phase open, heartbeat, reconnect, close |
| [src/credential/tunnel-proxy.ts](src/credential/tunnel-proxy.ts) | Reverse tunnel LLM proxy (multi-provider routing), injects real keys |
| [src/credential/provider-routes.ts](src/credential/provider-routes.ts) | Extract provider routes from local config (settings.yaml / profile patch), produce remote mirror |
| [src/credential/local-credentials.ts](src/credential/local-credentials.ts) | Read local `.credentials.yaml` refs as env-var credential fallback |
| [src/credential/token.ts](src/credential/token.ts) | Proxy token: generation and constant-time comparison |
| [src/credential/proxy-secret.ts](src/credential/proxy-secret.ts) | Credential material I/O: session-scoped token and reverse port persisted on remote |
| [src/plugin/remote-plugin-store.ts](src/plugin/remote-plugin-store.ts) | Remote plugin package management: list / install / remove / toggle |
| [src/cli/](src/cli/) | Command dispatch, argument parsing, terminal output, per-command auth wiring |

## Development

```bash
# Type check
pnpm run typecheck
```

> **⚠️ Contributors: install the git hook once after cloning — do not commit without it.**
>
> ```bash
> pnpm run setup:hooks
> ```
>
> `pnpm install` no longer builds anything: the `prepare` script was deliberately removed, because pnpm 11 refuses to install git-hosted packages that declare any lifecycle script (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`). The plugin artifacts (`lib/`) are committed to the repository, and the pre-commit hook rebuilds them automatically whenever `src/`, `scripts/`, or `tests/` change. **If you skip `setup:hooks` and also forget to run `pnpm run build:plugin` manually, your commit ships a stale `lib/` — everyone installing from GitHub then silently gets outdated plugin code.** Without the hook, always run `pnpm run build:plugin` and include the updated `lib/` in the same commit.

Code style guide is in [docs/type_script_style.md](docs/type_script_style.md) — read it before writing any code.

## Packaging

Produces release packages (see [Installation and running](#option-2-run-a-release-package)): esbuild bundles the CLI with all runtime dependencies into a single `dsh-remote-explorer.cjs`, then the official Node binary for the target platform is added, along with launchers and docs, and everything is archived. Output lands in `dist/` (gitignored) — **this does not change how the source itself runs via tsx**.

```bash
pnpm exec tsx scripts/package.ts                        # package for the current platform
pnpm exec tsx scripts/package.ts --all                  # full five-platform matrix
pnpm exec tsx scripts/package.ts --os linux --arch arm64
```

| Option | Description |
|---|---|
| `--os <os>` | Target OS: `win32` / `linux` / `darwin` (default: current platform) |
| `--arch <arch>` | Target architecture: `x64` / `arm64` (default: current architecture) |
| `--all` | Build the full five-platform matrix; ignores `--os` / `--arch` |
| `--node-version <ver>` | Node version to bundle (default: `v24.21.0`) |
| `--mirror <mirror>` | Node download source: `npmmirror` (default) / `official` / custom URL prefix |
| `--out-dir <dir>` | Output directory (default: `dist`) |
| `--minify` | Minify the bundle (off by default, keeps readable stack traces) |

Node distributions are verified against SHASUMS256 on download and cached in `dist/.node-cache`, so repeated packaging skips the download. Each run prints the path, size, and sha256 of every artifact.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
