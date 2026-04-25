import { execFile as execFileCb } from "child_process";
import { writeFile, readFile, unlink, mkdir } from "fs/promises";
import { resolve, dirname, relative } from "path";
import { promisify } from "util";

const execFile = promisify(execFileCb);

interface TmuxEntry {
  name: string;
  target: string; // tmux address: session name or "session:window.pane"
  alive: boolean;
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

  async runCommand(name: string, command: string, timeoutMs = 30000): Promise<{ output: string; exitCode: number | undefined }> {
    const entry = this.getAlive(name);
    const id = uid();
    const channel = `mta_ch_${id}`;
    const scriptFile = `/tmp/mta_cmd_${id}.sh`;
    const outFile = `/tmp/mta_out_${id}`;
    const exitFile = `/tmp/mta_exit_${id}`;

    // Write a temp script so the pane only shows "bash /tmp/mta_cmd_xxx.sh"
    const script = [
      "#!/bin/bash",
      `${command} 2>&1 | tee ${outFile}`,
      `echo \${PIPESTATUS[0]} > ${exitFile}`,
      `tmux wait-for -S ${channel}`,
    ].join("\n");
    await writeFile(scriptFile, script, { mode: 0o755 });

    await execFile("tmux", ["send-keys", "-t", entry.target, `bash ${scriptFile}`, "Enter"]);

    // Block until the signal fires (or timeout)
    try {
      await execFile("tmux", ["wait-for", channel], { timeout: timeoutMs });
    } catch (e: unknown) {
      const isTimeout = e instanceof Error && e.message.includes("timed out");
      if (!isTimeout) throw e;
      return { output: `(timed out after ${timeoutMs}ms)`, exitCode: undefined };
    }

    const output = stripAnsi(await readFile(outFile, "utf8").catch(() => "")).trim();
    const exitCodeStr = (await readFile(exitFile, "utf8").catch(() => "")).trim();
    const exitCode = exitCodeStr ? parseInt(exitCodeStr, 10) : undefined;

    // Clean up temp files
    await Promise.all([unlink(scriptFile), unlink(outFile), unlink(exitFile)].map((p) => p.catch(() => {})));

    return { output, exitCode };
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
      return { name, alive };
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

  async writeFile(filePath: string, content: string): Promise<string> {
    const cwd = process.cwd();
    const abs = resolve(cwd, filePath);
    if (relative(cwd, abs).startsWith("..")) {
      throw new Error(`Path "${filePath}" is outside the working directory (${cwd})`);
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    const lines = content.split("\n").length;
    return `Wrote ${lines} line${lines === 1 ? "" : "s"} to "${abs}"`;
  }

  private getAlive(name: string): TmuxEntry {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`Terminal "${name}" not found`);
    if (!entry.alive) throw new Error(`Terminal "${name}" has been closed`);
    return entry;
  }
}
