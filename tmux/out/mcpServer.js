"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MCPServer = void 0;
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const zod_1 = require("zod");
function ok(text) {
    return { content: [{ type: "text", text }] };
}
function fail(e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}
class MCPServer {
    tm;
    constructor(tm) {
        this.tm = tm;
    }
    async start() {
        const instructions = `
This server manages named tmux terminals and supports SSH/Docker workflows via terminal pairs.

Key rules:
- To start a long-running server, use run_command with wait_for=<health_url>. The server runs in the pane foreground (visible, stoppable with send_input C-c) and the tool returns once healthy. Never use nohup, & with sleep, or other manual daemonisation.
- Before creating an SSH pair, if the user has not provided a cwd, ask for it before proceeding. Once known, use that remote context for all subsequent file references — scp destinations, absolute paths, and run_command targets should all be expressed in terms absolute paths. Never use ~ in paths.
- Before creating an SSH pair, if the user has not specified port mappings, ask them whether any ports are exposed between the remote and the local machine.
- If using a ssh terminal pair, always use the correct terminal (local or remote) for each command, without trying to switch to the other from the current terminal.
- Local commands (file writes, scp, docker cp, curl) always go in the local terminal. Remote/container commands always go in the remote terminal.
- Port bindings are stored on the terminal entry. Use list_terminals to look them up when deciding which host/port to target.
- Prefer running commands in a terminal created from this MCP server over running it separately.
- To modify a remote file: generate a unified diff (git diff format with a/ b/ prefixes) and call patch_file with the terminal name, filepath, and diff. Never overwrite remote files in their entirety with write_file or scp. Use write_file only for new files or local files.
    `.trim();
        const server = new mcp_js_1.McpServer({ name: "multi-terminal-tmux", version: "1.0.0" }, { instructions });
        server.tool("create_terminal", "Create a named tmux session. Attach with: tmux attach -t mta_{name}", {
            name: zod_1.z.string().describe("Unique name for the terminal"),
            cwd: zod_1.z.string().optional().describe("Working directory path"),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }, async ({ name, cwd }) => {
            try {
                return ok(await this.tm.createTerminal(name, cwd));
            }
            catch (e) {
                return fail(e);
            }
        });
        server.tool("create_terminal_pair", "Create two named terminals as split panes in one tmux session. Attach with: tmux attach -t mta_{name1}", {
            name1: zod_1.z.string().describe("Name for the left pane"),
            name2: zod_1.z.string().describe("Name for the right pane"),
            cwd: zod_1.z.string().optional().describe("Working directory for both panes"),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }, async ({ name1, name2, cwd }) => {
            try {
                return ok(await this.tm.createTerminalPair(name1, name2, cwd));
            }
            catch (e) {
                return fail(e);
            }
        });
        server.tool("create_ssh_pair", "Create a split-pane terminal pair for SSH/Docker workflows. The 'local' pane is a local shell; the 'remote' pane automatically runs the connect command (ssh, docker exec, etc.). Use list_terminals to see roles — always run local commands (scp, write_file) in the local terminal and remote/container commands in the remote terminal. If the user has not already specified port mappings, ask them whether any ports are exposed between the remote and local machine before calling this tool.", {
            local_name: zod_1.z.string().optional().describe("Name for the local pane (default: 'local')"),
            remote_name: zod_1.z.string().optional().describe("Name for the remote/container pane (default: 'remote')"),
            connect_command: zod_1.z.string().describe('Command to connect to the remote, e.g. "ssh user@host", "docker exec -it mycontainer bash", "kubectl exec -it mypod -- bash"'),
            cwd: zod_1.z.string().optional().describe("Working directory for the local pane"),
            ports: zod_1.z.array(zod_1.z.object({ remote: zod_1.z.number(), local: zod_1.z.number() })).optional().describe("Port mappings between the remote and local machine. Each entry: remote = port on the remote/container, local = port on the local machine. E.g. [{remote:8080,local:3000}] means the app on port 8080 on the remote is reachable at localhost:3000 locally."),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }, async ({ local_name, remote_name, connect_command, cwd, ports }) => {
            try {
                return ok(await this.tm.createSshPair(local_name ?? "local", remote_name ?? "remote", connect_command, cwd, ports));
            }
            catch (e) {
                return fail(e);
            }
        });
        server.tool("run_command", "Run a command in a named terminal. By default blocks until the command exits and returns output + exit code. Use background=true to fire-and-forget (returns immediately; command runs in the pane foreground). Use wait_for=<url> to start a server and block until its health URL returns 2xx — the server runs in the pane foreground and can be killed later with send_input C-c.", 
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
            name: zod_1.z.string(),
            command: zod_1.z.string(),
            timeout: zod_1.z.number().optional().describe("Timeout ms (default 30000). For wait_for, this is the max time to wait for the health check."),
            background: zod_1.z.boolean().optional().describe("If true, start the command and return immediately without waiting for it to exit."),
            wait_for: zod_1.z.string().optional().describe("Health-check URL: start the command and poll this URL until it returns 2xx, then return. Use for servers (e.g. wait_for='http://localhost:8000/health')."),
        }, async ({ name, command, timeout, background, wait_for }) => {
            try {
                return ok(JSON.stringify(await this.tm.runCommand(name, command, timeout, { background, wait_for })));
            }
            catch (e) {
                return fail(e);
            }
        });
        server.tool("send_input", "Send raw text to a terminal without a newline (for interactive prompts like y/n)", {
            name: zod_1.z.string(),
            text: zod_1.z.string(),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }, async ({ name, text }) => {
            try {
                return ok(await this.tm.sendInput(name, text));
            }
            catch (e) {
                return fail(e);
            }
        });
        server.tool("read_output", "Read recent output from a named terminal", {
            name: zod_1.z.string(),
            lines: zod_1.z.number().optional().describe("Number of lines to return (default 50)"),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }, async ({ name, lines }) => {
            try {
                return ok(await this.tm.readOutput(name, lines));
            }
            catch (e) {
                return fail(e);
            }
        });
        server.tool("list_terminals", "List all managed terminals and their alive status", 
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {}, async () => {
            try {
                return ok(JSON.stringify(await this.tm.listTerminals(), null, 2));
            }
            catch (e) {
                return fail(e);
            }
        });
        server.tool("close_terminal", "Close a named terminal (kills the tmux session)", {
            name: zod_1.z.string(),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }, async ({ name }) => {
            try {
                return ok(await this.tm.closeTerminal(name));
            }
            catch (e) {
                return fail(e);
            }
        });
        server.tool("write_file", "Write content to a file. For local paths, writes directly. For remote paths (user@host:/path), writes to a temp file then SCPs. For user@host:~/file, ~ is resolved via a login-shell SSH probe so it matches interactive HOME (plain scp/SFTP expands ~ to the passwd home, which breaks on some hosts). Optionally set target_terminal to write through a named tmux pane with python3 (uses that shell's expanduser), e.g. the inside pane of an SSH pair.", 
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
            path: zod_1.z.string().describe("Destination: local path, scp path (user@host:/path), or path in target_terminal's session when target_terminal is set"),
            content: zod_1.z.string().describe("Full file content to write"),
            target_terminal: zod_1.z.string().optional().describe("Named terminal to write through (python3 on that pane) instead of scp — use for exact session HOME/cwd"),
        }, async ({ path, content, target_terminal }) => {
            try {
                return ok(await this.tm.writeFile(path, content, target_terminal ? { target_terminal } : undefined));
            }
            catch (e) {
                return fail(e);
            }
        });
        server.tool("patch_file", "Apply a unified diff to a file inside a named terminal. Writes the patch to a temp file (making the diff visible in the terminal), then applies it with git apply or patch -p1. Use this instead of write_file when modifying existing remote files — never overwrite them in their entirety.", 
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
            terminal: zod_1.z.string().describe("Terminal name to run the patch in"),
            filepath: zod_1.z.string().describe("Absolute path to the file being patched (for context/error messages)"),
            diff: zod_1.z.string().describe("Unified diff to apply. Use standard git diff format with --- a/<path> and +++ b/<path> prefixes for best compatibility."),
            cwd: zod_1.z.string().optional().describe("Directory to run git apply / patch from (default: current terminal directory). For git repos, use the repo root."),
        }, async ({ terminal, filepath, diff, cwd }) => {
            try {
                return ok(await this.tm.patchFile(terminal, filepath, diff, cwd));
            }
            catch (e) {
                return fail(e);
            }
        });
        const transport = new stdio_js_1.StdioServerTransport();
        await server.connect(transport);
    }
}
exports.MCPServer = MCPServer;
//# sourceMappingURL=mcpServer.js.map