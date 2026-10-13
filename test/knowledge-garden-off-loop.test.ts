import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildRegisteredGarden, type GardenBuildContext } from "../src/run-task.js";
import { GARDEN_PASS_STEP, REGISTERED_GARDEN_NAMES, boundedGardenPassSpawn, childGardenPassSpawn, isRegisteredGardenName, startGardenOffLoop } from "../src/lib/garden-registry.js";
import { gardenStatePath, initialGardenState, readGardenState } from "../src/lib/gardener.js";
import { GARDEN_ACTION_CLASSES } from "../src/lib/knowledge-gardener.js";
import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo } from "./helpers/git-repo.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture(t: { after: (fn: () => void) => void }) {
  const repo = gitRepo({ kind: "knowledge-offloop" });
  t.after(() => repo.cleanup());
  const stateDir = join(repo.dir, "state");
  mkdirSync(stateDir);
  const out: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const ctx: GardenBuildContext = {
    config: { root: repo.dir, claudeBin: "/bin/true" } as GardenBuildContext["config"],
    repoRoot: repo.dir, owner: "acme", repo: "remudero",
    log: (step, extra = {}) => { out.push({ step, extra }); },
    raiseDuplicate: () => "",
  };
  return { repo, stateDir, ctx, out };
}

test("knowledge garden production wiring uses the off-loop registry", async (t) => {
  const f = fixture(t);
  assert.equal(isRegisteredGardenName("knowledge"), true);
  assert.equal(REGISTERED_GARDEN_NAMES.filter((name: string) => name === "knowledge").length, 1);
  assert.deepEqual(REGISTERED_GARDEN_NAMES.slice(0, 8), ["plan", "gate", "test", "config", "export", "ci-friction", "selector-shadow", "evidence-coverage"], "existing registered gardener slots retain their names and order");
  const pass = await buildRegisteredGarden("knowledge", f.ctx);
  assert.equal(typeof pass, "function", "the CLI and production names build through the same registry");
  assert.equal(typeof pass.due, "function", "the parent has the established cheap due probe");
  assert.equal(pass.due!(), true, "a new private fixture has an initial pass due");
});

test("knowledge garden slow child leaves the parent timer responsive", async (t) => {
  const f = fixture(t), entry = join(f.repo.dir, "slow-knowledge.mjs"), output = join(f.repo.dir, "child.json");
  const source = fileURLToPath(new URL("../src/run-task.ts", import.meta.url));
  writeFileSync(entry, [
    'import { runRegisteredGardenPass } from ' + JSON.stringify(source) + ';',
    'import { writeFileSync } from "node:fs";',
    'const root = ' + JSON.stringify(f.repo.dir) + ';',
    'const rows = []; let stalled = false;',
    'const ctx = {config:{root,claudeBin:"/bin/true"},repoRoot:root,owner:"acme",repo:"remudero",raiseDuplicate:()=>"",',
    'log:(step,extra={})=>{if(!stalled){stalled=true;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,350);}rows.push({step,extra});}};',
    'const exit = await runRegisteredGardenPass(process.argv[4], [], ctx);',
    'writeFileSync(' + JSON.stringify(output) + ', JSON.stringify({exit,rows,pid:process.pid,args:process.argv.slice(2)}));',
    'process.exitCode=exit;',
  ].join("\n"));
  const spawn = childGardenPassSpawn({ execPath: process.execPath, execArgv: ["--import", "tsx"], entry, cwd: process.cwd(),
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, reserve: () => undefined, log: f.ctx.log });
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 5);
  let exit: number | null;
  try { exit = await spawn("knowledge", [], { stopped: false }); }
  finally { clearInterval(timer); }
  assert.equal(exit, 0, "the actual registry runs knowledge in the owned child");
  const seen = JSON.parse(readFileSync(output, "utf8")) as { exit: number; pid: number; args: string[]; rows: Array<{ step: string }> };
  assert.notEqual(seen.pid, process.pid);
  assert.deepEqual(seen.args, ["garden", "run", "knowledge"]);
  assert.ok(seen.rows.some((row) => row.step === "knowledge.scorecard"), "the child executed the actual knowledge spec");
  assert.ok(ticks >= 10, "parent timers advanced while the child did synchronous knowledge work");
});

test("knowledge garden child preserves review receipts and no overlap", async (t) => {
  const f = fixture(t), state = initialGardenState(GARDEN_ACTION_CLASSES);
  state.pending = { prUrl: "https://github.com/acme/remudero/pull/1", actionClass: "retire", baseline: { trials: 1, successes: 1 } };
  writeFileSync(gardenStatePath(f.stateDir, "knowledge"), JSON.stringify(state));
  const shim = ghShim([{ when: "repos/acme/remudero/pulls/1", stdout: '{"state":"closed","merged":false}' },
    { when: "api", exit: 1, stderr: "isolated unexpected API" }]);
  const priorPath = process.env.PATH;
  process.env.PATH = shim.dir + ":" + priorPath;
  try { await (await buildRegisteredGarden("knowledge", f.ctx))(); }
  finally { process.env.PATH = priorPath; }
  assert.ok(shim.calls().some((call) => call.includes("repos/acme/remudero/pulls/1")), "the real review reader used the shipped CLI boundary");
  assert.ok(f.out.some((row) => row.step === "knowledge.gardener_judged" && row.extra.verdict === "debit"), "closed review keeps the existing verdict");
  assert.equal(readGardenState(gardenStatePath(f.stateDir, "knowledge"), GARDEN_ACTION_CLASSES).classes.retire!.beta, 2);
  let calls = 0, finish!: (exit: number) => void;
  const spawn = boundedGardenPassSpawn(() => { calls++; return new Promise<number>((resolve) => { finish = resolve; }); }, 2);
  const garden = startGardenOffLoop("knowledge", 5, { spawnPass: spawn, log: f.ctx.log });
  t.after(() => garden.stop());
  await wait(30); assert.equal(calls, 1, "the first pass still in flight suppresses later ticks");
  garden.stop(); finish(0); await wait(0);
  const receipt = f.out.find((row) => row.step === GARDEN_PASS_STEP && row.extra.name === "knowledge");
  assert.equal(receipt?.extra.exit, 0, "the existing terminal child receipt is retained");
  assert.equal(calls, 1, "stopping never queues another knowledge pass");
});

test("knowledge registry catches its actual spec failure under the existing failure step", async (t) => {
  const f = fixture(t);
  const pass = await buildRegisteredGarden("knowledge", { ...f.ctx, log: (step, extra = {}) => {
    if (step === "knowledge.gardener_failed") f.out.push({ step, extra });
    else throw new Error("isolated knowledge log failure");
  } });
  await pass();
  assert.ok(f.out.some((row) => row.step === "knowledge.gardener_failed" && String(row.extra.error).includes("isolated knowledge log failure")));
});
