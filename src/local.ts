// The local T3 Code, through its CLI. The CLI talks to the running T3 Code server, so it
// must be the same version as that server.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.ts";
import type { Access } from "./store.ts";

export interface LinkedEnvironment {
  environmentId: string;
  label: string;
  urls: string[];
  status: string;
}

async function t3(args: string[], timeoutMs = 60_000): Promise<string> {
  const baseDir = config.t3BaseDir ? ["--base-dir", config.t3BaseDir] : [];
  try {
    const { stdout } = await promisify(execFile)(config.t3, [...args, ...baseDir], { timeout: timeoutMs, maxBuffer: 16 << 20 });
    return stdout;
  } catch (e: any) {
    if (e?.code === "ENOENT") throw new Error(`T3 Code CLI not found: install T3 Code or set T3EXE_T3`);
    const detail = String(e?.stderr || e?.stdout || e?.message).trim().split("\n").find((l) => /error/i.test(l)) ?? e?.message;
    throw new Error(`t3 ${args.slice(0, 2).join(" ")}: ${detail}`);
  }
}

/** The local T3 Code version, e.g. "0.1.10"; the VM gets the same one. */
export async function version(): Promise<string> {
  const out = await t3(["--version"], 15_000);
  const v = out.match(/(\d+\.\d+\.\d+\S*)/)?.[1];
  if (!v) throw new Error(`cannot parse \`t3 --version\`: ${out.trim()}`);
  return v;
}

export async function environments(): Promise<LinkedEnvironment[]> {
  return JSON.parse(await t3(["environment", "list", "--json"]));
}

export async function findEnvironment(url: string): Promise<LinkedEnvironment | undefined> {
  const want = new URL(url).origin;
  return (await environments()).find((env) => env.urls.some((u) => URL.canParse(u) && new URL(u).origin === want));
}

/** Links the environment at url with a pairing code from it; returns its environment id. */
export async function link(url: string, pairingCode: string, access: Access): Promise<string> {
  await t3(["environment", "link", url, "--pairing-code", pairingCode, "--access", access], 120_000);
  const env = await findEnvironment(url);
  if (!env) throw new Error(`linked ${url}, but it is missing from \`t3 environment list\``);
  return env.environmentId;
}

export async function unlink(environmentId: string): Promise<void> {
  await t3(["environment", "unlink", environmentId]);
}
