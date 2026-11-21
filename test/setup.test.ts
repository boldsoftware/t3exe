import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { VERSION } from "@exedev/sdk";
import { exeClient, version } from "../src/setup.ts";

test("requests identify t3exe and the SDK", async () => {
  assert.equal(version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  let ua: string | undefined;
  const exe = exeClient({
    token: "t",
    fetch: async (_url, init) => {
      ua = (init?.headers as Record<string, string>)["User-Agent"];
      return new Response('{"vms":[]}', { headers: { "Content-Type": "application/json" } });
    },
  });
  await exe.ls();
  assert.equal(ua, `t3exe/${version} exedev-js/${VERSION}`);
});
