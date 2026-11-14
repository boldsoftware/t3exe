// Settings, all from the environment, with defaults that need no setup beyond `t3exe login`.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = process.env.T3EXE_HOME || join(homedir(), ".t3exe");

export const config = {
  /** Where the token and the VM records live. */
  home,
  tokenFile: join(home, "token"),
  stateFile: join(home, "vms.json"),
  /** exe.dev API endpoint; an exe.dev integration URL works too. */
  baseURL: process.env.EXE_BASE_URL || "https://exe.dev",
  /** SSH host for `t3exe login`. */
  sshHost: process.env.EXE_SSH_HOST || "exe.dev",
  /** Every VM t3exe creates carries this tag; the API token is scoped to it. */
  tag: process.env.T3EXE_TAG || "t3exe",
  /** The local T3 Code CLI, and its data directory if not the default. */
  t3: process.env.T3EXE_T3 || "t3",
  t3BaseDir: process.env.T3EXE_T3_BASE_DIR || undefined,
  /** Names of local environment variables to copy into the VM's T3 Code service (e.g. ANTHROPIC_API_KEY). */
  forwardEnv: (process.env.T3EXE_FORWARD_ENV ?? "").split(",").map((s) => s.trim()).filter(Boolean),
};

export function apiToken(): string {
  const fromEnv = process.env.EXE_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const token = readFileSync(config.tokenFile, "utf8").trim();
    if (token) return token;
  } catch {}
  throw new Error(`no exe.dev API token: run \`t3exe login\` or set EXE_API_TOKEN`);
}
