// A selector MISS counts only when the diff plausibly caused the failure. The shadow gate scored
// host flakes as misses, so its verdict could never read `ready`, and its gardener filed 105
// `REPAIR THE SELECTOR EDGE` shards whose suites failed on main, recovered on retry, or failed in a
// mass run. A miss the diff did not cause is scored `unattributed`: it leaves the gate's arithmetic,
// files no repair shard, and is ledgered with its reason.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Namespace import: the attribution exports are new, so this suite still loads (and fails) at base.
import * as gardener from "../src/lib/selector-shadow-gardener.js";
import { shadowRecord } from "../src/lib/affected-suites.js";
import { appendLedger } from "../src/lib/ledger.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
// @ts-expect-error -- plain .mjs script, no type declarations
import * as shadowScript from "../scripts/select-affected-suites.mjs";

type Failure = { file: string; floor: string; narrow?: string; retry?: string };

/** A complete eight-shard run: shard 1 holds `failures` and concluded failure; shard 2 retry-recovered
 *  each of `recoveredFlakes` and concluded success. */
function run(id: number, failures: readonly Failure[], opts: { baseSha?: string; recoveredFlakes?: readonly string[] } = {}): gardener.SelectorShadowRun {
  const record = (f: readonly Failure[]) => ({ fullRun: false, floorSize: 10, narrowSize: 2, failures: f });
  const lines: string[] = [];
  for (let shard = 1; shard <= gardener.SELECTOR_SHADOW_SHARDS; shard++) {
    const flakes = shard === 2 ? opts.recoveredFlakes ?? [] : [];
    const own = shard === 1 ? failures : flakes.map((file) => ({ file, floor: "selected", narrow: "selected" }));
    if (flakes.length > 0) {
      lines.push(`coverage-shard (${shard}/8)\t2026-10-06T00:00:00Z FLAKE-RETRY-FILES: retrying ${flakes.length} failed file(s) uninstrumented — ${flakes.join(", ")}`);
      lines.push(`coverage-shard (${shard}/8)\t2026-10-06T00:00:01Z FLAKE-RETRY-RECOVERED: a flake, not a pass — x`);
    }
    lines.push(`coverage-shard (${shard}/8)\tAFFECTED-SUITES-SHADOW: ${JSON.stringify(record(own))}`);
    lines.push(`coverage-shard (${shard}/8)\tSELECTOR-SHADOW-JOB: conclusion=${shard === 1 && failures.length > 0 ? "failure" : "success"}`);
  }
  return { id, headSha: `head-${id}`, prNumber: id, ...(opts.baseSha === undefined ? {} : { baseSha: opts.baseSha }), log: lines.join("\n") };
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}selector-attribution-`));
  // The filing checkout holds the files a narrow edge declares, as main does: lint-plan's admission reads them.
  for (const owner of ["src/lib/affected-suites.ts", "test/the-affected-suite-selector-runs-in-shadow.test.ts"]) {
    mkdirSync(join(root, owner, ".."), { recursive: true });
    writeFileSync(join(root, owner), "// fixture\n");
  }
  mkdirSync(join(root, "test"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const landed: Array<{ paths: string[]; title: string; body: string }> = [];
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const deps = {
    stateDir: join(root, "state"),
    repoRoot: root,
    openWorkspace: () => ({
      root,
      branch: "selector-shadow-garden-test",
      land: (opts: { paths: string[]; title: string; body: string }) => (landed.push(opts), `https://github.com/acme/remudero/pull/${100 + landed.length}`),
      dispose: () => {},
    }),
    log: (step: string, extra: Record<string, unknown> = {}) => {
      events.push({ step, extra });
      appendLedger(join(root, "state", "ledger.ndjson"), { run_id: "GARDEN-test", task_id: "DAEMON", step, ...extra });
    },
  };
  let minted = 0;
  const mint = () => `W1-T91${String(++minted).padStart(2, "0")}`;
  const rows = (step: string) => events.filter((e) => e.step === step).map((e) => e.extra!);
  const pass = (runs: gardener.SelectorShadowRun[], mainFailures?: gardener.SelectorShadowMainFailures) =>
    gardener.runSelectorShadowGardener(deps, () => runs, () => ["src/lib/changed.ts"], mint, () => [], undefined, mainFailures);
  return { root, landed, deps, rows, pass };
}

test("a missed failure that main also failed in the window is scored unattributed, not missed", async () => {
  const h = harness();
  const red = run(8101, [{ file: "test/red-on-main.test.ts", floor: "selected", narrow: "missed", retry: "failed" }], { baseSha: "base-red" });
  const report = await h.pass([red], async () => ["test/red-on-main.test.ts"]);
  assert.deepEqual(report.misses, [], "a base-red failure is not charged to the selector");
  assert.equal(report.narrow.missed, 0);
  assert.equal(report.narrow.failures, 0, "an unattributed miss is not narrow-observed evidence either");
  assert.notEqual(report.verdict, "misses");
  assert.deepEqual(report.unattributed, {
    floor: 0, narrow: 1,
    misses: [{ runId: 8101, headSha: "head-8101", baseSha: "base-red", prNumber: 8101, selection: "narrow", file: "test/red-on-main.test.ts", reason: "base_red" }],
  });
  // The stored observation carries the reason, so a later pass (no main reader at all) still excludes it.
  const stored = gardener.readSelectorShadowObservations(h.deps.stateDir).observations;
  assert.equal(stored[0]!.failures[0]!.unattributed, "base_red");
  const again = await h.pass([]);
  assert.deepEqual([again.misses.length, again.unattributed.narrow], [0, 1]);
});

test("a missed failure its retry recovered is scored unattributed, not missed", async () => {
  const h = harness();
  // Shard 1 concluded failure (another file failed twice), but this file's own retry passed.
  const mixed = run(8102, [
    { file: "test/recovered.test.ts", floor: "missed", narrow: "missed", retry: "recovered" },
    { file: "test/broken.test.ts", floor: "selected", narrow: "selected", retry: "failed" },
  ]);
  const report = await h.pass([mixed]);
  assert.deepEqual(report.misses, []);
  assert.deepEqual([report.floor.failures, report.floor.missed, report.narrow.failures, report.narrow.missed], [1, 0, 1, 0]);
  assert.deepEqual(report.unattributed.misses.map((m) => [m.selection, m.file, m.reason]), [
    ["floor", "test/recovered.test.ts", "retry_recovered"],
    ["narrow", "test/recovered.test.ts", "retry_recovered"],
  ]);
});

test("the selector-shadow gardener files no repair shard for an unattributed miss", async () => {
  const h = harness();
  const runs = [
    run(8103, [{ file: "test/recovered.test.ts", floor: "selected", narrow: "missed", retry: "recovered" }]),
    // flaky-host.test.ts recovered on retry in run 8105, so its miss in run 8104 is flake history.
    run(8104, [{ file: "test/flaky-host.test.ts", floor: "selected", narrow: "missed", retry: "failed" }], { baseSha: "base-green" }),
    run(8105, [], { recoveredFlakes: ["test/flaky-host.test.ts"] }),
  ];
  await h.pass(runs, async () => []);
  await h.pass(runs, async () => []);
  assert.equal(h.landed.length, 0, "no repair shard for a miss the diff did not cause");
  assert.equal(h.rows("selector-shadow.miss_filed").length, 0);
  assert.deepEqual(h.rows("selector-shadow.miss_unattributed"), [
    { ci_run_id: 8103, head_sha: "head-8103", file: "test/recovered.test.ts", selection: "narrow", reason: "retry_recovered", pr: 8103 },
    { ci_run_id: 8104, head_sha: "head-8104", file: "test/flaky-host.test.ts", selection: "narrow", reason: "flake_history", pr: 8104 },
  ], "each unattributed miss is ledgered once with its reason");
});

test("a mass run's misses leave the gate's arithmetic as unattributed", async () => {
  const h = harness();
  const files = Array.from({ length: gardener.SELECTOR_SHADOW_MASS_FAILURE_FILES + 1 }, (_, i) => `test/mass-${i}.test.ts`);
  const report = await h.pass([run(8106, files.map((file) => ({ file, floor: "selected", narrow: "missed" })))]);
  assert.deepEqual([report.misses.length, report.unattributed.narrow], [0, files.length]);
  assert.ok(report.unattributed.misses.every((m) => m.reason === "mass"));
  assert.equal(h.landed.length, 0);
});

test("CONTROL: a diff-caused miss (green on main, retry also failed) still counts as missed and still files", async () => {
  const h = harness();
  const real = run(8107, [{ file: "test/diff-caused.test.ts", floor: "selected", narrow: "missed", retry: "failed" }], { baseSha: "base-green" });
  const report = await h.pass([real], async () => ["test/unrelated.test.ts"]);
  assert.deepEqual(report.misses.map((m) => [m.selection, m.file]), [["narrow", "test/diff-caused.test.ts"]]);
  assert.equal(report.verdict, "misses");
  // Read only fields base also has, so this control passes before and after the change.
  assert.deepEqual([report.narrow.failures, report.narrow.missed], [1, 1]);
  assert.equal(h.landed.length, 1, "a genuine miss still files its repair shard");
  assert.match(h.landed[0]!.title, /diff-caused\.test\.ts/);
  assert.equal(h.rows("selector-shadow.miss_unattributed").length, 0);
});

test("an unreadable main result charges the miss rather than excusing it", async () => {
  const h = harness();
  const report = await h.pass([run(8108, [{ file: "test/c.test.ts", floor: "selected", narrow: "missed" }], { baseSha: "base-err" })],
    async () => { throw new Error("main CI unavailable"); });
  assert.equal(report.misses.length, 1);
  assert.equal(h.landed.length, 1);
  assert.equal(h.rows("selector-shadow.base_unread").length, 1, "one memoized read, ledgered once by the W1-T5350 guard");
});

test("a stored observation row with an unknown attribution or retry value is counted unreadable", () => {
  const h = harness();
  const row = (failure: Record<string, unknown>) => JSON.stringify({
    step: "selector-shadow.observation", ci_run_id: 1, head_sha: "h", source: "live", full_run: false, floor_size: 1,
    failures: [{ file: "test/a.test.ts", floor: "missed", ...failure }], recovered: 0,
  });
  const ledger = [row({ unattributed: "guess" }), row({ retry: "maybe" }), { ...JSON.parse(row({ retry: "recovered", unattributed: "base_red" })), ci_run_id: 2 }]
    .map((r) => typeof r === "string" ? r : JSON.stringify(r)).join("\n") + "\n";
  writeLedger(h.deps.stateDir, ledger);
  const read = gardener.readSelectorShadowObservations(h.deps.stateDir);
  assert.equal(read.unreadable, 2);
  assert.deepEqual(read.observations.map((o) => o.failures[0]), [{ file: "test/a.test.ts", floor: "missed", retry: "recovered", unattributed: "base_red" }]);
});

function writeLedger(stateDir: string, contents: string): void {
  // The live ledger the union reader reads first.
  writeFileSync(join(stateDir, "ledger.ndjson"), contents);
}

test("a shadow record line rejects an unknown retry outcome", () => {
  const line = (retry: string) => `AFFECTED-SUITES-SHADOW: ${JSON.stringify({ fullRun: false, floorSize: 1, failures: [{ file: "test/a.test.ts", floor: "missed", retry }] })}`;
  assert.deepEqual(gardener.parseSelectorShadowLines(line("recovered"))[0]!.failures, [{ file: "test/a.test.ts", floor: "missed", retry: "recovered" }]);
  assert.throws(() => gardener.parseSelectorShadowLines(line("maybe")), /invalid failure verdict/);
});

test("the CI shadow record names each retried file's own pass-two outcome", () => {
  const root = "/repo";
  const tap = (file: string) => `not ok 1 - t\n  ---\n  location: '/repo/${file}:1:1'\n  ...`;
  const log = [
    tap("test/a.test.ts"), tap("test/b.test.ts"),
    "2026-10-06T00:00:00Z FLAKE-RETRY-FILES: retrying 2 failed file(s) uninstrumented — test/a.test.ts, test/b.test.ts",
    tap("test/b.test.ts"),
    "FLAKE-RETRY: retry ALSO failed — t",
  ].join("\n");
  assert.deepEqual(shadowScript.retryOutcomes(log, root), { "test/a.test.ts": "recovered", "test/b.test.ts": "failed" });
  assert.deepEqual(shadowScript.retryOutcomes(tap("test/a.test.ts"), root), {}, "no retry ran");
  const unnamed = `${tap("test/a.test.ts")}\nFLAKE-RETRY-FILES: retrying 1 failed file(s) — test/a.test.ts\nFLAKE-RETRY: retry ALSO failed — (no test name parsed from output)`;
  assert.deepEqual(shadowScript.retryOutcomes(unnamed, root), {}, "a retry that failed naming no file cannot call any file recovered");
  const selection = { fullRun: false, suites: ["test/a.test.ts"], reasons: [], recentOnly: { floor: [] } };
  assert.deepEqual(shadowRecord(selection, ["test/a.test.ts", "test/c.test.ts"], { "test/a.test.ts": "recovered" }).failures, [
    { file: "test/a.test.ts", floor: "selected", retry: "recovered" },
    { file: "test/c.test.ts", floor: "missed" },
  ]);
});
