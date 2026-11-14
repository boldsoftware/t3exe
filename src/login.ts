// `t3exe login`: mint an exe.dev API token over the user's existing SSH access, scoped to
// t3exe's tag and to the commands t3exe runs, and keep it in ~/.t3exe/token.

import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { promisify } from "node:util";
import { config } from "./config.ts";

/** Everything t3exe calls. A tag-scoped token may only touch VMs carrying the tag. */
export const TOKEN_COMMANDS = ["whoami", "ls", "new", "rm", "pause", "resume", "ssh", "share port", "share set-public"];

export async function login(opts: { exp?: string; label?: string } = {}): Promise<string> {
  const label = opts.label ?? `t3exe-${hostname().split(".")[0]}`.replace(/[^A-Za-z0-9_-]/g, "-");
  const exp = opts.exp ?? "90d";
  if (!/^[A-Za-z0-9_-]+$/.test(label) || !/^[A-Za-z0-9]+$/.test(exp)) throw new Error("invalid --label or --exp");
  // ssh joins its arguments into one command line for exe.dev's shell-like parser.
  const command = [
    "ssh-key generate-api-key",
    `--label=${label}`,
    `--tag=${config.tag}`,
    `--cmds='${TOKEN_COMMANDS.join(",")}'`,
    `--exp=${exp}`,
    "--json",
  ].join(" ");
  const { stdout } = await promisify(execFile)("ssh", ["-o", "BatchMode=yes", config.sshHost, command], { timeout: 60_000 });
  const token = JSON.parse(stdout).token;
  if (typeof token !== "string" || !token) throw new Error(`unexpected reply from ${config.sshHost}: ${stdout.trim()}`);
  await mkdir(config.home, { recursive: true, mode: 0o700 });
  await writeFile(config.tokenFile, token + "\n", { mode: 0o600 });
  await chmod(config.tokenFile, 0o600);
  return label;
}
