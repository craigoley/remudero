/**
 * test/unfiled-prs-do-not-supersede-each-other.test.ts — W1-T3535.
 *
 * THE DEFECT. W1-T3388 made `run-unfiled-<epochMs>` the CANONICAL head ref for an ad-hoc repair
 * with no filed task, and `scripts/head-identity-gate.mjs` refuses a PR that does not use it. But
 * `resolveOpenPrTaskId` then recovers the literal id `unfiled` from every such branch, and
 * `buildOpenPrViews` grouped every recovered id in `byTask` — so all ad-hoc PRs in the repo shared
 * ONE ownership key, the highest-numbered one marked the rest `supersededBy`, and the sweep's
 * `stale` row closed them with "superseded-by #N". The two gates contradicted each other: one
 * mandates the branch name, the other punishes it.
 *
 * OBSERVED TWICE ON THE LIVE QUEUE: #5411 closed by #5412 (2026-09-13, this task's filing
 * evidence), and #5630/#5631 closed by #5632 on 2026-09-15 — a `/v1/status` projection change
 * that shared not one changed path with either.
 *
 * These tests drive the REAL producer (`buildOpenPrViews`) rather than hand-built `OpenPrView`
 * fixtures, the discipline test/openpr-taskid-resolver.test.ts already uses for this function: a
 * regression that re-widens the grouping fails a population check, not a fabricated field.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildOpenPrViews } from "../src/run-task.js";

function ledgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-unfiled-supersession-"));
  const path = join(dir, "ledger.ndjson");
  writeFileSync(path, "");
  return path;
}

/** One open PR in the REST list shape `fetchOpenPrsRest`/`mapRestPr` expects. */
function restPr(over: { number: number; headRefName: string; body: string }): Record<string, unknown> {
  return {
    number: over.number,
    html_url: `https://github.com/craigoley/remudero/pull/${over.number}`,
    head: { ref: over.headRefName, sha: `${"a".repeat(39)}${over.number}` },
    updated_at: "2026-09-15T12:00:00.000Z",
    body: over.body,
    auto_merge: null,
    state: "open",
  };
}

/**
 * A `fetch` stub that answers the open-PR list AND the `GET /pulls/:n/files` read
 * `hydratePlanFilingFiles` issues for any PR with no `pr.opened{plan_only:true}` receipt.
 * EVERY PR here is given a NON-plan changed path on purpose: an empty file list would classify as
 * a plan-only filing, which WITHHOLDS the head-ref fallback and would leave `taskId` undefined —
 * turning every assertion below into a vacuous pass for the wrong reason.
 */
function fetchFor(prs: Array<Record<string, unknown>>, filesByPr: Map<number, string>): (args: string[]) => unknown {
  return (args: string[]): unknown => {
    const path = args[args.length - 1] ?? "";
    if (/state=open/.test(path)) return prs;
    const files = /\/pulls\/(\d+)\/files/.exec(path);
    if (files) return [{ filename: filesByPr.get(Number(files[1])) ?? "src/lib/untouched.ts" }];
    return [];
  };
}

function viewsFor(prs: Array<Record<string, unknown>>, filesByPr: Map<number, string>) {
  return buildOpenPrViews("craigoley", "remudero", ledgerPath(), {
    fetch: fetchFor(prs, filesByPr),
    requiredContexts: () => [],
  });
}

test("W1-T3535 criterion 1: two open run-unfiled branches have no supersededBy relationship merely because they share the sentinel", () => {
  // The exact live shape: two independent ad-hoc repairs, conforming branch names, disjoint diffs.
  const prs = [
    restPr({ number: 5630, headRefName: "run-unfiled-1789474181000", body: "a census repair" }),
    restPr({ number: 5632, headRefName: "run-unfiled-1789473581000", body: "a status-route repair" }),
  ];
  const files = new Map([
    [5630, "scripts/expiring-fixture-census.mjs"],
    [5632, "src/lib/status-board.ts"],
  ]);
  const views = viewsFor(prs, files);
  assert.equal(views.length, 2);

  const older = views.find((v) => v.prNumber === 5630);
  const newer = views.find((v) => v.prNumber === 5632);
  assert.ok(older && newer, "both PRs must be projected");

  // THE ANTI-VACUITY CONTROL, and the second half of criterion 2: attribution is UNCHANGED. If
  // this read `undefined`, the assertions below would pass because nothing resolved at all rather
  // than because ownership was narrowed — a different fix with the same green.
  assert.equal(older.taskId, "unfiled", "the sentinel still resolves as the review/ledger attribution fallback");
  assert.equal(newer.taskId, "unfiled", "…for both of them — the branch contract is untouched");

  assert.equal(older.supersededBy, undefined, "the newer ad-hoc PR must not own the older one's work");
  assert.equal(newer.supersededBy, undefined, "and supersession is not reciprocal either");
  assert.equal(older.supersessionVerdict, undefined, "no verdict is hydrated for a PR that was never flagged");
});

test("W1-T3535 criterion 3: two open PRs that claim the same real task still mark only the lower-numbered PR superseded", () => {
  // The control that stops the exclusion being written too wide. A real id must group exactly as
  // it always has, or this task has removed the guard instead of narrowing it.
  const prs = [
    restPr({ number: 5411, headRefName: "run-W1-T900-1789000000000", body: "first attempt" }),
    restPr({ number: 5412, headRefName: "run-W1-T900-1789100000000", body: "second attempt" }),
  ];
  const files = new Map([
    [5411, "src/lib/sweep.ts"],
    [5412, "src/lib/sweep.ts"],
  ]);
  const views = viewsFor(prs, files);

  const older = views.find((v) => v.prNumber === 5411);
  const newer = views.find((v) => v.prNumber === 5412);
  assert.ok(older && newer, "both PRs must be projected");
  assert.equal(older.taskId, "W1-T900");
  assert.equal(newer.taskId, "W1-T900");

  assert.equal(older.supersededBy, 5412, "a REAL shared task id still establishes ownership");
  assert.equal(newer.supersededBy, undefined, "the highest-numbered peer is never superseded by a lower one");
});

test("W1-T3535: a real-task PR and an ad-hoc PR never see each other, in either direction", () => {
  // A mixed board is the ordinary case, and the two keys must not leak into one another: the
  // sentinel cannot be superseded by a filed PR, and a filed PR cannot be superseded by an ad-hoc
  // one that merely happens to carry a higher number.
  const prs = [
    restPr({ number: 5700, headRefName: "run-W1-T901-1789000000000", body: "a filed build" }),
    restPr({ number: 5701, headRefName: "run-unfiled-1789200000000", body: "an ad-hoc repair" }),
  ];
  const files = new Map([
    [5700, "src/lib/plan.ts"],
    [5701, "scripts/comment-load-ratchet.mjs"],
  ]);
  const views = viewsFor(prs, files);

  const filed = views.find((v) => v.prNumber === 5700);
  const adHoc = views.find((v) => v.prNumber === 5701);
  assert.ok(filed && adHoc, "both PRs must be projected");
  assert.equal(filed.taskId, "W1-T901");
  assert.equal(adHoc.taskId, "unfiled");
  assert.equal(filed.supersededBy, undefined, "a higher-numbered ad-hoc PR cannot own a filed task's work");
  assert.equal(adHoc.supersededBy, undefined, "and the sentinel is not owned by anything either");
});

test("W1-T3535: THREE ad-hoc PRs stay independent — the defect closed every one below the maximum, not merely the adjacent pair", () => {
  const prs = [
    restPr({ number: 5610, headRefName: "run-unfiled-1789400000000", body: "one" }),
    restPr({ number: 5620, headRefName: "run-unfiled-1789450000000", body: "two" }),
    restPr({ number: 5630, headRefName: "run-unfiled-1789474181000", body: "three" }),
  ];
  const files = new Map([
    [5610, "src/lib/a.ts"],
    [5620, "src/lib/b.ts"],
    [5630, "src/lib/c.ts"],
  ]);
  const views = viewsFor(prs, files);
  assert.equal(views.length, 3);
  for (const v of views) {
    assert.equal(v.taskId, "unfiled", `#${v.prNumber} still attributes to the sentinel`);
    assert.equal(v.supersededBy, undefined, `#${v.prNumber} must stand on its own`);
  }
});
