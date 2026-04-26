# Multi-Terminal MCP Usage

This project uses the multi-terminal MCP server to manage tmux sessions, including SSH and Docker workflows.

## Rules

- **Remote and local work must go through the multi-terminal MCP** (`user-multi-terminal-vscode` or `user-multi-terminal-tmux`), not through ad-hoc shells. Use `list_terminals` to find the `local` and `remote` names, then `run_command` (and for tmux, `write_remote_file` / `read_output` / `send_input` as documented). Do not open a second path to the same machine (for example do not run `ssh user@host ...`, `ssh ... "cat"`, `scp`, or `rsync` from the generic Cursor/IDE terminal) when an SSH-pair `remote` terminal already exists or can be created—duplicate sessions break port-forward expectations, split auth, and hide output from the panes the user is watching. If the user has not set up a pair, create one with `create_ssh_pair` and run commands there.
- **If a tool call doesn't behave as desired, then investigate why rather than finding a workaround**.
- To start a long-running server, use `run_command` with `background=true`. The server runs in the pane foreground (visible, stoppable with `send_input C-c`). Never use `nohup`, `&` with `sleep`, or other manual daemonisation.
- Before creating an SSH pair, if the user has not provided a cwd, ask for it before proceeding. Once known, use that remote context for all subsequent file references — scp destinations, absolute paths, and run_command targets should all be expressed in terms absolute paths. Never use ~ in paths.
- Before creating an SSH pair, if the user has not specified port mappings, ask them whether any ports are exposed between the remote and the local machine.
- Check the `role` field from `list_terminals` to identify the correct terminal — `local` is the local shell, `remote` is the SSH/container session.
- For paths in commands (for example `scp` sources and destinations, `read_file` targets, or any tool args): do not use `~`. Use absolute paths. For the local side, use the known local working directory. For the remote or container side, use `run_command` on the `remote` terminal to read `pwd` (or `$HOME` when home is the intent) and build paths from that.
- Never run local commands (file writes, scp, docker cp, curl to mapped ports) in the remote terminal. Never run remote/container commands in the local terminal.
- Port bindings are stored on the terminal entry. Use `list_terminals` to look them up when deciding which host and port to target.
- To create or modify a file on a remote session: call `write_remote_file` on the `remote` terminal with an absolute path and the full new UTF-8 content. For local project files, use the editor or normal workspace tools.



## Tunneled service + local client (e.g. worker on remote, pytest on local)

- After `list_terminals`, use the `ports` entry: **`local`** = port to use on the laptop (e.g. `curl` / `WORKER_TEST_BASE_URL=http://127.0.0.1:<local>`), **`remote`** = port the app must **listen** on in the **remote** session. Keep this consistent with the SSH `-L` in `connect_command` (e.g. `-L 18080:127.0.0.1:8080` → listen on `8080` remote, test on `18080` local).
- If binding fails (address already in use), check what is listening on that remote port and stop the old process.
- Local-only traffic (hitting the tunnel, `pytest` with a `localhost` base URL) must run in the **`local`** terminal; the server and remote `curl` to `127.0.0.1:<remote port>` use **`remote`**.

## MCP / workflow improvements (for maintainers)

- **Agent clarity:** `create_ssh_pair` / docs could require `ports` to match parsed `-L` and echo a one-line “listen on R, test on L” summary when the pair is created.
- **Tooling:** A `run_command` option such as `background` / `wait_for_port` / `run_server` would avoid choosing between `nohup`, `&`, and blocking `uvicorn` on every run.
- **Optional skill:** A project skill “SSH pair: start tunneled service + run local tests” with env var naming and a port-alignment checklist could reduce rediscovery.
