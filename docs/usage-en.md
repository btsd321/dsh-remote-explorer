# dsh-remote Usage Guide (English)

**[English](usage-en.md)** | [中文](usage-cn.md)

This document provides a detailed walkthrough of every `dsh-remote` command, its options, and common workflows.

## Table of contents

- [Prerequisites](#prerequisites)
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

---

## Prerequisites

- **Node.js** v20.19+ or v22+ on the local machine (for running tsx).
- A reachable remote host: either a `Host` entry in `~/.ssh/config`, or an ad-hoc `user@host[:port]` target (IPv6 must go through the config). Authentication supports private keys (`IdentityFile`, overridable with `--private-key`); with no key configured and an interactive terminal, you will be prompted for a password (no echo; kept in memory only, never written to disk). You can also pass `--password <password>` — **this leaks**: the plaintext is visible in the process list and shell history. The CLI prints a warning; treat it as a stopgap.
- The remote host must be **Linux or macOS** (POSIX). The local client supports Windows, Linux, and macOS.
- **API keys** for whichever LLM providers you use (e.g. `DEEPSEEK_API_KEY`, `ASTUDIO_API_KEY`), set as environment variables in the shell where you run `dsh-remote connect`.

## Command overview

```
dsh-remote <command> [options]
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
npx tsx src/cli/bin.ts <command> [options]
```

---

## list — List SSH hosts

Lists all `Host` entries from `~/.ssh/config`. Pure local operation — does not connect to any host.

```bash
npx tsx src/cli/bin.ts list
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
npx tsx src/cli/bin.ts doctor <alias>
```

**Options:**

| Option | Description |
|---|---|
| `--refresh-mirrors` | Force re-benchmark mirror latency, ignore cached results |
| `--ssh-config <path>` | Use a custom ssh config file |

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
npx tsx src/cli/bin.ts provision <alias> --cwd //home/user
```

**Options:**

| Option | Description |
|---|---|
| `--cwd <path>` | Remote working directory (participates in session id computation) |
| `--node-version <ver>` | Target Node version (default: v24 series) |
| `--dsh-version <ver>` | Target dsh version or dist-tag |
| `--refresh-mirrors` | Force re-benchmark mirror latency |
| `--ssh-config <path>` | Use a custom ssh config file |

**Why provision separately:** Provisioning is the slowest and most failure-prone step (~75 seconds for a fresh install). Separating it allows independent retry and diagnosis.

**Version isolation:** Each Node and dsh version is installed in its own directory (e.g. `~/.dsh-remote/node/v24.11.1/`, `~/.dsh-remote/versions/dsh-0.1.6-alpha.2/`). Upgrading never overwrites in place — this avoids "Text file busy" errors when a running process holds files open.

**Output:** A table showing the remote base directory, Node version, dsh version, dsh entry path, and session `DSH_HOME`.

---

## connect — Start a full session

The main command. Orchestrates the entire flow: provision → start remote dsh → build forward tunnel → open browser → maintain session (long-running).

```bash
DEEPSEEK_API_KEY=sk-xxx ASTUDIO_API_KEY=sk-xxx \
  npx tsx src/cli/bin.ts connect <alias> --cwd //home/user
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

**What happens during connect:**

1. **Provision** — installs Node and dsh on the remote (skipped if already installed).
2. **Start remote dsh** — launches dsh in detached mode with per-session `DSH_HOME` and environment variables.
3. **Build forward tunnel** — forwards the remote dsh webserver port to a local port so the browser can reach it.
4. **Credential wiring** — starts the reverse tunnel proxy, injects placeholder tokens into the remote environment, mirrors local `settings.yaml` with provider baseURLs redirected into the tunnel.
5. **Open browser** — launches the default browser with the session URL (includes access token).
6. **Stay running** — the process blocks, maintaining the tunnel and proxy. Heartbeat checks run every 5 seconds.

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
npx tsx src/cli/bin.ts status
```

Stale entries (sessions whose maintaining CLI has exited) are automatically pruned.

**Output:** A table showing host alias, remote directory, local access URL, remote port, remote pid, and start time.

**Note:** The access URL requires a token. Use the full URL (including `?token=...`) printed by `connect`; `status` only shows the base URL without the token.

---

## kill — Stop remote dsh

Stops the remote dsh process. Useful when the remote process is in a bad state (config change not taking effect, port conflict, process hung).

```bash
# Stop a specific session
npx tsx src/cli/bin.ts kill <alias> --cwd //home/user

# Stop all sessions on a host (including orphan processes)
npx tsx src/cli/bin.ts kill <alias> --all
```

**Options:**

| Option | Description |
|---|---|
| `--cwd <path>` | Specify which session to stop (mutually exclusive with `--all`) |
| `--all` | Stop all sessions on this host (including orphans) |
| `--ssh-config <path>` | Use a custom ssh config file |

**Safety:** Process targeting uses pid files or listen-port-based lookup — **never `pkill -f`**, which would kill the SSH session running the command itself.

Install directories and session profiles are preserved after kill. Use `connect` to restart.

---

## clean — Remove stale remote resources

Removes stale session directories, old Node versions, and old dsh versions from the remote host. This is the necessary companion to the version-named, per-session-directory strategy — both accumulate over time.

```bash
# Clean with defaults (keep 1 version per category)
npx tsx src/cli/bin.ts clean <alias>

# Keep 2 versions per category
npx tsx src/cli/bin.ts clean <alias> --keep 2
```

**Options:**

| Option | Description |
|---|---|
| `--keep <N>` | Number of latest versions to keep per category (default: 1) |
| `--ssh-config <path>` | Use a custom ssh config file |

**Protection mechanism:** Active sessions' runner scripts (`.runtime/start.sh`) record which dsh and Node paths they use. Before deletion, the tool collects all active session references; versions referenced by running sessions are protected even if they are older than the keep threshold.

**What it cleans:**

- **Stale session directories** — sessions whose pid file points to a dead process.
- **Old dsh versions** — keeps the N newest, deletes the rest (protected versions excluded).
- **Old Node versions** — same rule.

**Output:** Reports freed space, deleted sessions/versions, and any protected versions.

---

## help — Show usage

```bash
npx tsx src/cli/bin.ts help
# or
npx tsx src/cli/bin.ts --help
# or
npx tsx src/cli/bin.ts -h
```

Also shows version:

```bash
npx tsx src/cli/bin.ts --version
# or
npx tsx src/cli/bin.ts -V
```

---

## Common workflows

### First-time setup

```bash
# 1. Install dependencies
npm install

# 2. List available hosts
npx tsx src/cli/bin.ts list

# 3. Diagnose the target host
npx tsx src/cli/bin.ts doctor my-server

# 4. Provision (optional — connect does this automatically)
npx tsx src/cli/bin.ts provision my-server --cwd //home/user

# 5. Connect
DEEPSEEK_API_KEY=sk-xxx npx tsx src/cli/bin.ts connect my-server --cwd //home/user
```

### Reconnect to an existing session

```bash
# If you disconnected with --keep-remote (or the session survived a crash)
DEEPSEEK_API_KEY=sk-xxx npx tsx src/cli/bin.ts connect my-server --cwd //home/user
```

The tool detects the running remote dsh and reuses it. You get a fresh local tunnel port.

### Full cleanup

```bash
# Stop the remote dsh
npx tsx src/cli/bin.ts kill my-server --all

# Clean stale versions and dead sessions
npx tsx src/cli/bin.ts clean my-server

# Full remote uninstall (run on the remote host itself)
rm -rf ~/.dsh-remote
```

### Force restart a stuck session

```bash
DEEPSEEK_API_KEY=sk-xxx npx tsx src/cli/bin.ts connect my-server --cwd //home/user --force-restart
```

### Run without auto-opening a browser

```bash
DEEPSEEK_API_KEY=sk-xxx npx tsx src/cli/bin.ts connect my-server --cwd //home/user --no-open
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
