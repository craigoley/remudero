import assert from "node:assert/strict";
import { test } from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fixedClock } from "../src/lib/clock.js";
import { defectEventsOf, fixLaneGardenSpec, fixLaneInventoryOf } from "../src/lib/fix-lane-gardener.js";
import * as gardener from "../src/lib/fix-lane-gardener.js";
import type { LedgerRecord } from "../src/lib/retro.js";
import { ghShim } from "./helpers/gh-shim.js";

const NOW = Date.UTC(2026, 9, 10, 12);
const at = (hour: number) => fixedClock(NOW + hour * 3_600_000).iso();
const coverage = "diff-coverage: BLOCKED -- this diff adds source line(s) with zero covering tests\n  - src/lib/reader.ts:6";
const source = `import { readFileSync } from "node:fs";
export function readPrior(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    return { reason: String(error) };
  }
}`;
const red = (check: string, signature: string) => ({ check, signature });
const rows = (): LedgerRecord[] => [
  { step: "fix.dispatch", pr_number: 10, ts: at(-6), round_id: "r1", head_sha: "old", ci_failures: [red("coverage-ratchet", "diff-coverage: BLOCKED")] },
  { step: "fix.done", pr_number: 10, ts: at(-5), round_id: "r1", fix_outcome: "FIXED", head_sha: "old", pushed_head_sha: "new" },
  { step: "fix.dispatch", pr_number: 10, ts: at(-4), round_id: "r2", head_sha: "new", ci_failures: [red("rule-checks", "test/the-affected-suite-reach-ratchet.test.ts")] },
];
const evidence = { readHeadSource: (head: string, file: string) => {
  assert.equal(head, "old"); assert.equal(file, "src/lib/reader.ts"); return source;
}, readCoverageLog: (head: string) => { assert.equal(head, "old"); return coverage; } };

test("test/the-fix-lane-gardener-prices-unseamed-catches-and-swapped-reds.test.ts", () => {
  const inventory = fixLaneInventoryOf(rows(), [], new Map(), { ok: true, interventions: [] }, NOW, evidence);
  assert.deepEqual(inventory.priced.map(p => [p.key, p.hours]), [
    ["coverage-unseamed-catch", 6], ["fix-swapped-red-for-census", 4],
  ]);
  const events = defectEventsOf(rows(), NOW, evidence);
  assert.match(events[0]!.evidence, /src\/lib\/reader.ts:6.*readFileSync.*missing injectable seam/);
  assert.match(events[1]!.evidence, /r1.*coverage-ratchet.*r2.*rule-checks.*new/);
  const spec = fixLaneGardenSpec({ repoRoot: ".", stateDir: ".", clock: fixedClock(NOW), log: () => {},
    openWorkspace: () => { throw new Error("unexpected workspace"); } }, {
    owner: "acme", repo: "remudero", mintTaskId: () => "W1-T9001", ledgerRecords: rows,
    planState: () => ({ tasks: [] }), prOutcomes: () => new Map(), interventions: () => ({ ok: true, interventions: [] }),
    ...evidence,
  });
  assert.deepEqual(spec.candidates(spec.inventory(), () => 0).map(a => a.origin), ["fix-lane:coverage-unseamed-catch"]);
  const open = fixLaneInventoryOf(rows(), [{ id: "W1-T9000", origin: "fix-lane:coverage-unseamed-catch", status: "queued", retired: false,
    files: ["src/lib/reader.ts"] }], new Map(), { ok: true, interventions: [] }, NOW, evidence);
  assert.deepEqual(spec.candidates(open, () => 0).map(a => a.origin), ["fix-lane:fix-swapped-red-for-census"]);
});

const coverageEvents = (text: string | undefined, log = coverage) => defectEventsOf(rows().slice(0, 1), NOW, {
  readHeadSource: () => text, readCoverageLog: () => log,
}).filter(e => e.key === "coverage-unseamed-catch");

test("only a complete uncovered set inside unseamed catch arms is priced", () => {
  assert.equal(coverageEvents(source).length, 1);
  assert.equal(coverageEvents(source, coverage.split("\n").map(line => `2026-10-10T01:02:03.000Z ${line}`).join("\n")).length, 1);
  assert.deepEqual(coverageEvents(source.replace("path: string", "path: string, readFileSync = reader")), []);
  assert.deepEqual(coverageEvents(source.replace("path: string", "path: string, deps: { read: typeof readFileSync }")
    .replace("return readFileSync", "return deps.read")), []);
  assert.deepEqual(coverageEvents(source.replace("path: string", "path: string, deps: { read?: typeof readFileSync }")
    .replace("  try {", "  const read = deps.read ?? readFileSync; try {").replace("return readFileSync", "return read")), []);
  assert.equal(coverageEvents(source.replace("  try {", "  const label = path; try {")).length, 1, "an unrelated parameter use is not a reader seam");
  assert.equal(coverageEvents(source.replace("  try {", '  const label = `outer${{ key: `inner${path}` }}tail${path}`; try {')).length, 1);
  assert.equal(coverageEvents(source.replace("  try {", '  const pattern = /[{}]/; try {')).length, 1);
  assert.equal(coverageEvents(source.replace("  try {", '  const pattern = path ? /[{}]/ : /x/; try {')).length, 1);
  assert.equal(coverageEvents(source.replace("catch (error)", "catch")).length, 1);
  assert.equal(coverageEvents(source.replace('import { readFileSync }', 'import * as fs')
    .replace('readFileSync(path, "utf8")', 'fs.promises.readFile(path, "utf8")')).length, 1);
  assert.deepEqual(coverageEvents(source, coverage + "\n  - src/lib/reader.ts:4"), []);
  assert.deepEqual(coverageEvents(source, coverage + "\n  ... 1 more not listed"), []);
  assert.deepEqual(coverageEvents(source, "diff-coverage: OK"), []);
  assert.deepEqual(coverageEvents(source, coverage.replace(":6", ":99")), []);
  assert.deepEqual(coverageEvents(undefined), []);
  assert.deepEqual(coverageEvents('const text = "catch (error) { readFileSync(); }";'), []);
  assert.deepEqual(coverageEvents(source.slice(0, -1)), []);
  assert.deepEqual(coverageEvents(source.replace("catch (error)", "catch (error]")), []);
  assert.deepEqual(coverageEvents(source.replace("export function", "export 💥 function")), []);
  assert.deepEqual(coverageEvents('const text = "unterminated;'), []);
  assert.deepEqual(coverageEvents('const text = `start${path}unterminated'), []);
  assert.deepEqual(coverageEvents(source.replace('readFileSync(path, "utf8")', 'JSON.parse(path)')), []);
  const ownLog = rows().slice(0, 1);
  ownLog[0]!.ci_failures = [{ ...red("coverage-ratchet", "blocked"), logTail: coverage }, null, {}];
  assert.equal(defectEventsOf(ownLog, NOW, { readHeadSource: () => source,
    readCoverageLog: () => { throw new Error("payload already contains the log"); } }).length, 1);
  assert.deepEqual(defectEventsOf([{ ...ownLog[0]!, head_sha: undefined }], NOW, evidence), []);
});

test("an unseamed default parameter implementation is priced and its own injected reader is reachable", () => {
  const text = `import { writeFileSync } from "node:fs";
function writeRecord(writer = (row: string) => {
  return writeFileSync("ledger", row);
}) { return writer("hello"); }`;
  const log = coverage.replace(":6", ":3");
  assert.match(coverageEvents(text, log)[0]!.evidence, /writeFileSync: missing injectable seam/);
  assert.deepEqual(coverageEvents(text.replace("row: string", "row: string, writeFileSync = writerImpl"), log), []);
  assert.equal(coverageEvents('import { writeFileSync } from "node:fs"; function writeRecord(writer = row => writeFileSync("ledger", row)) { return writer("hello"); }',
    coverage.replace(":6", ":1")).length, 1);
  const arrow = source.replace("export function readPrior(path: string)", "export const readPrior = (path: string) =>");
  assert.equal(coverageEvents(arrow).length, 1);
});

test("census swaps require cleared reds and consecutive rounds joined by a pushed head on the same PR", () => {
  const swapped = (list: LedgerRecord[]) => defectEventsOf(list, NOW).filter(e => e.key === "fix-swapped-red-for-census");
  assert.equal(swapped(rows()).length, 1);
  for (const [index, patch] of [
    [1, { fix_outcome: "FLAKE" }], [1, { pushed_head_sha: undefined }], [1, { ts: at(-3) }],
    [1, { ts: at(-7) }], [1, { pr_number: 11 }],
    [2, { head_sha: "unrelated" }], [2, { pr_number: 11 }], [2, { round_id: "r1" }],
    [2, { round_id: undefined }], [2, { ci_failures: [] }], [0, { ci_failures: [] }],
    [2, { ci_failures: [red("coverage-ratchet", "diff-coverage: BLOCKED"), red("rule-checks", "census")] }],
    [2, { ci_failures: [red("ci", "test/ordinary.test.ts")] }],
  ] as Array<[number, Record<string, unknown>]>) {
    const list = rows(); list[index] = { ...list[index]!, ...patch }; assert.deepEqual(swapped(list), [], JSON.stringify(patch));
  }
  const same = rows(); same[0]!.ci_failures = same[2]!.ci_failures;
  assert.deepEqual(swapped(same), []);
  const intervening = rows(); intervening.splice(2, 0, { step: "fix.dispatch", pr_number: 10, ts: at(-4.5), round_id: "other", head_sha: "new" });
  assert.deepEqual(swapped(intervening), []);
  for (const failure of [red("census-precheck", "x"), red("coverage (1/8)", "test/config-reader-seams-census.test.ts"),
    red("coverage-session-blanking", "x"), red("ci", "test/env-var-registry.test.ts"), red("reach-ratchet", "x")]) {
    const list = rows(); list[2]!.ci_failures = [failure]; assert.equal(swapped(list).length, 1, failure.check);
  }
  const three = rows(); three.push(
    { step: "fix.done", pr_number: 10, round_id: "r2", ts: at(-3), fix_outcome: "FIXED", pushed_head_sha: "third" },
    { step: "fix.dispatch", pr_number: 10, round_id: "r3", ts: at(-2), head_sha: "third", ci_failures: [red("coverage-session-blanking", "new red")] });
  assert.equal(swapped(three).length, 2);
});

test("the native evidence reader uses the async transport at the exact recorded head", async t => {
  const shim = ghShim([
    { when: "contents/src/lib/reader.ts?ref=old", stdout: JSON.stringify({ encoding: "base64", content: Buffer.from(source).toString("base64") }) },
    { when: "commits/old/check-runs", stdout: JSON.stringify([{ check_runs: [
      { id: 1, name: "coverage-ratchet", conclusion: "failure", details_url: "https://github.com/acme/remudero/actions/runs/1/jobs/44" },
      { id: 2, name: "coverage-ratchet", conclusion: "failure", details_url: "https://github.com/acme/remudero/actions/runs/1/jobs/45" },
      { id: 1, name: "coverage-ratchet", conclusion: "failure", details_url: "https://github.com/acme/remudero/actions/runs/1/jobs/44" },
      { id: 3, name: "ci", conclusion: "failure" },
    ] }, { check_runs: [{ id: 4, name: "diff-coverage", conclusion: "failure", external_id: "46" },
      { id: 5, name: "coverage-ratchet-success", conclusion: "success" }, { id: 47, name: "diff-coverage-other", conclusion: "failure" }] }]) },
    { when: "actions/jobs/45/logs", stdout: coverage }, { when: "actions/jobs/46/logs", stdout: "diff-coverage: OK" },
    { when: "actions/jobs/47/logs", stdout: "diff-coverage: OK" },
  ]);
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const keys = ["PATH", "RMD_GH_CACHE_HOME", "RMD_GH_SHARED_READ_GAP_MS"];
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  process.env.PATH = `${shim.dir}:${process.env.PATH}`;
  process.env.RMD_GH_CACHE_HOME = join(shim.dir, "cache");
  process.env.RMD_GH_SHARED_READ_GAP_MS = "0";
  t.after(() => { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const native = await gardener.readFixLaneEvidence({ owner: "acme", repo: "remudero" }, rows());
  assert.equal(defectEventsOf(rows(), NOW, native).filter(e => e.key === "coverage-unseamed-catch").length, 1);
  assert.deepEqual(shim.calls().map(c => c.replace(/^api /, "")), [
    "repos/acme/remudero/commits/old/check-runs?per_page=100 --paginate --slurp",
    "repos/acme/remudero/actions/jobs/45/logs", "repos/acme/remudero/actions/jobs/46/logs",
    "repos/acme/remudero/actions/jobs/47/logs", "repos/acme/remudero/contents/src/lib/reader.ts?ref=old",
  ]);
  shim.addRoute({ when: "contents/", stdout: "{}" });
  await assert.rejects(() => gardener.readFixLaneEvidence({ owner: "acme", repo: "remudero" }, rows()), /fix-lane source unreadable.*reader.ts@old/);
  shim.addRoute({ when: "check-runs", stderr: "denied", exit: 1 });
  await assert.rejects(() => gardener.readFixLaneEvidence({ owner: "acme", repo: "remudero" }, rows()), /denied/);
});

test("a garden pass reuses each head's evidence and an unreadable head stops measurement", () => {
  let logReads = 0, sourceReads = 0;
  const spec = fixLaneGardenSpec({ repoRoot: ".", stateDir: ".", clock: fixedClock(NOW), log: () => {},
    openWorkspace: () => { throw new Error("unexpected workspace"); } }, {
    owner: "acme", repo: "remudero", mintTaskId: () => "W1-T9001", ledgerRecords: rows,
    planState: () => ({ tasks: [] }), prOutcomes: () => new Map(), interventions: () => ({ ok: true, interventions: [] }),
    readHeadSource: () => { sourceReads++; return source; }, readCoverageLog: () => { logReads++; return coverage; },
  });
  assert.equal(spec.inventory().priced.length, 2);
  assert.equal(sourceReads, 1); assert.equal(logReads, 1);
  const unavailable = fixLaneGardenSpec({ repoRoot: ".", stateDir: ".", clock: fixedClock(NOW), log: () => {},
    openWorkspace: () => { throw new Error("unexpected workspace"); } }, {
    owner: "acme", repo: "remudero", mintTaskId: () => "W1-T9001", ledgerRecords: rows,
    planState: () => ({ tasks: [] }), readCoverageLog: () => coverage,
    readHeadSource: () => { throw new Error("head source unavailable"); },
  });
  assert.throws(() => unavailable.inventory(), /head source unavailable/);
});
