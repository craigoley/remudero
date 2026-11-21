/**
 * An exposed config canary whose cohort never clears its floor before `expiresAt` is `expired`. Its
 * edits were merged and never validated, so the tend lands the same exact revert a rolled-back canary
 * lands — and, since an unmeasured change is not evidence of harm, releases its class unjudged.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Clock } from "#src/lib/clock.js";
import {
  configGardenSpec,
  configInventory,
  readConfigCanaries,
  runConfigGarden,
  tendConfigCanaries,
  CANARY_TTL_MS,
  CONFIG_GARDEN_CLASSES,
  exactLineProofPattern,
  type ConfigGardenSources,
} from "#src/lib/config-gardener.js";
import { gardenStatePath, readGardenState, type GardenCheckout, type GardenLandOpts, type PrState } from "#src/lib/gardener.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const T0 = Date.parse("2026-09-25T00:00:00Z");
const HOUR = 3600 * 1000;

function shard(id: string): string {
  return [
    `- id: ${id}`,
    `  title: "task ${id}"`,
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    "  budget_usd: 30.00",
    "  status: queued",
    "  files: [src/x.ts]",
    "  acceptance:",
    `    - claim: "c"`,
    `      proof: 'grep: never-${id} in src/x.ts'`,
    "",
  ].join("\n");
}

/** One settled implement run of class `src`, as the ledger records it. */
function run(runId: string, taskId: string, atMs: number, verdict: string, costUsd: number): Array<Record<string, unknown>> {
  return [
    { step: "run.start", run_id: runId, task_id: taskId, type: "implement", task_class: "src", ts: new Date(atMs).toISOString() },
    { step: "verdict", run_id: runId, task_id: taskId, verdict, cost_usd: costUsd, ts: new Date(atMs + 60_000).toISOString() },
  ];
}

/** Twelve queued $30 shards over thirty settled $3–$6 runs: the gardener canaries a $9 budget on six. */
function harness() {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}expired-canary-`));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  const ids = Array.from({ length: 12 }, (_, i) => `W1-T${900 + i}`);
  for (const id of ids) writeFileSync(join(root, "plan", "tasks.d", `${id}-x.yaml`), shard(id));
  const rows = Array.from({ length: 30 }, (_, i) => run(`h${i}`, `W1-T${100 + i}`, T0 - (40 - i) * HOUR, "merged", 3 + (i % 4))).flat();
  const landed: GardenLandOpts[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let now = T0;
  let pr: PrState = "open";
  const clock: Clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  const deps = {
    stateDir: join(root, "state"),
    repoRoot: root,
    openWorkspace: (): GardenCheckout => ({
      root,
      land: (opts) => {
        landed.push(opts);
        return `https://github.com/acme/remudero/pull/${100 + landed.length}`;
      },
      dispose: () => {},
    }),
    prState: () => pr,
    log: (step: string, extra?: Record<string, unknown>) => void logs.push({ step, extra }),
    seed: 7,
    clock,
  };
  const sources: ConfigGardenSources = { ledgerRows: () => rows, entryWeights: () => ({}), mountRecommendations: () => [] };
  return {
    ids,
    rows,
    landed,
    logs,
    deps,
    pass: () => runConfigGarden(configGardenSpec(deps, sources), deps, sources),
    tend: () => tendConfigCanaries(deps, async () => (await configInventory(deps, sources)).runs),
    advance: (ms: number) => void (now += ms),
    now: () => now,
    setPr: (s: PrState) => void (pr = s),
    budgetOf: (id: string) => /^ {2}budget_usd: (\S+)$/m.exec(readFileSync(join(root, "plan", "tasks.d", `${id}-x.yaml`), "utf8"))![1],
    gardenState: () => readGardenState(gardenStatePath(deps.stateDir, "config"), CONFIG_GARDEN_CLASSES),
  };
}

/** Whether the proof executor's own invocation, `grep -arn -- <pattern> <path>`, finds `pattern` in a file holding `text`. */
function grepFinds(pattern: string, text: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}canary-proof-`));
  const file = join(dir, "shard.yaml");
  writeFileSync(file, text);
  const res = spawnSync("grep", ["-arn", "--", pattern, file], { encoding: "utf8" });
  assert.ok(res.status === 0 || res.status === 1, `grep ran: ${res.stderr}`);
  return res.status === 0;
}

/** The revert body's grep proofs, as `{ pattern, path }`. */
function proofsOf(body: string): Array<{ pattern: string; path: string }> {
  return [...body.matchAll(/^ {2}proof: grep: (.+) in (\S+)$/gm)].map((m) => ({ pattern: m[1]!, path: m[2]! }));
}

/** A merged budget canary, exposed, whose cohort has one settled run — below its floor of five. */
async function thinExposedCanary() {
  const h = harness();
  await h.pass();
  const [shadow] = readConfigCanaries(h.deps.stateDir);
  assert.equal(shadow?.promotion.state, "shadow");
  assert.equal(h.landed.length, 1, "the canary's own PR");
  if (shadow.cohort.kind !== "tasks") throw new Error("a budget canary names a task cohort");
  const cohort = shadow.cohort.taskIds;
  for (const id of cohort) assert.equal(h.budgetOf(id), "9.00", `${id} carries the canary's budget`);
  h.setPr("merged");
  h.advance(2 * HOUR);
  await h.tend();
  const exposed = readConfigCanaries(h.deps.stateDir)[0]!;
  assert.equal(exposed.promotion.state, "canary", "the merge exposes it");
  h.rows.push(...run("c0", cohort[0]!, h.now() + HOUR, "blocked", 9));
  return { h, cohort, prUrl: exposed.prUrl, classesBefore: h.gardenState().classes };
}

test("an expired config canary lands a revert of its edits and releases its class unjudged", async () => {
  const { h, cohort, prUrl, classesBefore } = await thinExposedCanary();
  assert.equal(h.gardenState().pending?.prUrl, prUrl, "the canary holds the gardener while it is open");
  h.advance(CANARY_TTL_MS + HOUR);
  const [result] = await h.tend();

  assert.equal(result?.step.verdict, "expired", "never cleared its floor, it expires rather than being judged");
  const canary = readConfigCanaries(h.deps.stateDir)[0]!;
  assert.equal(canary.promotion.state, "expired");
  assert.equal(h.landed.length, 2, "the expiry lands a revert as its own PR");
  assert.match(h.landed[1]!.title, /^revert\(config\): /);
  assert.equal(h.landed[1]!.sealedLanding, false, "the revert keeps its own PR, never the shared task-files landing that counts a held path as carried");
  assert.deepEqual(h.landed[1]!.paths, cohort.map((id) => `plan/tasks.d/${id}-x.yaml`).sort(), "exactly the canary's files");
  assert.match(h.landed[1]!.body, /expired before its cohort cleared the floor/);
  const proofs = proofsOf(h.landed[1]!.body);
  assert.equal(proofs.length, cohort.length, "one proof per reverted shard");
  for (const { pattern, path } of proofs) {
    assert.equal(pattern, exactLineProofPattern("budget_usd: 30.00"));
    assert.equal(grepFinds(pattern, "  budget_usd: 9.00\n"), false, `${path}'s proof is false on the canary's tree, so the revert PR is not stale`);
  }
  for (const id of h.ids) assert.equal(h.budgetOf(id), "30.00", `${id}'s declared budget is restored`);
  for (const { pattern, path } of proofs) assert.equal(grepFinds(pattern, readFileSync(join(h.deps.repoRoot, path), "utf8")), true, `${path}'s proof holds after the revert`);
  assert.equal(canary.rollbackPrUrl, "https://github.com/acme/remudero/pull/102", "the revert's receipt is kept on the canary");

  const state = h.gardenState();
  assert.deepEqual(state.classes, classesBefore, "an unmeasured change neither credits nor debits its class");
  assert.equal(state.pending, undefined, "the expired canary no longer holds the gardener");
  const expired = h.logs.filter((l) => l.step === "config.canary_expired");
  assert.equal(expired.length, 1);
  assert.equal(expired[0]!.extra?.rollback_pr_url, canary.rollbackPrUrl, "the expiry row names the revert");
  assert.equal(expired[0]!.extra?.pr_url, prUrl);
});

test("a canary that is still under its floor before expiry lands no revert", async () => {
  const { h, cohort, prUrl, classesBefore } = await thinExposedCanary();
  h.advance(2 * HOUR);
  const [result] = await h.tend();

  assert.equal(result?.step.verdict, "waiting", "one task is below the floor: it waits");
  const canary = readConfigCanaries(h.deps.stateDir)[0]!;
  assert.equal(canary.promotion.state, "canary");
  assert.equal(canary.rollbackPrUrl, undefined);
  assert.equal(h.landed.length, 1, "nothing is reverted while the canary can still be measured");
  for (const id of cohort) assert.equal(h.budgetOf(id), "9.00", `${id} keeps the canary's budget`);
  assert.equal(h.gardenState().pending?.prUrl, prUrl, "the canary still holds the gardener");
  assert.deepEqual(h.gardenState().classes, classesBefore);
  assert.equal(h.logs.some((l) => l.step === "config.canary_expired" || l.step === "config.canary_rolled_back"), false);
});

test("a revert's proof matches its own line exactly, never a longer value or a look-alike", () => {
  const pattern = exactLineProofPattern("  budget_usd: 5");
  assert.equal(grepFinds(pattern, "  budget_usd: 5\n"), true, "the reverted value");
  assert.equal(grepFinds(pattern, "  budget_usd: 50.00\n"), false, "a canary that raised 5 to 50.00 does not satisfy its own revert's proof");
  assert.equal(grepFinds(exactLineProofPattern("budget_usd: 9.00"), "  budget_usd: 9x00\n"), false, "a dot is literal");
  assert.equal(grepFinds(exactLineProofPattern("ci_judge: { model: sonnet, effort: low }"), "ci_judge: { model: sonnet, effort: low }\n"), true, "a mounts flow line");
});
