# dsh-remote

**[English](README.md)** | [中文](README.cn.md)

Remote development launcher: install [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) on a remote host and use it from your local browser. LLM credentials never leave your machine.

Inspired by VS Code Remote-SSH, Zed, and JetBrains Gateway — **code and sessions live on the remote, the local machine only renders the UI**. Full architecture rationale, research sources, and benchmark data are in [PLAN.md](PLAN.md).

## Supported environments

- **Local (client)**: Windows / Linux / macOS. Node.js v20.19+ or v22+ is only needed for the **source-run** mode; release packages bundle their own Node runtime.
- **Remote host**: Linux or macOS (POSIX); aarch64 (arm64) and x86_64 both work. No Node preinstalled required — the tool installs and self-checks it.
- **SSH authentication**: private key (`IdentityFile`, recommended); with no key configured, an interactive terminal prompts for a password (no echo); `--password` also works (leaks via process list / shell history — the CLI warns).
- Hosts come from `Host` entries in `~/.ssh/config`, or ad-hoc `user@host[:port]` (IPv6 must go through the config).

## Installation and running

Pick either mode — commands and options are identical.

### Option 1: run from source

The repository has no build step; `.ts` source is executed directly via tsx. After fetching the source:

```bash
npm install
npx tsx src/cli/bin.ts list
```

### Option 2: run a release package

Download the archive for your platform from the release page (produced by the [packaging script](#packaging), named `dsh-remote-<version>-<platform>.<zip|tar.gz>`), unpack it, and run directly — no Node, npm, or network required on the target:

| Platform | Archive | How to run after unpacking |
|---|---|---|
| win32-x64 | `.zip` | `dsh-remote.cmd <command>` |
| linux-x64 / linux-arm64 | `.tar.gz` | `./dsh-remote <command>` |
| darwin-x64 / darwin-arm64 | `.tar.gz` | `./dsh-remote <command>` |

Each package bundles the official Node binary (SHASUMS256-verified at download time) and a single-file CLI `dsh-remote.cjs` (all dependencies bundled in). Verify the archive against the sha256 published with the release.

## Quick start

> Examples below use the **source-run** form. With a release package, replace `npx tsx src/cli/bin.ts` with `./dsh-remote` (Windows: `dsh-remote.cmd`) — the options are identical.

```bash
# List hosts from ~/.ssh/config
npx tsx src/cli/bin.ts list

# Diagnose a host's provisioning conditions (replace myhost with your alias or user@host[:port])
npx tsx src/cli/bin.ts doctor myhost
npx tsx src/cli/bin.ts doctor myhost --refresh-mirrors   # force re-benchmark mirrors

# Main command: provision → start remote dsh → build tunnel → open browser (long-running)
# Export the API key for whichever provider you use (provider list comes from ~/.dsh/settings.yaml)
DEEPSEEK_API_KEY=sk-xxx ASTUDIO_API_KEY=sk-xxx npx tsx src/cli/bin.ts connect myhost --cwd //home/youruser

# Show all sessions maintained on this machine
npx tsx src/cli/bin.ts status

# Stop remote dsh
npx tsx src/cli/bin.ts kill myhost --all

# Clean up stale remote resources (old versions, dead session dirs; running sessions are protected)
npx tsx src/cli/bin.ts clean myhost
npx tsx src/cli/bin.ts clean myhost --keep 2   # keep 2 versions per category

# Provision only, don't start services (idempotent; reuses installed versions)
npx tsx src/cli/bin.ts provision myhost --cwd //home/youruser

# Use a different ssh config file
npx tsx src/cli/bin.ts list --ssh-config /path/to/config
```

After `connect`, the process must stay running — the local tunnel listener and LLM proxy live inside it. **Ctrl-C stops the remote dsh as well** (disconnect = clean). To disconnect but keep the remote process for reuse, add `--keep-remote`. If the session enters a terminal state due to failure, the remote process is also preserved.

For a detailed walkthrough of every command and option, see [docs/usage-en.md](docs/usage-en.md).

## How credentials work

Model calls do not go directly to the public internet. Instead, they traverse a reverse SSH tunnel. **Multi-provider support**: the proxy routes by path prefix — DeepSeek's native channel uses `/anthropic`, and providers configured in `~/.dsh/settings.yaml` under `llm-pi-ai.providers` (e.g. AStudio, qwen, iflytek) each use `/r/<provider-name>`. Routing is extracted automatically — no manual configuration needed.

```
Remote dsh ──(placeholder token)──▶ Remote 127.0.0.1:<reverse-port>/r/<provider> ──SSH reverse tunnel──▶ Local proxy
                                                                         ├─ /anthropic → api.deepseek.com
                                                                         └─ /r/astudio → maas-api.cn-huabei-1.xf-yun.com
                                                                            (real key injected per route)
```

- Each provider's real key (`DEEPSEEK_API_KEY`, `ASTUDIO_API_KEY`, etc.) **exists only in the local process** — never written to remote disk, never placed in the remote environment. The remote process environment contains proxy tokens (random values).
- The local `~/.dsh/settings.yaml` is **mirrored** into the session's `DSH_HOME/settings.yaml` (settings keys like `agent-default-model` are mirrored so the remote default model matches local). Only provider `baseURL` is redirected into the tunnel. **Only settings are mirrored (credential references, no secrets); `.credentials.yaml` is never mirrored** (it may contain real keys).
- Missing a provider's key only affects that provider (502 with clear guidance); others continue normally.
- The proxy token and reverse port are fixed per session, persisted to remote `.runtime/` (token at permission 600), and read back on reconnect and reuse.
- Multiple local CLIs sharing the same session share the credential path (reverse port is first-come-first-served; later views automatically yield).
- Known residual risk: a same-privilege user on the remote could consume your quota via your tunnel (they cannot extract the key itself). Be aware on multi-user remote hosts; see [PLAN.md](PLAN.md) section 4.5.

## Remote disk isolation

Modeled after VS Code's `~/.vscode-server` single-root self-contained model: everything this tool writes on the remote is inside `~/.dsh-remote/` (installations, per-session state, npm cache, temporary files). It **never writes to** remote `~/.dsh` (official dsh's home) or `~/.npm` (shared npm cache). The remote dsh's skill directory is also redirected into the session (`DSH_AGENTS_HOME`), not the machine-global `~/.agents`.

- Other users running official dsh on the same machine are not affected; `doctor`'s isolation check section reports usage.
- Full uninstall = `rm -rf ~/.dsh-remote`, one command, clean.
- Known low-risk sharing: remote pnpm store — only touched if someone actively runs `dsh plugin` on the remote; content-addressed and concurrency-safe.

**When writing remote paths in Git Bash, use double slashes** (`--cwd //home/xxx`) or set `MSYS_NO_PATHCONV=1` first. MSYS rewrites `/home/xxx` into something like `D:/SoftWare/Git/home/xxx` before the argument reaches the program, which the CLI can only detect and reject.

`doctor` checks connectivity, platform, basic commands, disk space, installed runtimes, **Node runtime stability**, and live mirror latency. It is the first tool for troubleshooting remote environment issues — most remote development failures are environmental, not code.

## Architecture

```
Local (Windows/Linux/macOS)                      Remote (Linux/macOS)
┌────────────────────────────────┐              ┌──────────────────────────────┐
│ Browser                        │              │ dsh (full npm install)        │
│ 127.0.0.1:<local-port>         │              │ webserver 127.0.0.1:<port>    │
└───────────────┬────────────────┘              │                              │
                │ HTTP / WS + session token     │  ├ session / agent           │
┌───────────────▼────────────────┐  forward     │  ├ fs / subprocess           │
│ dsh-remote CLI (long-running)  │══════════════▶│  ├ terminal / lsp            │
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
| [src/provision/probe.ts](src/provision/probe.ts) | Remote probe + **Node stability self-check** |
| [src/provision/mirror-selector.ts](src/provision/mirror-selector.ts) | Live mirror latency measurement and adaptive selection |
| [src/provision/remote-paths.ts](src/provision/remote-paths.ts) | Single source of truth for remote path rules |
| [src/provision/node-installer.ts](src/provision/node-installer.ts) | Install Node, version-isolated, self-checks after install |
| [src/provision/dsh-installer.ts](src/provision/dsh-installer.ts) | Install dsh, explicit version (no dist-tag reliance) |
| [src/provision/profile-writer.ts](src/provision/profile-writer.ts) | Per-session independent `DSH_HOME` and profile/patch generation |
| [src/provision/provisioner.ts](src/provision/provisioner.ts) | Provisioning orchestration, each step idempotent |
| [src/util/session-id.ts](src/util/session-id.ts) | Deterministic session id from host alias + remote directory |
| [src/tunnel/port-allocator.ts](src/tunnel/port-allocator.ts) | Remote port allocation and listen confirmation |
| [src/tunnel/forward-local.ts](src/tunnel/forward-local.ts) | Forward tunneling, **listener survives reconnection** |
| [src/session/remote-process.ts](src/session/remote-process.ts) | Remote dsh detach launch, token capture, safe shutdown |
| [src/session/lifecycle-state.ts](src/session/lifecycle-state.ts) | Session state machine, pure functions |
| [src/session/heartbeat.ts](src/session/heartbeat.ts) | Heartbeat: process + port + HTTP application-level, single command |
| [src/session/reconnect.ts](src/session/reconnect.ts) | Bounded exponential backoff |
| [src/session/session-registry.ts](src/session/session-registry.ts) | Local session table, lock file + atomic replacement |
| [src/session/session-manager.ts](src/session/session-manager.ts) | Session orchestration: open, credential wiring, reconnect, close |
| [src/credential/tunnel-proxy.ts](src/credential/tunnel-proxy.ts) | Reverse tunnel LLM proxy (multi-provider routing), injects real keys |
| [src/credential/provider-routes.ts](src/credential/provider-routes.ts) | Extract provider routes from local settings.yaml, produce remote mirror |
| [src/credential/token.ts](src/credential/token.ts) | Proxy token: generation and constant-time comparison |
| [src/cli/](src/cli/) | Command dispatch, argument parsing, terminal output, per-command auth wiring |

## Development

```bash
# Type check (local tsc has issues, see CLAUDE.md)
npx -y -p typescript@5.7.3 tsc --noEmit
```

Code style guide is in [docs/type_script_style.md](docs/type_script_style.md) — read it before writing any code.

## Packaging

Produces release packages (see [Installation and running](#option-2-run-a-release-package)): esbuild bundles the CLI with all runtime dependencies into a single `dsh-remote.cjs`, then the official Node binary for the target platform is added, along with launchers and docs, and everything is archived. Output lands in `dist/` (gitignored) — **this does not change how the source itself runs via tsx**.

```bash
npx tsx scripts/package.ts                        # package for the current platform
npx tsx scripts/package.ts --all                  # full five-platform matrix
npx tsx scripts/package.ts --os linux --arch arm64
```

| Option | Description |
|---|---|
| `--os <os>` | Target OS: `win32` / `linux` / `darwin` (default: current platform) |
| `--arch <arch>` | Target architecture: `x64` / `arm64` (default: current architecture) |
| `--all` | Build the full five-platform matrix; ignores `--os` / `--arch` |
| `--node-version <ver>` | Node version to bundle (default: `v24.11.1`) |
| `--mirror <mirror>` | Node download source: `npmmirror` (default) / `official` / custom URL prefix |
| `--out-dir <dir>` | Output directory (default: `dist`) |
| `--minify` | Minify the bundle (off by default, keeps readable stack traces) |

Node distributions are verified against SHASUMS256 on download and cached in `dist/.node-cache`, so repeated packaging skips the download. Each run prints the path, size, and sha256 of every artifact.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
