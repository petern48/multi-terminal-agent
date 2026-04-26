import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { Server } from "http";
import { z } from "zod";
import { TerminalManager } from "./terminalManager";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function fail(e: unknown): ToolResult {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

export class MCPServer {
  private httpServer: Server | null = null;

  constructor(private tm: TerminalManager) {}

  start(port: number): void {
    const server = new McpServer({ name: "multi-terminal", version: "1.0.0" });

    server.tool("create_terminal", "Create a single named terminal tab in VS Code", {
      name: z.string().describe("Unique name for the terminal"),
      cwd: z.string().optional().describe("Working directory path"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any, async ({ name, cwd }: { name: string; cwd?: string }): Promise<ToolResult> => {
      try { return ok(this.tm.createTerminal(name, cwd)); } catch (e) { return fail(e); }
    });

    server.tool("create_terminal_pair", "Create two named terminals side by side in a split view. Prefer this over calling create_terminal twice.", {
      name1: z.string().describe("Name for the left terminal"),
      name2: z.string().describe("Name for the right terminal"),
      cwd: z.string().optional().describe("Working directory for both terminals"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any, async ({ name1, name2, cwd }: { name1: string; name2: string; cwd?: string }): Promise<ToolResult> => {
      try { return ok(this.tm.createTerminalPair(name1, name2, cwd)); } catch (e) { return fail(e); }
    });

    server.tool("run_command",
      "Run a command in a terminal. By default blocks until the command exits and returns full output + exit code (requires shell integration). Use background=true to fire-and-forget — the command runs in the terminal foreground and can be stopped with send_input('C-c').",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {
        name: z.string(),
        command: z.string(),
        timeout: z.number().optional().describe("Timeout ms (default 30000)"),
        background: z.boolean().optional().describe("If true, start the command and return immediately with a startup snapshot. Stop later with send_input('C-c')."),
      } as any,
      async ({ name, command, timeout, background }: { name: string; command: string; timeout?: number; background?: boolean }): Promise<ToolResult> => {
        try { return ok(JSON.stringify(await this.tm.runCommand(name, command, timeout, { background }))); } catch (e) { return fail(e); }
      });

    // server.tool("send_command", "Send a shell command to a named terminal (executes immediately)", {
    //   name: z.string(),
    //   command: z.string(),
    // // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // } as any, async ({ name, command }: { name: string; command: string }): Promise<ToolResult> => {
    //   try { return ok(this.tm.sendCommand(name, command)); } catch (e) { return fail(e); }
    // });

    server.tool("send_input", "Send raw text to a terminal without a newline. Use 'C-c' to interrupt a running process (e.g. stop a background server).", {
      name: z.string(),
      text: z.string(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any, async ({ name, text }: { name: string; text: string }): Promise<ToolResult> => {
      try { return ok(this.tm.sendInput(name, text)); } catch (e) { return fail(e); }
    });

    server.tool("read_output", "Read recent output from a named terminal", {
      name: z.string(),
      lines: z.number().optional().describe("Number of lines to return (default 50)"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any, async ({ name, lines }: { name: string; lines?: number }): Promise<ToolResult> => {
      try { return ok(this.tm.readOutput(name, lines)); } catch (e) { return fail(e); }
    });

    server.tool("list_terminals", "List all managed terminals and whether they are alive",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any, async (): Promise<ToolResult> => {
      try { return ok(JSON.stringify(this.tm.listTerminals(), null, 2)); } catch (e) { return fail(e); }
    });

    server.tool("close_terminal", "Close and remove a named terminal", {
      name: z.string(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any, async ({ name }: { name: string }): Promise<ToolResult> => {
      try { return ok(this.tm.closeTerminal(name)); } catch (e) { return fail(e); }
    });

    const app = express();
    app.use(express.json());

    // One transport per request (stateless mode)
    app.post("/mcp", async (req: Request, res: Response) => {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });

    app.get("/mcp", (_req: Request, res: Response) => {
      res.json({ status: "ok", server: "multi-terminal", version: "1.0.0" });
    });

    this.httpServer = app.listen(port, "127.0.0.1", () => {
      console.log(`[multi-terminal] MCP server listening on http://127.0.0.1:${port}/mcp`);
    });
  }

  stop(): void {
    this.httpServer?.close();
    this.httpServer = null;
  }
}
