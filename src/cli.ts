// The t3exe command line: setup, and by-hand control of the VMs the MCP server manages.

import { parseArgs } from "node:util";
import { config } from "./config.ts";
import { login } from "./login.ts";
import { DEFAULTS, errorMessage } from "./manager.ts";
import { gitOrigin, manager, version } from "./setup.ts";
import type { Access, IdleAction } from "./store.ts";

const USAGE = `t3exe ${version}: exe.dev VMs as linked T3 Code environments

Usage:
  t3exe                    run the MCP server (stdio)
  t3exe login [--exp 90d]  create an exe.dev API key for t3exe (over ssh ${config.sshHost})
  t3exe create [--repo URL|none] [--ref REF] [--name NAME] [--access MODE] [--cpu N] [--memory SIZE]
               [--idle MINUTES] [--on-idle pause|delete] [--ttl MINUTES] [--keep-alive]
  t3exe ls [--json]
  t3exe pause NAME | resume NAME | rm NAME...
  t3exe set NAME [--idle MINUTES] [--on-idle pause|delete] [--ttl MINUTES] [--keep-alive | --no-keep-alive]
  t3exe reap               apply idle and TTL cleanup once (e.g. from cron)

Defaults: --access ${DEFAULTS.access} --idle ${DEFAULTS.idleMinutes} --on-idle ${DEFAULTS.onIdle} --ttl ${DEFAULTS.ttlMinutes}
Environment: EXE_API_TOKEN, EXE_BASE_URL, T3EXE_TAG (${config.tag}), T3EXE_T3, T3EXE_T3_BASE_DIR, T3EXE_FORWARD_ENV, T3EXE_HOME
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    repo: { type: "string" },
    ref: { type: "string" },
    name: { type: "string" },
    access: { type: "string" },
    cpu: { type: "string" },
    memory: { type: "string" },
    idle: { type: "string" },
    "on-idle": { type: "string" },
    ttl: { type: "string" },
    "keep-alive": { type: "boolean" },
    exp: { type: "string" },
    label: { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});
const [command, ...args] = positionals;

const int = (s: string | undefined, flag: string) => {
  if (s === undefined) return undefined;
  if (!/^\d+$/.test(s)) throw new Error(`--${flag} wants a whole number`);
  return Number(s);
};
const oneOf = <T extends string>(s: string | undefined, flag: string, choices: readonly T[]) => {
  if (s !== undefined && !choices.includes(s as T)) throw new Error(`--${flag} must be one of ${choices.join(", ")}`);
  return s as T | undefined;
};
const cleanup = () => ({
  idleMinutes: int(flags.idle, "idle"),
  onIdle: oneOf<IdleAction>(flags["on-idle"], "on-idle", ["pause", "delete"]),
  ttlMinutes: int(flags.ttl, "ttl"),
  keepAlive: flags["keep-alive"],
});
const names = () => {
  if (args.length === 0) throw new Error(`usage: t3exe ${command} NAME`);
  return args;
};
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

async function main(): Promise<void> {
  if (flags.help || command === "help") return void process.stdout.write(USAGE);
  switch (command) {
    case "login": {
      const label = await login({ exp: flags.exp, label: flags.label });
      console.log(`Saved an API key for VMs tagged ${config.tag} to ${config.tokenFile}.`);
      console.log(`Revoke it with: ssh ${config.sshHost} ssh-key remove ${label}`);
      return;
    }
    case "create": {
      const repo = flags.repo === "none" ? undefined : (flags.repo ?? (await gitOrigin(process.cwd())));
      const vm = await manager().create({
        repo,
        ref: flags.ref,
        name: flags.name,
        access: oneOf<Access>(flags.access, "access", ["read-only", "approval-required", "auto-accept-edits", "auto", "full-access"]),
        cpu: int(flags.cpu, "cpu"),
        memory: flags.memory,
        ...cleanup(),
        progress: (m) => console.error(m),
      });
      return print(vm);
    }
    case "ls":
    case "list": {
      const vms = await manager().list();
      if (flags.json) return print(vms);
      if (vms.length === 0) return console.log("No t3exe VMs.");
      for (const v of vms) {
        const when = v.keepAlive ? "kept alive" : `${v.idleAt ? `${v.onIdle} at ${v.idleAt} if idle, ` : ""}deleted at ${v.deleteAt}`;
        console.log(`${v.name}  ${v.url}  vm:${v.vmStatus}  link:${v.linkStatus}  env:${v.environmentId ?? "-"}\n  ${v.workspace ?? "-"}  ${when}`);
      }
      return;
    }
    case "pause":
      for (const n of names()) print(await manager().pause(n));
      return;
    case "resume":
      for (const n of names()) print(await manager().resume(n));
      return;
    case "rm":
    case "destroy":
      for (const n of names()) {
        await manager().destroy(n);
        console.log(`Deleted ${n}.`);
      }
      return;
    case "set":
      for (const n of names()) print(manager().configure(n, cleanup()));
      return;
    case "reap":
      for (const a of await manager().reap()) console.log(`${a.action} ${a.name}: ${a.reason}`);
      return;
    default:
      process.stderr.write(USAGE);
      process.exitCode = 2;
  }
}

try {
  await main();
} catch (e) {
  console.error(`t3exe: ${errorMessage(e)}`);
  process.exitCode = 1;
}
