"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TerminalManager = void 0;
const child_process_1 = require("child_process");
const promises_1 = require("fs/promises");
const path_1 = require("path");
const os_1 = require("os");
const util_1 = require("util");
const execFile = (0, util_1.promisify)(child_process_1.execFile);
const REMOTE_SCP = /^[^/\s]+@[^:\s]+:(.+)$/;
const REMOTE_PATH_HAS_TILDE = /^~\//; // we only rewrite ~/foo, not a bare ~
/**
 * scp(1) passes paths to the sftp server, which typically expands `~` to the account
 * home from the password database — not the interactive $HOME (e.g. ML platforms set
 * HOME to a workspace in profile). We probe a login shell over SSH to match what most
 * users expect from `~` in their session.
 */
async function resolveTildeInRemoteScpPath(userAtHost, remotePath) {
    if (!REMOTE_PATH_HAS_TILDE.test(remotePath))
        return remotePath;
    // bash -l -c "printf %s \"$HOME\""
    const homeProbe = "bash -l -c " + JSON.stringify('printf %s "$HOME"');
    const { stdout } = await execFile("ssh", [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=20",
        userAtHost,
        homeProbe,
    ]).catch(() => ({ stdout: "" }));
    const home = stdout.trim();
    if (!home)
        return remotePath;
    // remotePath is ~/relpath; drop ~ to get /relpath, then home + that suffix (POSIX join)
    return home + remotePath.slice(1);
}
function stripAnsi(str) {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1B\][^\x07]*\x07/g, "");
}
function uid() {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
// Inject -L flags for any ports not already forwarded. Only applies to ssh commands.
function injectSshPortForwarding(command, ports) {
    if (!ports.length || !/^\s*ssh\s/.test(command))
        return command;
    const missing = ports.filter((p) => !command.includes(`-L ${p.local}:`));
    if (!missing.length)
        return command;
    const flags = missing.map((p) => `-L ${p.local}:localhost:${p.remote}`).join(" ");
    return command.replace(/^(\s*ssh\s)/, `$1${flags} `);
}
class TerminalManager {
    entries = new Map();
    static PREFIX = "mta_";
    sid(name) {
        return `${TerminalManager.PREFIX}${name}`;
    }
    async sessionExists(sid) {
        try {
            await execFile("tmux", ["has-session", "-t", sid]);
            return true;
        }
        catch {
            return false;
        }
    }
    async createTerminal(name, cwd) {
        const sid = this.sid(name);
        if (await this.sessionExists(sid)) {
            this.entries.set(name, { name, target: sid, alive: true });
            return `Terminal "${name}" already exists (tmux session ${sid})`;
        }
        const args = ["new-session", "-d", "-s", sid];
        if (cwd)
            args.push("-c", cwd);
        await execFile("tmux", args);
        this.entries.set(name, { name, target: sid, alive: true });
        return `Created terminal "${name}" — attach with: tmux attach -t ${sid}`;
    }
    async createTerminalPair(name1, name2, cwd) {
        const sid = this.sid(name1);
        if (await this.sessionExists(sid)) {
            await execFile("tmux", ["kill-session", "-t", sid]);
        }
        const args = ["new-session", "-d", "-s", sid];
        if (cwd)
            args.push("-c", cwd);
        await execFile("tmux", args);
        const splitArgs = ["split-window", "-h", "-t", `${sid}:0`];
        if (cwd)
            splitArgs.push("-c", cwd);
        await execFile("tmux", splitArgs);
        // Name each pane via title (cosmetic only)
        await execFile("tmux", ["select-pane", "-t", `${sid}:0.0`, "-T", name1]);
        await execFile("tmux", ["select-pane", "-t", `${sid}:0.1`, "-T", name2]);
        this.entries.set(name1, { name: name1, target: `${sid}:0.0`, alive: true });
        this.entries.set(name2, { name: name2, target: `${sid}:0.1`, alive: true });
        return `Created terminals "${name1}" (left) and "${name2}" (right) — attach with: tmux attach -t ${sid}`;
    }
    async createSshPair(localName, remoteName, connectCommand, cwd, ports) {
        const sid = this.sid(localName);
        if (await this.sessionExists(sid)) {
            await execFile("tmux", ["kill-session", "-t", sid]);
        }
        const args = ["new-session", "-d", "-s", sid];
        if (cwd)
            args.push("-c", cwd);
        await execFile("tmux", args);
        const splitArgs = ["split-window", "-h", "-t", `${sid}:0`];
        if (cwd)
            splitArgs.push("-c", cwd);
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
    async runCommand(name, command, timeoutMs = 30000, opts) {
        const entry = this.getAlive(name);
        if (opts?.background) {
            // Start the command in the pane foreground — visible, killable with send_input C-c.
            await execFile("tmux", ["send-keys", "-t", entry.target, command, "Enter"]);
            return { output: "Command started (running in terminal foreground)", exitCode: undefined };
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
            if (endIdx === -1)
                continue;
            const startIdx = lines.findLastIndex((l) => l.includes(startMarker));
            const output = (startIdx !== -1 && endIdx > startIdx)
                ? lines.slice(startIdx + 1, endIdx).join("\n").trim()
                : lines.slice(Math.max(0, endIdx - 100), endIdx).join("\n").trim();
            // capture-pane is width-wrapped, so the echoed "__MTA_END_…__:0" can split
            // across display lines. Join a short window and match the full marker+code.
            const endWindow = lines
                .slice(endIdx, Math.min(lines.length, endIdx + 4))
                .join("");
            const exitRe = new RegExp(endMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":(\\d+)");
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
    async sendInput(name, text) {
        const entry = this.getAlive(name);
        await execFile("tmux", ["send-keys", "-t", entry.target, text]);
        return `Sent input to "${name}"`;
    }
    async readOutput(name, lines = 50) {
        const entry = this.getAlive(name);
        const { stdout } = await execFile("tmux", [
            "capture-pane", "-t", entry.target, "-p", "-S", `-${lines}`,
        ]);
        return stripAnsi(stdout).trim();
    }
    async listTerminals() {
        let liveSessions;
        try {
            const { stdout } = await execFile("tmux", ["list-sessions", "-F", "#{session_name}"]);
            liveSessions = new Set(stdout.trim().split("\n").filter(Boolean));
        }
        catch {
            liveSessions = new Set();
        }
        return Array.from(this.entries.entries()).map(([name, entry]) => {
            // A pane target like "mta_server:0.1" — check the session part
            const sessionName = entry.target.split(":")[0];
            const alive = liveSessions.has(sessionName);
            if (entry.alive !== alive)
                entry.alive = alive;
            return { name, alive, role: entry.role, ports: entry.ports };
        });
    }
    async closeTerminal(name) {
        const entry = this.entries.get(name);
        if (!entry)
            throw new Error(`Terminal "${name}" not found`);
        const sessionName = entry.target.split(":")[0];
        // Only kill the session if this entry owns the root pane (pane 0 or whole session)
        const isPrimaryPane = !entry.target.includes(".") || entry.target.endsWith(".0");
        if (isPrimaryPane) {
            await execFile("tmux", ["kill-session", "-t", sessionName]);
        }
        this.entries.delete(name);
        return `Closed terminal "${name}"`;
    }
    async writeFile(path, content, options) {
        if (options?.target_terminal) {
            if (/^[^/\s]+@[^:\s]+:/.test(path)) {
                throw new Error("When target_terminal is set, path is a local path in that session (not user@host:...)");
            }
            const b64 = Buffer.from(content, "utf8").toString("base64");
            const py = [
                "import base64,os,pathlib; p=os.path.expanduser(",
                JSON.stringify(path),
                "); b=",
                JSON.stringify(b64),
                "; pathlib.Path(p).parent.mkdir(parents=True, exist_ok=True); open(p,'wb').write(base64.b64decode(b))",
            ].join("");
            const command = "python3 -c " + JSON.stringify(py);
            const { exitCode, output } = await this.runCommand(options.target_terminal, command, 120000);
            if (exitCode == null) {
                throw new Error(`write via ${options.target_terminal} could not parse exit status (tmux capture wrapped oddly): ${output || "(no output)"}`);
            }
            if (exitCode !== 0) {
                throw new Error(`write via ${options.target_terminal} failed (exit ${exitCode}): ${output || "(no output)"}`);
            }
            const lines = content.split("\n").length;
            return `Wrote ${lines} line${lines === 1 ? "" : "s"} to "${path}" in terminal "${options.target_terminal}" (session HOME)`;
        }
        const tmpPath = (0, path_1.resolve)((0, os_1.tmpdir)(), `mta_wf_${uid()}`);
        await (0, promises_1.writeFile)(tmpPath, content, "utf8");
        let effectivePath = path;
        try {
            const isRemote = /^[^/\s]+@[^:\s]+:/.test(path); // user@host:/path
            if (isRemote) {
                const m = path.match(REMOTE_SCP);
                if (m) {
                    const uAtH = path.slice(0, path.indexOf(":"));
                    const remotePath = m[1];
                    const resolvedRemote = await resolveTildeInRemoteScpPath(uAtH, remotePath);
                    effectivePath = resolvedRemote === remotePath ? path : `${uAtH}:${resolvedRemote}`;
                }
                await execFile("scp", [tmpPath, effectivePath]);
            }
            else {
                const abs = (0, path_1.resolve)(path);
                await (0, promises_1.mkdir)((0, path_1.dirname)(abs), { recursive: true });
                await (0, promises_1.rename)(tmpPath, abs);
            }
        }
        finally {
            await (0, promises_1.unlink)(tmpPath).catch(() => { });
        }
        const lines = content.split("\n").length;
        const note = effectivePath !== path ? ` (remote ~ resolved to a login-style HOME, scp target: ${effectivePath})` : "";
        return `Wrote ${lines} line${lines === 1 ? "" : "s"} to "${path}"${note}`;
    }
    async patchFile(terminalName, filepath, unifiedDiff, cwd) {
        const tmpPatch = `/tmp/mta_patch_${uid()}.patch`;
        const b64 = Buffer.from(unifiedDiff, "utf8").toString("base64");
        // Write the patch to a temp file via Python (cross-platform base64 decode)
        const py = `import base64; open(${JSON.stringify(tmpPatch)}, "wb").write(base64.b64decode(${JSON.stringify(b64)}))`;
        const { exitCode: wExit, output: wOut } = await this.runCommand(terminalName, `python3 -c ${JSON.stringify(py)}`, 10000);
        if (wExit !== 0)
            throw new Error(`Failed to write patch file: ${wOut}`);
        // Display the diff with ANSI colors: bright red for removed, bright green for added, cyan for hunks
        const colorize = `awk 'BEGIN{R="\\033[91m";G="\\033[92m";C="\\033[36m";N="\\033[0m"} /^\\+\\+\\+/{print;next} /^---/{print;next} /^\\+/{print G$0 N;next} /^-/{print R$0 N;next} /^@@/{print C$0 N;next} {print}' ${tmpPatch}`;
        await this.runCommand(terminalName, colorize, 10000);
        // Apply: git apply first (handles a/b/ prefixes), fall back to patch -p1
        const prefix = cwd ? `cd ${JSON.stringify(cwd)} && ` : "";
        const { exitCode, output } = await this.runCommand(terminalName, `${prefix}(git apply ${tmpPatch} 2>/dev/null || patch -p1 < ${tmpPatch})`, 30000);
        await this.runCommand(terminalName, `rm -f ${tmpPatch}`, 5000).catch(() => { });
        if (exitCode !== 0)
            throw new Error(`Patch apply failed (exit ${exitCode}): ${output}`);
        return `Patched "${filepath}" in terminal "${terminalName}"${output ? `:\n${output}` : ""}`;
    }
    getAlive(name) {
        const entry = this.entries.get(name);
        if (!entry)
            throw new Error(`Terminal "${name}" not found`);
        if (!entry.alive)
            throw new Error(`Terminal "${name}" has been closed`);
        return entry;
    }
}
exports.TerminalManager = TerminalManager;
//# sourceMappingURL=terminalManager.js.map