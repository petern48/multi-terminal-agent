"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const terminalManager_1 = require("./terminalManager");
const mcpServer_1 = require("./mcpServer");
const tm = new terminalManager_1.TerminalManager();
const server = new mcpServer_1.MCPServer(tm);
server.start().catch((e) => { console.error(e); process.exit(1); });
//# sourceMappingURL=index.js.map