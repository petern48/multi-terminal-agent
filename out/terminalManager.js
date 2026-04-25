"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TerminalManager = void 0;
const vscode = __importStar(require("vscode"));
function stripAnsi(str) {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1B\][^\x07]*\x07/g, "");
}
class TerminalManager {
    constructor(context) {
        this.terminals = new Map();
        // Capture output for commands run via shellIntegration.executeCommand (or sent via sendText when SI is active)
        context.subscriptions.push(vscode.window.onDidStartTerminalShellExecution(async (event) => {
            const entry = this.findByTerminal(event.terminal);
            if (!entry)
                return;
            const stream = event.execution.read();
            for await (const data of stream) {
                const clean = stripAnsi(data);
                const lines = clean.split("\n");
                entry.outputBuffer.push(...lines);
                if (entry.outputBuffer.length > TerminalManager.MAX_BUFFER) {
                    entry.outputBuffer.splice(0, entry.outputBuffer.length - TerminalManager.MAX_BUFFER);
                }
            }
        }), vscode.window.onDidCloseTerminal((t) => {
            const entry = this.findByTerminal(t);
            if (entry)
                entry.alive = false;
        }));
    }
    createTerminal(name, cwd) {
        const existing = this.terminals.get(name);
        if (existing?.alive) {
            existing.terminal.show();
            return `Terminal "${name}" already exists and is active`;
        }
        const terminal = vscode.window.createTerminal({ name, cwd });
        this.terminals.set(name, { terminal, outputBuffer: [], alive: true });
        terminal.show();
        return `Created terminal "${name}"`;
    }
    createTerminalPair(name1, name2, cwd) {
        const t1 = vscode.window.createTerminal({ name: name1, cwd });
        this.terminals.set(name1, { terminal: t1, outputBuffer: [], alive: true });
        const t2 = vscode.window.createTerminal({ name: name2, cwd, location: { parentTerminal: t1 } });
        this.terminals.set(name2, { terminal: t2, outputBuffer: [], alive: true });
        t1.show();
        return `Created terminals "${name1}" (left) and "${name2}" (right) side by side`;
    }
    async runCommand(name, command, timeoutMs = 30000) {
        const entry = this.getAlive(name);
        if (!entry.terminal.shellIntegration) {
            throw new Error(`Shell integration not active on "${name}" — run any command manually first to activate it`);
        }
        const execution = entry.terminal.shellIntegration.executeCommand(command);
        // Capture exit code from the end event matched by execution identity
        let exitCode;
        const exitCodePromise = new Promise((resolve) => {
            const disposable = vscode.window.onDidEndTerminalShellExecution((event) => {
                if (event.execution === execution) {
                    disposable.dispose();
                    resolve(event.exitCode);
                }
            });
        });
        const chunks = [];
        const readAll = async () => {
            for await (const data of execution.read()) {
                chunks.push(stripAnsi(data));
            }
            return chunks.join("");
        };
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`Command timed out after ${timeoutMs}ms`)), timeoutMs));
        const output = await Promise.race([readAll(), timeout]);
        exitCode = await Promise.race([exitCodePromise, new Promise((r) => setTimeout(() => r(undefined), 500))]);
        return { output, exitCode };
    }
    // sendCommand(name: string, command: string): string {
    //   const entry = this.getAlive(name);
    //   entry.terminal.show(true);
    //   // Use shell integration executeCommand if available (enables output capture)
    //   if (entry.terminal.shellIntegration) {
    //     entry.terminal.shellIntegration.executeCommand(command);
    //   } else {
    //     entry.terminal.sendText(command, true);
    //   }
    //   return `Sent command to "${name}": ${command}`;
    // }
    sendInput(name, text) {
        const entry = this.getAlive(name);
        entry.terminal.sendText(text, false);
        return `Sent input to "${name}"`;
    }
    readOutput(name, lines = 50) {
        const entry = this.terminals.get(name);
        if (!entry)
            throw new Error(`Terminal "${name}" not found`);
        if (entry.outputBuffer.length === 0) {
            return "(no output captured yet — shell integration may not be active)";
        }
        return entry.outputBuffer.slice(-lines).join("\n");
    }
    listTerminals() {
        return Array.from(this.terminals.entries()).map(([name, e]) => ({
            name,
            alive: e.alive,
        }));
    }
    closeTerminal(name) {
        const entry = this.terminals.get(name);
        if (!entry)
            throw new Error(`Terminal "${name}" not found`);
        entry.terminal.dispose();
        this.terminals.delete(name);
        return `Closed terminal "${name}"`;
    }
    getAlive(name) {
        const entry = this.terminals.get(name);
        if (!entry)
            throw new Error(`Terminal "${name}" not found`);
        if (!entry.alive)
            throw new Error(`Terminal "${name}" has been closed`);
        return entry;
    }
    findByTerminal(t) {
        for (const entry of this.terminals.values()) {
            if (entry.terminal === t)
                return entry;
        }
        return undefined;
    }
}
exports.TerminalManager = TerminalManager;
TerminalManager.MAX_BUFFER = 500;
//# sourceMappingURL=terminalManager.js.map