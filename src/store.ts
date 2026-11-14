// The VMs t3exe manages, in one JSON file. Several t3exe processes may share it (each
// agent session starts its own MCP server), so every change re-reads the file under a
// lock and replaces it atomically.

import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Access = "read-only" | "approval-required" | "auto-accept-edits" | "auto" | "full-access";
export type IdleAction = "pause" | "delete";

export interface VMRecord {
  name: string;
  url: string;
  state: "creating" | "ready" | "paused";
  createdAt: number;
  /** Last time a thread on the VM was busy, or it was created or resumed. */
  activeAt: number;
  environmentId?: string;
  projectId?: string;
  workspace?: string;
  repo?: string;
  ref?: string;
  access: Access;
  idleMinutes: number;
  onIdle: IdleAction;
  ttlMinutes: number;
  keepAlive: boolean;
}

interface State {
  vms: Record<string, VMRecord>;
  /** One process at a time runs the reaper. */
  reaper?: { pid: number; until: number };
}

const LOCK_STALE_MS = 30_000;

export class Store {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  read(): State {
    try {
      const state = JSON.parse(readFileSync(this.file, "utf8")) as State;
      return { ...state, vms: state.vms ?? {} };
    } catch (e: any) {
      if (e?.code === "ENOENT") return { vms: {} };
      throw new Error(`cannot read ${this.file}: ${e?.message ?? e}`);
    }
  }

  list(): VMRecord[] {
    return Object.values(this.read().vms).sort((a, b) => a.createdAt - b.createdAt);
  }

  get(name: string): VMRecord | undefined {
    return this.read().vms[name];
  }

  /** Applies fn to the current state and saves it. fn must be synchronous. */
  update<T>(fn: (state: State) => T): T {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const lock = this.file + ".lock";
    this.#lock(lock);
    try {
      const state = this.read();
      const result = fn(state);
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
      renameSync(tmp, this.file);
      return result;
    } finally {
      rmdirSync(lock);
    }
  }

  put(vm: VMRecord): void {
    this.update((s) => void (s.vms[vm.name] = vm));
  }

  patch(name: string, fields: Partial<VMRecord>): VMRecord | undefined {
    return this.update((s) => {
      const vm = s.vms[name];
      if (vm) Object.assign(vm, fields);
      return vm;
    });
  }

  remove(name: string): void {
    this.update((s) => void delete s.vms[name]);
  }

  /** True if this process may run the reaper for the next leaseMs. */
  claimReaper(leaseMs: number): boolean {
    return this.update((s) => {
      const now = Date.now();
      if (s.reaper && s.reaper.pid !== process.pid && s.reaper.until > now && alive(s.reaper.pid)) return false;
      s.reaper = { pid: process.pid, until: now + leaseMs };
      return true;
    });
  }

  #lock(path: string): void {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        mkdirSync(path);
        return;
      } catch (e: any) {
        if (e?.code !== "EEXIST") throw e;
      }
      try {
        if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) rmdirSync(path);
      } catch {}
      if (Date.now() > deadline) throw new Error(`${path} is held by another t3exe process`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}
