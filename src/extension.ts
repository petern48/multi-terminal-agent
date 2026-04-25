import * as vscode from "vscode";
import { TerminalManager } from "./terminalManager";
import { MCPServer } from "./mcpServer";

export function activate(context: vscode.ExtensionContext): void {
  const tm = new TerminalManager(context);
  const port = vscode.workspace.getConfiguration("multiTerminal").get<number>("port", 3456);
  const mcp = new MCPServer(tm);
  mcp.start(port);

  context.subscriptions.push(
    { dispose: () => mcp.stop() },
    vscode.commands.registerCommand("multiTerminal.showStatus", () => {
      const terms = tm.listTerminals();
      const names = terms.map((t) => `${t.name}${t.alive ? "" : " (closed)"}`).join(", ") || "none";
      vscode.window.showInformationMessage(`Multi-Terminal: MCP on :${port} | Terminals: ${names}`);
    })
  );

  vscode.window.showInformationMessage(`Multi-Terminal: MCP server started on port ${port}`);
}

export function deactivate(): void {}
