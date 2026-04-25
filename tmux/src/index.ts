import { TerminalManager } from "./terminalManager";
import { MCPServer } from "./mcpServer";

const tm = new TerminalManager();
const server = new MCPServer(tm);
server.start().catch((e) => { console.error(e); process.exit(1); });
