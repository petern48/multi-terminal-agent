"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MCPServer = void 0;
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const express_1 = __importDefault(require("express"));
const zod_1 = require("zod");
function ok(text) {
    return { content: [{ type: "text", text }] };
}
function fail(e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}
class MCPServer {
    constructor(tm) {
        this.tm = tm;
        this.httpServer = null;
    }
    start(port) {
        const server = new mcp_js_1.McpServer({ name: "multi-terminal", version: "1.0.0" });
        server.tool("create_terminal", "Create a single named terminal tab in VS Code", {
            name: zod_1.z.string().describe("Unique name for the terminal"),
            cwd: zod_1.z.string().optional().describe("Working directory path"),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }, async ({ name, cwd }) => {
            try {
                return ok(this.tm.createTerminal(name, cwd));
            }
            catch (e) {
                return fail(e);
            }
        });
        server.tool("create_ssh_pair", "Create a local/remote terminal pair. The local terminal is for local commands (scp, file writes). The remote terminal automatically runs the connect command (ssh or docker exec) so it operates inside the remote/container. Port mappings inject -L forwarding flags into ssh commands. After connect, the remote pane’s cwd is probed (or taken from optional remote_cwd) and stored on the remote terminal only; list_terminals exposes it as cwd. In-memory for this session only.", {
            local_name: zod_1.z.string().describe("Name for the local terminal"),
            remote_name: zod_1.z.string().describe("Name for the remote terminal"),
            connect_command: zod_1.z.string().describe("Command to connect to remote, e.g. 'ssh user@host' or 'docker exec -it container bash'"),
            cwd: zod_1.z.string().optional().describe("Working directory for the local terminal"),
            remote_cwd: zod_1.z.string().optional().describe("Optional absolute path on the remote to cd into after connect; also used if pwd output cannot be parsed"),
            ports: zod_1.z.array(zod_1.z.object({
                remote: zod_1.z.number().describe("Port on the remote/container"),
                local: zod_1.z.number().describe("Port on the local machine"),
            })).optional().describe("Port mappings to forward. Injects -L flags into ssh commands."),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }, async ({ local_name, remote_name, connect_command, cwd, remote_cwd, ports }) => {
            try {
                return ok(await this.tm.createSshPair(local_name, remote_name, connect_command, cwd, ports, remote_cwd));
            }
            catch (e) {
                return fail(e);
            }
        });
        server.tool("create_terminal_pair", "Create two named terminals side by side in a split view. Prefer this over calling create_terminal twice.", {
            name1: zod_1.z.string().describe("Name for the left terminal"),
            name2: zod_1.z.string().describe("Name for the right terminal"),
            cwd: zod_1.z.string().optional().describe("Working directory for both terminals"),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }, async ({ name1, name2, cwd }) => {
            try {
                return ok(this.tm.createTerminalPair(name1, name2, cwd));
            }
            catch (e) {
                return fail(e);
            }
        });
        server.tool("run_command", "Run a command in a terminal. By default blocks until the command exits and returns full output + exit code (requires shell integration). Use background=true to fire-and-forget — the command runs in the terminal foreground and can be stopped with send_input('C-c').", 
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
            name: zod_1.z.string(),
            command: zod_1.z.string(),
            timeout: zod_1.z.number().optional().describe("Timeout ms (default 30000)"),
            background: zod_1.z.boolean().optional().describe("If true, start the command and return immediately with a startup snapshot. Stop later with send_input('C-c')."),
        }, async ({ name, command, timeout, background }) => {
            try {
                return ok(JSON.stringify(await this.tm.runCommand(name, command, timeout, { background })));
            }
            catch (e) {
                return fail(e);
            }
        });
        // server.tool("send_command", "Send a shell command to a named terminal (executes immediately)", {
        //   name: z.string(),
        //   command: z.string(),
        // // eslint-disable-next-line @typescript-eslint/no-explicit-any
        // } as any, async ({ name, command }: { name: string; command: string }): Promise<ToolResult> => {
        //   try { return ok(this.tm.sendCommand(name, command)); } catch (e) { return fail(e); }
        // });
        server.tool("send_input", "Send raw text to a terminal without a newline. Use 'C-c' to interrupt a running process (e.g. stop a background server).", {
            name: zod_1.z.string(),
            text: zod_1.z.string(),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }, async ({ name, text }) => {
            try {
                return ok(this.tm.sendInput(name, text));
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
                return ok(this.tm.readOutput(name, lines));
            }
            catch (e) {
                return fail(e);
            }
        });
        server.tool("list_terminals", "List all managed terminals and whether they are alive. Remote SSH panes may include cwd and remote_cwd_source (from the last create_ssh_pair probe).", 
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {}, async () => {
            try {
                return ok(JSON.stringify(this.tm.listTerminals(), null, 2));
            }
            catch (e) {
                return fail(e);
            }
        });
        server.tool("patch_file", "Apply a unified diff to a file on the remote through a named terminal. Writes the patch to /tmp, displays it with ANSI colours, then applies with git apply (handles a/b/ prefixes) or falls back to patch -p1. Prefer this over overwriting the whole file when modifying existing remote files. Requires shell integration to be active on the terminal.", {
            terminal: zod_1.z.string().describe("Terminal name to run the patch in (must be the remote pane for SSH pairs)"),
            filepath: zod_1.z.string().describe("Absolute path to the file being patched (used in error messages)"),
            diff: zod_1.z.string().describe("Unified diff in git format with --- a/<path> and +++ b/<path> prefixes"),
            cwd: zod_1.z.string().optional().describe("Repo root to run git apply from (defaults to the terminal's current directory)"),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }, async ({ terminal, filepath, diff, cwd }) => {
            try {
                return ok(await this.tm.patchFile(terminal, filepath, diff, cwd));
            }
            catch (e) {
                return fail(e);
            }
        });
        server.tool("close_terminal", "Close and remove a named terminal", {
            name: zod_1.z.string(),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }, async ({ name }) => {
            try {
                return ok(this.tm.closeTerminal(name));
            }
            catch (e) {
                return fail(e);
            }
        });
        const app = (0, express_1.default)();
        app.use(express_1.default.json());
        // One transport per request (stateless mode)
        app.post("/mcp", async (req, res) => {
            const transport = new streamableHttp_js_1.StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            res.on("close", () => transport.close());
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        });
        app.get("/mcp", (_req, res) => {
            res.json({ status: "ok", server: "multi-terminal", version: "1.0.0" });
        });
        this.httpServer = app.listen(port, "127.0.0.1", () => {
            console.log(`[multi-terminal] MCP server listening on http://127.0.0.1:${port}/mcp`);
        });
    }
    stop() {
        this.httpServer?.close();
        this.httpServer = null;
    }
}
exports.MCPServer = MCPServer;
//# sourceMappingURL=mcpServer.js.map