import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { Server } from "http";
import { z } from "zod";
import { TerminalManager, PortMapping } from "./terminalManager";

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

    server.tool("create_ssh_pair",
      "Create a local/remote terminal pair. The local terminal is for local commands (scp, file writes). The remote terminal automatically runs the connect command (ssh or docker exec) so it operates inside the remote/container. Port mappings inject -L forwarding flags into ssh commands. After connect, the remote pane’s cwd is probed (or taken from optional remote_cwd) and stored on the remote terminal only; list_terminals exposes it as cwd. In-memory for this session only.",
      {
        local_name: z.string().describe("Name for the local terminal"),
        remote_name: z.string().describe("Name for the remote terminal"),
        connect_command: z.string().describe("Command to connect to remote, e.g. 'ssh user@host' or 'docker exec -it container bash'"),
        cwd: z.string().optional().describe("Working directory for the local terminal"),
        remote_cwd: z.string().optional().describe("Optional absolute path on the remote to cd into after connect; also used if pwd output cannot be parsed"),
        ports: z.array(z.object({
          remote: z.number().describe("Port on the remote/container"),
          local: z.number().describe("Port on the local machine"),
        })).optional().describe("Port mappings to forward. Injects -L flags into ssh commands."),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any, async ({ local_name, remote_name, connect_command, cwd, remote_cwd, ports }: { local_name: string; remote_name: string; connect_command: string; cwd?: string; remote_cwd?: string; ports?: PortMapping[] }): Promise<ToolResult> => {
        try { return ok(await this.tm.createSshPair(local_name, remote_name, connect_command, cwd, ports, remote_cwd)); } catch (e) { return fail(e); }
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
      "Run a command in a terminal. For local/integrated panes, blocks until the command exits and returns output + exit code (shell integration + onDidEnd). For create_ssh_pair remotes, uses a sendText+exit-marker path so short commands return without spurious timeouts. background=true = fire-and-forget with a 1s snapshot; long-running in foreground, stop with send_input('C-c').",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {
        name: z.string(),
        command: z.string(),
        timeout: z.number().optional().describe("Timeout ms (default 30000)"),
        background: z.boolean().optional().describe("If true, start the command and return after ~1s with a snapshot. Stop long-running work with send_input('C-c')."),
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

    server.tool("list_terminals", "List all managed terminals and whether they are alive. Remote SSH panes may include cwd and remote_cwd_source (from the last create_ssh_pair probe).",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any, async (): Promise<ToolResult> => {
      try { return ok(JSON.stringify(this.tm.listTerminals(), null, 2)); } catch (e) { return fail(e); }
    });

    server.tool("write_remote_file",
      "Write the full file content to a path on the machine attached to a named terminal (e.g. the remote pane of an SSH pair). Uses python3 to decode UTF-8 via base64 and create parent directories — no unified diff, no scp. Prefer absolute paths; ~ is expanded in that session.",
      {
        terminal: z.string().describe("Terminal name (must be the remote pane for SSH pairs)"),
        path: z.string().describe("Destination path in that session (absolute recommended; ~ expanded)"),
        content: z.string().describe("Complete new file content (UTF-8)"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any, async ({ terminal, path, content }: { terminal: string; path: string; content: string }): Promise<ToolResult> => {
        try { return ok(await this.tm.writeRemoteFile(terminal, path, content)); } catch (e) { return fail(e); }
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
