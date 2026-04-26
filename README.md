# Multi-Terminal MCP

Let AI coding agents (Claude Code, Cursor) control multiple named terminal sessions simultaneously via the [Model Context Protocol](https://modelcontextprotocol.io).

The agent drives the terminals. You watch.

**Contents**
- [Use cases](#use-cases)
- [VS Code extension](#vs-code-extension) ⭐
  - [How it works](#how-it-works)
  - [Setup](#setup)
- [tmux](#tmux)
  - [How it works](#how-it-works-1)
  - [Setup](#setup-1)
- [AGENTS.md](#agentsmd)
- [API (MCP Server Tools)](#api-mcp-server-tools)

---

Two implementations — pick one:

| | **VS Code extension** ⭐ recommended | **tmux** |
|---|---|---|
| Terminals visible in | Cursor terminal panel | tmux sessions in any terminal |
| Transport | HTTP (`localhost:3456`) | stdio |
| Requires | Cursor | tmux (`brew install tmux`) |

> **Windsurf Support Limitation:** The VS Code extension creates terminals via the VS Code Extension API, but Windsurf does not display those terminals in its UI — they run invisibly in the background. This is a Windsurf integration limitation, not a bug in the extension. In theory, the VS Code Extension should still work, but the terminal windows will not be visible in Windsurf.

## Use cases

### Server + client iteration (e.g. ClickHouse, databases, compilers)

When a bug requires recompiling a server and re-running a client test, a single-terminal agent gets stuck — it can't keep the server running while also running the client. With a terminal pair, the agent restarts the server in one pane and runs tests in the other, iterating freely without any manual intervention.

> **User:** "My tests are failing. Investigate, fix the bug, and confirm the test passes. Recompile and restart the server as many times as you need to."

```
# Create side-by-side terminals one for server and one for client
Agent: create_terminal_pair("server", "client")
# Start the database server
Agent: run_command("server", "./build/clickhouse-server --config server.xml", { background: true })
# Run the client or test
Agent: run_command("client", "./build/clickhouse-client --query 'SELECT ...'")
# Kill the old database server
Agent: send_input("server", "C-c")
... (agent makes a code change) ...
# Recompile source code and start the updated server
Agent: run_command("server", "ninja -C build && ./build/clickhouse-server --config server.xml", { background: true })
# Re-try the client or test
Agent: run_command("client", "./build/clickhouse-client --query 'SELECT ...'")
... (continues iterating if needed)
```

---

### Debugging across two machines via SSH (e.g. local + remote VM or local + docker container)

Cross-system bugs are hard to debug with a single agent because it can only see one side. With `create_ssh_pair`, one agent gets a local terminal and a remote terminal in the same session. It can serve as a single brain that is capable of inspecting and modifying both local and remote machines.

> **User:** "The app on staging is returning 500s. SSH into user@vm, check the logs, and fix whatever's broken. Deploy your fix when you're done."

```
# Open a local shell and an SSH shell side by side, forwarding port 8080
Agent: create_ssh_pair("local", "remote", "ssh user@vm", { remote_cwd: "/app", ports: [{remote: 8080, local: 8080}] })
# Check recent errors on the remote
Agent: run_command("remote", "tail -50 logs/error.log")
# → KeyError: 'user_id' in handlers/auth.py:34
# Read the offending file on the remote
Agent: run_command("remote", "cat handlers/auth.py")
# Write the fixed version of the file directly to the remote
Agent: write_remote_file("remote", "/app/handlers/auth.py", "<full fixed content>")
# Restart the app on the remote and verify it's healthy
Agent: run_command("remote", "systemctl restart app")
Agent: run_command("remote", "curl -s localhost:8080/health")
# → {"status": "ok"}
```

---


### Frontend + backend running concurrently

> **User:** "Start the backend and frontend, then figure out why the login form isn't submitting. Fix it and confirm it works."

```
Agent: create_terminal_pair("api", "web")
Agent: run_command("api", "cd backend && npm start", { background: true })
Agent: run_command("web", "cd frontend && npm run dev", { background: true })
# after a code change:
Agent: send_input("api", "C-c")
Agent: run_command("api", "cd backend && npm start", { background: true })
```


---

## VS Code extension

### How it works

The extension starts a local MCP HTTP server on `localhost:3456` when VS Code activates. Terminals are created and managed inside VS Code's terminal panel — you see every command the agent runs in real time.

```
Agent (Claude Code / Cursor)
    │  MCP tool calls (HTTP)
    ▼
MCP Server (localhost:3456)
    │  VS Code Extension API
    |_________________
    |                 |
    ▼                 ▼
┌─────────────────┬─────────────────┐
│  Terminal Panel │  Terminal Panel │  ←  you watch these
│    (server)     │    (client)     │
└─────────────────┴─────────────────┘
```


### Setup

**1. Install dependencies and compile**
```bash
cd vscode
npm install
npm run compile
```

**2. Launch the extension**

Open the `vscode/` folder in your VS Code-compatible IDE and press **F5**. A new Extension Development Host window opens with a toast: _"Multi-Terminal: MCP server started on port 3456"_.

> For permanent use, package the extension as a `.vsix` (`vsce package`) and install it.

**3. Connect your agent**

**Claude Code** (`.claude/settings.json` or `~/.claude/settings.json`):
```json
{
  "mcpServers": {
    "multi-terminal": {
      "type": "http",
      "url": "http://localhost:3456/mcp"
    }
  }
}
```

**Cursor** (`~/.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "multi-terminal": {
      "url": "http://localhost:3456/mcp"
    }
  }
}
```

---

## tmux

### How it works

A standalone Node.js process that speaks MCP over stdio. It creates and manages named tmux sessions — attach to any of them with `tmux attach -t mta_<name>` to watch the agent work.

```
Agent (Claude Code / any MCP client)
    │  MCP tool calls (stdio)
    ▼
Node.js MCP server
    │  tmux CLI
    ▼
tmux sessions  ←  attach to watch
```

### Setup

**1. Install tmux**
```bash
brew install tmux   # macOS
# or: sudo apt install tmux
```

**2. Install dependencies and compile**
```bash
cd tmux
npm install
npm run compile
```

**3. Connect your agent**

**Claude Code** (`.claude/settings.json` or `~/.claude/settings.json`):
```json
{
  "mcpServers": {
    "multi-terminal": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/multi-terminal-agent/tmux/out/index.js"]
    }
  }
}
```

---

## AGENTS.md

Copy [`assets/AGENTS.md`](assets/AGENTS.md) into the root of any project where you want agents to use this MCP server. Claude Code, Cursor, and other agents automatically read `AGENTS.md` at the project root and follow its rules.

---

## API (MCP Server Tools)

> This section is for agents and MCP clients. If you're a human setting up the server, you only need the Setup section above.

Both implementations share the same core tool set. Tools marked **VS Code only** or **tmux only** are not available in the other.

---

### `create_terminal`
Create a single named terminal.

| Parameter | Type | Description |
|---|---|---|
| `name` | string | Unique name for the terminal |
| `cwd` | string? | Working directory |

> tmux: attach with `tmux attach -t mta_<name>`

---

### `create_terminal_pair`
Create two named terminals side by side in a split view. Prefer this over calling `create_terminal` twice.

| Parameter | Type | Description |
|---|---|---|
| `name1` | string | Name for the left terminal |
| `name2` | string | Name for the right terminal |
| `cwd` | string? | Working directory for both |

---

### `create_ssh_pair`
Create a local/remote terminal pair for SSH or Docker workflows. The local terminal is a normal shell; the remote terminal automatically runs the connect command and operates inside the remote machine or container. Port mappings inject `-L` forwarding flags into `ssh` commands.

| Parameter | Type | Description |
|---|---|---|
| `local_name` | string | Name for the local terminal |
| `remote_name` | string | Name for the remote terminal |
| `connect_command` | string | e.g. `ssh user@host` or `docker exec -it mycontainer bash` |
| `cwd` | string? | Working directory for the local terminal |
| `remote_cwd` | string? | Path to `cd` into on the remote after connect |
| `ports` | `{remote, local}[]`? | Port mappings to forward (SSH only) |

After connecting, the remote terminal's working directory is probed via `pwd -P` and stored in memory. `list_terminals` exposes it as `cwd`.

---

### `run_command`
Run a command in a named terminal. Blocks until the command exits and returns full output + exit code.

Use `background=true` to fire-and-forget — the command runs in the terminal foreground and can be stopped with `send_input('C-c')`. Returns a 1-second startup snapshot.

A terminal with an active background process is **blocked**: calling `run_command` on it (without `background=true`) returns an error asking you to send C-c first.

| Parameter | Type | Description |
|---|---|---|
| `name` | string | Target terminal name |
| `command` | string | Shell command to run |
| `timeout` | number? | Timeout in ms (default: 30000) |
| `background` | boolean? | Fire-and-forget mode |

Returns `{ output: string, exitCode: number | undefined }`.

---

### `send_input`
Send raw text to a terminal without a newline. Use `'C-c'` to interrupt a running process and unblock the terminal.

| Parameter | Type | Description |
|---|---|---|
| `name` | string | Target terminal name |
| `text` | string | Text to send, e.g. `y`, `C-c`, a password |

---

### `read_output`
Return recent buffered output from a named terminal (ANSI codes stripped).

| Parameter | Type | Description |
|---|---|---|
| `name` | string | Target terminal name |
| `lines` | number? | Lines to return (default: 50) |

---

### `list_terminals`
List all managed terminals, their alive status, role (`local`/`remote`), port mappings, cwd (remote SSH terminals), and whether they are blocked.

No parameters.

---

### `write_remote_file` — VS Code only
Write a file on the machine attached to a named terminal (typically the remote pane of an SSH pair). Content is base64-encoded and written via `python3`, which avoids shell-quoting issues and works for any UTF-8 content. Parent directories are created automatically. `~` is expanded in the terminal's session.

| Parameter | Type | Description |
|---|---|---|
| `terminal` | string | Terminal to write through (use the remote pane for SSH pairs) |
| `path` | string | Absolute path on the remote machine (`~` is allowed) |
| `content` | string | Full file content to write |

---

### `patch_file`
Apply a unified diff to a file through a named terminal. Writes the patch to `/tmp`, displays it with ANSI colour coding, then applies it with `git apply` (falling back to `patch -p1`).

| Parameter | Type | Description |
|---|---|---|
| `terminal` | string | Terminal to run the patch in (use the remote pane for SSH pairs) |
| `filepath` | string | Absolute path to the file being patched |
| `diff` | string | Unified diff in git format (`--- a/…` / `+++ b/…`) |
| `cwd` | string? | Repo root to run `git apply` from |

---

### `write_file` — tmux only
Write content to a file. For local paths, writes directly. For remote paths (`user@host:/path`), writes to a temp file then SCPs. Pass `target_terminal` to write through a named tmux pane using Python's `open()` — useful when the remote home directory differs from the passwd entry.

| Parameter | Type | Description |
|---|---|---|
| `path` | string | Destination: local path, scp path, or path in `target_terminal`'s session |
| `content` | string | Full file content |
| `target_terminal` | string? | Named terminal to write through instead of scp |

---

### `close_terminal`
Close and remove a named terminal.

| Parameter | Type | Description |
|---|---|---|
| `name` | string | Terminal to close |
