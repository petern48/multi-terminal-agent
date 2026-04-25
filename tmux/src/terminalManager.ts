import { execFile as execFileCb } from "child_process";
import { writeFile, readFile, unlink, mkdir, rename } from "fs/promises";
import { resolve, dirname } from "path";
import { tmpdir } from "os";
import { promisify } from "util";

const execFile = promisify(execFileCb);

interface TmuxEntry {
  name: string;
  target: string; // tmux address: session name or "session:window.pane"
  alive: boolean;
  role?: "outside" | "inside";
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1B\][^\x07]*\x07/g, "");
}

function uid(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

  async createSshPair(outsideName: string, insideName: string, connectCommand: string, cwd?: string): Promise<string> {
    const sid = this.sid(outsideName);
    if (await this.sessionExists(sid)) {
      await execFile("tmux", ["kill-session", "-t", sid]);
    }
    const args = ["new-session", "-d", "-s", sid];
    if (cwd) args.push("-c", cwd);
    await execFile("tmux", args);

    const splitArgs = ["split-window", "-h", "-t", `${sid}:0`];
    if (cwd) splitArgs.push("-c", cwd);
    await execFile("tmux", splitArgs);

    await execFile("tmux", ["select-pane", "-t", `${sid}:0.0`, "-T", outsideName]);
    await execFile("tmux", ["select-pane", "-t", `${sid}:0.1`, "-T", insideName]);

    await execFile("tmux", ["send-keys", "-t", `${sid}:0.1`, connectCommand, "Enter"]);

    this.entries.set(outsideName, { name: outsideName, target: `${sid}:0.0`, alive: true, role: "outside" });
    this.entries.set(insideName, { name: insideName, target: `${sid}:0.1`, alive: true, role: "inside" });

    return `Created SSH pair:\n  outside: "${outsideName}" (local commands)\n  inside:  "${insideName}" (runs inside the remote/container)\n\nTo view both panes, run:\n  tmux attach -t ${sid}`;
  }

  async runCommand(name: string, command: string, timeoutMs = 30000): Promise<{ output: string; exitCode: number | undefined }> {
    const entry = this.getAlive(name);
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

      const match = lines[endIdx].match(/:(\d+)$/);
      const exitCode = match ? parseInt(match[1], 10) : undefined;
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
      return { name, alive, role: entry.role };
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

  async writeFile(path: string, content: string): Promise<string> {
    const tmpPath = resolve(tmpdir(), `mta_wf_${uid()}`);
    await writeFile(tmpPath, content, "utf8");
    try {
      const isRemote = /^[^/\s]+@[^:\s]+:/.test(path); // user@host:/path
      if (isRemote) {
        await execFile("scp", [tmpPath, path]);
      } else {
        const abs = resolve(path);
        await mkdir(dirname(abs), { recursive: true });
        await rename(tmpPath, abs);
      }
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
    const lines = content.split("\n").length;
    return `Wrote ${lines} line${lines === 1 ? "" : "s"} to "${path}"`;
  }

  private getAlive(name: string): TmuxEntry {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`Terminal "${name}" not found`);
    if (!entry.alive) throw new Error(`Terminal "${name}" has been closed`);
    return entry;
  }
}
