import { execFile as execFileCb } from "child_process";
import { promisify } from "util";

const execFile = promisify(execFileCb);

interface PortMapping {
  remote: number; // port as seen from the remote/container
  local: number;  // port as seen from the local machine
}

interface TmuxEntry {
  name: string;
  target: string; // tmux address: session name or "session:window.pane"
  alive: boolean;
  role?: "local" | "remote";
  ports?: PortMapping[]; // only set on ssh pair entries
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1B\][^\x07]*\x07/g, "");
}

function uid(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Inject -L flags for any ports not already forwarded. Only applies to ssh commands.
function injectSshPortForwarding(command: string, ports: PortMapping[]): string {
  if (!ports.length || !/^\s*ssh\s/.test(command)) return command;
  const missing = ports.filter((p) => !command.includes(`-L ${p.local}:`));
  if (!missing.length) return command;
  const flags = missing.map((p) => `-L ${p.local}:localhost:${p.remote}`).join(" ");
  return command.replace(/^(\s*ssh\s)/, `$1${flags} `);
}

export class TerminalManager {
  private entries = new Map<string, TmuxEntry>();
  private static readonly PREFIX = "mta_";

  private sid(name: string): string {
    return `${TerminalManager.PREFIX}${name}`;
  }

  private async sessionExists(sid: string): Promise<boolean> {
    try {
      await execFile("tmux", ["has-session", "-t", sid]);
      return true;
    } catch {
      return false;
    }
  }

  async createTerminal(name: string, cwd?: string): Promise<string> {
    const sid = this.sid(name);
    if (await this.sessionExists(sid)) {
      this.entries.set(name, { name, target: sid, alive: true });
      return `Terminal "${name}" already exists (tmux session ${sid})`;
    }
    const args = ["new-session", "-d", "-s", sid];
    if (cwd) args.push("-c", cwd);
    await execFile("tmux", args);
    this.entries.set(name, { name, target: sid, alive: true });
    return `Created terminal "${name}" — attach with: tmux attach -t ${sid}`;
  }

  async createTerminalPair(name1: string, name2: string, cwd?: string): Promise<string> {
    const sid = this.sid(name1);
    if (await this.sessionExists(sid)) {
      await execFile("tmux", ["kill-session", "-t", sid]);
    }
    const args = ["new-session", "-d", "-s", sid];
    if (cwd) args.push("-c", cwd);
    await execFile("tmux", args);

    const splitArgs = ["split-window", "-h", "-t", `${sid}:0`];
    if (cwd) splitArgs.push("-c", cwd);
    await execFile("tmux", splitArgs);

    // Name each pane via title (cosmetic only)
    await execFile("tmux", ["select-pane", "-t", `${sid}:0.0`, "-T", name1]);
    await execFile("tmux", ["select-pane", "-t", `${sid}:0.1`, "-T", name2]);

    this.entries.set(name1, { name: name1, target: `${sid}:0.0`, alive: true });
    this.entries.set(name2, { name: name2, target: `${sid}:0.1`, alive: true });

    return `Created terminals "${name1}" (left) and "${name2}" (right) — attach with: tmux attach -t ${sid}`;
  }

  async createSshPair(localName: string, remoteName: string, connectCommand: string, cwd?: string, ports?: PortMapping[]): Promise<string> {
    const sid = this.sid(localName);
    if (await this.sessionExists(sid)) {
      await execFile("tmux", ["kill-session", "-t", sid]);
    }
    const args = ["new-session", "-d", "-s", sid];
    if (cwd) args.push("-c", cwd);
    await execFile("tmux", args);

    const splitArgs = ["split-window", "-h", "-t", `${sid}:0`];
    if (cwd) splitArgs.push("-c", cwd);
    await execFile("tmux", splitArgs);

    await execFile("tmux", ["select-pane", "-t", `${sid}:0.0`, "-T", localName]);
    await execFile("tmux", ["select-pane", "-t", `${sid}:0.1`, "-T", remoteName]);

    const effectiveCommand = ports ? injectSshPortForwarding(connectCommand, ports) : connectCommand;
    await execFile("tmux", ["send-keys", "-t", `${sid}:0.1`, effectiveCommand, "Enter"]);

    this.entries.set(localName, { name: localName, target: `${sid}:0.0`, alive: true, role: "local", ports });
    this.entries.set(remoteName, { name: remoteName, target: `${sid}:0.1`, alive: true, role: "remote", ports });

    const portsSummary = ports && ports.length > 0
      ? `\n  ports:   ${ports.map((p) => `remote:${p.remote} → local:${p.local}`).join(", ")}`
      : "";
    return `Created SSH pair:\n  local:  "${localName}" (local commands)\n  remote: "${remoteName}" (runs inside the remote/container)${portsSummary}\n\nTo view both panes, run:\n  tmux attach -t ${sid}`;
  }

  async runCommand(
    name: string,
    command: string,
    timeoutMs = 30000,
    opts?: { background?: boolean },
  ): Promise<{ output: string; exitCode: number | undefined }> {
    const entry = this.getAlive(name);

    if (opts?.background) {
      // Start the command in the pane foreground — visible, killable with send_input C-c.
      await execFile("tmux", ["send-keys", "-t", entry.target, command, "Enter"]);
      // Wait briefly then snapshot the pane so the agent can verify startup output.
      await new Promise((r) => setTimeout(r, 1000));  // 1 second
      const snapshot = await this.readOutput(name, 50 /* lines */);
      return { output: snapshot, exitCode: undefined };
    }

    const id = uid();
    const startMarker = `__MTA_START_${id}__`;
    const endMarker = `__MTA_END_${id}__`;

    // Type the command directly — works in any shell (local, SSH, Docker, etc.)
    // Sentinels delimit output; polling capture-pane avoids any dependency on tmux/local files
    const wrapped = `echo '${startMarker}'; ${command}; echo '${endMarker}':$?`;
    await execFile("tmux", ["send-keys", "-t", entry.target, wrapped, "Enter"]);

    // Poll until end marker appears in scrollback
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      const { stdout: raw } = await execFile("tmux", ["capture-pane", "-t", entry.target, "-p", "-S", "-5000"]);
      const lines = stripAnsi(raw).split("\n");

      const endIdx = lines.findLastIndex((l) => l.includes(endMarker));
      if (endIdx === -1) continue;

      const startIdx = lines.findLastIndex((l) => l.includes(startMarker));
      const output = (startIdx !== -1 && endIdx > startIdx)
        ? lines.slice(startIdx + 1, endIdx).join("\n").trim()
        : lines.slice(Math.max(0, endIdx - 100), endIdx).join("\n").trim();

      // capture-pane is width-wrapped, so the echoed "__MTA_END_…__:0" can split
      // across display lines. Join a short window and match the full marker+code.
      const endWindow = lines
        .slice(endIdx, Math.min(lines.length, endIdx + 4))
        .join("");
      const exitRe = new RegExp(
        endMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":(\\d+)",
      );
      const exitM = endWindow.match(exitRe);
      const lineM = (lines[endIdx] ?? "").match(/:(\d+)$/);
      const exitCode = exitM
        ? parseInt(exitM[1], 10)
        : lineM
          ? parseInt(lineM[1], 10)
          : undefined;
      return { output, exitCode };
    }

    return { output: `(timed out after ${timeoutMs}ms)`, exitCode: undefined };
  }

  async sendInput(name: string, text: string): Promise<string> {
    const entry = this.getAlive(name);
    await execFile("tmux", ["send-keys", "-t", entry.target, text]);
    return `Sent input to "${name}"`;
  }

  async readOutput(name: string, lines = 50): Promise<string> {
    const entry = this.getAlive(name);
    const { stdout } = await execFile("tmux", [
      "capture-pane", "-t", entry.target, "-p", "-S", `-${lines}`,
    ]);
    return stripAnsi(stdout).trim();
  }

  async listTerminals(): Promise<{ name: string; alive: boolean }[]> {
    let liveSessions: Set<string>;
    try {
      const { stdout } = await execFile("tmux", ["list-sessions", "-F", "#{session_name}"]);
      liveSessions = new Set(stdout.trim().split("\n").filter(Boolean));
    } catch {
      liveSessions = new Set();
    }

    return Array.from(this.entries.entries()).map(([name, entry]) => {
      // A pane target like "mta_server:0.1" — check the session part
      const sessionName = entry.target.split(":")[0];
      const alive = liveSessions.has(sessionName);
      if (entry.alive !== alive) entry.alive = alive;
      return { name, alive, role: entry.role, ports: entry.ports };
    });
  }

  async closeTerminal(name: string): Promise<string> {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`Terminal "${name}" not found`);
    const sessionName = entry.target.split(":")[0];
    // Only kill the session if this entry owns the root pane (pane 0 or whole session)
    const isPrimaryPane = !entry.target.includes(".") || entry.target.endsWith(".0");
    if (isPrimaryPane) {
      await execFile("tmux", ["kill-session", "-t", sessionName]);
    }
    this.entries.delete(name);
    return `Closed terminal "${name}"`;
  }

  async writeRemoteFile(terminalName: string, path: string, content: string): Promise<string> {
    const b64 = Buffer.from(content, "utf8").toString("base64");
    const token = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const tmpFile = `/tmp/mta_write_${token}.b64`;

    // b64 chars are [A-Za-z0-9+/=] — safe inside single quotes. Write in chunks so each
    // send-keys call is short and doesn't stall the PTY input buffer.
    const CHUNK = 4000;
    if (b64.length === 0) {
      await this.runCommand(terminalName, `> ${tmpFile}`, 10_000);
    } else {
      for (let i = 0; i < b64.length; i += CHUNK) {
        const chunk = b64.slice(i, i + CHUNK);
        const op = i === 0 ? ">" : ">>";
        const { exitCode } = await this.runCommand(terminalName, `printf '%s' '${chunk}' ${op} ${tmpFile}`, 15_000);
        if (exitCode !== 0) throw new Error(`write_remote_file: failed writing chunk at offset ${i}`);
      }
    }

    const py = `import base64,os,pathlib; p=os.path.expanduser(${JSON.stringify(path)}); pathlib.Path(p).parent.mkdir(parents=True,exist_ok=True); open(p,'wb').write(base64.b64decode(open('${tmpFile}').read()))`;
    const { exitCode, output } = await this.runCommand(terminalName, "python3 -c " + JSON.stringify(py), 30_000);
    await this.runCommand(terminalName, `rm -f ${tmpFile}`, 5_000).catch(() => {});

    if (exitCode !== 0) {
      throw new Error(`write_remote_file: decode failed (exit ${exitCode}): ${output || "(no output)"}`);
    }
    const lines = content.split("\n").length;
    return `Wrote ${lines} line${lines === 1 ? "" : "s"} to "${path}" in terminal "${terminalName}"`;
  }

  private getAlive(name: string): TmuxEntry {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`Terminal "${name}" not found`);
    if (!entry.alive) throw new Error(`Terminal "${name}" has been closed`);
    return entry;
  }
}
