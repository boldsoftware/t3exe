import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { anyBusy, pairingScopes } from "../src/manager.ts";
import { Store, type VMRecord } from "../src/store.ts";

test("a task delegated to the VM keeps it busy", () => {
  // What the VM's orchestration snapshot shows while a delegate_task thread runs there:
  // `t3 thread list` leaves this thread out.
  assert.equal(anyBusy([{ id: "mcp:delegated", status: "running", activityRunStatus: "running", pendingRuntimeRequest: false }]), true);
});

test("busy and idle statuses", () => {
  for (const status of ["preparing", "queued", "starting", "running", "waiting"]) {
    assert.equal(anyBusy([{ id: "t", status }]), true, status);
  }
  for (const status of ["completed", "interrupted", "failed", "cancelled", null]) {
    assert.equal(anyBusy([{ id: "t", status }]), false, String(status));
  }
  assert.equal(anyBusy([]), false);
  assert.equal(anyBusy([{ id: "t", status: "completed", activityRunStatus: "running" }]), true);
  assert.equal(anyBusy([{ id: "t", status: "completed", pendingRuntimeRequest: true }]), true);
});

test("pairing scopes match T3 Code's requirements", () => {
  assert.deepEqual(pairingScopes("read-only"), ["orchestration:read"]);
  assert.deepEqual(pairingScopes("auto"), ["orchestration:read", "orchestration:operate"]);
  assert.ok(pairingScopes("full-access").includes("source-control:write"));
});

test("store updates and the reaper lease", () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "t3exe-")), "vms.json"));
  const vm: VMRecord = {
    name: "a", url: "https://a.exe.xyz", state: "ready", createdAt: 1, activeAt: 1, access: "auto",
    idleMinutes: 15, onIdle: "delete", ttlMinutes: 60, keepAlive: false,
  };
  store.put(vm);
  assert.equal(store.patch("a", { activeAt: 2 })?.activeAt, 2);
  assert.equal(store.patch("missing", { activeAt: 2 }), undefined);
  assert.equal(store.claimReaper(1000), true);
  assert.equal(store.claimReaper(1000), true, "the same process renews its lease");
  store.remove("a");
  assert.deepEqual(store.list(), []);
});
