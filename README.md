# Multi-Terminal MCP

A VS Code extension that lets AI coding agents (Windsurf, Cursor, Claude Code) control multiple named terminal sessions simultaneously via the [Model Context Protocol](https://modelcontextprotocol.io).

The agent drives the terminals. You watch.

---

## How it works

The extension starts a local MCP server on `localhost:3456` when VS Code activates. Terminals are created and managed inside VS Code's own terminal panel — you see every command the agent runs in real time. The agent reads output on demand by calling `read_output`.

```
Agent (Windsurf / Cursor / Claude Code)
    │  MCP tool calls
    ▼
MCP Server (localhost:3456)
    │  VS Code Extension API
    ▼
Terminal Panel  ←  you watch this
```

---

## Setup

**1. Install dependencies and compile**
```bash
npm install
npm run compile
```

**2. Launch the extension**

Open this folder in VS Code or Windsurf and press **F5**. A new Extension Development Host window opens. You'll see a toast: _"Multi-Terminal: MCP server started on port 3456"_.

**3. Connect your agent**

Add the MCP server to your agent's config and reload.

**Windsurf** (`~/.codeium/windsurf/mcp_config.json`):
```json
{
  "mcpServers": {
    "multi-terminal": {
      "serverUrl": "http://localhost:3456/mcp"
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

**Claude Code** (`.claude/settings.json`):
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

---

## API

### `create_terminal_pair`
Creates two named terminals side by side in a split view. Prefer this over calling `create_terminal` twice.

| Parameter | Type | Description |
|---|---|---|
| `name1` | string | Name for the left terminal |
| `name2` | string | Name for the right terminal |
| `cwd` | string? | Working directory for both terminals |

---

### `create_terminal`
Creates a single named terminal tab.

| Parameter | Type | Description |
|---|---|---|
| `name` | string | Unique name for the terminal |
| `cwd` | string? | Working directory |

---

### `send_command`
Sends a shell command to a named terminal. Appends a newline to execute immediately.

| Parameter | Type | Description |
|---|---|---|
| `name` | string | Target terminal name |
| `command` | string | Shell command to run |

---

### `send_input`
Sends raw text to a terminal without a newline. Use for interactive prompts.

| Parameter | Type | Description |
|---|---|---|
| `name` | string | Target terminal name |
| `text` | string | Raw text to send (e.g. `y`, `q`, a password prompt) |

---

### `read_output`
Returns recent output from a named terminal as plain text (ANSI codes stripped). Requires shell integration to be active — enabled by default in bash and zsh.

| Parameter | Type | Description |
|---|---|---|
| `name` | string | Target terminal name |
| `lines` | number? | Number of lines to return (default: 50) |

---

### `list_terminals`
Returns the names and alive status of all managed terminals.

No parameters.

---

### `close_terminal`
Closes and removes a named terminal.

| Parameter | Type | Description |
|---|---|---|
| `name` | string | Terminal to close |

---

## Use cases

### Client/server debugging

A fullstack app where the backend and frontend need to run concurrently. The agent can start both processes, watch for errors in either one, and iterate — without losing the running server every time it needs to check something.

```
Agent: create_terminal_pair("server", "client")
Agent: send_command("server", "cd backend && npm start")
Agent: send_command("client", "cd frontend && npm run dev")
Agent: read_output("server", 20)   # check server started cleanly
Agent: read_output("client", 20)   # check client compiled
# ... later, after a code change ...
Agent: send_command("client", "npm run dev")   # restart just the client
Agent: read_output("client", 30)               # verify it came back up
```

You see both processes running side by side the entire time.

---

### Local app + SSH remote debugging

Debugging an issue that only reproduces on a remote server. The agent maintains a local terminal for editing and deploying, and an SSH session for log tailing and remote commands.

```
Agent: create_terminal_pair("local", "remote")
Agent: send_command("remote", "ssh user@staging-server")
Agent: send_command("local", "npm run build && scp dist/ user@staging-server:~/app/")
Agent: send_command("remote", "pm2 restart app && pm2 logs app --lines 50")
Agent: read_output("remote", 50)   # read crash logs
# agent edits the code, redeploys, checks logs again
```

---

### Test runner + dev server

Running an integration test suite that needs a live server. The agent starts the server in one terminal and runs tests in the other, reading results without killing the server between runs.

```
Agent: create_terminal_pair("server", "tests")
Agent: send_command("server", "npm start")
Agent: read_output("server", 10)               # wait for "listening on port..."
Agent: send_command("tests", "npm test")
Agent: read_output("tests", 100)               # read test results
# agent fixes a failing test, reruns without restarting the server
Agent: send_command("tests", "npm test -- --grep 'auth'")
```

---

## Notes

- The MCP server runs only while the Extension Development Host (F5) is open. For permanent use, package the extension as a `.vsix` and install it.
- `read_output` captures output from commands run while shell integration is active. Long-running process logs (e.g. a dev server) are captured as they stream in.
- The agent pulls output on demand — it does not receive terminal events passively. For time-sensitive output, instruct the agent to call `read_output` immediately after a command.
