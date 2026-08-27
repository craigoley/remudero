/**
 * test/uncredited-build-detection.test.ts — W1-T2392.
 *
 * THE DEFECT. A build can merge with no credit on ANY surface and then get built again — four
 * times in two days: W1-T2318 (four wasted dispatches), W1-T2323 (six), W1-T2326, and W1-T2379,
 * whose #3095 merged and was rebuilt by #3100 for $18.53 and a closed duplicate.
 *
 * RE-DERIVED AT HEAD (window 2026-08-25 to 2026-08-27, 271 merged PRs, 103 touching `src/` and
 * not a test): all three credit surfaces are empty on 31 of 103 builds, 30.1%. Of those 31,
 * 19 (61.3%) name a task id in their own prose and 12 (38.7%) name nothing at all.
 *
 * WHY THIS IS A WARN AND NOT A BLOCK. Refusing every trailerless src PR would refuse 30.1% of
 * everything that landed, including those twelve standalone repairs that were never builds of a
 * queued task. The shard forbids a blocking check outright. So this reports and takes no action:
 * `merged` is untouched, no dispatch or disposition changes, and a consumer that ignores the
 * field behaves byte-identically.
 *
 * WHY THE BODY IS READ AND NOT ONLY THE TITLE. Of those 19, only 5 name the id in the TITLE.
 * #3095 — the instance this task exists for — names W1-T2379 in its BODY alone, so a title-only
 * reader would have missed exactly the case that prompted the work. `PrRef.body` rides the same
 * batched `gh pr list` fetch `title` and `headRefName` already ride, so reading it costs nothing.
 *
 * NO FOURTH CREDIT PATH IS BUILT (the shard's Q2). Crediting from prose is the over-crediting
 * W1-T2387 was required to rule out: a task credited wrongly is never built at all, which is
 * worse than one built twice.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveStatus, projectPlan, indexProseNamedTaskIds, uncreditedBuildWarning } from "../src/lib/status.js";
import type { GitHub, PrRef } from "../src/lib/status.js";
import type { Plan, Task } from "../src/lib/plan.js";

const ledgerFile = (lines: Array<Record<string, unknown>>): string => {
  const p = join(mkdtempSync(join(tmpdir(), "rmd-t2392-")), "ledger.ndjson");
  writeFileSync(p, lines.map((l) => JSON.stringify({ ts: "2026-08-26T00:00:00.000Z", ...l })).join("\n") + "\n");
  return p;
};

/** Drives the REAL production path: `projectPlan` fetches the merged list once and builds the
 *  prose index from it, exactly as it does for W1-T257's batching. */
function project(ids: string[], deps: Parameters<typeof projectPlan>[1]) {
  const plan = { tasks: ids.map((i) => task(i)) } as unknown as Plan;
  return projectPlan(plan, deps);
}

const task = (id: string): Task =>
  ({ id, title: id, repo: "remudero", type: "implement", depends_on: [], status: "queued" }) as unknown as Task;

/** The three real shapes, as PRs the batched gateway would hand back. */
const PR_3095: PrRef = {
  number: 3095,
  url: "https://github.com/craigoley/remudero/pull/3095",
  state: "MERGED",
  title: "fix(sweep): stop the light-pass tick waiting on the fix rung's CI wait",
  headRefName: "fix/light-pass-tick-not-bounded-by-ci",
  body: "Builds W1-T2379, option (a) of its design: the light pass dispatches and returns.",
};
const PR_FILING: PrRef = {
  number: 3105,
  url: "https://github.com/craigoley/remudero/pull/3105",
  state: "MERGED",
  title: "chore(plan): file the build that merges with no credit on any surface (W1-T2392)",
  headRefName: "chore/plan-file-w1-t2392",
  body: "One new plan shard under the reserved id W1-T2392.",
};
const PR_REPAIR: PrRef = {
  number: 3019,
  url: "https://github.com/craigoley/remudero/pull/3019",
  state: "MERGED",
  title: "fix(cadence): create the marker directory instead of assuming it",
  headRefName: "fix/cadence-markers-create-their-directory",
  body: "The marker write assumed a directory that nothing created.",
};

/** Minimal gateway: enumerates merged PRs and answers `changedFiles`. Nothing else is needed —
 *  every other credit path is left unanswered on purpose, which is what "uncredited" means. */
function gateway(
  merged: PrRef[],
  filesByUrl: Record<string, string[] | undefined>,
  opts: { omitList?: boolean; omitChangedFiles?: boolean } = {},
): GitHub & { listCalls: number } {
  const g = {
    listCalls: 0,
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: (url: string) => merged.find((p) => p.url === url)?.headRefName,
    prBody: (url: string) => merged.find((p) => p.url === url)?.body,
  } as unknown as GitHub & { listCalls: number };
  if (!opts.omitList) {
    (g as unknown as { listMergedHeadBranches: () => PrRef[] }).listMergedHeadBranches = () => {
      g.listCalls++;
      return merged;
    };
  }
  if (!opts.omitChangedFiles) {
    (g as unknown as { changedFiles: (u: string) => string[] | undefined }).changedFiles = (u) => filesByUrl[u];
  }
  return g;
}

const SRC = ["src/lib/sweep.ts", "src/lib/daemon.ts", "test/x.test.ts"];
const PLAN_ONLY = ["plan/tasks.d/W1-T2392-a-build.yaml"];

// ── Q3: the predicate, proved on all three real shapes ───────────────────────────────────────

test("acceptance: the warn FIRES on the #3095 shape — every credit surface empty, prose names the task, diff touches src", () => {
  const g = gateway([PR_3095], { [PR_3095.url]: SRC });
  const proj = project(["W1-T2379"], { ledgerPath: ledgerFile([]), github: g }).get("W1-T2379")!;
  assert.equal(proj.merged, false, "the task is still NOT merged — this reports, it does not credit");
  assert.ok(proj.uncreditedBuild, "and it is reported");
  assert.equal(proj.uncreditedBuild!.prNumber, 3095);
  assert.equal(proj.uncreditedBuild!.namedIn, "body", "#3095 names W1-T2379 in its BODY, not its title");
});

test("acceptance: the warn is SILENT on a credited task — a merged, trailer-credited PR never reaches this at all", () => {
  // The #3043 shape: `deriveStatus` returns at "MERGED is terminal" long before the warn, so a
  // credited task cannot carry one. Driven through the real precedence rather than asserted.
  const url = "https://github.com/craigoley/remudero/pull/3043";
  const credited: PrRef = { number: 3043, url, state: "MERGED", title: "fix(sweep): report a stalled job", headRefName: "run-W1-T2340-1787801842342", body: "…\n\nRemudero-Task: W1-T2340\n" };
  const g = gateway([credited, PR_3095], { [url]: SRC, [PR_3095.url]: SRC });
  const proj = project(["W1-T2340"], { ledgerPath: ledgerFile([{ step: "pr.opened", task_id: "W1-T2340", pr_url: url }]), github: { ...g, prByRef: () => credited } as GitHub }).get("W1-T2340")!;
  assert.equal(proj.merged, true, "credited, so merged");
  assert.equal(proj.uncreditedBuild, undefined, "and carries no warning");
});

test("acceptance: the warn is SILENT on a standalone repair that names no task id", () => {
  const g = gateway([PR_REPAIR], { [PR_REPAIR.url]: SRC });
  const proj = project(["W1-T2379"], { ledgerPath: ledgerFile([]), github: g }).get("W1-T2379")!;
  assert.equal(proj.uncreditedBuild, undefined, "the twelve that name nothing must not warn");
});

test("acceptance: the warn is SILENT on a plan-only FILING that names its own id in its title", () => {
  // The largest naming population by far: every `chore(plan): file … (W1-T…)` names itself.
  const g = gateway([PR_FILING], { [PR_FILING.url]: PLAN_ONLY });
  const proj = project(["W1-T2392"], { ledgerPath: ledgerFile([]), github: g }).get("W1-T2392")!;
  assert.equal(proj.uncreditedBuild, undefined, "a filing is not a build — the plan-only refusal is load-bearing");
});

// ── it reports and does nothing else ──────────────────────────────────────────────────────────

test("acceptance: the warn changes no decision — status, merged and every other field are identical with and without it", () => {
  const withPr = project(["W1-T2379"], { ledgerPath: ledgerFile([]), github: gateway([PR_3095], { [PR_3095.url]: SRC }) }).get("W1-T2379")!;
  const without = project(["W1-T2379"], { ledgerPath: ledgerFile([]), github: gateway([], {}) }).get("W1-T2379")!;
  assert.ok(withPr.uncreditedBuild, "the first really did warn");
  assert.equal(without.uncreditedBuild, undefined);
  const strip = (p: Record<string, unknown>) => { const c = { ...p }; delete c.uncreditedBuild; return c; };
  assert.deepEqual(strip(withPr as unknown as Record<string, unknown>), strip(without as unknown as Record<string, unknown>),
    "every other field is byte-identical — this is a report, not a credit and not an action");
});

test("acceptance: a gateway that cannot enumerate merged PRs, or cannot read changed files, stays silent rather than guessing", () => {
  const noList = project(["W1-T2379"], { ledgerPath: ledgerFile([]), github: gateway([PR_3095], { [PR_3095.url]: SRC }, { omitList: true }) }).get("W1-T2379")!;
  assert.equal(noList.uncreditedBuild, undefined, "no enumeration ⇒ prior behaviour exactly");
  const noFiles = project(["W1-T2379"], { ledgerPath: ledgerFile([]), github: gateway([PR_3095], {}, { omitChangedFiles: true }) }).get("W1-T2379")!;
  assert.equal(noFiles.uncreditedBuild, undefined, "no file list ⇒ a build and a filing are indistinguishable, so say nothing");
  const unreadable = project(["W1-T2379"], { ledgerPath: ledgerFile([]), github: gateway([PR_3095], { [PR_3095.url]: undefined }) }).get("W1-T2379")!;
  assert.equal(unreadable.uncreditedBuild, undefined, "an UNREADABLE file list fails OPEN — never a fabricated warning");
});

// ── the index: anchored, both surfaces, walked once ───────────────────────────────────────────

test("indexProseNamedTaskIds: anchored on a [0-9] class, so a prefix id is never credited a longer one's mention", () => {
  const pr: PrRef = { number: 1, url: "u1", state: "MERGED", title: "t", body: "this names W1-T2392 only" };
  const idx = indexProseNamedTaskIds([pr]);
  assert.ok(idx.get("W1-T2392"), "the id itself is indexed");
  assert.equal(idx.get("W1-T239"), undefined, "and W1-T239 is NOT — the prefix trap this anchor exists for");
});

test("indexProseNamedTaskIds: reads the title AND the body, and prefers the title when both name it", () => {
  const idx = indexProseNamedTaskIds([PR_3095, PR_FILING]);
  assert.equal(idx.get("W1-T2379")![0].namedIn, "body", "body-only naming is seen — 14 of the 19 are this shape");
  assert.equal(idx.get("W1-T2392")![0].namedIn, "title", "title naming is seen — the other 5");
});

test("NO SECOND BATCHED FETCH: the prose index rides the merged list projectPlan already pulls", () => {
  // The naive per-task scan is ~2,400 merged PRs x ~900 tasks over multi-kilobyte bodies, and a
  // second `listMergedHeadBranches()` call would break W1-T257's own guard, which counts batched
  // fetches. So `projectPlan` walks the rows it already has, once, for the whole plan.
  const g = gateway([PR_3095, PR_FILING, PR_REPAIR], { [PR_3095.url]: SRC });
  const out = project(["W1-T2379", "W1-T2392", "W1-T1", "W1-T2"], { ledgerPath: ledgerFile([]), github: g });
  assert.equal(g.listCalls, 1, `exactly ONE batched fetch across four tasks, saw ${g.listCalls}`);
  assert.ok(out.get("W1-T2379")!.uncreditedBuild, "and the warning still lands");
});

test("a per-task deriveStatus caller, which supplies no index, is silent and unchanged", () => {
  const g = gateway([PR_3095], { [PR_3095.url]: SRC });
  const proj = deriveStatus(task("W1-T2379"), { ledgerPath: ledgerFile([]), github: g });
  assert.equal(proj.uncreditedBuild, undefined, "no index supplied ⇒ prior behaviour exactly");
  assert.equal(g.listCalls, 0, "and deriveStatus never enumerates merged PRs on its own account");
});

test("uncreditedBuildWarning: the pure predicate takes the index and a file reader and nothing else", () => {
  const idx = indexProseNamedTaskIds([PR_3095]);
  assert.ok(uncreditedBuildWarning("W1-T2379", idx, () => SRC), "fires on a src-touching build");
  assert.equal(uncreditedBuildWarning("W1-T2379", idx, () => PLAN_ONLY), undefined, "silent on a plan-only diff");
  assert.equal(uncreditedBuildWarning("W1-T2379", idx, undefined), undefined, "silent with no file reader");
  assert.equal(uncreditedBuildWarning("W1-T9999", idx, () => SRC), undefined, "silent for a task nothing names");
  assert.equal(uncreditedBuildWarning("W1-T2379", undefined, () => SRC), undefined, "silent with no index");
});

test("nothing added paces or throttles or sleeps a call", () => {
  const realTimeout = globalThis.setTimeout;
  const realInterval = globalThis.setInterval;
  let timers = 0;
  globalThis.setTimeout = ((...a: unknown[]) => { timers++; return (realTimeout as unknown as (...x: unknown[]) => unknown)(...a); }) as typeof setTimeout;
  globalThis.setInterval = ((...a: unknown[]) => { timers++; return (realInterval as unknown as (...x: unknown[]) => unknown)(...a); }) as typeof setInterval;
  try {
    deriveStatus(task("W1-T2379"), { ledgerPath: ledgerFile([]), github: gateway([PR_3095], { [PR_3095.url]: SRC }) });
  } finally {
    globalThis.setTimeout = realTimeout;
    globalThis.setInterval = realInterval;
  }
  assert.equal(timers, 0, "the derivation schedules no timer of its own");
});
