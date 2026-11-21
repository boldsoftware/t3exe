// Running local commands for `t3exe login`, and finding them on PATH.

import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command to completion. A missing command is code 127, like a shell's. */
export type Runner = (command: string, args: string[], opts?: { env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number }) => Promise<Result>;

export const run: Runner = (command, args, opts = {}) =>
  new Promise((done) => {
    const child = execFile(
      command,
      args,
      { env: opts.env ? { ...process.env, ...opts.env } : process.env, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 16 << 20 },
      (err: any, stdout, stderr) => {
        const code = !err ? 0 : err.code === "ENOENT" ? 127 : typeof err.code === "number" ? err.code : 1;
        done({ code, stdout: String(stdout), stderr: String(stderr || (code === 127 ? `${command}: not found` : err?.message ?? "")) });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });

/**
 * The absolute path of an executable: as given if it has a slash, else the first on PATH.
 * Symlinks stay: an installer's stable link outlives the versioned file it points to.
 */
export function which(command: string): string | undefined {
  const candidates = command.includes("/")
    ? [command]
    : (process.env.PATH ?? "").split(delimiter).filter(isAbsolute).map((dir) => join(dir, command));
  for (const path of candidates) {
    try {
      accessSync(path, constants.X_OK);
      return resolve(path);
    } catch {}
  }
  return undefined;
}

/** The first line of a failed command's output that says what went wrong. */
export function failure(r: Result): string {
  const lines = `${r.stderr}\n${r.stdout}`.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /error|denied|not found|invalid/i.test(l)) ?? lines[0] ?? `exit status ${r.code}`;
}
