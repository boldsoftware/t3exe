// The local T3 Code's settings, as `t3exe login` reads and sets them: which coding agents it
// runs (so t3exe can be added to each as an MCP server) and the Linked environments switch.

import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { config } from "./config.ts";
import { failure, type Runner, which } from "./run.ts";

export const MCP_NAME = "t3exe";

export function t3BaseDir(): string {
  return expandHome(config.t3BaseDir ?? join(homedir(), ".t3"));
}

export function settingsFile(): string {
  return join(t3BaseDir(), "userdata", "settings.json");
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

function readSettings(): Record<string, any> | undefined {
  try {
    const value = JSON.parse(readFileSync(settingsFile(), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export type AgentKind = "claude" | "codex";

/** A coding agent T3 Code runs: its CLI, and the config directory that CLI reads. */
export interface Agent {
  kind: AgentKind;
  /** T3 Code's provider instance ids using this CLI and config directory. */
  instances: string[];
  /** The CLI as T3 Code is configured to run it ("claude", or a binaryPath). */
  binary: string;
  /** CLAUDE_CONFIG_DIR or CODEX_HOME, if T3 Code sets one. */
  home?: string;
}

const DRIVERS: Record<string, AgentKind> = { claudeAgent: "claude", codex: "codex" };
const HOME_VARIABLE: Record<AgentKind, string> = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };

/**
 * The enabled Claude Code and Codex provider instances in T3 Code's settings, merged by
 * CLI and config directory. This follows T3 Code's own rules (contracts/src/settings.ts):
 * the default codex and claudeAgent instances are on unless settings turn them off, and an
 * instance is off if it or its config says enabled: false.
 */
export function agents(settings = readSettings()): Agent[] {
  const instances: Record<string, any> = { claudeAgent: { driver: "claudeAgent" }, codex: { driver: "codex" } };
  const configured = settings?.providerInstances;
  if (configured && typeof configured === "object") Object.assign(instances, configured);
  const byKey = new Map<string, Agent>();
  for (const [id, instance] of Object.entries(instances)) {
    const kind = DRIVERS[instance?.driver];
    if (!kind || instance.enabled === false || instance.config?.enabled === false) continue;
    const binary = nonEmpty(instance.config?.binaryPath) ?? kind;
    const fromEnvironment = Array.isArray(instance.environment)
      ? instance.environment.find((v: any) => v?.name === HOME_VARIABLE[kind] && !v.secret)?.value
      : undefined;
    const home = nonEmpty(instance.config?.homePath) ?? nonEmpty(fromEnvironment);
    const agent: Agent = { kind, instances: [], binary: expandHome(binary), home: home && expandHome(home) };
    const key = `${kind}\0${agent.binary}\0${agent.home ?? ""}`;
    const existing = byKey.get(key) ?? byKey.set(key, agent).get(key)!;
    existing.instances.push(id);
  }
  return [...byKey.values()];
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Turns on T3 Code's Linked environments, which t3exe needs. The running server picks the
 * change up from the file. Returns false if it was already on.
 */
export function enableLinkedEnvironments(): boolean {
  const file = settingsFile();
  const settings = readSettings();
  if (settings?.linkedEnvironmentsEnabled === true) return false;
  if (!settings && existsSync(file)) throw new Error(`can't read ${file}: turn on Linked environments in T3 Code's settings`);
  if (!existsSync(dirname(file))) throw new Error(`no T3 Code data in ${t3BaseDir()}: start T3 Code once, or set T3EXE_T3_BASE_DIR`);
  const tmp = `${file}.t3exe-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ ...settings, linkedEnvironmentsEnabled: true }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  return true;
}

/** How an agent starts t3exe's MCP server. */
export interface ServerCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * The command that runs this t3exe as an MCP server, the way it was started now: through
 * npx (so agents get the latest release), or this install. T3 Code's service may run with a
 * short PATH, without node, so the command is absolute and PATH is set. A shebang's
 * `env node` needs node on PATH, and npx doesn't add it.
 */
export function serverCommand(argv1 = process.argv[1], env = process.env): ServerCommand {
  const node = process.execPath;
  const script = realpathSync(argv1);
  let args = [script];
  if (script.includes("/_npx/")) {
    const npx = [env.npm_execpath && join(dirname(env.npm_execpath), "npx-cli.js"), which("npx") && realpathSync(which("npx")!)].find(
      (p) => p && existsSync(p) && p.endsWith(".js"),
    );
    if (npx) args = [npx, "-y", "@exedev/t3exe"];
  }
  const vars: Record<string, string> = { PATH: [...new Set([dirname(node), "/usr/local/bin", "/usr/bin", "/bin"])].join(":") };
  // T3 Code's installer puts t3 in ~/.local/bin, which a non-interactive shell may not have on PATH.
  const t3 = which(config.t3) ?? (config.t3 === "t3" ? which(join(homedir(), ".local", "bin", "t3")) : undefined);
  if (t3) vars.T3EXE_T3 = t3;
  // Settings login ran with, so the server uses the same ones. The API key stays in its file.
  for (const name of ["T3EXE_T3_BASE_DIR", "T3EXE_TAG", "T3EXE_HOME", "T3EXE_FORWARD_ENV", "EXE_BASE_URL"]) {
    if (env[name]) vars[name] = env[name]!;
  }
  return { command: node, args, env: vars };
}

/** The commands that add t3exe to an agent, replacing any t3exe entry it has. */
export function addCommands(agent: Agent, server: ServerCommand): { remove: string[]; add: string[] } {
  const envFlag = agent.kind === "claude" ? "-e" : "--env";
  const env = Object.entries(server.env).flatMap(([k, v]) => [envFlag, `${k}=${v}`]);
  return agent.kind === "claude"
    ? {
        remove: ["mcp", "remove", MCP_NAME, "--scope", "user"],
        add: ["mcp", "add", MCP_NAME, "--scope", "user", ...env, "--", server.command, ...server.args],
      }
    : { remove: ["mcp", "remove", MCP_NAME], add: ["mcp", "add", MCP_NAME, ...env, "--", server.command, ...server.args] };
}

export function agentName(agent: Agent): string {
  const name = agent.kind === "claude" ? "Claude Code" : "Codex";
  return agent.home ? `${name} (${HOME_VARIABLE[agent.kind]}=${agent.home})` : name;
}

/** A shell command line, for telling the user what to run. */
export function shellLine(agent: Agent, args: string[]): string {
  const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  const prefix = agent.home ? `${HOME_VARIABLE[agent.kind]}=${quote(agent.home)} ` : "";
  return prefix + [agent.binary, ...args].map(quote).join(" ");
}

export type Registration = { agent: Agent; status: "added" | "missing" | "failed"; detail?: string };

/** Adds t3exe as an MCP server to each agent whose CLI is installed. */
export async function register(run: Runner, list: Agent[], server: ServerCommand): Promise<Registration[]> {
  const results: Registration[] = [];
  for (const agent of list) {
    const binary = which(agent.binary);
    if (!binary) {
      results.push({ agent, status: "missing", detail: `${agent.binary} is not on PATH` });
      continue;
    }
    const env = agent.home ? { [HOME_VARIABLE[agent.kind]]: agent.home } : undefined;
    const { remove, add } = addCommands(agent, server);
    await run(binary, remove, { env, timeoutMs: 30_000 });
    const r = await run(binary, add, { env, timeoutMs: 30_000 });
    results.push(r.code === 0 ? { agent, status: "added" } : { agent, status: "failed", detail: failure(r) });
  }
  return results;
}

/** Removes t3exe from each agent; whether each one had it isn't checked. */
export async function unregister(run: Runner, list: Agent[]): Promise<Agent[]> {
  const removed: Agent[] = [];
  for (const agent of list) {
    const binary = which(agent.binary);
    if (!binary) continue;
    const env = agent.home ? { [HOME_VARIABLE[agent.kind]]: agent.home } : undefined;
    if ((await run(binary, addCommands(agent, { command: "", args: [], env: {} }).remove, { env, timeoutMs: 30_000 })).code === 0) removed.push(agent);
  }
  return removed;
}
