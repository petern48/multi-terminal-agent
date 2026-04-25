import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
  constructor(private tm: TerminalManager) {}

  async start(): Promise<void> {
    const server = new McpServer({ name: "multi-terminal-tmux", version: "1.0.0" });

    server.tool("create_terminal", "Create a named tmux session. Attach with: tmux attach -t mta_{name}", {
      name: z.string().describe("Unique name for the terminal"),
      cwd: z.string().optional().describe("Working directory path"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any, async ({ name, cwd }: { name: string; cwd?: string }): Promise<ToolResult> => {
      try { return ok(await this.tm.createTerminal(name, cwd)); } catch (e) { return fail(e); }
    });

    server.tool("create_terminal_pair", "Create two named terminals as split panes in one tmux session. Attach with: tmux attach -t mta_{name1}", {
      name1: z.string().describe("Name for the left pane"),
      name2: z.string().describe("Name for the right pane"),
      cwd: z.string().optional().describe("Working directory for both panes"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any, async ({ name1, name2, cwd }: { name1: string; name2: string; cwd?: string }): Promise<ToolResult> => {
      try { return ok(await this.tm.createTerminalPair(name1, name2, cwd)); } catch (e) { return fail(e); }
    });

    server.tool("create_ssh_pair",
      "Create a split-pane terminal pair for SSH/Docker workflows. The 'outside' pane is a local shell; the 'inside' pane automatically runs the connect command (ssh, docker exec, etc.). Use list_terminals to see roles — always run local commands (scp, write_file) in the outside terminal and remote/container commands in the inside terminal.",
      {
        outside_name: z.string().describe("Name for the local (outside) pane"),
        inside_name: z.string().describe("Name for the remote/container (inside) pane"),
        connect_command: z.string().describe('Command to connect to the remote, e.g. "ssh user@host", "docker exec -it mycontainer bash", "kubectl exec -it mypod -- bash"'),
        cwd: z.string().optional().describe("Working directory for the outside pane"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any, async ({ outside_name, inside_name, connect_command, cwd }: { outside_name: string; inside_name: string; connect_command: string; cwd?: string }): Promise<ToolResult> => {
        try { return ok(await this.tm.createSshPair(outside_name, inside_name, connect_command, cwd)); } catch (e) { return fail(e); }
      });

    server.tool("run_command",
      "Run a command in a named terminal and wait for it to finish, returning full output and exit code. Works in any shell environment including local, SSH, and Docker sessions.",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { name: z.string(), command: z.string(), timeout: z.number().optional().describe("Timeout ms, default 30000") } as any,
      async ({ name, command, timeout }: { name: string; command: string; timeout?: number }): Promise<ToolResult> => {
        try { return ok(JSON.stringify(await this.tm.runCommand(name, command, timeout))); } catch (e) { return fail(e); }
      });

    server.tool("send_input", "Send raw text to a terminal without a newline (for interactive prompts like y/n)", {
      name: z.string(),
      text: z.string(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any, async ({ name, text }: { name: string; text: string }): Promise<ToolResult> => {
      try { return ok(await this.tm.sendInput(name, text)); } catch (e) { return fail(e); }
    });

    server.tool("read_output", "Read recent output from a named terminal", {
      name: z.string(),
      lines: z.number().optional().describe("Number of lines to return (default 50)"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any, async ({ name, lines }: { name: string; lines?: number }): Promise<ToolResult> => {
      try { return ok(await this.tm.readOutput(name, lines)); } catch (e) { return fail(e); }
    });

    server.tool("list_terminals", "List all managed terminals and their alive status",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any, async (): Promise<ToolResult> => {
      try { return ok(JSON.stringify(await this.tm.listTerminals(), null, 2)); } catch (e) { return fail(e); }
    });

    server.tool("close_terminal", "Close a named terminal (kills the tmux session)", {
      name: z.string(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any, async ({ name }: { name: string }): Promise<ToolResult> => {
      try { return ok(await this.tm.closeTerminal(name)); } catch (e) { return fail(e); }
    });

    server.tool("write_file",
      "Write content to a file. For local paths, writes directly. For remote paths (user@host:/path), writes to a local temp file then SCPs it over and cleans up.",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { path: z.string().describe("Destination: local absolute path OR scp-style remote path (user@host:/remote/path)"), content: z.string().describe("Full file content to write") } as any,
      async ({ path, content }: { path: string; content: string }): Promise<ToolResult> => {
        try { return ok(await this.tm.writeFile(path, content)); } catch (e) { return fail(e); }
      });

    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}
