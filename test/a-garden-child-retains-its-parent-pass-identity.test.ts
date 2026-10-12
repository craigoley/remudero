import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { boundedGardenPassSpawn, childGardenPassSpawn, startGardenOffLoop } from "../src/lib/garden-registry.js";
import type { GardenerRuntimeEvent } from "../src/lib/gardener-runtime.js";
import { appendLedger } from "../src/lib/ledger.js";

const passId = "a5142db1-3dab-4f50-8f8f-a25cfb8e8db1";
// The canonical executor copies this test onto merge base. Absence of the new module
// must become a genuine assertion failure there, not an import/toolchain-unknown verdict.
const origin = existsSync(new URL("../src/lib/gardener-origin.ts", import.meta.url))
  ? await import("../src/lib/gardener-origin.js") : undefined;
const GARDENER_ORIGIN_ENV = "REMUDERO_GARDENER_ORIGIN";
const carrier = JSON.stringify({ version: 1, name: "plan", passId });
const linked = { state: "linked", version: 1, name: "plan", passId };
async function scratch(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "rmd-garden-origin-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function records(path: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(path, "utf8")).trim().split("\n").map(row => JSON.parse(row));
}

test("gardener origin is a bounded closed correlation carrier and never raw environment data", () => {
  assert.ok(origin, "the merge base has no gardener correlation carrier");
  assert.equal(origin.GARDENER_ORIGIN_ENV, GARDENER_ORIGIN_ENV);
  const { GARDENER_ORIGIN_MAX_BYTES, gardenerOriginEnv, readGardenerOrigin } = origin;
  assert.equal(gardenerOriginEnv("plan", passId), carrier);
  assert.equal(readGardenerOrigin({}), undefined);
  assert.equal(gardenerOriginEnv("plan", undefined), undefined);
  assert.deepEqual(readGardenerOrigin({ [GARDENER_ORIGIN_ENV]: carrier }), linked);
  for (const value of ["", "not-json-secret", "null", "[]", "1", JSON.stringify({ version: 2, name: "plan", passId }),
    JSON.stringify({ version: 1, name: "plan", passId, privateToken: "secret" }),
    JSON.stringify({ version: 1, name: ["plan"], passId }),
    JSON.stringify({ version: 1, name: "plan\nsecret", passId }),
    JSON.stringify({ version: 1, name: "plan", passId: "other-run" }),
    JSON.stringify({ version: 1, name: "plan", passId: [] }), "x".repeat(GARDENER_ORIGIN_MAX_BYTES + 1),
    JSON.stringify({ version: 1, name: "x".repeat(64), passId }).replace(/x/g, "é")]) {
    assert.deepEqual(readGardenerOrigin({ [GARDENER_ORIGIN_ENV]: value }), { state: "invalid", reason: "malformed" });
  }
});

test("a garden child ledger stamps its process context without rewriting cost run task repo or authority", async (t) => {
  const path = join(await scratch(t), "ledger.ndjson");
  const previous = process.env[GARDENER_ORIGIN_ENV];
  t.after(() => { if (previous === undefined) delete process.env[GARDENER_ORIGIN_ENV]; else process.env[GARDENER_ORIGIN_ENV] = previous; });
  process.env[GARDENER_ORIGIN_ENV] = carrier;
  const row = { run_id: "child-1", task_id: "W1-T1", repo: "acme/app", step: "worker.done", cost_usd: 0.25,
    gardener_origin: { state: "linked", version: 1, name: "forged", passId: "forged" } };
  appendLedger(path, row);
  const [seen] = await records(path);
  assert.deepEqual(seen!.gardener_origin, linked);
  for (const key of ["run_id", "task_id", "repo", "step", "cost_usd"]) assert.equal(seen![key], row[key as keyof typeof row]);
  assert.equal(seen!.actor, "test");
  assert.equal(seen!.actor_pid, process.pid);
  delete process.env[GARDENER_ORIGIN_ENV];
  appendLedger(path, row);
  assert.equal("gardener_origin" in (await records(path))[1]!, false, "an unscoped process cannot stamp the caller's forged origin");
  process.env[GARDENER_ORIGIN_ENV] = "secret-malformed-carrier";
  appendLedger(path, row);
  assert.deepEqual((await records(path))[2]!.gardener_origin, { state: "invalid", reason: "malformed" });
  assert.equal((await readFile(path, "utf8")).includes("secret-malformed-carrier"), false);
});

test("a real queued garden child links priced and unpriced ledger rows to its parent lifecycle", async (t) => {
  const dir = await scratch(t), path = join(dir, "ledger.ndjson"), entry = join(dir, "pass.mts");
  const moduleUrl = new URL("../src/lib/ledger.ts", import.meta.url).href;
  // Real default spawn and real default writer, no fake worker or writer. This local probe
  // makes no provider call; it tests attribution, not a billed model or measured ROI.
  await writeFile(entry, `import {appendLedger} from ${JSON.stringify(moduleUrl)};
    appendLedger(${JSON.stringify(path)}, {run_id:'child', task_id:'W1-T1', step:'worker.done', repo:'acme/app', cost_usd:0.25});
    appendLedger(${JSON.stringify(path)}, {run_id:'unpriced-child', task_id:'W1-T2', step:'worker.done', repo:'acme/app'});
  `);
  const observed: GardenerRuntimeEvent[] = [];
  let done!: () => void;
  const completed = new Promise<void>(resolve => { done = resolve; });
  const previous = process.env[GARDENER_ORIGIN_ENV];
  const child = childGardenPassSpawn({ execPath: process.execPath, execArgv: ["--import", "tsx"],
    entry, cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, [GARDENER_ORIGIN_ENV]: carrier } });
  const garden = startGardenOffLoop("config", 60_000, { spawnPass: boundedGardenPassSpawn(child, 1), log: () => {},
    observe: event => { observed.push(event); if (["completed", "failed", "cancelled"].includes(event.phase)) done(); } });
  t.after(() => garden.stop());
  await completed;
  const parent = observed.find(row => row.phase === "completed");
  assert.ok(parent, JSON.stringify(observed));
  assert.ok(parent.passId && parent.passId !== passId, "a new pass must not borrow the inherited pass");
  assert.deepEqual(observed.map(row => row.phase), ["queued", "running", "completed"]);
  const seen = await records(path);
  assert.equal(seen.length, 2);
  for (const row of seen) assert.deepEqual(row.gardener_origin, { state: "linked", version: 1, name: "config", passId: parent.passId });
  assert.equal(seen[0]!.cost_usd, 0.25);
  assert.equal("cost_usd" in seen[1]!, false, "unpriced remains unknown, never synthesized zero");
  assert.equal(process.env[GARDENER_ORIGIN_ENV], previous, "child carrier construction cannot mutate the parent's environment");
});

test("direct garden spawns clear inherited origins and concurrent children never share a pass identity", async (t) => {
  const dir = await scratch(t), entry = join(dir, "pass.mts");
  await writeFile(entry, `import {appendLedger} from ${JSON.stringify(new URL("../src/lib/ledger.ts", import.meta.url).href)};
    appendLedger(${JSON.stringify(join(dir, "ledger.ndjson"))}, {run_id:process.argv[4],task_id:'DAEMON',step:'garden.probe'});`);
  const spawn = childGardenPassSpawn({ execPath: process.execPath, execArgv: ["--import", "tsx"], entry,
    cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, [GARDENER_ORIGIN_ENV]: carrier } });
  const other = "e6921695-5c56-45c2-89f4-1f1e4d67c826";
  assert.deepEqual(await Promise.all([spawn("plan", [], { stopped: false, passId }),
    spawn("gate", [], { stopped: false, passId: other }), spawn("test", [], { stopped: false })]), [0, 0, 0]);
  const seen = await records(join(dir, "ledger.ndjson"));
  assert.equal(seen.length, 3);
  assert.deepEqual(seen.find(row => row.run_id === "plan")!.gardener_origin, linked);
  assert.deepEqual(seen.find(row => row.run_id === "gate")!.gardener_origin, { state: "linked", version: 1, name: "gate", passId: other });
  assert.equal("gardener_origin" in seen.find(row => row.run_id === "test")!, false);
});
