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
- Whenever you're asked to run a server, run it synchronously (not in the background by default)
- Before creating an SSH pair, if the user has not provided a cwd, ask for it before proceeding. Once known, use that remote context for all subsequent file references — scp destinations, absolute paths, and run_command targets should all be expressed in terms absolute paths. Never use ~ in paths.
- Before creating an SSH pair, if the user has not specified port mappings, ask them whether any ports are exposed between the remote and the local machine.
- If using a ssh terminal pair, always use the correct terminal (outside of inside) for each command, without trying to switch to the other from the current terminal.
- Local commands (file writes, scp, docker cp, curl) always go in the outside terminal. Remote/container commands always go in the inside terminal.
- Port bindings are stored on the terminal entry. Use list_terminals to look them up when deciding which host/port to target.
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
        server.tool("create_ssh_pair", "Create a split-pane terminal pair for SSH/Docker workflows. The 'outside' pane is a local shell; the 'inside' pane automatically runs the connect command (ssh, docker exec, etc.). Use list_terminals to see roles — always run local commands (scp, write_file) in the outside terminal and remote/container commands in the inside terminal. If the user has not already specified port mappings, ask them whether any ports are exposed between the remote and local machine before calling this tool.", {
            outside_name: zod_1.z.string().optional().describe("Name for the local (outside) pane (default: 'outside')"),
            inside_name: zod_1.z.string().optional().describe("Name for the remote/container (inside) pane (default: 'inside')"),
            connect_command: zod_1.z.string().describe('Command to connect to the remote, e.g. "ssh user@host", "docker exec -it mycontainer bash", "kubectl exec -it mypod -- bash"'),
            cwd: zod_1.z.string().optional().describe("Working directory for the outside pane"),
            ports: zod_1.z.array(zod_1.z.object({ inside: zod_1.z.number(), outside: zod_1.z.number() })).optional().describe("Port mappings between the remote and local machine. Each entry: inside = port on the remote/container, outside = port on the local machine. E.g. [{inside:8080,outside:3000}] means the app on port 8080 inside the container is reachable at localhost:3000 from outside."),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }, async ({ outside_name, inside_name, connect_command, cwd, ports }) => {
            try {
                return ok(await this.tm.createSshPair(outside_name ?? "outside", inside_name ?? "inside", connect_command, cwd, ports));
            }
            catch (e) {
                return fail(e);
            }
        });
        server.tool("run_command", "Run a command in a named terminal and wait for it to finish, returning full output and exit code. Works in any shell environment including local, SSH, and Docker sessions.", 
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { name: zod_1.z.string(), command: zod_1.z.string(), timeout: zod_1.z.number().optional().describe("Timeout ms, default 30000") }, async ({ name, command, timeout }) => {
            try {
                return ok(JSON.stringify(await this.tm.runCommand(name, command, timeout)));
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
        const transport = new stdio_js_1.StdioServerTransport();
        await server.connect(transport);
    }
}
exports.MCPServer = MCPServer;
//# sourceMappingURL=mcpServer.js.map