// Creates, links, pauses, resumes and deletes exe.dev VMs that serve T3 Code.

import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { ExeAPIError, type ExedevClient, quote } from "@exedev/sdk";
import { config } from "./config.ts";
import * as t3 from "./local.ts";
import type { Access, IdleAction, Store, VMRecord } from "./store.ts";

/** The VM's T3 Code listens here; exe.dev's HTTPS proxy forwards https://<vm>.exe.xyz to it. */
export const PORT = 8000;

export const DEFAULTS = {
  access: "full-access" as Access,
  idleMinutes: 15,
  onIdle: "delete" as IdleAction,
  ttlMinutes: 8 * 60,
};

/** Thread statuses that mean an agent is (or is about to be) working, or waits on an approval. */
const BUSY = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/**
 * Prints the VM's live threads as JSON. `t3 thread list` leaves out delegated threads,
 * which is what a task sent here with delegate_task is, so this reads the server's
 * orchestration snapshot instead, with a read-only token kept on the VM.
 */
const THREADS_SCRIPT = `set -u
t3="$HOME/.local/bin/t3" token="$HOME/.t3exe/read-token" out="$HOME/.t3exe/shell.json"
issue() { (umask 077 && "$t3" auth session issue --base-dir "$HOME/.t3" --scope orchestration:read --ttl 30d --label "t3exe idle check" --token-only >"$token.new" && mv "$token.new" "$token"); }
get() { curl -sS -m 30 -o "$out" -w '%{http_code}' -H "Authorization: Bearer $(cat "$token" 2>/dev/null)" -H 'x-t3-orchestration-protocol: 2' http://127.0.0.1:${PORT}/api/orchestration/shell; }
[ -s "$token" ] || issue
code=$(get)
if [ "$code" = 401 ]; then issue && code=$(get); fi
[ "$code" = 200 ] || { echo "GET /api/orchestration/shell: HTTP $code: $(head -c 300 "$out" 2>/dev/null)" >&2; exit 1; }
jq -c '[.threads[] | select(.archivedAt == null and .deletedAt == null) | {id, status, activityRunStatus, pendingRuntimeRequest: (.pendingRuntimeRequest != null)}]' "$out"`;

export interface ThreadState {
  id: string;
  status?: string | null;
  activityRunStatus?: string | null;
  pendingRuntimeRequest?: boolean;
}

/** Whether any thread is working, about to work, or waiting on an approval. */
export function anyBusy(threads: ThreadState[]): boolean {
  return threads.some(
    (t) => BUSY.has(t.status ?? "") || BUSY.has(t.activityRunStatus ?? "") || t.pendingRuntimeRequest === true,
  );
}

/** Abandon a creation after this long: its process is gone. */
const CREATE_TIMEOUT_MS = 30 * 60_000;

const SETUP_SCRIPT = readFileSync(new URL("../vm/setup.sh", import.meta.url), "utf8");

/** The scopes T3 Code requires of a pairing code for each access level (mcpClientScopes in its contracts). */
export function pairingScopes(access: Access): string[] {
  if (access === "read-only") return ["orchestration:read"];
  if (access === "full-access") return ["orchestration:read", "orchestration:operate", "settings:write", "source-control:write"];
  return ["orchestration:read", "orchestration:operate"];
}

export interface CreateOptions {
  name?: string;
  repo?: string;
  ref?: string;
  access?: Access;
  idleMinutes?: number;
  onIdle?: IdleAction;
  ttlMinutes?: number;
  keepAlive?: boolean;
  cpu?: number;
  memory?: string;
  signal?: AbortSignal;
  progress?: (message: string) => void;
}

export type Settings = Pick<VMRecord, "idleMinutes" | "onIdle" | "ttlMinutes" | "keepAlive">;

export interface VMView extends VMRecord {
  /** exe.dev's status for the VM, e.g. running or paused; "missing" if it is gone. */
  vmStatus: string;
  /** The local link's status: reachable, unreachable, expired or "unlinked". */
  linkStatus: string;
  /** When the reaper acts, unless keepAlive is set. */
  idleAt?: string;
  deleteAt?: string;
}

export interface ReapAction {
  name: string;
  action: "pause" | "delete" | "forget" | "error";
  reason: string;
}

export class Manager {
  readonly exe: ExedevClient;
  readonly store: Store;

  constructor(exe: ExedevClient, store: Store) {
    this.exe = exe;
    this.store = store;
  }

  async create(opts: CreateOptions = {}): Promise<VMRecord> {
    const progress = opts.progress ?? (() => {});
    const version = await t3.version();
    const forwarded = envFile();

    progress("creating the VM");
    const vm = await this.exe.new({
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.cpu ? { cpu: opts.cpu } : {}),
      ...(opts.memory ? { memory: opts.memory } : {}),
      tag: [config.tag],
      comment: "t3exe: T3 Code environment",
      "no-email": true,
      signal: opts.signal,
    });
    const now = Date.now();
    const record: VMRecord = {
      name: vm.name,
      url: new URL(vm.httpsUrl ?? `https://${vm.name}.exe.xyz`).origin,
      state: "creating",
      createdAt: now,
      activeAt: now,
      repo: opts.repo,
      ref: opts.ref,
      access: opts.access ?? DEFAULTS.access,
      idleMinutes: opts.idleMinutes ?? DEFAULTS.idleMinutes,
      onIdle: opts.onIdle ?? DEFAULTS.onIdle,
      ttlMinutes: opts.ttlMinutes ?? DEFAULTS.ttlMinutes,
      keepAlive: opts.keepAlive ?? false,
    };
    this.store.put(record);

    try {
      // T3 Code's own auth guards the server, so the proxy can let everyone through:
      // a peer link cannot sign in to exe.dev.
      await vm.sharePort(String(PORT), { signal: opts.signal });
      await vm.shareSetPublic({ signal: opts.signal });

      progress(`installing T3 Code ${version} on ${vm.name}`);
      const inputs = {
        T3_VERSION: version,
        PORT: String(PORT),
        REPO: record.repo ?? "",
        REF: record.ref ?? "",
        SCOPES: pairingScopes(record.access).join(" "),
        LABEL: `t3exe on ${hostname()}`,
        ENV_B64: Buffer.from(forwarded).toString("base64"),
      };
      const script = Buffer.from(SETUP_SCRIPT).toString("base64");
      const command =
        Object.entries(inputs).map(([k, v]) => `${k}=${quote(v)}`).join(" ") +
        ` bash -c "$(echo ${script} | base64 -d)" t3exe-setup`;
      const result = await vm.ssh(command, { signal: opts.signal, onStdout: lines((l) => l.startsWith("[t3exe] ") && progress(l.slice(8))) });
      const line = result.stdout.split("\n").find((l) => l.startsWith("T3EXE_RESULT "));
      if (result.exitCode !== 0 || !line) {
        const tail = (result.stderr || result.stdout).trim().split("\n").slice(-15).join("\n");
        throw new Error(`setting up ${vm.name} failed (exit ${result.exitCode}):\n${tail}`);
      }
      const out = JSON.parse(line.slice("T3EXE_RESULT ".length)) as { projectId: string; workspace: string; pairingCode: string };

      progress(`linking ${record.url}`);
      const environmentId = await t3.link(record.url, out.pairingCode, record.access);
      return this.store.patch(vm.name, {
        state: "ready",
        environmentId,
        projectId: out.projectId,
        workspace: out.workspace,
        activeAt: Date.now(),
      })!;
    } catch (e) {
      progress(`deleting ${vm.name}: ${errorMessage(e).split("\n")[0]}`);
      await this.destroy(vm.name).catch(() => {});
      throw e;
    }
  }

  /** Unlinks and deletes a VM t3exe created. */
  async destroy(name: string): Promise<void> {
    const record = this.#record(name);
    const env = record.environmentId ? { environmentId: record.environmentId } : await t3.findEnvironment(record.url).catch(() => undefined);
    if (env) await t3.unlink(env.environmentId).catch(() => {});
    await this.exe.vm(name).rm().catch(ignoreMissing);
    this.store.remove(name);
  }

  /** Pauses a VM: its memory goes to disk, and it costs no CPU or RAM until resumed. */
  async pause(name: string): Promise<VMRecord> {
    const record = this.#record(name);
    if (record.state !== "ready") throw new Error(`${name} is ${record.state}`);
    await this.exe.vm(name).pause();
    return this.store.patch(name, { state: "paused" })!;
  }

  /** Resumes a paused VM and waits until its T3 Code answers through the link. */
  async resume(name: string, signal?: AbortSignal): Promise<VMView> {
    const record = this.#record(name);
    if (record.state === "creating") throw new Error(`${name} is still being created`);
    const vm = this.exe.vm(name);
    if (record.state === "paused") await vm.resume({ signal });
    const health = `for i in $(seq 60); do curl -fsS -m 2 -o /dev/null http://127.0.0.1:${PORT}/.well-known/t3/environment && exit 0; sleep 1; done; exit 1`;
    const { exitCode } = await vm.ssh(health, { signal });
    if (exitCode !== 0) throw new Error(`T3 Code on ${name} did not come back; see \`journalctl -u t3exe\` there`);
    this.store.patch(name, { state: "ready", activeAt: Date.now() });
    for (let i = 0; i < 30; i++) {
      const env = await t3.findEnvironment(record.url);
      if (env?.status === "reachable") break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    return (await this.list()).find((v) => v.name === name)!;
  }

  configure(name: string, settings: Partial<Settings>): VMRecord {
    this.#record(name);
    const fields = Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined));
    // Changing the idle policy restarts the idle clock.
    return this.store.patch(name, { ...fields, activeAt: Date.now() })!;
  }

  /** Every VM t3exe manages, with exe.dev's and the link's view of it. */
  async list(): Promise<VMView[]> {
    const [vms, envs] = await Promise.all([this.exe.ls(), t3.environments().catch(() => [])]);
    return this.store.list().map((r) => {
      const vm = vms.find((v) => v.name === r.name);
      const env = envs.find((e) => e.environmentId === r.environmentId);
      const due = (minutes: number, from: number) => new Date(from + minutes * 60_000).toISOString();
      return {
        ...r,
        vmStatus: vm?.info.status ?? "missing",
        linkStatus: env?.status ?? "unlinked",
        ...(r.keepAlive ? {} : { deleteAt: due(r.ttlMinutes, r.createdAt) }),
        ...(r.keepAlive || r.state !== "ready" ? {} : { idleAt: due(r.idleMinutes, r.activeAt) }),
      };
    });
  }

  /** Whether any thread on the VM is busy, including tasks delegated to it over the link. */
  async busy(record: VMRecord, signal?: AbortSignal): Promise<boolean> {
    const { exitCode, stdout, stderr } = await this.exe.vm(record.name).ssh(THREADS_SCRIPT, { signal });
    if (exitCode !== 0) throw new Error(`reading threads on ${record.name}: ${stderr.trim()}`);
    return anyBusy(JSON.parse(stdout));
  }

  /** Applies each VM's TTL and idle policy once. */
  async reap(now = Date.now()): Promise<ReapAction[]> {
    const actions: ReapAction[] = [];
    for (const r of this.store.list()) {
      try {
        const age = now - r.createdAt;
        if (r.state === "creating") {
          if (age > CREATE_TIMEOUT_MS) {
            await this.destroy(r.name);
            actions.push({ name: r.name, action: "delete", reason: "creation never finished" });
          }
          continue;
        }
        if (r.keepAlive) continue;
        if (age >= r.ttlMinutes * 60_000) {
          await this.destroy(r.name);
          actions.push({ name: r.name, action: "delete", reason: `reached its ${r.ttlMinutes} minute TTL` });
          continue;
        }
        if (r.state !== "ready") continue;
        if (await this.busy(r, AbortSignal.timeout(60_000))) {
          this.store.patch(r.name, { activeAt: now });
        } else if (now - r.activeAt >= r.idleMinutes * 60_000) {
          if (r.onIdle === "pause") await this.pause(r.name);
          else await this.destroy(r.name);
          actions.push({ name: r.name, action: r.onIdle, reason: `idle for ${r.idleMinutes} minutes` });
        }
      } catch (e) {
        if (e instanceof ExeAPIError && e.status === 404) {
          // Deleted outside t3exe.
          await this.destroy(r.name).catch(() => this.store.remove(r.name));
          actions.push({ name: r.name, action: "forget", reason: "the VM no longer exists" });
        } else {
          actions.push({ name: r.name, action: "error", reason: errorMessage(e) });
        }
      }
    }
    return actions;
  }

  #record(name: string): VMRecord {
    const record = this.store.get(name);
    if (!record) throw new Error(`${name} is not a VM t3exe created (see exe_vm_list)`);
    return record;
  }
}

/** A systemd EnvironmentFile with the variables named in T3EXE_FORWARD_ENV. */
function envFile(): string {
  let out = "";
  for (const name of config.forwardEnv) {
    const value = process.env[name];
    if (value === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /['\\\n\r]/.test(value)) {
      throw new Error(`cannot forward ${name}: unsupported name or value`);
    }
    out += `${name}='${value}'\n`;
  }
  return out;
}

function ignoreMissing(e: unknown): void {
  if (!(e instanceof ExeAPIError && e.status === 404)) throw e;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Calls fn with each complete line of a stream. */
function lines(fn: (line: string) => unknown): (chunk: string) => void {
  let partial = "";
  return (chunk) => {
    const parts = (partial + chunk).split("\n");
    partial = parts.pop()!;
    for (const line of parts) fn(line);
  };
}
