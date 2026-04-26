# API (MCP Server Tools)

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
