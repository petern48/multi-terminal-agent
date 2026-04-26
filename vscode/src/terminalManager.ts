import * as vscode from "vscode";
import { randomUUID } from "crypto";

export interface PortMapping {
  remote: number;
  local: number;
}

export type RemoteCwdSource = "explicit" | "probed";

interface TerminalEntry {
  terminal: vscode.Terminal;
  outputBuffer: string[];
  alive: boolean;
  role?: "local" | "remote";
  ports?: PortMapping[];
  /** Remote session cwd (e.g. after SSH) — in-memory only, lives with this terminal. */
  remoteCwd?: string;
  /** How `remoteCwd` was set: user-provided or discovered via `pwd` on the remote. */
  remoteCwdSource?: RemoteCwdSource;
  /** True while a background process is running; blocks run_command until C-c is sent. */
  blocked?: boolean;
}

function injectSshPortForwarding(command: string, ports: PortMapping[]): string {
  if (!ports.length || !/^\s*ssh\s/.test(command)) return command;
  const missing = ports.filter((p) => !command.includes(`-L ${p.local}:`));
  if (!missing.length) return command;
  const flags = missing.map((p) => `-L ${p.local}:localhost:${p.remote}`).join(" ");
  return command.replace(/^(\s*ssh\s)/, `$1${flags} `);
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1B\][^\x07]*\x07/g, "");
}

function quoteBashPath(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

function findProbableAbsPathInOutput(text: string): string | undefined {
  const lines = text.split("\n").map((l) => l.trim().replace(/\r$/, "")).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.length > 1 && line.startsWith("/") && !line.includes(" ")) return line;
    if (line.length > 1 && line.startsWith("/") && /^\/[\w/.-]+$/.test(line)) return line;
  }
  return undefined;
}

export class TerminalManager {
  private terminals = new Map<string, TerminalEntry>();
  private static readonly MAX_BUFFER = 500;
  // TerminalShellExecution.read() is single-consumer — only this handler may call read().
  // runCommand waits for onDidEndTerminalShellExecution and reads new lines from outputBuffer
  // (snapshot index before executeCommand). That avoids hanging on read() iterators that never
  // complete on some remotes while still returning captured output.

  constructor(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.window.onDidStartTerminalShellExecution(async (event) => {
        const entry = this.findByTerminal(event.terminal);
        if (!entry) return;
        const stream = event.execution.read();
        for await (const data of stream) {
          const clean = stripAnsi(data);
          const lines = clean.split("\n");
          entry.outputBuffer.push(...lines);
          if (entry.outputBuffer.length > TerminalManager.MAX_BUFFER) {
            entry.outputBuffer.splice(0, entry.outputBuffer.length - TerminalManager.MAX_BUFFER);
          }
        }
      }),
      vscode.window.onDidEndTerminalShellExecution((event) => {
        const entry = this.findByTerminal(event.terminal);
        if (entry) entry.blocked = false;
      }),
      vscode.window.onDidCloseTerminal((t) => {
        const entry = this.findByTerminal(t);
        if (entry) entry.alive = false;
      })
    );
  }

  createTerminal(name: string, cwd?: string): string {
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

  /**
   * After SSH (or similar) is up, records the remote filesystem cwd on the remote `TerminalEntry`
   * (`remoteCwd`, `remoteCwdSource`) and includes it in the return text for agents.
   */
  async createSshPair(
    localName: string,
    remoteName: string,
    connectCommand: string,
    cwd?: string,
    ports?: PortMapping[],
    remote_cwd?: string
  ): Promise<string> {
    for (const n of [localName, remoteName]) {
      const existing = this.terminals.get(n);
      if (existing?.alive) existing.terminal.dispose();
      this.terminals.delete(n);
    }

    const localTerminal = vscode.window.createTerminal({ name: localName, cwd });
    this.terminals.set(localName, { terminal: localTerminal, outputBuffer: [], alive: true, role: "local", ports });

    const remoteTerminal = vscode.window.createTerminal({ name: remoteName, location: { parentTerminal: localTerminal } });
    this.terminals.set(remoteName, {
      terminal: remoteTerminal,
      outputBuffer: [],
      alive: true,
      role: "remote",
      ports,
    });

    const effectiveCommand = ports ? injectSshPortForwarding(connectCommand, ports) : connectCommand;
    remoteTerminal.sendText(effectiveCommand, true);
    localTerminal.show();

    const explicit = remote_cwd?.trim();
    await new Promise((r) => setTimeout(r, 2800));

    const remoteEntry = this.terminals.get(remoteName);
    if (remoteEntry) {
      if (explicit) {
        remoteTerminal.sendText(`cd ${quoteBashPath(explicit)} 2>/dev/null || true; pwd -P`, true);
        await new Promise((r) => setTimeout(r, 1200));
        const out = this.readOutput(remoteName, 50);
        const path = findProbableAbsPathInOutput(out) || explicit;
        remoteEntry.remoteCwd = path;
        remoteEntry.remoteCwdSource = "explicit";
      } else {
        remoteTerminal.sendText("pwd -P", true);
        await new Promise((r) => setTimeout(r, 1200));
        const out = this.readOutput(remoteName, 50);
        const path = findProbableAbsPathInOutput(out);
        if (path) {
          remoteEntry.remoteCwd = path;
          remoteEntry.remoteCwdSource = "probed";
        }
      }
    }

    const portsSummary = ports && ports.length > 0
      ? `\n  ports:   ${ports.map((p) => `remote:${p.remote} → local:${p.local}`).join(", ")}`
      : "";
    const re = this.terminals.get(remoteName);
    const jsonLine = re?.remoteCwd
      ? `\n\n${JSON.stringify({
          remote_cwd: re.remoteCwd,
          remote_cwd_source: re.remoteCwdSource,
        })}`
      : "";
    return `Created SSH pair:\n  local:  "${localName}" (local commands)\n  remote: "${remoteName}" (runs inside the remote/container)${portsSummary}${jsonLine}`;
  }

  createTerminalPair(name1: string, name2: string, cwd?: string): string {
    const t1 = vscode.window.createTerminal({ name: name1, cwd });
    this.terminals.set(name1, { terminal: t1, outputBuffer: [], alive: true });
    const t2 = vscode.window.createTerminal({ name: name2, cwd, location: { parentTerminal: t1 } });
    this.terminals.set(name2, { terminal: t2, outputBuffer: [], alive: true });
    t1.show();
    return `Created terminals "${name1}" (left) and "${name2}" (right) side by side`;
  }

  async runCommand(
    name: string,
    command: string,
    timeoutMs = 30000,
    opts?: { background?: boolean },
  ): Promise<{ output: string; exitCode: number | undefined }> {
    const entry = this.getAlive(name);

    if (opts?.background) {
      entry.terminal.sendText(command, true);
      entry.terminal.show(false);
      await new Promise((r) => setTimeout(r, 1000));
      entry.blocked = true;
      return { output: this.readOutput(name, 50), exitCode: undefined };
    }

    if (entry.blocked) {
      throw new Error(
        `Terminal "${name}" has a background process running. ` +
        `Send C-c first with send_input('C-c'), then retry the command.`
      );
    }

    if (entry.role === "remote") {
      return this.runCommandRemote(name, command, timeoutMs, entry);
    }

    if (!entry.terminal.shellIntegration) {
      throw new Error(`Shell integration not active on "${name}" — run any command manually first to activate it`);
    }

    const bufferStart = entry.outputBuffer.length;
    const execution = entry.terminal.shellIntegration.executeCommand(command);

    let endListenerDisposable: vscode.Disposable | undefined;
    const exitPromise = new Promise<number | undefined>((resolve) => {
      endListenerDisposable = vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.execution !== execution) return;
        endListenerDisposable?.dispose();
        endListenerDisposable = undefined;
        resolve(event.exitCode);
      });
    });

    let timerId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => {
        endListenerDisposable?.dispose();
        endListenerDisposable = undefined;
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    let exitCode: number | undefined;
    try {
      exitCode = await Promise.race([exitPromise, timeoutPromise]);
    } catch (e) {
      endListenerDisposable?.dispose();
      throw e;
    } finally {
      clearTimeout(timerId!);
    }

    // Trailing lines can land in the buffer slightly after the end event
    await new Promise((r) => setTimeout(r, 150));
    const output = entry.outputBuffer.slice(bufferStart).join("\n");
    return { output, exitCode };
  }

  private async runCommandRemote(
    _name: string,
    command: string,
    timeoutMs: number,
    entry: TerminalEntry,
  ): Promise<{ output: string; exitCode: number }> {
    const bufferStart = entry.outputBuffer.length;
    const token = randomUUID().replace(/-/g, "");
    const endLineRe = new RegExp(`__MTA_EX__${token}__(\\d+)`);
    const wrapped = `set +e; ${command}\n__mta__ec=$?; printf '\\n__MTA_EX__${token}__%s\\n' "$__mta__ec"`;
    entry.terminal.sendText(wrapped, true);
    entry.terminal.show(false);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 80));
      const chunk = entry.outputBuffer.slice(bufferStart).join("\n");
      const m = endLineRe.exec(chunk);
      if (m) {
        return { output: chunk.slice(0, m.index).trimEnd(), exitCode: parseInt(m[1]!, 10) };
      }
    }
    throw new Error(`Command timed out after ${timeoutMs}ms`);
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

  sendInput(name: string, text: string): string {
    const entry = this.getAlive(name);
    // Map common control sequences so callers can use tmux-style names
    const resolved = text === "C-c" ? "\x03" : text === "C-d" ? "\x04" : text;
    if (resolved === "\x03") entry.blocked = false;
    entry.terminal.sendText(resolved, false);
    return `Sent input to "${name}"`;
  }

  readOutput(name: string, lines = 50): string {
    const entry = this.terminals.get(name);
    if (!entry) throw new Error(`Terminal "${name}" not found`);
    if (entry.outputBuffer.length === 0) {
      return "(no output captured yet — shell integration may not be active)";
    }
    return entry.outputBuffer.slice(-lines).join("\n");
  }

  listTerminals(): {
    name: string;
    alive: boolean;
    blocked?: boolean;
    role?: "local" | "remote";
    ports?: PortMapping[];
    cwd?: string;
    remote_cwd_source?: RemoteCwdSource;
  }[] {
    return Array.from(this.terminals.entries()).map(([name, e]) => ({
      name,
      alive: e.alive,
      ...(e.blocked ? { blocked: true } : {}),
      ...(e.role ? { role: e.role } : {}),
      ...(e.ports ? { ports: e.ports } : {}),
      ...(e.remoteCwd ? { cwd: e.remoteCwd, ...(e.remoteCwdSource ? { remote_cwd_source: e.remoteCwdSource } : {}) } : {}),
    }));
  }

  /**
   * Write full file content on the machine attached to a named terminal (e.g. SSH-pair "remote")
   * via `python3` + base64 — avoids shell-quoting bugs and works for any UTF-8.
   * Parent directories are created; `path` may use ~ (expanded in that session).
   */
  async writeRemoteFile(terminalName: string, path: string, content: string): Promise<string> {
    const b64 = Buffer.from(content, "utf8").toString("base64");
    const py = [
      "import base64,os,pathlib; p=os.path.expanduser(",
      JSON.stringify(path),
      "); b=",
      JSON.stringify(b64),
      "; pathlib.Path(p).parent.mkdir(parents=True, exist_ok=True); open(p,'wb').write(base64.b64decode(b))",
    ].join("");
    const command = "python3 -c " + JSON.stringify(py);
    const { exitCode, output } = await this.runCommand(terminalName, command, 120_000);
    if (exitCode !== 0) {
      throw new Error(`write_remote_file failed (exit ${exitCode}): ${output || "(no output)"}`);
    }
    const lines = content.split("\n").length;
    return `Wrote ${lines} line${lines === 1 ? "" : "s"} to "${path}" in terminal "${terminalName}"`;
  }

  closeTerminal(name: string): string {
    const entry = this.terminals.get(name);
    if (!entry) throw new Error(`Terminal "${name}" not found`);
    entry.terminal.dispose();
    this.terminals.delete(name);
    return `Closed terminal "${name}"`;
  }

  private getAlive(name: string): TerminalEntry {
    const entry = this.terminals.get(name);
    if (!entry) throw new Error(`Terminal "${name}" not found`);
    if (!entry.alive) throw new Error(`Terminal "${name}" has been closed`);
    return entry;
  }

  private findByTerminal(t: vscode.Terminal): TerminalEntry | undefined {
    for (const entry of this.terminals.values()) {
      if (entry.terminal === t) return entry;
    }
    return undefined;
  }
}
