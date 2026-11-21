import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// config reads the environment when first imported.
const root = mkdtempSync(join(tmpdir(), "t3exe-login-"));
process.env.T3EXE_HOME = join(root, "t3exe");
process.env.T3EXE_T3_BASE_DIR = join(root, "t3");
process.env.T3EXE_T3 = "/bin/true";
delete process.env.T3EXE_TAG;
const settingsPath = join(root, "t3", "userdata", "settings.json");
mkdirSync(join(root, "t3", "userdata"), { recursive: true });

const { agents, addCommands, enableLinkedEnvironments, serverCommand } = await import("../src/agents.ts");
const { ensureIntegration, githubRepo, integrationName } = await import("../src/github.ts");
const { login, logout } = await import("../src/login.ts");

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const err = (stderr: string) => ({ code: 1, stdout: "", stderr });

test("agents follows T3 Code's enabled rules", () => {
  assert.deepEqual(agents(undefined).map((a) => a.kind).sort(), ["claude", "codex"]);
  assert.deepEqual(agents({ providerInstances: { claudeAgent: { driver: "claudeAgent", enabled: false } } }).map((a) => a.kind), ["codex"]);
  assert.deepEqual(agents({ providerInstances: { codex: { driver: "codex", config: { enabled: false } } } }).map((a) => a.kind), ["claude"]);
  const custom = agents({
    providerInstances: {
      claudeAgent: { driver: "claudeAgent", enabled: false },
      codex: { driver: "codex" },
      codex_work: { driver: "codex", config: { homePath: "/w/codex", binaryPath: "/opt/codex" } },
      codex_same: { driver: "codex", environment: [{ name: "CODEX_HOME", value: "/w/codex" }], config: { binaryPath: "/opt/codex" } },
      cursor: { driver: "cursor", enabled: true },
    },
  });
  assert.deepEqual(custom, [
    { kind: "codex", instances: ["codex"], binary: "codex", home: undefined },
    { kind: "codex", instances: ["codex_work", "codex_same"], binary: "/opt/codex", home: "/w/codex" },
  ]);
});

test("add commands replace t3exe in each agent", () => {
  const server = { command: "/n/node", args: ["/x/t3exe.mjs"], env: { PATH: "/n:/usr/bin", T3EXE_T3: "/h/t3" } };
  assert.deepEqual(addCommands({ kind: "claude", instances: [], binary: "claude" }, server), {
    remove: ["mcp", "remove", "t3exe", "--scope", "user"],
    add: ["mcp", "add", "t3exe", "--scope", "user", "-e", "PATH=/n:/usr/bin", "-e", "T3EXE_T3=/h/t3", "--", "/n/node", "/x/t3exe.mjs"],
  });
  assert.deepEqual(addCommands({ kind: "codex", instances: [], binary: "codex" }, server).add, [
    "mcp", "add", "t3exe", "--env", "PATH=/n:/usr/bin", "--env", "T3EXE_T3=/h/t3", "--", "/n/node", "/x/t3exe.mjs",
  ]);
});

test("the server command keeps npx, with absolute paths", () => {
  const npxDir = join(root, "npm", "bin");
  mkdirSync(npxDir, { recursive: true });
  writeFileSync(join(npxDir, "npx-cli.js"), "");
  const cached = join(root, ".npm", "_npx", "abc", "node_modules", "@exedev", "t3exe", "bin");
  mkdirSync(cached, { recursive: true });
  writeFileSync(join(cached, "t3exe.mjs"), "");
  const viaNpx = serverCommand(join(cached, "t3exe.mjs"), { npm_execpath: join(npxDir, "npm-cli.js") });
  assert.equal(viaNpx.command, process.execPath);
  assert.deepEqual(viaNpx.args, [join(npxDir, "npx-cli.js"), "-y", "@exedev/t3exe"]);
  assert.ok(viaNpx.env.PATH.startsWith(join(process.execPath, "..")));
  assert.equal(viaNpx.env.T3EXE_T3, "/bin/true");
  const installed = serverCommand(new URL("../bin/t3exe.mjs", import.meta.url).pathname, { EXE_BASE_URL: "https://x" });
  assert.deepEqual(installed.args, [new URL("../bin/t3exe.mjs", import.meta.url).pathname]);
  assert.equal(installed.env.EXE_BASE_URL, "https://x");
});

test("github.com remotes", () => {
  for (const url of ["https://github.com/o/r.git", "https://github.com/o/r", "git@github.com:o/r.git", "ssh://git@github.com/o/r", "https://tok@github.com/o/r/"]) {
    assert.equal(githubRepo(url), "o/r", url);
  }
  assert.equal(githubRepo("https://github.com/my.org/my-repo.js.git"), "my.org/my-repo.js");
  assert.equal(githubRepo("https://gitlab.com/o/r.git"), undefined);
  assert.equal(githubRepo("https://github.int.exe.xyz/o/r.git"), "o/r");
  assert.equal(githubRepo("https://evil.example/github.com/o/r"), undefined);
  assert.equal(githubRepo(undefined), undefined);
});

test("integration names are valid and free", () => {
  assert.equal(integrationName("Bold/My_Repo", new Set()), "t3exe-my-repo");
  assert.equal(integrationName("bold/app", new Set(["t3exe-app"])), "t3exe-bold-app");
  assert.equal(integrationName("bold/app", new Set(["t3exe-app", "t3exe-bold-app"])), "t3exe-bold-app-2");
  assert.match(integrationName("o/" + "x".repeat(80), new Set()), /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/);
});

test("ensureIntegration uses, attaches, or adds an integration", async () => {
  const fake = (list: unknown[], replies: Record<string, ReturnType<typeof ok>> = {}) => {
    const calls: string[] = [];
    const exe = async (c: string) => (calls.push(c), c === "integrations list --json" ? ok(JSON.stringify(list)) : (replies[c.split(" ").slice(0, 2).join(" ")] ?? ok()));
    return { calls, exe };
  };
  const gh = (name: string, repositories: string[], attachments: string[]) => ({ name, type: "github", repositories, attachments });

  let f = fake([gh("mine", ["Bold/App"], ["tag:t3exe"])]);
  assert.deepEqual(await ensureIntegration(f.exe, "bold/app", "t3exe"), { status: "present", name: "mine" });
  assert.deepEqual(f.calls, ["integrations list --json"]);

  f = fake([gh("mine", ["bold/app", "bold/web"], ["vm:x"])]);
  assert.deepEqual(await ensureIntegration(f.exe, "bold/app", "t3exe"), { status: "attached", name: "mine" });
  assert.equal(f.calls[1], "integrations attach mine tag:t3exe");

  f = fake([gh("t3exe-app", ["other/app"], []), { name: "x", type: "http-proxy", repositories: null, attachments: null }]);
  assert.deepEqual(await ensureIntegration(f.exe, "bold/app", "t3exe"), { status: "added", name: "t3exe-bold-app" });
  assert.equal(f.calls[1], "integrations add github --name t3exe-bold-app --repository bold/app --attach tag:t3exe");

  f = fake([], { "integrations add": err("error: no GitHub account connected; run: integrations setup github") });
  assert.deepEqual(await ensureIntegration(f.exe, "bold/app", "t3exe"), { status: "unconnected", detail: "no GitHub account connected; run: integrations setup github" });

  f = fake([], { "integrations add": err("error: some other failure") });
  await assert.rejects(ensureIntegration(f.exe, "bold/app", "t3exe"), /some other failure/);
});

test("Linked environments get turned on, keeping other settings", () => {
  writeFileSync(settingsPath, JSON.stringify({ idleCompaction: "onReturn" }));
  assert.equal(enableLinkedEnvironments(), true);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { idleCompaction: "onReturn", linkedEnvironmentsEnabled: true });
  assert.equal(enableLinkedEnvironments(), false);
});

test("login sets everything up and logout takes it down", async () => {
  // Agent CLIs that only need to exist: the fake runner answers for them.
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  for (const n of ["claude", "codex"]) {
    writeFileSync(join(bin, n), "#!/bin/sh\n");
    chmodSync(join(bin, n), 0o755);
  }
  writeFileSync(
    settingsPath,
    JSON.stringify({ providerInstances: { claudeAgent: { driver: "claudeAgent", config: { binaryPath: join(bin, "claude") } }, codex: { driver: "codex", config: { binaryPath: join(bin, "codex") } } } }),
  );
  // A checkout of a GitHub repository.
  const checkout = join(root, "app");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  writeFileSync(join(checkout, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:bold/app.git\n');
  writeFileSync(join(checkout, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(checkout, ".git", "objects"));
  mkdirSync(join(checkout, ".git", "refs"));

  const calls: string[] = [];
  const lines: string[] = [];
  const deps = {
    print: (l: string) => lines.push(l),
    readStdin: async () => "",
    whoami: async (token: string) => {
      assert.equal(token, "exe1.secret");
      return "dev@example.com";
    },
    run: async (command: string, args: string[]) => {
      if (command !== "ssh") {
        calls.push(`${command.split("/").pop()} ${args.slice(0, 3).join(" ")}`);
        return ok();
      }
      const c = args.at(-1)!;
      calls.push(`exe ${c.split(" ").slice(0, 2).join(" ")}`);
      if (c.startsWith("ssh-key generate-api-key --label=t3exe-")) {
        assert.match(c, /--tag=t3exe --cmds='whoami,ls,new,rm,pause,resume,ssh,share port,share set-public' --exp=90d --json$/);
        // The first label is taken by an earlier login's key.
        return calls.filter((x) => x.startsWith("exe ssh-key generate")).length === 1 ? err(`error: a key named "x" already exists; use a different --label`) : ok('{"token":"exe1.secret"}');
      }
      if (c === "integrations list --json") return ok("[]");
      return ok();
    },
  };
  await login({ dir: checkout }, deps);
  const token = join(root, "t3exe", "token");
  assert.equal(readFileSync(token, "utf8"), "exe1.secret\n");
  assert.equal(statSync(token).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).linkedEnvironmentsEnabled, true);
  assert.match(lines[0], /^API key: saved a new key for VMs tagged t3exe to .*token \(dev@example.com, key t3exe-.*-2, expires in 90d\)\.$/);
  assert.deepEqual(lines.slice(1, 4), [
    "Agents: added t3exe to Claude Code and Codex as an MCP server.",
    "Linked environments: turned on in T3 Code.",
    "GitHub: VMs clone and push bold/app through the new integration t3exe-app.",
  ]);
  assert.deepEqual(calls, [
    "exe ssh-key generate-api-key",
    "exe ssh-key generate-api-key",
    "claude mcp remove t3exe",
    "claude mcp add t3exe",
    "codex mcp remove t3exe",
    "codex mcp add t3exe",
    "exe integrations list",
    "exe integrations add",
  ]);

  // Again: the saved key still works, so no new one.
  calls.length = 0;
  lines.length = 0;
  await login({ dir: checkout }, deps);
  assert.match(lines[0], /^API key: using the key in .*token \(dev@example.com\)\.$/);
  assert.ok(!calls.some((c) => c.startsWith("exe ssh-key")));

  calls.length = 0;
  lines.length = 0;
  await logout({}, deps);
  assert.deepEqual(calls, ["claude mcp remove t3exe", "codex mcp remove t3exe", "exe integrations remove", "exe ssh-key remove"]);
  assert.equal(existsSync(token), false);
  assert.match(lines.join("\n"), /removed t3exe from Claude Code and Codex[\s\S]*removed integration t3exe-app[\s\S]*revoked t3exe-.*-2/);
});

test("login --token-stdin takes generate-api-key's JSON", async () => {
  const lines: string[] = [];
  await login(
    { tokenStdin: true, dir: root },
    { print: (l) => lines.push(l), readStdin: async () => '{"token":"exe1.other","label":"t3exe-vm"}\n', whoami: async () => "dev@example.com", run: async () => ok() },
  );
  assert.equal(readFileSync(join(root, "t3exe", "token"), "utf8"), "exe1.other\n");
  assert.match(lines[0], /^API key: saved the key from stdin to .*token \(dev@example.com\)\.$/);
  assert.equal(JSON.parse(readFileSync(join(root, "t3exe", "login.json"), "utf8")).label, "t3exe-vm");
});

test("logout keeps the key while t3exe VMs exist, unless forced", async () => {
  const { Store } = await import("../src/store.ts");
  const store = new Store(join(root, "t3exe", "vms.json"));
  store.put({ name: "left", url: "https://left.exe.xyz", state: "ready", createdAt: 1, activeAt: 1, access: "auto", idleMinutes: 15, onIdle: "delete", ttlMinutes: 60, keepAlive: false });
  const lines: string[] = [];
  const deps = { print: (l: string) => lines.push(l), readStdin: async () => "", whoami: async () => "", run: async () => ok() };
  await assert.rejects(logout({}, deps), /t3exe VMs still exist: left\. Delete them first/);
  await logout({ force: true }, deps);
  assert.match(lines.at(-1)!, /^VMs: left running: left\./);
  store.remove("left");
});
