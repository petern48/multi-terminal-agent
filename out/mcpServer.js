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
        server.tool("create_terminal", "Create a named terminal tab in VS Code", {
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
        server.tool("send_command", "Send a shell command to a named terminal (executes immediately)", {
            name: zod_1.z.string(),
            command: zod_1.z.string(),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }, async ({ name, command }) => {
            try {
                return ok(this.tm.sendCommand(name, command));
            }
            catch (e) {
                return fail(e);
            }
        });
        server.tool("send_input", "Send raw text to a terminal without a newline (for interactive prompts)", {
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
        server.tool("list_terminals", "List all managed terminals and whether they are alive", 
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {}, async () => {
            try {
                return ok(JSON.stringify(this.tm.listTerminals(), null, 2));
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