// Wiring shared by the MCP server and the CLI.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { exedev } from "@exedev/sdk";
import { apiToken, config } from "./config.ts";
import { Manager } from "./manager.ts";
import { Store } from "./store.ts";

export const version: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

let instance: Manager | undefined;

/** The Manager, created on first use so that commands without a token still work. */
export function manager(): Manager {
  instance ??= new Manager(exedev({ token: apiToken(), baseURL: config.baseURL }), new Store(config.stateFile));
  return instance;
}

/**
 * The origin remote of the git checkout at dir, if any, as an https URL: a new VM has no
 * SSH keys. T3 Code matches projects across environments by repository, not by URL form.
 */
export async function gitOrigin(dir: string): Promise<string | undefined> {
  let url: string;
  try {
    const { stdout } = await promisify(execFile)("git", ["-C", dir, "remote", "get-url", "origin"], { timeout: 10_000 });
    url = stdout.trim();
  } catch {
    return undefined;
  }
  const ssh = url.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/);
  return ssh ? `https://${ssh[1]}/${ssh[2]}` : url || undefined;
}
