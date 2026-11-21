/**
 * An exposed config canary whose cohort never clears its floor before `expiresAt` is `expired`. Its
 * edits were merged and never validated, so the tend lands the same exact revert a rolled-back canary
 * lands — and, since an unmeasured change is not evidence of harm, releases its class unjudged.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import type { Clock } from "#src/lib/clock.js";
import {
  configGardenSpec,
  configInventory,
  readConfigCanaries,
  runConfigGarden,
  tendConfigCanaries,
  writeConfigCanaries,
  CANARY_TTL_MS,
  CONFIG_GARDEN_CLASSES,
  exactLineProof,
  holdsExactLine,
  type ConfigEdit,
  type ConfigGardenSources,
} from "#src/lib/config-gardener.js";
import { gardenStatePath, readGardenState, type GardenCheckout, type GardenLandOpts, type PrState } from "#src/lib/gardener.js";
import { parseAcceptanceBlock, parseWhitelistedProof } from "#src/lib/review.js";
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

/** Whether the proof executor's own run of `proof` succeeds on a tree holding `files`: the argv
 *  `parseWhitelistedProof` compiles (`grep -arn -- <pattern> <path>`), run with the tree as its cwd. */
function executorFinds(proof: string, files: ReadonlyMap<string, string>): boolean {
  const parsed = parseWhitelistedProof(proof);
  assert.ok(parsed?.kind === "grep", `the executor runs ${proof} as a grep`);
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}canary-proof-`));
  for (const [path, text] of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const res = spawnSync(parsed.command, parsed.args, { cwd: dir, encoding: "utf8" });
  assert.ok(res.status === 0 || res.status === 1, `grep ran: ${res.stderr}`);
  return res.status === 0;
}

/** The revert body's proofs, as the reviewer's own parser reads them. */
function proofsOf(body: string): string[] {
  return parseAcceptanceBlock(body).map((c) => c.proof);
}

/** Write `text` at `path` under the harness root. */
function put(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
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
  const root = h.deps.repoRoot;
  // One shard was already put back by another change: its revert has nothing to do and proves nothing.
  const restored = `plan/tasks.d/${cohort[0]}-x.yaml`;
  writeFileSync(join(root, restored), readFileSync(join(root, restored), "utf8").replace(/^ {2}budget_usd: 9\.00$/m, "  budget_usd: 30.00"));
  // Every way a revert's proof has failed review, as edits of this one canary:
  // - a reverted value that is a prefix of the canary's (5 under 50.00);
  // - a reverted line with trailing spaces;
  // - a line full of BRE metacharacters, a backslash, a comment and the proof grammar's own ` in `;
  // - a file holding one edit already put back and one still to revert.
  const prefix = "plan/tasks.d/W1-T950-p.yaml", spaced = "plan/tasks.d/W1-T951-s.yaml", mounts = "plan/mounts.yaml";
  const caps = "scripts/knowledge-budget-baseline.json";
  put(root, prefix, shard("W1-T950").replace("  budget_usd: 30.00", "  budget_usd: 50.00"));
  put(root, spaced, shard("W1-T951").replace("  budget_usd: 30.00", "  budget_usd: 9.00"));
  put(root, mounts, "flows:\n  ci_judge: { model: haiku, effort: low }\n");
  put(root, caps, '{\n  "capturedAt": "2026-09-01",\n  "maxChars": 9000\n}\n');
  const extra: ConfigEdit[] = [
    { path: prefix, from: "  budget_usd: 5", to: "  budget_usd: 50.00" },
    { path: spaced, from: "  budget_usd: 30.00  ", to: "  budget_usd: 9.00" },
    { path: mounts, from: "  ci_judge: { model: sonnet, effort: low } # [x]* ^$ a.b? \\d+ in c", to: "  ci_judge: { model: haiku, effort: low }" },
    { path: caps, from: '  "capturedAt": "2026-09-01",', to: '  "capturedAt": "2026-09-20",' },
    { path: caps, from: '  "maxChars": 6000', to: '  "maxChars": 9000' },
  ];
  const [canary0] = readConfigCanaries(h.deps.stateDir);
  writeConfigCanaries(h.deps.stateDir, [{ ...canary0!, edits: [...canary0!.edits, ...extra] }]);
  const touched = [...new Set([...canary0!.edits, ...extra].map((e) => e.path))];
  const tree = () => new Map(touched.map((path) => [path, readFileSync(join(root, path), "utf8")]));
  const before = tree();
  h.advance(CANARY_TTL_MS + HOUR);
  const [result] = await h.tend();

  assert.equal(result?.step.verdict, "expired", "never cleared its floor, it expires rather than being judged");
  const canary = readConfigCanaries(h.deps.stateDir)[0]!;
  assert.equal(canary.promotion.state, "expired");
  assert.equal(h.landed.length, 2, "the expiry lands a revert as its own PR");
  assert.match(h.landed[1]!.title, /^revert\(config\): /);
  assert.equal(h.landed[1]!.sealedLanding, false, "the revert keeps its own PR, never the shared task-files landing that counts a held path as carried");
  const shards = cohort.map((id) => `plan/tasks.d/${id}-x.yaml`).filter((p) => p !== restored);
  assert.deepEqual(h.landed[1]!.paths, [...shards, prefix, spaced, mounts, caps].sort(), "exactly the files the revert still changes");
  assert.match(h.landed[1]!.body, /expired before its cohort cleared the floor/);
  const after = tree();
  for (const e of [...canary0!.edits, ...extra]) assert.ok(holdsExactLine(after.get(e.path)!, e.from), `${e.path} is back at ${JSON.stringify(e.from)}`);
  for (const id of h.ids) assert.equal(h.budgetOf(id), "30.00", `${id}'s declared budget is restored`);

  // The proofs, as the reviewer parses them and the executor runs them: one per line put back, none for a line already
  // at its baseline, each holding after the revert and not before it, so preflight never reads the revert as stale.
  const proofs = proofsOf(h.landed[1]!.body);
  const putBack = [...shards.map((path) => ({ path, line: "  budget_usd: 30.00" })), { path: prefix, line: "  budget_usd: 5" },
    { path: spaced, line: "  budget_usd: 30.00  " }, { path: mounts, line: extra[2]!.from }, { path: caps, line: '  "maxChars": 6000' }];
  assert.deepEqual([...proofs].sort(), putBack.map((p) => exactLineProof(p.path, p.line)).sort(), "one proof per line put back");
  for (const proof of proofs) {
    assert.equal(executorFinds(proof, after), true, `${proof} holds after the revert`);
    assert.equal(executorFinds(proof, before), false, `${proof} is false on the tree before the revert`);
  }
  assert.equal(proofs.some((p) => p.includes("capturedAt")), false, "the line already put back gets no proof");
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
  const path = "plan/x.yaml";
  const cases: Array<[line: string, lookAlikes: string[]]> = [
    ["  budget_usd: 5", ["  budget_usd: 50.00", "  budget_usd: 5 ", "budget_usd: 5", "    budget_usd: 5"]],
    ["  budget_usd: 30.00  ", ["  budget_usd: 30.00", "  budget_usd: 30x00  "]],
    ["  ci_judge: { model: sonnet, effort: low } # [x]* ^$ a.b? \\d+ in c", ["  ci_judge: { model: sonnet, effort: low } # [x]* ^$ a.b? \\d+ in", "  ci_judge: { model: sonnet, effort: low }"]],
    ['  "maxChars": 6000,', ['  "maxChars": 60000,', '  "maxChars": 6000']],
    ["\tkey: a|b (c) {d} +e", ["\tkey: a|b (c) {d} +ee", "key: a|b (c) {d} +e"]],
  ];
  for (const [line, lookAlikes] of cases) {
    const proof = exactLineProof(path, line);
    assert.deepEqual(parseAcceptanceBlock(`Acceptance:\n- claim: c\n  proof: ${proof}`).map((c) => c.proof), [proof], `${proof} reads back verbatim`);
    assert.equal(executorFinds(proof, new Map([[path, `a\n${line}\nz\n`]])), true, `${JSON.stringify(line)} is found`);
    assert.equal(holdsExactLine(`a\n${line}\nz\n`, line), true);
    for (const other of lookAlikes) {
      const text = `a\n${other}\nz\n`;
      assert.equal(executorFinds(proof, new Map([[path, text]])), false, `${JSON.stringify(line)}'s proof does not match ${JSON.stringify(other)}`);
      assert.equal(holdsExactLine(text, line), false, `the gardener's own check agrees with grep on ${JSON.stringify(other)}`);
    }
  }
});

test("a revert that cannot land leaves its canary as it was, and the pass still records the others", async () => {
  const { h, prUrl } = await thinExposedCanary();
  const [real] = readConfigCanaries(h.deps.stateDir);
  // A second canary whose line someone has since changed: its exact revert is refused.
  put(h.deps.repoRoot, "plan/tasks.d/W1-T960-z.yaml", shard("W1-T960").replace("  budget_usd: 30.00", "  budget_usd: 12.00"));
  const stuck = { ...structuredClone(real!), prUrl: "https://github.com/acme/remudero/pull/999",
    edits: [{ path: "plan/tasks.d/W1-T960-z.yaml", from: "  budget_usd: 30.00", to: "  budget_usd: 9.00" }] };
  writeConfigCanaries(h.deps.stateDir, [stuck, real!]);
  h.advance(CANARY_TTL_MS + HOUR);
  await assert.rejects(h.tend(), /rollback line changed or ambiguous/, "a refused revert still fails the pass");

  const [kept, done] = readConfigCanaries(h.deps.stateDir);
  assert.deepEqual(kept, stuck, "the canary whose revert could not land is left exactly as it was, to be stepped again");
  assert.equal(done!.promotion.state, "expired");
  assert.equal(done!.rollbackPrUrl, "https://github.com/acme/remudero/pull/102", "the other canary's revert is recorded, so the next pass never reopens it");
  assert.equal(h.landed.length, 2, "one revert opened");
  assert.ok(h.logs.some((l) => l.step === "config.canary_expired" && l.extra?.pr_url === prUrl), "the canary that did revert is logged");
  assert.equal(h.gardenState().pending, undefined, "the canary that did revert released its class");

  // The failed pass still recorded its tend time, so the refused canary is stepped again after the tend interval.
  // Two refusals in one pass fail it once, naming both.
  writeConfigCanaries(h.deps.stateDir, [stuck, { ...stuck, prUrl: "https://github.com/acme/remudero/pull/998" }]);
  h.advance(2 * HOUR);
  await assert.rejects(h.tend(), /rollback line changed or ambiguous: plan\/tasks\.d\/W1-T960-z\.yaml; config gardener: rollback line changed or ambiguous/);
  assert.equal(h.landed.length, 2, "neither opens a revert");
});
