// `t3exe login`: everything t3exe needs, in one command. An exe.dev API key scoped to t3exe's
// tag and commands, minted over the user's `ssh exe.dev`; t3exe as an MCP server in each
// coding agent T3 Code runs; T3 Code's Linked environments; and, in a GitHub checkout, an
// exe.dev GitHub integration so VMs can clone and push the repository.
// `t3exe logout` undoes it.

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { ExeAPIError } from "@exedev/sdk";
import { agentName, agents, enableLinkedEnvironments, register, serverCommand, settingsFile, shellLine, unregister } from "./agents.ts";
import { config } from "./config.ts";
import { ensureIntegration, githubRepo, INTEGRATIONS_URL } from "./github.ts";
import { errorMessage } from "./manager.ts";
import { failure, run as realRun, type Runner } from "./run.ts";
import { exeClient, gitOrigin } from "./setup.ts";
import { Store } from "./store.ts";

/** Everything t3exe calls. A tag-scoped key may only touch VMs carrying the tag. */
export const TOKEN_COMMANDS = ["whoami", "ls", "new", "rm", "pause", "resume", "ssh", "share port", "share set-public"];

export interface Deps {
  run: Runner;
  /** Checks a key, returning the account's email; throws ExeAPIError 401/403 for a bad key. */
  whoami: (token: string) => Promise<string>;
  readStdin: () => Promise<string>;
  print: (line: string) => void;
}

export const defaultDeps: Deps = {
  run: realRun,
  whoami: async (token) => ((await exeClient({ token, baseURL: config.baseURL }).whoami()) as { email?: string }).email ?? "",
  readStdin: async () => {
    let data = "";
    for await (const chunk of process.stdin) data += chunk;
    return data;
  },
  print: (line) => console.log(line),
};

/** What login set up that logout should take down. */
interface Record_ {
  label?: string;
  integrations?: string[];
}
const recordFile = () => `${config.home}/login.json`;
function readRecord(): Record_ {
  try {
    return JSON.parse(readFileSync(recordFile(), "utf8"));
  } catch {
    return {};
  }
}
function writeRecord(r: Record_): void {
  mkdirSync(config.home, { recursive: true, mode: 0o700 });
  writeFileSync(recordFile(), JSON.stringify(r, null, 2) + "\n", { mode: 0o600 });
}

const tilde = (p: string) => (p.startsWith(homedir() + "/") ? `~${p.slice(homedir().length)}` : p);

/** How the user ran t3exe, for commands we tell them to run. */
export function self(argv1 = process.argv[1]): string {
  return argv1?.includes("/_npx/") ? "npx -y @exedev/t3exe" : "t3exe";
}

export interface LoginOptions {
  /** Read the API key from stdin (the token, or generate-api-key's JSON) instead of minting one. */
  tokenStdin?: boolean;
  /** Mint a new key even if the saved one works. */
  newKey?: boolean;
  exp?: string;
  label?: string;
  /** The checkout whose GitHub repository to set up; default the current directory. */
  dir?: string;
}

export async function login(opts: LoginOptions = {}, deps: Deps = defaultDeps): Promise<void> {
  const { print } = deps;
  const record = readRecord();
  const exe = (command: string) => deps.run("ssh", ["-o", "BatchMode=yes", config.sshHost, command], { timeoutMs: 60_000 });

  // 1. The API key.
  if (opts.tokenStdin) {
    const input = (await deps.readStdin()).trim();
    let token = input;
    record.label = undefined;
    if (input.startsWith("{")) {
      const parsed = JSON.parse(input);
      token = parsed.token;
      if (parsed.label) record.label = parsed.label;
    }
    if (!token) throw new Error("no API key on stdin");
    const email = await deps.whoami(token);
    saveToken(token);
    print(`API key: saved the key from stdin to ${tilde(config.tokenFile)} (${email}).`);
  } else {
    const current = opts.newKey ? undefined : savedToken();
    const email = current && (await checkToken(deps, current));
    if (email) {
      print(`API key: using the key in ${tilde(config.tokenFile)} (${email}).`);
    } else {
      const { token, label } = await mintToken(exe, opts);
      const email = await deps.whoami(token);
      saveToken(token);
      record.label = label;
      print(`API key: saved a new key for VMs tagged ${config.tag} to ${tilde(config.tokenFile)} (${email}, key ${label}, expires in ${opts.exp ?? "90d"}).`);
    }
  }
  writeRecord(record);

  // 2. t3exe in each coding agent T3 Code uses.
  const server = serverCommand();
  if (!server.env.T3EXE_T3) print(`T3 Code: \`${config.t3}\` is not on PATH. Install T3 Code (https://t3.codes), or set T3EXE_T3 and run login again.`);
  const results = await register(deps.run, agents(), server);
  const added = results.filter((r) => r.status === "added").map((r) => agentName(r.agent));
  if (added.length) print(`Agents: added t3exe to ${added.join(" and ")} as an MCP server.`);
  for (const r of results) {
    if (r.status === "missing") print(`Agents: ${agentName(r.agent)} is on in T3 Code, but ${r.detail}; skipped.`);
    if (r.status === "failed") print(`Agents: couldn't add t3exe to ${agentName(r.agent)}: ${r.detail}`);
  }
  if (results.length === 0) print("Agents: T3 Code has neither Claude Code nor Codex turned on; turn one on and run login again.");

  // 3. Linked environments.
  try {
    print(enableLinkedEnvironments() ? "Linked environments: turned on in T3 Code." : "Linked environments: already on.");
  } catch (e) {
    print(`Linked environments: ${errorMessage(e)}`);
  }

  // 4. The checkout's GitHub repository.
  if (opts.tokenStdin) {
    const repo = githubRepo(await gitOrigin(opts.dir ?? process.cwd()));
    if (repo) print(`GitHub: to let VMs clone and push ${repo}, run \`npx -y @exedev/t3exe repo add ${repo}\` on a computer with ssh ${config.sshHost}.`);
  } else {
    await repoAdd({ dir: opts.dir, quietIfNone: true }, deps, record, exe);
  }

  print("");
  print("Ready. Start a new thread in T3 Code and ask its agent to do the work on an exe.dev VM.");
  print(`Undo with: ${self()} logout`);
}

/** `t3exe repo add [owner/repo]`: give t3exe VMs access to a GitHub repository. Returns whether VMs can now reach it. */
export async function repoAdd(
  opts: { repo?: string; dir?: string; quietIfNone?: boolean },
  deps: Deps = defaultDeps,
  record = readRecord(),
  exe = (command: string) => deps.run("ssh", ["-o", "BatchMode=yes", config.sshHost, command], { timeoutMs: 60_000 }),
): Promise<boolean> {
  const { print } = deps;
  const dir = opts.dir ?? process.cwd();
  const repo = opts.repo ? (githubRepo(opts.repo) ?? githubRepo(`https://github.com/${opts.repo}`)) : githubRepo(await gitOrigin(dir));
  if (!repo) {
    if (opts.repo) throw new Error(`not a GitHub repository: ${opts.repo} (want owner/repo)`);
    if (!opts.quietIfNone) throw new Error(`${dir} has no github.com origin; pass owner/repo`);
    print(`GitHub: ${tilde(dir)} isn't a GitHub checkout. Run \`${self()} repo add\` in one to let VMs clone a private repository.`);
    return true;
  }
  try {
    const r = await ensureIntegration(exe, repo, config.tag);
    if (r.status === "unconnected") {
      print(`GitHub: exe.dev can't reach ${repo} yet (${r.detail}).`);
      print(`  Connect GitHub at ${INTEGRATIONS_URL}, then run \`${self()} repo add ${repo}\`. Until then VMs clone it from github.com if it's public, and can't push.`);
      return false;
    }
    if (r.status === "added") {
      record.integrations = [...new Set([...(record.integrations ?? []), r.name])];
      writeRecord(record);
    }
    const how = { present: `through integration ${r.name}`, attached: `through integration ${r.name}, now attached to tag:${config.tag}`, added: `through the new integration ${r.name}` }[r.status];
    print(`GitHub: VMs clone and push ${repo} ${how}.`);
    return true;
  } catch (e) {
    print(`GitHub: couldn't set up ${repo}: ${errorMessage(e)}`);
    return false;
  }
}

/** `t3exe logout`: remove what login set up. With VMs left, only with force: they'd outlive the key that deletes them. */
export async function logout(opts: { force?: boolean } = {}, deps: Deps = defaultDeps): Promise<void> {
  const { print } = deps;
  const vms = new Store(config.stateFile).list();
  if (vms.length && !opts.force) {
    const names = vms.map((v) => v.name).join(" ");
    throw new Error(`t3exe VMs still exist: ${names}. Delete them first with \`${self()} rm ${names}\`, or pass --force to leave them running.`);
  }
  const record = readRecord();
  const exe = (command: string) => deps.run("ssh", ["-o", "BatchMode=yes", config.sshHost, command], { timeoutMs: 60_000 });
  const removed = await unregister(deps.run, agents());
  if (removed.length) print(`Agents: removed t3exe from ${removed.map(agentName).join(" and ")}.`);
  for (const name of record.integrations ?? []) {
    const r = await exe(`integrations remove ${name}`);
    print(r.code === 0 ? `GitHub: removed integration ${name}.` : `GitHub: couldn't remove integration ${name} (${failure(r)}); try \`ssh ${config.sshHost} integrations remove ${name}\``);
  }
  if (record.label) {
    const r = await exe(`ssh-key remove ${record.label}`);
    if (r.code === 0) print(`API key: revoked ${record.label}.`);
    else if (r.code === 255 || r.code === 127) print(`API key: revoke it from a computer with ssh access to exe.dev: \`ssh ${config.sshHost} ssh-key remove ${record.label}\``);
    else print(`API key: couldn't revoke ${record.label} (${failure(r)}); try \`ssh ${config.sshHost} ssh-key remove ${record.label}\``);
  }
  rmSync(config.tokenFile, { force: true });
  rmSync(recordFile(), { force: true });
  print(`API key: deleted ${tilde(config.tokenFile)}.`);
  print(`Linked environments: left on; turn it off in T3 Code's settings (${tilde(settingsFile())}) if nothing else uses it.`);
  if (vms.length) print(`VMs: left running: ${vms.map((v) => v.name).join(", ")}. Delete them at https://exe.dev or with \`ssh ${config.sshHost} rm NAME\`.`);
}

function savedToken(): string | undefined {
  try {
    return readFileSync(config.tokenFile, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function saveToken(token: string): void {
  mkdirSync(config.home, { recursive: true, mode: 0o700 });
  writeFileSync(config.tokenFile, token + "\n", { mode: 0o600 });
  chmodSync(config.tokenFile, 0o600);
}

/** The account's email if token works, undefined if exe.dev rejects it. */
async function checkToken(deps: Deps, token: string): Promise<string | undefined> {
  try {
    return await deps.whoami(token);
  } catch (e) {
    if (e instanceof ExeAPIError && (e.status === 401 || e.status === 403)) return undefined;
    throw e;
  }
}

async function mintToken(exe: (command: string) => ReturnType<Runner>, opts: LoginOptions): Promise<{ token: string; label: string }> {
  const base = opts.label ?? `t3exe-${hostname().split(".")[0]}`.replace(/[^A-Za-z0-9_-]/g, "-");
  const exp = opts.exp ?? "90d";
  if (!/^[A-Za-z0-9_-]+$/.test(base) || !/^[A-Za-z0-9]+$/.test(exp)) throw new Error("invalid --label or --exp");
  // A label is taken if an earlier login's key still exists: number this one, unless the
  // user chose the label.
  for (let n = 1; n <= 20; n++) {
    const label = n === 1 ? base : `${base}-${n}`;
    // ssh joins its arguments into one command line for exe.dev's shell-like parser.
    const r = await exe(
      ["ssh-key generate-api-key", `--label=${label}`, `--tag=${config.tag}`, `--cmds='${TOKEN_COMMANDS.join(",")}'`, `--exp=${exp}`, "--json"].join(" "),
    );
    if (r.code === 0) {
      const token = JSON.parse(r.stdout).token;
      if (typeof token !== "string" || !token) throw new Error(`unexpected reply from ${config.sshHost}: ${r.stdout.trim()}`);
      return { token, label };
    }
    if (/already exists/.test(r.stdout + r.stderr) && !opts.label) continue;
    if (r.code === 127 || r.code === 255) {
      throw new Error(`ssh ${config.sshHost}: ${failure(r)}. Set up ssh to exe.dev (https://exe.dev/docs), or make a key elsewhere and use --token-stdin.`);
    }
    throw new Error(`ssh-key generate-api-key: ${failure(r)}`);
  }
  throw new Error(`too many keys labeled ${base}-N: remove old ones with ssh ${config.sshHost} ssh-key remove`);
}
