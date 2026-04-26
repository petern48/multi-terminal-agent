# Multi-Terminal MCP

Let AI coding agents (Claude Code, Cursor) control multiple named terminal sessions simultaneously via the [Model Context Protocol](https://modelcontextprotocol.io).

The agent drives the terminals. You watch.

Two implementations — pick one:

| | **VS Code extension** ⭐ recommended | **tmux** |
|---|---|---|
| Terminals visible in | Cursor terminal panel | tmux sessions in any terminal |
| Transport | HTTP (`localhost:3456`) | stdio |
| Requires | Cursor | tmux (`brew install tmux`) |
| `write_file` tool | — | yes |
| SSH remote terminals | yes (`create_ssh_pair`) | yes (`create_ssh_pair`) |

> **Windsurf Support Limitation:** The VS Code extension creates terminals via the VS Code Extension API, but Windsurf does not display those terminals in its UI — they run invisibly in the background. This is a Windsurf integration limitation, not a bug in the extension. In theory, the VS Code Extension should still work, but the terminal windows will not be visible in Windsurf.

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
    ▼
Terminal Panel  ←  you watch this
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

## API

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

### `patch_file`
Apply a unified diff to a file through a named terminal. Writes the patch to `/tmp`, displays it with ANSI colour coding, then applies it with `git apply` (falling back to `patch -p1`). Prefer this over rewriting an entire remote file.

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

---

## Use cases

### Client/server debugging

```
Agent: create_terminal_pair("server", "client")
Agent: run_command("server", "cd backend && npm start", { background: true })
Agent: run_command("client", "cd frontend && npm run dev", { background: true })
# ... after a code change ...
Agent: send_input("server", "C-c")
Agent: run_command("server", "cd backend && npm start", { background: true })
```

### SSH remote debugging

```
Agent: create_ssh_pair("local", "remote", "ssh user@staging", { remote_cwd: "/home/deploy/app" })
Agent: run_command("remote", "cat logs/error.log | tail -30")
Agent: run_command("local", "npm run build && scp -r dist/ user@staging:/home/deploy/app/")
Agent: run_command("remote", "pm2 restart app")
```

### Test runner + dev server

```
Agent: create_terminal_pair("server", "tests")
Agent: run_command("server", "npm start", { background: true })
Agent: run_command("tests", "npm test")
Agent: run_command("tests", "npm test -- --grep 'auth'")
```
