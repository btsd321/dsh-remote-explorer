# dsh-remote

**[English](README.md)** | [中文](README.cn.md)

Remote development launcher: install [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) on a remote host and use it from your local browser. LLM credentials never leave your machine.

Inspired by VS Code Remote-SSH, Zed, and JetBrains Gateway — **code and sessions live on the remote, the local machine only renders the UI**. Full architecture rationale, research sources, and benchmark data are in [PLAN.md](PLAN.md).

## What changed from 0.3.x

0.3.x was a Cordis plugin: dsh ran locally and used helper RPC to forward individual filesystem operations to the remote. That approach required a shim for every dsh feature that touches the filesystem, and native modules on the remote could only be replaced with no-op stubs (landlock sandbox and flock were lost).

Starting with 0.4.0, dsh-remote is a standalone CLI: a complete dsh is installed on the remote, and nothing dsh-related runs locally. ~2,000 lines of shim code were removed, and the remote gets real prebuilt native modules.

## Current status

All milestones from [PLAN.md](PLAN.md) are complete.

| Phase | Scope | Status |
|---|---|---|
| P0 | Feasibility (manual end-to-end) | ✅ Five-step pass |
| P1 | Connection: transport, host resolution, probe, mirror benchmark | ✅ `list` / `doctor` |
| P2 | Provisioning: install Node & dsh, generate session profile | ✅ `provision` |
| P3 | Session: tunneling, heartbeat reconnection, multi-host parallel | ✅ `connect` / `status` / `kill` |
| P4 | Credentials: reverse tunnel proxy | ✅ Key never leaves local (verified) |
| P5 | Polish: three-tier heartbeat, `clean` command | ✅ Done |

## Installation

No build step — source is run directly via tsx.

```bash
npm install
```

## Quick start

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
| [src/util/](src/util/) | Shell escaping, error types |
| [src/hosts/ssh-config-parser.ts](src/hosts/ssh-config-parser.ts) | **Sole** source of host config: parses ssh config, recursively resolves ProxyJump |
| [src/transport/types.ts](src/transport/types.ts) | Transport abstraction (designed for multiple transports; Docker/WSL possible later) |
| [src/transport/ssh-transport.ts](src/transport/ssh-transport.ts) | ssh2 implementation: jump host chains, command execution, SFTP, forward/reverse forwarding |
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
| [src/cli/](src/cli/) | Command dispatch and terminal output |

## Known pitfalls

These were all discovered through real testing. Don't step back into them when modifying code (see [PLAN.md](PLAN.md) chapter 11 for details):

- **Remote Node must be v24.** v22.23.2 on aarch64 has a 35% process crash rate, manifesting as V8 OOM despite sufficient memory. `npm install` spawns dozens of node processes and will inevitably fail, with errors misleadingly pointing to the last failing package. `probe.ts` therefore enforces a stability self-check.
- **Mirror benchmarking must use `-L` and verify response content.** Alibaba's mirror returns 302 for `index.json`; timing-only would treat the redirect page as success and pick the wrong "fastest" mirror.
- **Remote commands are uniformly wrapped with `sh -c`.** ssh exec uses the user's login shell; zsh aborts on unmatched globs, while bash keeps them as literals. Without locking POSIX semantics, the same script behaves differently on different users' machines.
- **To prepend a directory to PATH, use exec's `pathPrefix` option, not `env`.** `env: { PATH: '<new>:$PATH' }` — the `$PATH` is quoted into a literal, leaving the remote PATH with only one directory; even `rm` and `mkdir` become unfindable.
- **Multi-line remote scripts must be joined with `\n`, not spaces.** `head=$(...) if [ ... ]` is a syntax error; the entire script fails at parse time, manifesting as all probes returning "no output" — easily mistaken for a network issue.
- **Never stop remote processes with `pkill -f <pattern>`.** The shell carrying the command also matches the pattern and kills its own SSH session. Use pid files or listen-port-based targeting.
- **Always construct remote paths by string concatenation with `/`**, never `node:path`'s `join` — the local machine may be Windows, which produces backslashes.
- **The session table primary key is the composite `(sessionId, localPid)`.** Session id is remote identity; multiple local CLIs with the same alias and directory share one remote dsh — they are multiple local views of the same remote session. Deduplicating by sessionId alone would let later CLIs evict earlier records, causing `status` to miss active tunnels.
- **Local listeners must survive reconnection.** Reconnection only swaps the transport reference; the local port stays the same — a port change invalidates all browser tabs the user has open. This is why the transport interface provides `openChannel` (open a channel only) rather than `forwardOut` (listen + forward integrated).
- **Raw TCP socket error listeners must be attached before any `destroy`.** Use argumentless `destroy()` on failure paths — `destroy(Error)` on an unmonitored socket raises an unhandled event that crashes the process.
- **Forward channel quota is sized for browser steady-state concurrency.** A browser maintains 6+ HTTP/1.1 keep-alive connections to a single host in steady state; a limit of 5 is exhausted during normal use. The pool takes 64 (direct-tcpip has no low hard limit like sshd's `MaxSessions`).
- **Local Node v24.14.0's fetch rejects all streaming request bodies** (ReadableStream / async generators throw `expected non-null body source`; strings and Buffers work). So the LLM proxy buffers the entire request body before forwarding; the streaming-sensitive response side (SSE) is piped directly.
- **ssh2 channels cannot be fed directly to http.Server** (missing `setTimeout` and other Socket interface methods). The proxy runs a real http.Server on local loopback; channels bridge to a local TCP connection.

## Development

```bash
# Type check (local tsc has issues, see CLAUDE.md)
npx -y -p typescript@5.7.3 tsc --noEmit
```

Code style guide is in [docs/type_script_style.md](docs/type_script_style.md) — read it before writing any code.

## Verification environment

Verified on an aarch64 Linux host (Ubuntu glibc 2.35, kernel 5.10.0+), client Windows 11.

P0 benchmark: installing Node v24.11.1 + dsh 0.1.6-alpha.2 took ~75 seconds / 700M; `ssh -L` tunnel delivered the full GUI page; `ssh -R` credential round-trip worked, with no API keys in the remote environment.

One known environment limitation: the host's kernel does not enable landlock (LSM list is `capability,yama,kbox_capability`), so `node-addon-system`'s `probe()` returns `unusable`. This depends on the remote kernel configuration, not the architecture; `flock` works on the same machine.

## License

Internal use — see [PLAN.md](PLAN.md) for details.
