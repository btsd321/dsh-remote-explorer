# dsh-remote-explorer Usage Guide (English)

**[English](usage-en.md)** | [中文](usage-cn.md)

This document provides a detailed walkthrough of every `dsh-remote-explorer` command, its options, and common workflows.

> Examples use the source-run form (`pnpm exec tsx src/cli/bin.ts <command>`; the dev environment defaults to pnpm). With a release package, substitute `./dsh-remote-explorer <command>` (Windows: `dsh-remote-explorer.cmd <command>`) — commands and options are identical.

## Table of contents

- [Prerequisites](#prerequisites)
- [Authentication and host targeting](#authentication-and-host-targeting)
- [Command overview](#command-overview)
- [list — List SSH hosts](#list--list-ssh-hosts)
- [doctor — Diagnose a host](#doctor--diagnose-a-host)
- [provision — Set up the remote environment](#provision--set-up-the-remote-environment)
- [connect — Start a full session](#connect--start-a-full-session)
- [status — View active sessions](#status--view-active-sessions)
- [kill — Stop remote dsh](#kill--stop-remote-dsh)
- [clean — Remove stale remote resources](#clean--remove-stale-remote-resources)
- [help — Show usage](#help--show-usage)
- [Common workflows](#common-workflows)
- [Exit codes](#exit-codes)
- [Git Bash path caveat](#git-bash-path-caveat)
- [Using it as a dsh plugin](#using-it-as-a-dsh-plugin)

---

## Prerequisites

- **Node.js** v20.19+ or v22+ on the local machine (for running tsx).
- A reachable remote host: either a `Host` entry in `~/.ssh/config`, or an ad-hoc `user@host[:port]` target (IPv6 must go through the config). Authentication supports private keys (`IdentityFile`, overridable with `--private-key`); with no key configured and an interactive terminal, you will be prompted for a password (no echo; kept in memory only, never written to disk). You can also pass `--password <password>` — **this leaks**: the plaintext is visible in the process list and shell history. The CLI prints a warning; treat it as a stopgap.
- The remote host must be **Linux or macOS** (POSIX). The local client supports Windows, Linux, and macOS.
- **API keys** for whichever LLM providers you use (e.g. `DEEPSEEK_API_KEY`), set as environment variables in the shell where you run `dsh-remote-explorer connect`.

## Authentication and host targeting

Every command that connects to a remote (`doctor` / `provision` / `connect` / `kill` / `clean`) shares the same authentication rules.

### Host argument

The `<alias>` argument accepts two forms:

- **ssh config alias**: a `Host` entry in `~/.ssh/config` (`Host *` defaults are merged, `ProxyJump` chains resolved recursively). A matching config entry always wins.
- **Ad-hoc syntax** `user@host[:port]`: connect without touching the config. Port defaults to 22. IPv6 literals are not supported inline (colons conflict with the port suffix) — put them in the config. Ad-hoc hosts have no jump host.

### Auth methods and precedence

```
--private-key  >  --password  >  config IdentityFile  >  interactive password prompt
```

- **`--private-key <path>`**: path to a private key, takes precedence over the config's `IdentityFile`. `~/` prefix supported.
- **`--password <password>`**: plaintext password, forces password auth (wins over a configured key). **This leaks** — the password shows up in the command line, process list, and shell history; the CLI prints a warning. No retry after rejection. Treat it as a stopgap; prefer a key or interactive input.
- **Both given**: `--private-key` wins and `--password` is ignored (with a notice).
- **Interactive password prompt**: when the host (or a jump host) has no `IdentityFile` and the terminal is interactive, you are prompted during connection — **no echo**, re-prompted on rejection (up to 3 attempts). The password lives only in local process memory — never written to disk or logs. In a non-interactive terminal (pipes/CI), no prompt appears; the command fails with a missing-`IdentityFile` error instead of hanging.

### Jump hosts

`--private-key` / `--password` apply to the **target host only**; jump hosts authenticate from the config (or an interactive prompt per hop if they have no key).

### Passwords across reconnection

Automatic reconnection is unattended: it **never prompts** and silently reuses the password from the initial connect. If the password changes on the remote, reconnection terminates immediately with a clear message telling you to `connect` again — it does not retry forever or hang waiting for input.

## Command overview

```
dsh-remote-explorer <command> [options]
```

| Command | Description |
|---|---|
| `connect <alias>` | Main command: provision → start remote dsh → build tunnel → open browser (long-running) |
| `status` | List all sessions maintained on this machine |
| `kill <alias>` | Stop remote dsh process |
| `clean <alias>` | Clean up stale remote resources (old versions, dead session dirs) |
| `list` | List hosts from ~/.ssh/config |
| `doctor <alias>` | Diagnose a host's provisioning conditions |
| `provision <alias>` | Provision only, don't start services (idempotent) |
| `help` | Show help |

Since the project has no build step, run commands via tsx:

```bash
pnpm exec tsx src/cli/bin.ts <command> [options]
```

---

## list — List SSH hosts

Lists all `Host` entries from `~/.ssh/config`. Pure local operation — does not connect to any host.

```bash
pnpm exec tsx src/cli/bin.ts list
```

**Options:**

| Option | Description |
|---|---|
| `--ssh-config <path>` | Use a custom ssh config file instead of `~/.ssh/config` |

**Output:** A table showing alias, address, user, port, and proxy jump for each host.

---

## doctor — Diagnose a host

Runs a comprehensive diagnostic of a host's provisioning conditions. This is the **first tool for troubleshooting** — most remote development failures are environmental, not code-related.

```bash
pnpm exec tsx src/cli/bin.ts doctor <alias>
```

**Options:**

| Option | Description |
|---|---|
| `--refresh-mirrors` | Force re-benchmark mirror latency, ignore cached results |
| `--ssh-config <path>` | Use a custom ssh config file |
| `--private-key <path>` | Private key path, wins over the config's IdentityFile (see [Authentication](#authentication-and-host-targeting)) |
| `--password <password>` | Plaintext password auth (leaks; see [Authentication](#authentication-and-host-targeting)) |

**What it checks:**

1. **SSH config** — verifies the alias resolves and shows the connection target and jump host chain.
2. **Connection & platform** — establishes an SSH connection and reports OS/architecture.
3. **Basic commands** — checks for `curl`/`wget`, `tar`, `xz`.
4. **Disk space** — verifies at least ~1.5 GB free in the home directory (provisioning needs ~0.7 GB).
5. **Installed runtimes** — lists any Node and dsh versions already installed by this tool.
6. **Node stability** — for each installed Node version, runs a stability self-check (starts the process multiple times; any failure on aarch64 is a known v22 issue).
7. **Mirror latency** — benchmarks Node distribution and npm registry mirrors from the remote host (not locally — what matters is the remote's connectivity).
8. **SSH channel usage** — reports current channel pool usage.
9. **Isolation check** — reports this tool's disk footprint on the remote and confirms `~/.dsh` (official dsh home) is not written to.

**Exit code:** `0` if all checks pass or only warnings; `1` if any check fails.

---

## provision — Set up the remote environment

Installs Node and dsh on the remote host to the point where `dsh --version` reports the correct version. Does not start services or build tunnels. **Idempotent** — re-running with the same versions reuses existing installs.

```bash
pnpm exec tsx src/cli/bin.ts provision <alias> --cwd //home/user
```

**Options:**

| Option | Description |
|---|---|
| `--cwd <path>` | Remote working directory (participates in session id computation) |
| `--node-version <ver>` | Target Node version (default: v24 series) |
| `--dsh-version <ver>` | Target dsh version or dist-tag |
| `--refresh-mirrors` | Force re-benchmark mirror latency |
| `--ssh-config <path>` | Use a custom ssh config file |
| `--private-key <path>` | Private key path, wins over the config's IdentityFile (see [Authentication](#authentication-and-host-targeting)) |
| `--password <password>` | Plaintext password auth (leaks; see [Authentication](#authentication-and-host-targeting)) |

**Why provision separately:** Provisioning is the slowest and most failure-prone step (~75 seconds for a fresh install). Separating it allows independent retry and diagnosis.

**Version isolation:** Each Node and dsh version is installed in its own directory (e.g. `~/.dsh-remote-explorer/btsd321/node/v24.21.0/`, `~/.dsh-remote-explorer/btsd321/versions/dsh-0.1.6-alpha.2/`). Upgrading never overwrites in place — this avoids "Text file busy" errors when a running process holds files open.

**Output:** A table showing the remote base directory, Node version, dsh version, dsh entry path, and session `DSH_HOME`.

---

## connect — Start a full session

The main command. Orchestrates the entire flow: provision → start remote dsh → build forward tunnel → open browser → maintain session (long-running).

```bash
DEEPSEEK_API_KEY=sk-xxx pnpm exec tsx src/cli/bin.ts connect <alias> --cwd //home/user
```

**Options:**

| Option | Description |
|---|---|
| `--cwd <path>` | Remote working directory (participates in session id computation) |
| `--local-port <port>` | Local listening port (default: OS-assigned) |
| `--no-open` | Do not auto-open the browser |
| `--force-restart` | Restart remote dsh even if an existing session is available |
| `--keep-remote` | On Ctrl-C, keep remote dsh running for reuse (default: stop it) |
| `--node-version <ver>` | Target Node version (default: v24 series) |
| `--dsh-version <ver>` | Target dsh version or dist-tag |
| `--refresh-mirrors` | Force re-benchmark mirror latency |
| `--ssh-config <path>` | Use a custom ssh config file |
| `--private-key <path>` | Private key path, wins over the config's IdentityFile (see [Authentication](#authentication-and-host-targeting)) |
| `--password <password>` | Plaintext password auth (leaks; see [Authentication](#authentication-and-host-targeting)) |

**What happens during connect:**

1. **Provision** — installs Node and dsh on the remote (skipped if already installed), installs pnpm, and ensures the user-level plugin store skeleton.
2. **Attach plugin store** — symlinks the session profile's node_modules to the user-level plugin store and syncs its manifest (hot-applied via hmr).
3. **Start remote dsh** — launches dsh in detached mode with per-session `DSH_HOME` and environment variables.
3. **Build forward tunnel** — forwards the remote dsh webserver port to a local port so the browser can reach it.
4. **Credential wiring** — starts the reverse tunnel proxy, injects placeholder tokens into the remote environment, mirrors local `settings.yaml` with provider baseURLs redirected into the tunnel.
5. **Open browser** — launches the default browser with the session URL (includes access token).
6. **Stay running** — the process blocks, maintaining the tunnel and proxy. Heartbeat checks run every 5 seconds.

**Environment variables:**

- `DEEPSEEK_API_KEY` and other LLM keys: export them in the shell that launches `connect` (export the ones for the providers you use; the list comes from `~/.dsh/settings.yaml`).
- `DSH_REMOTE_PROXY`: proxy fallback for hosts without direct internet. Installing a GitHub plugin in remote dsh goes over HTTPS (`git ls-remote https://github.com/...`) — **SSH (port 22) working does not mean HTTPS (port 443) works**. When set, the launcher injects `http_proxy`/`https_proxy`/`ALL_PROXY` (both letter cases, six keys) into the remote dsh process, pointing at the proxy port your SSH reverse tunnel exposes on the remote loopback (e.g. `http://127.0.0.1:18890`); dsh passes these through to the `git`/`pnpm` child processes it spawns. Unset injects nothing — machines with direct internet are unaffected.
- Injection happens **when the remote process starts**: reusing an already-running session does not re-inject; use `--force-restart`. In plugin form, per-host gear-button config takes precedence over this variable (see [Using as a dsh plugin](#using-as-a-dsh-plugin)).

**Session reuse:** If you run `connect` again with the same alias and `--cwd`, it detects the existing remote dsh process and reuses it. The new CLI gets its own local tunnel port. Multiple CLIs can share one remote session.

**Ctrl-C behavior:**

- Default: stops both the local process and the remote dsh (clean disconnect).
- `--keep-remote`: stops only the local process; remote dsh keeps running for next `connect`.
- If the session enters a terminal failure state (e.g. reconnection exhausted), the remote process is preserved.

**Output:** A table with the access URL, local/remote ports, remote pid, Node/dsh versions, session id, and credential proxy status (route count, any missing keys).

---

## status — View active sessions

Lists all remote sessions currently maintained by this machine. Pure local operation — reads the session registry without connecting to any host.

```bash
pnpm exec tsx src/cli/bin.ts status
```

Stale entries (sessions whose maintaining CLI has exited) are automatically pruned.

**Output:** A table showing host alias, remote directory, local access URL, remote port, remote pid, and start time.

**Note:** The access URL requires a token. Use the full URL (including `?token=...`) printed by `connect`; `status` only shows the base URL without the token.

---

## kill — Stop remote dsh

Stops the remote dsh process. Useful when the remote process is in a bad state (config change not taking effect, port conflict, process hung).

```bash
# Stop a specific session
pnpm exec tsx src/cli/bin.ts kill <alias> --cwd //home/user

# Stop all sessions on a host (including orphan processes)
pnpm exec tsx src/cli/bin.ts kill <alias> --all
```

**Options:**

| Option | Description |
|---|---|
| `--cwd <path>` | Specify which session to stop (mutually exclusive with `--all`) |
| `--all` | Stop all sessions **started from this machine** on this host (including orphans) |
| `--include-others` | With `--all`, also stop sessions owned by other fingerprints (default: skip and list them) |
| `--ssh-config <path>` | Use a custom ssh config file |
| `--private-key <path>` | Private key path, wins over the config's IdentityFile (see [Authentication](#authentication-and-host-targeting)) |
| `--password <password>` | Plaintext password auth (leaks; see [Authentication](#authentication-and-host-targeting)) |

**Safety:** Process targeting uses pid files or listen-port-based lookup — **never `pkill -f`**, which would kill the SSH session running the command itself.

**Multi-user scope:** Every session directory carries an owner fingerprint (local hostname + OS user) written at session start. `--all` stops only sessions **whose fingerprint matches this machine** plus process-less leftovers; live sessions with someone else's fingerprint are skipped and listed. `--include-others` restores the old full-scope behavior. This prevents killing another person's session when several people connect through the same remote account.

Install directories and session profiles are preserved after kill. Use `connect` to restart.

---

## clean — Remove stale remote resources

Removes stale session directories, old Node versions, and old dsh versions from the remote host. This is the necessary companion to the version-named, per-session-directory strategy — both accumulate over time.

```bash
# Clean with defaults (keep 1 version per category)
pnpm exec tsx src/cli/bin.ts clean <alias>

# Keep 2 versions per category
pnpm exec tsx src/cli/bin.ts clean <alias> --keep 2
```

**Options:**

| Option | Description |
|---|---|
| `--keep <N>` | Number of latest versions to keep per category (default: 1) |
| `--include-others` | Also delete stale session directories owned by other fingerprints (default: skip and list them) |
| `--ssh-config <path>` | Use a custom ssh config file |
| `--private-key <path>` | Private key path, wins over the config's IdentityFile (see [Authentication](#authentication-and-host-targeting)) |
| `--password <password>` | Plaintext password auth (leaks; see [Authentication](#authentication-and-host-targeting)) |

**Protection mechanism:** Active sessions' runner scripts (`.runtime/start.sh`) record which dsh and Node paths they use. Before deletion, the tool collects all active session references; versions referenced by running sessions are protected even if they are older than the keep threshold.

**What it cleans:**

- **Stale session directories** — sessions whose pid file points to a dead process; directories owned by other fingerprints are skipped by default (`--include-others` includes them).
- **Old dsh versions** — keeps the N newest, deletes the rest (protected versions excluded).
- **Old Node versions** — same rule.

The user-level plugin store (`plugins/`) is shared data and is **never touched by clean**.

**Output:** Reports freed space, deleted sessions/versions, and any protected versions.

---

## help — Show usage

```bash
pnpm exec tsx src/cli/bin.ts help
# or
pnpm exec tsx src/cli/bin.ts --help
# or
pnpm exec tsx src/cli/bin.ts -h
```

Also shows version:

```bash
pnpm exec tsx src/cli/bin.ts --version
# or
pnpm exec tsx src/cli/bin.ts -V
```

---

## Common workflows

### First-time setup

```bash
# 1. Install dependencies (dev environment defaults to pnpm)
pnpm install

# 2. List available hosts
pnpm exec tsx src/cli/bin.ts list

# 3. Diagnose the target host
pnpm exec tsx src/cli/bin.ts doctor my-server

# 4. Provision (optional — connect does this automatically)
pnpm exec tsx src/cli/bin.ts provision my-server --cwd //home/user

# 5. Connect
DEEPSEEK_API_KEY=sk-xxx pnpm exec tsx src/cli/bin.ts connect my-server --cwd //home/user
```

### Password login (host with no key configured)

```bash
# Ad-hoc syntax + interactive password (no echo; re-prompts on rejection, up to 3 attempts)
pnpm exec tsx src/cli/bin.ts doctor user@192.168.0.10

# Same for connect; the password stays in local process memory and is
# silently reused across reconnections
DEEPSEEK_API_KEY=sk-xxx pnpm exec tsx src/cli/bin.ts connect user@192.168.0.10 --cwd //home/user

# For throwaway scripts you can pass it in the clear (leaks; CLI warns)
DEEPSEEK_API_KEY=sk-xxx pnpm exec tsx src/cli/bin.ts connect user@192.168.0.10 --cwd //home/user --password 'xxx'

# Explicit key path (wins over the config's IdentityFile)
pnpm exec tsx src/cli/bin.ts connect my-server --cwd //home/user --private-key ~/.ssh/id_ed25519
```

### Installing plugins on an offline host via proxy

Installing a plugin in remote dsh (e.g. `github:btsd321/...`) goes over HTTPS; on a host without direct internet the bare connection times out and dsh reports "GitHub connection timeout". Once your local proxy is borrowed to the remote loopback via an SSH reverse tunnel, have the launcher inject the proxy variables:

```bash
# Assuming the reverse tunnel exposes the local proxy at remote 127.0.0.1:18890
DSH_REMOTE_PROXY=http://127.0.0.1:18890 DEEPSEEK_API_KEY=sk-xxx \
  pnpm exec tsx src/cli/bin.ts connect my-server --cwd //home/user
```

To verify: take the remote pid from the connect output and run `cat /proc/<pid>/environ | tr '\0' '\n' | grep -i proxy` on the remote (the proxy variables should be listed); `https_proxy=http://127.0.0.1:18890 git ls-remote https://github.com/<repo> HEAD` should return a commit hash (this is exactly the probe dsh runs before installing). In plugin form, use the per-host ⚙ gear button in the panel instead (one-click proxy preset, effective on the next connect).

### Reconnect to an existing session

```bash
# If you disconnected with --keep-remote (or the session survived a crash)
DEEPSEEK_API_KEY=sk-xxx pnpm exec tsx src/cli/bin.ts connect my-server --cwd //home/user
```

The tool detects the running remote dsh and reuses it. You get a fresh local tunnel port.

### Full cleanup

```bash
# Stop the remote dsh
pnpm exec tsx src/cli/bin.ts kill my-server --all

# Clean stale versions and dead sessions
pnpm exec tsx src/cli/bin.ts clean my-server

# Full remote uninstall (run on the remote host itself)
rm -rf ~/.dsh-remote-explorer/btsd321
```

### Force restart a stuck session

```bash
DEEPSEEK_API_KEY=sk-xxx pnpm exec tsx src/cli/bin.ts connect my-server --cwd //home/user --force-restart
```

### Run without auto-opening a browser

```bash
DEEPSEEK_API_KEY=sk-xxx pnpm exec tsx src/cli/bin.ts connect my-server --cwd //home/user --no-open
```

The access URL (with token) is printed in the terminal; open it manually.

---

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Unexpected error (internal bug) |
| 2 | Host not found or config invalid |
| 3 | Connection failed |
| 4 | Remote command execution failed |
| 5 | Platform unsupported |
| 6 | Node runtime unstable |
| 7 | All mirrors unreachable |
| 8 | Required remote tool missing |
| 64 | Invalid arguments |
| 130 | Aborted (Ctrl-C) |

---

## Git Bash path caveat

When using Git Bash (MSYS) on Windows, writing remote paths like `--cwd /home/user` will be rewritten by MSYS to something like `D:/SoftWare/Git/home/user` **before** the argument reaches the program. The CLI detects and rejects Windows-style paths, but to avoid the issue:

- Use **double slashes**: `--cwd //home/user`
- Or set the environment variable: `MSYS_NO_PATHCONV=1`

The CLI normalizes `//home/user` to `/home/user` internally, so session ids are consistent regardless of which form you use.

(The plugin form is unaffected: panel and chat-box input never passes through a shell — write `/home/user` directly.)

---

## Using it as a dsh plugin

Since 0.6.0 this tool is also a valid dsh plugin package: installed into a local dsh profile, remote-session management appears in three surfaces — a global panel in the left navigation, a slash command, and agent tools. **The plugin shares the CLI's session orchestration, remote provisioning, and session table** — it is not a lite version, just the same engine in a different cockpit.

### Installation

Prerequisites: a local dsh (`@deepseek-ai/dsh` ≥ 0.1.5-rc.2) and **pnpm on PATH** (the `dsh plugin` command forwards to pnpm verbatim; exit 127 when missing).

```bash
# From npm (installs into the web profile and auto-activates)
dsh plugin --profile web add dsh-remote-explorer

# When dsh is not on PATH
npx --yes @deepseek-ai/dsh plugin --profile web add dsh-remote-explorer

# From a local checkout (development): build the plugin artifacts first
pnpm run build:plugin
dsh plugin --profile web add /path/to/repo

# Development sandbox (isolated DSH_HOME, never touches ~/.dsh; includes boot smoke)
pnpm exec tsx scripts/dev-plugin.ts          # resident, Ctrl-C to stop
pnpm exec tsx scripts/dev-plugin.ts --smoke  # probes then kills (CI)
pnpm exec tsx scripts/dev-plugin.ts --sync   # sync artifacts into the sandbox only
```

Restart `dsh web` after installing (dsh contract: package replacement requires a process restart to load new code). Uninstall: `dsh plugin --profile web remove dsh-remote-explorer`.

> **pnpm 11.7+ build-script approval gate:** pnpm 11.7 treats *undecided* dependency build scripts as a hard failure, and this package's dependency tree carries three (`cpu-features`, `esbuild` via tsx, `ssh2`) — the first `dsh plugin add` fails with `ERR_PNPM_IGNORED_BUILDS` regardless of the install source. None are needed at plugin runtime (artifacts pre-built; ssh2 falls back to pure JS). **Prefer installing through the dsh web GUI's plugin manager page** (built-in approve-and-retry); the CLI workaround is in [Troubleshooting](#troubleshooting).

### The three surfaces

**Left navigation "Remote SSH Sessions"** (global panel, level with the "Plugins" button; moved out of Settings in 0.6.x — Settings holds preferences, workflow panels get their own surface):

- Connect form: host (dropdown from `~/.ssh/config`, or type `user@host[:port]`), remote directory (remembers the last value per host), advanced options (local port / force restart / mirror re-test / Node and dsh versions / private key path), SSH password field, and the **⚙ environment-variables button** (per-host custom variables: key-value row editor plus a proxy preset; stored host-side in `~/.dsh/remote-host-env.json`, never in ssh config; injected into the remote dsh process on connect — `DSH_HOME`/`DSH_AGENTS_HOME`/`PATH` are reserved and rejected). Session rows carry the same gear button (except "external" sessions). **Window-mode buttons branch by environment**:
  - **Desktop (DeepSeek Harness)**: a single "Connect in new window" button — once the session is ready it opens a **full-window floating desktop** (the desktop shell is a single OS window; every http/https popup and cross-origin navigation is redirected to the system browser, so the only in-app carrier is a webview; the opaque overlay fills the window — opening it hides the main desktop and its title-bar buttons, collapsing restores it, and minimize/fullscreen move the whole window). **No self-made top bar**: the remote dsh web UI fills the window; being web-form it renders no desktop title bar ("App/Edit" menus are an Electron desktop-shell feature the remote web page does not have), so back/close/stop all go through the remote sidebar's status pill (see [Remote window handoff](#remote-window-handoff)); Esc also collapses while the webview has not taken focus. After an app reload the overlay is not restored — reopen it from the panel
  - **Browser**: the dual entry points (VS Code-style) — "Connect in current tab" = after the session is ready, a 3-second cancellable countdown navigates this tab into the remote window; "Connect in new tab" = this page stays as the manager and the session row opens the remote in a new tab
- Session table: state dot, local port, the row entry (desktop: "Open in new window" = the full-window floating desktop; browser: "Enter (current tab)" and "Open in new tab ↗", the new tab serving the **remote dsh UI through the tunnel**), a "Disconnect" button (with "Also stop remote dsh" checked by default); sessions kept by other local processes are marked "external" and read-only
- Remote plugins section: with a session selected, manage the user-level plugin store of its remote profile (list / install / enable / disable / uninstall, see [Remote plugin management](#remote-plugin-management))
- Progress log: incremental live tail of the selected session (provisioning stages, state transitions, errors)

**Slash command** (chat composer):

```
/remote-explorer hosts                             list ssh config hosts
/remote-explorer connect <alias> [remote-dir]      start connecting in the background (returns immediately)
/remote-explorer status                            session list and states
/remote-explorer disconnect <alias|session-id> [--keep-remote]
```

**Agent tools** (callable by the model, behind dsh's regular tool-approval gate): `remote_hosts_list`, `remote_connect`, `remote_status`, `remote_kill`. All non-blocking: connect returns the session id immediately and the model polls status for progress. **Tools never accept a password parameter** — hosts needing password auth go through the panel or the CLI.

### Remote window handoff

The remote window (the full-window floating desktop on Desktop, or the remote dsh UI opened via "Open in new tab" / the countdown in the browser) carries a **status pill** at the sidebar foot (host alias + state dot). Clicking it opens the local connection-manager menu: connection state, progress-log tail, and three actions — **Back to local manager** / **Close remote connection and return** / **Stop remote dsh and return**. The latter two are navigate-then-act: the tab first navigates back to the local manager (intent hash in the address bar), where a banner asks for confirmation before executing — disconnecting would instantly kill the remote page served through the tunnel, so the action must run from the surviving side (the counterpart of VS Code's "Close Remote Connection" reloading the window back to local). In CLI form there is no manager page, so the remote menu degrades to read-only. **The Desktop form (full-window floating desktop) passes a fake intent origin instead of a real manager URL**: the webview policy refuses navigation back to the app origin, so a real address would be a dead link; with the fake origin, "Back to local manager"'s `window.open` is denied by the desktop shell and forwarded to the overlay (= collapse the overlay back to the main window), and "Close/Stop and return"'s `location.href` is intercepted by the overlay watching the webview's `will-navigate` (= run disconnect/stop, then collapse) — the handoff component needs no changes, its menu is no longer read-only, and the overlay needs no self-made top bar.

### Remote plugin management

The remote plugin store is **user-level** (one per remote OS account: `~/.dsh-remote-explorer/btsd321/plugins/`, the counterpart of VS Code's `~/.vscode-server/extensions/`); every session profile of that account attaches via symlink with zero copies. Two surfaces operate on the same store:

- **Local manager page**: the panel's "Remote plugins" section — list / install (package name or `name@version`, handed to remote pnpm) / enable / disable / uninstall. Changes hot-apply to **your own live session via hmr** immediately; other users' live sessions pick them up at their next connect
- **Inside the remote window**: the remote dsh's own Settings plugin UI (provisioning installs pnpm on the remote)

Install/uninstall fall back to "effective after reconnect/restart" on remote dsh versions without hmr. Concurrent installs are serialized by pnpm's own directory lock plus a flock around provisioning critical sections. Each session profile carries an `.npmrc` pinning `virtual-store-dir` to the store's `.pnpm` — without it, pnpm run in the profile directory (the remote window's native UI does) rejects the symlinked node_modules with `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE`.

### Multi-user and session ownership

Follows the VS Code model: **different remote OS accounts = fully isolated** (separate remote roots, sessions, and plugin stores); **same remote account = shared session root and plugin store** — same (host, remote directory) means the same session with multiple views: sessions see each other and the credential proxy belongs to the first view. Sharing is expected behavior (VS Code shares one server per account likewise); use separate remote accounts per person for full isolation. Destructive operations (`kill --all` / `clean`) are scoped by owner fingerprint, see their sections; the fingerprint can be overridden with the `DSH_OWNER_TAG` environment variable (test hook).

### Configuration (profile patch layer)

Override by entry id in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-remote-explorer
  config:
    host: myhost              # default host alias
    cwd: /home/youruser       # default remote directory
    keepRemoteOnDispose: false # keep the remote dsh when the host exits
    localPort: 0              # local port (0 = auto-assign)
    nodeVersion: ""           # empty = provisioner default
    dshVersion: ""            # empty = provisioner default
    forceRestart: false
    refreshMirrors: false
    panel: true               # false = skip panel routes, keep command and tools
```

**There is no password field** — Config lands on disk with the patch layer; a password there would be plaintext on disk.

### Lifecycle and credentials (differences from the CLI)

| | CLI | Plugin |
|---|---|---|
| Session rides which process | the resident `connect` CLI process | the host dsh process |
| On process exit | Ctrl-C stops the remote by default (`--keep-remote` keeps it) | dispose stops the remote by default (`keepRemoteOnDispose: true` keeps it) |
| On SIGKILL | remote survives detached; the `kill` command cleans up | same |
| LLM key source | environment of the shell launching the CLI | environment of the process launching dsh |
| Settings mirror source | `~/.dsh/settings.yaml` | `$DSH_HOME/settings.yaml` (whatever the host actually uses) |

The session table (`~/.dsh/remote-sessions.json`) is shared both ways: the panel shows CLI-kept sessions ("external", read-only) and `status` shows plugin-kept ones.

### Troubleshooting

- **Global panel missing after install**: make sure dsh was restarted and look for the "Remote SSH Sessions" button in the left navigation; `curl http://127.0.0.1:<port>/api/dsh-remote-explorer/ping` **with the session cookie** should return **200** — that is the actual proof the route is registered. A credential-less 401 only proves the `/api` auth gate is up (it 401s unknown routes too, so it is not evidence of mounting); still 404 with the cookie = plugin not active (check `dsh.profile.bundles` in the profile's `package.json`)
- **`add` fails with ERR_PNPM_IGNORED_BUILDS (pnpm 11.7+)**: three build scripts await a decision (`cpu-features`/`esbuild`/`ssh2`), none needed at plugin runtime. Fix: ① edit `~/.dsh/profiles/web/pnpm-workspace.yaml` and set the three pending `allowBuilds` entries to `false`; ② remove the half-committed `dsh-remote-explorer` entry from `dependencies` in `~/.dsh/profiles/web/package.json` (the failed add leaves it there, and a plain retry exits 0 without activating the plugin — a dsh CLI quirk present in 0.1.7-rc.1/rc.2); ③ re-run the add. Or simply install through the dsh web GUI's plugin manager page (built-in approve-and-retry)
- **pnpm not found (exit 127)**: `npm i -g pnpm` (only needed for local `dsh plugin add/remove`; the remote store uses the pnpm provisioning installs on the remote)
- **Peer dependency warnings**: expected under `autoInstallPeers: false`; at runtime peers resolve through the profile's installation fallback links to the host's copies — harmless
- **Connect stuck in provisioning**: watch the panel log; a first provisioning downloads Node and dsh (minutes) — run `doctor` to pre-check the host
- **No status pill in the remote window**: make sure the session connected on 0.6.x or later (older sessions get the component backfilled at reconnect; a reused live remote process shows it only after its next restart); with the session cookie, the remote `/api/dsh-remote-handoff/meta` should return 200, 503 = session runtime materials missing
- **Remote plugin install fails**: read the pnpm error in the panel log; the registry comes from the provisioning benchmark cache; concurrent provisioning/install on the same remote account makes the later one wait on the flock, timing out after 15 minutes with "another bootstrap is in progress"
- **Installing a GitHub plugin reports "GitHub connection timeout"**: dsh probes `github:` specs over HTTPS (`git ls-remote`) — SSH (port 22) working does not mean HTTPS (port 443) works. Give the launcher a proxy: in CLI, set `DSH_REMOTE_PROXY` (see [Common workflows](#common-workflows)); in the plugin panel, use the ⚙ gear button next to the host input or on a session row (the proxy preset fills it in one click). The config takes effect on the **next connect** — a running session must be disconnected (with "Also stop remote dsh" checked) and reconnected before the variables are injected
