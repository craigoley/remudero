import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOpenPrViews } from "../src/run-task.js";
import {
  PLAN_FILING_FILE_RESPONSE_CAP,
  createPlanFilingFileCache,
  hydratePlanFilingFiles,
  type GhApiFetcher,
} from "../src/lib/open-prs-rest.js";
import {
  DEFAULT_SWEEP_POLICY,
  oldestActivityFirst,
  reviewAdmissionKey,
  selectReviewAdmission,
  selectReviewAdmissions,
  type OpenPrView,
} from "../src/lib/sweep.js";

// ── W1-T2439 — THE REVIEW CAP IS PRICED FOR A JUDGE 98% OF PLAN-ONLY REVIEWS NEVER SPAWN ────
//
// Half one wires `isPlanFiling`'s producer; half two splits the admission on it. The bound
// cannot key on `reviewer_outcome` — that is written AFTER the review runs, and this selector
// receives only views, a policy and a clock (the shard's Q1). `isPlanFiling` is the one signal
// available at admission, which is why the producer had to land first.

const NOW = Date.parse("2026-08-28T12:00:00Z");

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 1,
    prUrl: "https://github.com/o/r/pull/1",
    taskId: "W1-TX",
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-08-28T11:00:00Z",
    createdAt: "2026-08-01T00:00:00Z",
    headSha: "aaaa111",
    autoMergeArmed: false,
    ...over,
  };
}
const filing = (n: number, created: string) => pr({ prNumber: n, createdAt: created, isPlanFiling: true });
const build = (n: number, created: string) => pr({ prNumber: n, createdAt: created, isPlanFiling: false });

// ── acceptance 1: the producer populates the signal ─────────────────────────────────────────

test("W1-T2439 (acceptance 1): buildOpenPrViews assigns isPlanFiling from the ledger predicate", () => {
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  assert.match(src, /new Map\(raw\.map\(\(pr\) => \[pr\.number, isPlanOnlyFilingPr\(ledger, pr\.url\)\]\)\)/,
    "the producer must still derive the emitter fast path from the shared ledger predicate");
  assert.match(src, /isPlanFiling: planFiling\.isPlanFiling,/,
    "the producer must assign the classified key plainly, never through a conditional spread");
  // The census walks TOP-LEVEL KEYS and pushes any spread onto `unresolvableSpreads` — the shape
  // that made #3127 read as unwired. Assert the key is not inside one.
  assert.ok(!/\.\.\.\([^)]*isPlanFiling/.test(src), "isPlanFiling must not be assigned via a spread");
});

test("W1-T2439 (acceptance 1, control): the KNOWN_UNWIRED entry is removed, not left in place", () => {
  const allow = readFileSync(new URL("../src/lib/producer-completeness.ts", import.meta.url), "utf8");
  // Strip comments before asserting: the mechanism this test pins is that `isPlanFiling` is no
  // longer a LIVE key of the KNOWN_UNWIRED object literal (that is what the completeness audit
  // actually reads) -- not that some comment nearby happens to say a sentence. A comment-only
  // match would be satisfiable by prose alone, never by the audit's own code path.
  const withoutComments = allow.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const entry = /^\s{2}isPlanFiling:\s*$/m.test(allow) || /^\s{2}isPlanFiling:\s*"/m.test(allow);
  assert.equal(entry, false, "the field is wired, so its allowlist entry must be gone (this file's own rule)");
  assert.ok(!/\bisPlanFiling\s*:/.test(withoutComments),
    "isPlanFiling must not appear as a live key anywhere in KNOWN_UNWIRED once comments are stripped");
});

// ── acceptance 2: the cheap lane admits more than one ───────────────────────────────────────

test("W1-T2439 (acceptance 2): the non-spawning lane admits more than one plan filing per pass", () => {
  const q = [filing(10, "2026-08-01T00:00:00Z"), filing(11, "2026-08-02T00:00:00Z"), filing(12, "2026-08-03T00:00:00Z")];
  const { planFilings } = selectReviewAdmissions(q, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(planFilings.length, 3, "three filings, bound 3 — all admitted");
  assert.ok(planFilings.length > 1, "the whole point: MORE than one, which today's cap forbids");
  assert.deepEqual(planFilings.map((p) => p.prNumber), [10, 11, 12], "and oldest-first by the immutable key");
});

test("W1-T2439 (acceptance 2): the cheap lane is BOUNDED — a queue deeper than the bound is truncated", () => {
  const q = [10, 11, 12, 13, 14].map((n, i) => filing(n, `2026-08-0${i + 1}T00:00:00Z`));
  const { planFilings } = selectReviewAdmissions(q, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(planFilings.length, DEFAULT_SWEEP_POLICY.planFilingAdmissionBound,
    "a lane with no bound would spend the budget faster than the one this unblocks");
  assert.deepEqual(planFilings.map((p) => p.prNumber), [10, 11, 12], "the OLDEST three, never an arbitrary three");
});

// ── acceptance 3: the spawning lane uses the configured review budget ───────────────────────

test("W1-T2439/W1-T2792: the spawning lane admits the oldest configured reviewLanes", () => {
  const q = [build(20, "2026-08-01T00:00:00Z"), build(21, "2026-08-02T00:00:00Z"), build(22, "2026-08-03T00:00:00Z")];
  const { spawning } = selectReviewAdmissions(q, DEFAULT_SWEEP_POLICY, NOW);
  assert.deepEqual(spawning.map((p) => p.prNumber), [20, 21], "the oldest two builds win the configured two lanes");
  assert.equal(selectReviewAdmission(q, DEFAULT_SWEEP_POLICY, NOW)?.prNumber, 20,
    "and the singular entry point is byte-identical in behaviour to what W1-T526 always ran");
});

test("W1-T2439 (acceptance 3): a build is REFUSED by the spawning bound even while filings are admitted", () => {
  const q = [
    build(20, "2026-08-01T00:00:00Z"),
    build(21, "2026-08-02T00:00:00Z"),
    build(22, "2026-08-03T00:00:00Z"),
    filing(30, "2026-08-04T00:00:00Z"),
    filing(31, "2026-08-05T00:00:00Z"),
  ];
  const { spawning, planFilings } = selectReviewAdmissions(q, DEFAULT_SWEEP_POLICY, NOW);
  assert.deepEqual(spawning.map((p) => p.prNumber), [20, 21], "both configured semantic lanes are admitted");
  assert.ok(!planFilings.some((p) => p.prNumber === 22), "the THIRD build is not smuggled into the cheap lane");
  assert.deepEqual(planFilings.map((p) => p.prNumber), [30, 31], "only real filings ride the cheap lane");
});

// ── acceptance 4: a plan-only review that reaches the judge is charged to the spawning side ──

test("W1-T2439/W1-T2792: the split never exceeds reviewLanes, so a filing that spawns remains charged", () => {
  const onlyFilings = [filing(30, "2026-08-01T00:00:00Z"), filing(31, "2026-08-02T00:00:00Z")];
  const { spawning } = selectReviewAdmissions(onlyFilings, DEFAULT_SWEEP_POLICY, NOW);
  assert.deepEqual(spawning, [], "a pass of only filings admits NOBODY to the spawning lane");
  // The guarantee: spawn-capable admissions never exceed the configured review bound, whatever the
  // cheap lane does. Detecting WHICH filing spawns is unbuildable at admission (the shard's Q1),
  // so the design charges it rather than predicting it.
  const mixed = [build(20, "2026-08-01T00:00:00Z"), ...onlyFilings];
  const r = selectReviewAdmissions(mixed, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.spawning.length, 1, "only the real build consumes semantic capacity, never one slot per filing");
});

// ── acceptance 5: an unpopulated signal falls back to today's behaviour ─────────────────────

test("W1-T2439 (acceptance 5): isPlanFiling undefined is treated as SPAWNING — fail-open, unchanged", () => {
  const q = [pr({ prNumber: 40, createdAt: "2026-08-01T00:00:00Z" }), pr({ prNumber: 41, createdAt: "2026-08-02T00:00:00Z" })];
  assert.equal(q[0].isPlanFiling, undefined, "the fixture must actually omit it, or this asserts nothing");
  const { spawning, planFilings } = selectReviewAdmissions(q, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(planFilings.length, 0, "an absent signal never rides the cheap lane");
  assert.deepEqual(spawning.map((p) => p.prNumber), [40, 41], "both absent signals consume the bounded semantic capacity");
});

test("W1-T2439 (acceptance 5): isPlanFiling false is also SPAWNING, not merely undefined", () => {
  const { planFilings } = selectReviewAdmissions([build(50, "2026-08-01T00:00:00Z")], DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(planFilings.length, 0, "only an explicit true opts into the cheap lane");
});

// ── acceptance 6: ordering unchanged, still on the immutable key ────────────────────────────

test("W1-T2439 (acceptance 6): both lanes rank on reviewAdmissionKey, which a posted verdict cannot move", () => {
  const old = filing(60, "2026-08-01T00:00:00Z");
  const reviewed = { ...old, lastActivityAt: "2026-08-28T11:59:55Z" }; // a verdict just bumped updatedAt
  const younger = filing(61, "2026-08-20T00:00:00Z");
  const { planFilings } = selectReviewAdmissions([younger, reviewed], DEFAULT_SWEEP_POLICY, NOW);
  assert.deepEqual(planFilings.map((p) => p.prNumber), [60, 61], "createdAt still leads; the review did not reorder it");
  assert.equal(reviewAdmissionKey(reviewed), reviewAdmissionKey(old), "the key is invariant under the bump");
});

test("W1-T2439 (acceptance 6): W1-T528's shared comparator is untouched", () => {
  const a = { prNumber: 1, lastActivityAt: "2026-08-01T00:00:00Z" };
  const b = { prNumber: 2, lastActivityAt: "2026-08-10T00:00:00Z" };
  assert.equal(oldestActivityFirst([b, a], NOW)?.prNumber, 1, "still ranks on lastActivityAt");
});

// ── acceptance 7 & 8: no lane unbounded, no bound raised, nothing paces ─────────────────────

test("W1-T2439 (acceptance 7): no lane is unbounded and no existing bound is raised", () => {
  assert.equal(DEFAULT_SWEEP_POLICY.planFilingAdmissionBound, 3, "the derived number, not a picked one");
  assert.ok(DEFAULT_SWEEP_POLICY.planFilingAdmissionBound > 1, "it must admit more than one to be worth building");
  assert.equal(DEFAULT_SWEEP_POLICY.repeatDispositionBound, 50, "the repeat bound is untouched");
  assert.equal(DEFAULT_SWEEP_POLICY.strikeCap, 2, "the strike cap is untouched");
  // A zero/negative bound must not become "unbounded" through a sign slip.
  const q = [filing(70, "2026-08-01T00:00:00Z"), filing(71, "2026-08-02T00:00:00Z")];
  const zero = selectReviewAdmissions(q, { ...DEFAULT_SWEEP_POLICY, planFilingAdmissionBound: 0 }, NOW);
  assert.equal(zero.planFilings.length, 0, "bound 0 admits none — never all");
  const neg = selectReviewAdmissions(q, { ...DEFAULT_SWEEP_POLICY, planFilingAdmissionBound: -5 }, NOW);
  assert.equal(neg.planFilings.length, 0, "a negative bound clamps to none, never to unbounded");
});

test("W1-T2439 (acceptance 8): nothing added paces, sleeps, or arms auto-merge earlier", () => {
  const src = readFileSync(new URL("../src/lib/sweep.ts", import.meta.url), "utf8");
  const start = src.indexOf("export function selectReviewAdmissions");
  const body = src.slice(start, src.indexOf("\n}", start) + 2);
  assert.ok(body.length > 0, "the function must be found, or this assertion is vacuous");
  for (const banned of ["setTimeout", "await", "sleep", "delay", "arm("]) {
    assert.ok(!body.includes(banned), `selectReviewAdmissions must not contain ${banned}`);
  }
});

// ── W1-T2864 — external plan filings earn the same lane from material GitHub paths ──────────

interface RestFixturePr {
  number: number;
  html_url: string;
  head: { ref: string; sha: string };
  updated_at: string;
  created_at: string;
  body: string;
  auto_merge: null;
  state: "open";
}

function restPr(number: number, sha: string): RestFixturePr {
  return {
    number,
    html_url: `https://github.com/o/r/pull/${number}`,
    head: { ref: `agent/plan-${number}`, sha },
    updated_at: "2026-09-05T04:00:00.000Z",
    created_at: "2026-09-05T03:00:00.000Z",
    body: "opened outside the rmd emitter",
    auto_merge: null,
    state: "open",
  };
}

function viewHarness(
  initial: RestFixturePr[],
  initialFiles: Map<number, unknown>,
  ledgerRows: Array<Record<string, unknown>> = [],
) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-plan-filing-admission-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, ledgerRows.map((row) => JSON.stringify(row)).join("\n") + (ledgerRows.length ? "\n" : ""));
  let rows = initial;
  const files = initialFiles;
  const fileCalls = new Map<number, number>();
  const fetch: GhApiFetcher = (args) => {
    const path = args[args.length - 1] ?? "";
    if (/pulls\?state=open/.test(path)) return rows;
    const fileMatch = path.match(/pulls\/(\d+)\/files/);
    if (fileMatch) {
      const number = Number(fileMatch[1]);
      fileCalls.set(number, (fileCalls.get(number) ?? 0) + 1);
      const reply = files.get(number);
      if (reply instanceof Error) throw reply;
      return reply;
    }
    if (/\/pulls\/\d+$/.test(path)) return { mergeable: true, mergeable_state: "clean" };
    if (/check-runs/.test(path)) {
      return {
        check_runs: [
          {
            name: "ci-gate",
            status: "completed",
            conclusion: "success",
            started_at: "2026-09-05T03:30:00.000Z",
          },
        ],
      };
    }
    if (/\/status$/.test(path)) return { statuses: [] };
    return [];
  };
  return {
    ledgerPath,
    fetch,
    files,
    fileCalls,
    setRows(next: RestFixturePr[]) {
      rows = next;
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

type ClassifiedView = OpenPrView & { planFilingSource?: string };
type ClassificationEvent = { prNumber: number; headSha: string; source: string };

function buildClassifiedViews(
  harness: ReturnType<typeof viewHarness>,
  opts: { cache?: ReturnType<typeof createPlanFilingFileCache>; missCap?: number } = {},
): { views: ClassifiedView[]; events: ClassificationEvent[] } {
  const events: ClassificationEvent[] = [];
  const views = buildOpenPrViews("o", "r", harness.ledgerPath, {
    fetch: harness.fetch,
    requiredContexts: () => ["ci-gate"],
    readCiGateRequired: () => ["ci-gate"],
    planFilingFileCache: opts.cache ?? createPlanFilingFileCache(),
    planFilingFileMissCap: opts.missCap ?? 3,
    onPlanFilingClassification: (event: ClassificationEvent) => events.push(event),
  }) as ClassifiedView[];
  return { views, events };
}

test("W1-T2864: a complete external plan changeset reaches the existing non-spawning lane", () => {
  const harness = viewHarness([restPr(101, "a".repeat(40))], new Map([[101, [{ filename: "plan/tasks.d/W1-T3000.yaml" }]]]));
  try {
    const { views, events } = buildClassifiedViews(harness);
    assert.equal(views[0].isPlanFiling, true);
    assert.equal(views[0].planFilingSource, "github-files");
    assert.deepEqual(events, [{ prNumber: 101, headSha: "a".repeat(40), source: "github-files" }]);
    const admitted = selectReviewAdmissions(views, DEFAULT_SWEEP_POLICY, NOW);
    assert.deepEqual(admitted.planFilings.map((candidate) => candidate.prNumber), [101]);
    assert.deepEqual(admitted.spawning, []);
  } finally {
    harness.cleanup();
  }
});

test("W1-T2864: the emitter ledger signal remains a zero-file-request fast path", () => {
  const row = restPr(102, "b".repeat(40));
  const harness = viewHarness([row], new Map([[102, [{ filename: "src/not-consulted.ts" }]]]), [
    { step: "pr.opened", pr_url: row.html_url, plan_only: true },
  ]);
  try {
    const { views, events } = buildClassifiedViews(harness);
    assert.equal(views[0].isPlanFiling, true);
    assert.equal(views[0].planFilingSource, "emitter-ledger");
    assert.equal(harness.fileCalls.get(102) ?? 0, 0);
    assert.equal(events[0].source, "emitter-ledger");
  } finally {
    harness.cleanup();
  }
});

test("W1-T2864: lookalikes, enforcement data, unavailable reads and misses beyond the cap stay semantic", () => {
  const prs = [1, 2, 3, 4, 5].map((number) => restPr(number, String(number).repeat(40)));
  const harness = viewHarness(
    prs,
    new Map<number, unknown>([
      [1, [{ filename: "src/lib/lookalike.ts" }]],
      [2, [{ filename: "plan/policy.yaml" }]],
      [3, []],
      [4, new Error("rate limited")],
      [5, [{ filename: "plan/tasks.d/W1-T3005.yaml" }]],
    ]),
  );
  try {
    const { views, events } = buildClassifiedViews(harness, { missCap: 4 });
    assert.deepEqual(views.map((view) => view.isPlanFiling), [false, false, false, false, false]);
    assert.deepEqual(views.map((view) => view.planFilingSource), [
      "not-plan-only",
      "not-plan-only",
      "unreadable",
      "unreadable",
      "unreadable",
    ]);
    assert.equal(harness.fileCalls.get(5) ?? 0, 0, "the candidate beyond the primary per-pass bound is not fetched");
    assert.deepEqual(Object.keys(events[0]).sort(), ["headSha", "prNumber", "source"], "telemetry is bounded metadata only");
    assert.doesNotMatch(JSON.stringify(events), /lookalike|policy\.yaml|rate limited|credential|token/i);
    assert.equal(selectReviewAdmissions(views, DEFAULT_SWEEP_POLICY, NOW).planFilings.length, 0);
  } finally {
    harness.cleanup();
  }
});

test("W1-T2864: one head reads once, while a new head reads again and cannot inherit classification", () => {
  const cache = createPlanFilingFileCache();
  const first = restPr(103, "c".repeat(40));
  const harness = viewHarness([first], new Map([[103, [{ filename: "plan/tasks.d/W1-T3006.yaml" }]]]));
  try {
    assert.equal(buildClassifiedViews(harness, { cache }).views[0].isPlanFiling, true);
    assert.equal(buildClassifiedViews(harness, { cache }).views[0].isPlanFiling, true);
    assert.equal(harness.fileCalls.get(103), 1, "the complete positive observation is cached at this head");

    harness.setRows([restPr(103, "d".repeat(40))]);
    harness.files.set(103, [{ filename: "src/lib/now-semantic.ts" }]);
    const changed = buildClassifiedViews(harness, { cache }).views[0];
    assert.equal(changed.isPlanFiling, false);
    assert.equal(changed.planFilingSource, "not-plan-only");
    assert.equal(harness.fileCalls.get(103), 2, "the new head earns one new material read");
    assert.equal(buildClassifiedViews(harness, { cache }).views[0].isPlanFiling, false);
    assert.equal(harness.fileCalls.get(103), 2, "the complete negative observation is cached too");
  } finally {
    harness.cleanup();
  }
});

test("W1-T2864: malformed and page-capped reads remain unknown, and retained cache state is bounded", () => {
  const cache = createPlanFilingFileCache();
  const candidates = [201, 202, 203, 204, 205].map((number) => ({ number, headRefOid: String(number).repeat(40).slice(0, 40) }));
  const fetch: GhApiFetcher = (args) => {
    const number = Number((args[args.length - 1] ?? "").match(/pulls\/(\d+)\/files/)?.[1]);
    if (number === 201) return [{ filename: null }];
    if (number === 202) return Array.from({ length: PLAN_FILING_FILE_RESPONSE_CAP }, (_, i) => ({ filename: `plan/tasks.d/${i}.yaml` }));
    return [{ filename: `plan/tasks.d/W1-T${number}.yaml` }];
  };
  const observations = hydratePlanFilingFiles("o", "r", candidates, fetch, cache, { missCap: 5, maxEntries: 2 });
  assert.deepEqual(observations.get(201), { state: "unreadable", reason: "malformed" });
  assert.deepEqual(observations.get(202), { state: "unreadable", reason: "response-cap" });
  assert.equal(cache.entries.size, 2, "the retained LRU never exceeds its configured backstop");
});

test("W1-T2864: capped misses rotate so an unreadable early PR cannot starve later candidates", () => {
  const cache = createPlanFilingFileCache();
  const candidates = [301, 302].map((number) => ({
    number,
    headRefOid: String(number).repeat(40).slice(0, 40),
  }));
  const calls: number[] = [];
  const fetch: GhApiFetcher = (args) => {
    const number = Number((args[args.length - 1] ?? "").match(/pulls\/(\d+)\/files/)?.[1]);
    calls.push(number);
    if (number === 301) throw new Error("still unavailable");
    return [{ filename: "plan/tasks.d/W1-T3302.yaml" }];
  };

  const first = hydratePlanFilingFiles("o", "r", candidates, fetch, cache, { missCap: 1 });
  assert.deepEqual(first.get(301), { state: "unreadable", reason: "fetch-failed" });
  assert.deepEqual(first.get(302), { state: "unreadable", reason: "per-pass-cap" });

  const second = hydratePlanFilingFiles("o", "r", candidates, fetch, cache, { missCap: 1 });
  assert.deepEqual(second.get(301), { state: "unreadable", reason: "per-pass-cap" });
  assert.deepEqual(second.get(302), {
    state: "complete",
    paths: ["plan/tasks.d/W1-T3302.yaml"],
    cache: "miss",
  });
  assert.deepEqual(calls, [301, 302], "each pass advances one bounded miss instead of retrying PR 301 forever");
});

test("W1-T2864: the daemon owns one structural cache outside its recurring sweep callback", () => {
  const source = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const hook = source.indexOf("export function buildSweepHook");
  const cache = source.indexOf("const planFilingFileCache = createPlanFilingFileCache()", hook);
  const callback = source.indexOf("return async (continueReviewAdmissions", hook);
  const consumer = source.indexOf("planFilingFileCache,", callback);
  assert.ok(hook >= 0 && cache > hook && callback > cache, "the cache must be built once per daemon lifetime, before the poll callback");
  assert.ok(consumer > callback, "every recurring build uses that same cache instance");
});
