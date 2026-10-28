/**
 * When the operator closes a knowledge-gardener PR without merging it, the gardener remembers that PR's
 * merge and retire targets and never proposes them again (operator ruling, 2026-10-13). A gardener PR is
 * not an inbox proposal, so `rmd decline` cannot reach it; before this a close only debited the class,
 * and the next pass could re-propose the exact same retirement. A declined target is set aside before
 * the per-pass cap, so it never takes a slot from the next candidate in line.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { GardenStateUnreadableError } from "#src/lib/gardener.js";
import {
  gardenerStatePath,
  initialGardenerState,
  readGardenerState,
  runGardenPass,
  type GardenWorkspace,
  type PrState,
} from "#src/lib/knowledge-gardener.js";
import { learningUsagePath } from "#src/lib/knowledge-value.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

type Usage = { offered: number; used: number };
type Rows = Array<[string, Record<string, unknown> | undefined]>;

const AT = "2026-10-13T00:00:00.000Z";
const entry = (id: string) => [`- id: ${id}`, "  subsystem: t", "  lifecycle: active", "  files: [src/x.ts]", "  fact: >-", `    Entry ${id} alone.`, "  src: t", ""].join("\n");

/** Retired with certainty: every one of the 400 draws falls below the corpus median. */
const CERTAIN: Usage = { offered: 400, used: 0 };
/** The corpus's typical learning; sixteen of them set the median every candidate is judged against. */
const TYPICAL: Usage = { offered: 100, used: 80 };
const typical = Array.from({ length: 16 }, (_, i) => [`mm-typical-${String(i + 1).padStart(2, "0")}`, TYPICAL] as const);

let stamp = Date.parse("2026-10-01T00:00:00.000Z");
/** Write the corpus and its usage; each write gets a fresh mtime, so the next pass's cheap fingerprint moves. */
function writeCorpus(root: string, entries: ReadonlyArray<readonly [string, Usage]>): void {
  mkdirSync(join(root, "learnings"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const usage = learningUsagePath(join(root, "state"));
  writeFileSync(join(root, "learnings", "core.yaml"), entries.map(([id]) => entry(id)).join("\n"));
  writeFileSync(usage, JSON.stringify(Object.fromEntries(entries)));
  stamp += 60_000;
  utimesSync(usage, new Date(stamp), new Date(stamp));
}

/** A corpus where only the retire class may act. */
function corpus(entries: ReadonlyArray<readonly [string, Usage]>): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-decline-`));
  writeCorpus(root, entries);
  for (const c of ["merge", "refresh"]) writeFileSync(join(root, "state", `KNOWLEDGE_OFF-${c}`), "");
  return root;
}

/** One pass. Its PR lands from a copy of the corpus, as a real worktree does, so a closed PR leaves the corpus as it was. */
async function pass(root: string, opts: { land?: string; prState?: PrState; rows?: Rows; seed?: number } = {}) {
  const rows = opts.rows ?? [];
  const workspace = (): GardenWorkspace => {
    const ws = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-decline-ws-`));
    cpSync(join(root, "learnings"), join(ws, "learnings"), { recursive: true });
    return { root: ws, refreshAssertions: () => [], land: () => opts.land, dispose: () => rmSync(ws, { recursive: true, force: true }) };
  };
  const result = await runGardenPass({
    stateDir: join(root, "state"),
    repoRoot: root,
    openWorkspace: workspace,
    prState: () => opts.prState ?? "unknown",
    log: (s, e) => rows.push([s, e]),
    seed: opts.seed ?? 3,
    clock: fixedClock(Date.parse(AT)),
  });
  return { result, rows, state: readGardenerState(gardenerStatePath(join(root, "state"))) };
}

const targetsOf = (actions: ReadonlyArray<{ target: string }> | undefined) => (actions ?? []).map((a) => a.target).sort();
const rowsOf = (rows: Rows, step: string) => rows.filter(([s]) => s === step).map(([, e]) => e!);

test("a closed gardener PR's retire targets are never proposed again, and the next pass logs knowledge.kept_for_decline naming the PR", async () => {
  const declined = ["zz-certain-1", "zz-certain-2"];
  const root = corpus([...typical, ...declined.map((id) => [id, CERTAIN] as const)]);
  const first = await pass(root, { land: "https://github.com/acme/remudero/pull/41" });
  assert.equal(first.result.prUrl, "https://github.com/acme/remudero/pull/41");
  assert.deepEqual(targetsOf(first.result.plan?.actions), declined, "the first pass proposes both retirements");
  assert.deepEqual(first.state.pending?.targets, declined.map((target) => ({ class: "retire", target })), "its pending record carries the targets it acts on");
  // The operator closes #41 unmerged; meanwhile a third learning becomes a retirement candidate.
  writeCorpus(root, [...typical, ...declined.map((id) => [id, CERTAIN] as const), ["zz-certain-3", CERTAIN]]);
  const second = await pass(root, { land: "https://github.com/acme/remudero/pull/42", prState: "closed" });
  assert.deepEqual(rowsOf(second.rows, "knowledge.gardener_judged").map((r) => r.verdict), ["debit"], "the close still debits the class");
  assert.deepEqual(targetsOf(second.result.plan?.actions), ["zz-certain-3"], "only the new candidate is proposed; the declined two are not");
  assert.deepEqual(
    rowsOf(second.rows, "knowledge.kept_for_decline").map((r) => [r.class, r.target, r.pr_number]),
    declined.map((target) => ["retire", target, 41]),
    "each declined target is logged with the PR that declined it",
  );
  assert.deepEqual(second.state.declinedTargets, declined.map((target) => ({ class: "retire", target, prNumber: 41, declinedAt: AT })));
  // Later passes read the remembered list back from the state file, and still never propose them.
  writeCorpus(root, [...typical.map(([id]) => [id, { offered: 101, used: 81 }] as const), ...declined.map((id) => [id, CERTAIN] as const), ["zz-certain-3", CERTAIN]]);
  const third = await pass(root, { prState: "open" });
  assert.equal(third.result.prUrl, undefined, "#42 is still open, so nothing new lands");
  assert.deepEqual(third.state.declinedTargets?.map((d) => d.target), declined, "and the declined list survives the pass unchanged");
});

test("a MERGED gardener PR's targets are not remembered as declined, even when its metric later debits the class", async () => {
  const merged = ["zz-certain-1", "zz-certain-2"];
  const root = corpus([...typical, ...merged.map((id) => [id, CERTAIN] as const)]);
  const first = await pass(root, { land: "https://github.com/acme/remudero/pull/51" });
  assert.deepEqual(first.state.pending?.targets?.map((t) => t.target), merged, "the PR's pending carried targets a close would have declined");
  const rows: Rows = [];
  const pinned = await pass(root, { prState: "merged", rows });
  assert.ok(pinned.state.pending?.atMerge, "the merge pins the baseline the metric is judged from");
  // Workers are offered the corpus 1,000 more times and use none of it: the metric debits the merged class.
  writeCorpus(root, [...typical.slice(1), [typical[0]![0], { offered: 1_100, used: 80 }], ...merged.map((id) => [id, CERTAIN] as const)]);
  const judged = await pass(root, { prState: "merged", rows });
  assert.deepEqual(rowsOf(rows, "knowledge.gardener_judged").map((r) => r.verdict), ["debit"], "the merged class was debited by its metric");
  assert.deepEqual(judged.state.declinedTargets, [], "a merged PR's targets are never declined");
  assert.deepEqual(rowsOf(rows, "knowledge.kept_for_decline"), [], "so nothing is set aside for a decline");
});

test("a declined target does not take a slot of the per-pass cap: of 4 candidates with one declined, all 3 others act", async () => {
  const ids = ["a-certain", "b-certain", "c-certain", "d-certain"];
  const root = corpus([...typical, ...ids.map((id) => [id, CERTAIN] as const)]);
  writeFileSync(
    gardenerStatePath(join(root, "state")),
    JSON.stringify({ ...initialGardenerState(), declinedTargets: [{ class: "retire", target: "a-certain", prNumber: 12, declinedAt: "2026-10-12T00:00:00.000Z" }] }),
  );
  const { result, rows } = await pass(root, { land: "https://github.com/acme/remudero/pull/61" });
  assert.deepEqual(result.plan?.acting, ["retire"]);
  assert.deepEqual(targetsOf(result.plan?.actions), ["b-certain", "c-certain", "d-certain"], "the three undeclined candidates all act");
  assert.equal(result.scorecard?.deferred, undefined, "nothing is deferred: the declined entry held no cap slot");
  assert.deepEqual(rowsOf(rows, "knowledge.kept_for_decline").map((r) => [r.target, r.pr_number]), [["a-certain", 12]]);
});

test("a knowledge gardener state written before declinedTargets existed loads as an empty declined list", async () => {
  const root = corpus([...typical]);
  const path = gardenerStatePath(join(root, "state"));
  const legacy = { ...initialGardenerState(), lastCheap: "stale", pending: { prUrl: "https://github.com/acme/remudero/pull/7", actionClass: "retire", baseline: { trials: 1, successes: 1 } } };
  writeFileSync(path, JSON.stringify(legacy));
  assert.deepEqual(readGardenerState(path).declinedTargets, [], "no field reads as nothing declined");
  // Its pending predates recorded targets: closing it debits the class and declines nothing.
  const closed = await pass(root, { prState: "closed" });
  assert.deepEqual(closed.state.classes.retire, { alpha: 3, beta: 2 });
  assert.deepEqual(closed.state.declinedTargets, []);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).declinedTargets, undefined, "and no empty list is written for it");
  // A present field of the wrong shape is refused, never read as empty.
  writeFileSync(path, JSON.stringify({ ...legacy, declinedTargets: [{ class: "retire", target: "x" }] }));
  assert.throws(() => readGardenerState(path), GardenStateUnreadableError);
  writeFileSync(path, JSON.stringify({ ...legacy, pending: { ...legacy.pending, targets: "x" } }));
  assert.throws(() => readGardenerState(path), GardenStateUnreadableError);
});

test("the declined list keeps its newest 200 targets, and a closed url naming no PR number records a null number", async () => {
  const root = corpus([...typical]);
  const path = gardenerStatePath(join(root, "state"));
  const old = Array.from({ length: 199 }, (_, i) => ({ class: "retire", target: `old-${i}`, prNumber: 1, declinedAt: "2026-10-01T00:00:00.000Z" }));
  const pending = { prUrl: "https://example.invalid/garden", actionClass: "retire", baseline: { trials: 1, successes: 1 }, targets: [{ class: "retire", target: "new-1" }, { class: "merge", target: "new-2", into: "kept" }] };
  writeFileSync(path, JSON.stringify({ ...initialGardenerState(), lastCheap: "stale", pending, declinedTargets: old }));
  const { state } = await pass(root, { prState: "closed" });
  assert.equal(state.declinedTargets?.length, 200, "199 + 2 is bounded to 200");
  assert.equal(state.declinedTargets?.[0]?.target, "old-1", "the oldest entry is the one dropped");
  assert.deepEqual(state.declinedTargets?.slice(-2), [
    { class: "retire", target: "new-1", prNumber: null, declinedAt: AT },
    { class: "merge", target: "new-2", into: "kept", prNumber: null, declinedAt: AT },
  ]);
});
