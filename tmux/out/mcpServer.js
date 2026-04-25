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
        const server = new mcp_js_1.McpServer({ name: "multi-terminal-tmux", version: "1.0.0" });
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
        server.tool("write_file", "Write content to a file. For local paths, writes directly. For remote paths (user@host:/path), writes to a local temp file then SCPs it over and cleans up.", 
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { path: zod_1.z.string().describe("Destination: local absolute path OR scp-style remote path (user@host:/remote/path)"), content: zod_1.z.string().describe("Full file content to write") }, async ({ path, content }) => {
            try {
                return ok(await this.tm.writeFile(path, content));
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