import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import type { GardenCheckout, GardenerDeps } from "../src/lib/gardener.js";
import { loadPlanFromYaml, type Task } from "../src/lib/plan.js";
import type { PlanInventory } from "../src/lib/plan-gardener.js";
import {
  SCOUT_SURVIVAL_WINDOW_MS, SCOUT_UNPRIORITIZED_SHARE_BOUND, SCOUT_WINDOW_MS, readMergedTasks, scoutGardenSpec, type ScoutSources,
} from "../src/lib/scout-gardener.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "./helpers/git-repo.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const NOW = Date.UTC(2026, 9, 8, 12);
const DAY = 24 * 3_600_000;
const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

/** `older` rows in the older half of the window and `newer` in the newer half. */
function rows(step: string, older: number, newer: number, extra: Record<string, unknown> = {}): Record<string, unknown>[] {
  return [
    ...Array.from({ length: older }, (_, i) => ({ ts: at(SCOUT_WINDOW_MS * 0.9 - i * 1000), step, ...extra })),
    ...Array.from({ length: newer }, (_, i) => ({ ts: at(SCOUT_WINDOW_MS * 0.2 - i * 1000), step, ...extra })),
  ];
}
function task(id: string, fields: Partial<Task> = {}): Task {
  return { id, title: `task ${id}`, repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "low", status: "queued", attempts: 0, files: [`src/${id}.ts`], priority: 3, ...fields };
}
const planOf = (open: Task[], all: Task[] = open): PlanInventory => ({ open, all, shards: new Map() });

function fixture(opts: { ledger?: Record<string, unknown>[]; open?: Task[]; all?: Task[]; merged?: Record<string, number>; mergedLastDay?: number; mint?: () => string } = {}) {
  const logs: Array<{ step: string; fields?: Record<string, unknown> }> = [];
  const deps: GardenerDeps = {
    repoRoot: "/unused", stateDir: "/unused", clock: fixedClock(NOW), log: (step, fields) => logs.push({ step, fields }),
    openWorkspace: () => { throw new Error("unexpected workspace"); },
  };
  let next = 9000;
  const sources: Partial<ScoutSources> & Pick<ScoutSources, "mintTaskId"> = {
    clock: fixedClock(NOW),
    ledger: (since, steps) => (opts.ledger ?? []).filter((r) => (steps === undefined || steps.includes(r.step as string)) && Date.parse(r.ts as string) >= Date.parse(since)),
    plan: () => planOf(opts.open ?? [], opts.all ?? opts.open ?? []),
    mergedTasks: () => new Map(Object.entries(opts.merged ?? {})),
    mergedLastDay: () => opts.mergedLastDay ?? 5,
    pricedSteps: () => new Set(["fix.commit_refused"]),
    fileExists: (p) => p === "src/lib/widget.ts",
    mintTaskId: opts.mint ?? (() => `W1-T${++next}`),
  };
  return { spec: scoutGardenSpec(deps, sources), logs };
}
function workspace(root: string): GardenCheckout {
  return { root, branch: "scout-garden-123", land: () => { throw new Error("unexpected landing"); }, dispose: () => {} } as unknown as GardenCheckout;
}

test("W1-T5454: a failing step that no task cites is filed once through the machine filing renderer", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}scout-file-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledger = [
    ...rows("widget.sync_failed", 3, 4, { file: "src/lib/widget.ts" }),
    ...rows("widget.healthy", 3, 4),         // no failure shape: never a symptom
    ...rows("widget.burst_failed", 0, 9),    // only the newer half: not recurring
    ...rows("fix.commit_refused", 4, 4),     // a scorecard prices it: covered by definition
  ];
  const { spec } = fixture({ ledger });
  const inv = spec.inventory();
  assert.deepEqual(inv.uncovered.map((s) => s.step), ["widget.sync_failed"]);
  assert.deepEqual(inv.uncovered[0]!.files, ["src/lib/widget.ts"]);
  const plan = { actions: spec.candidates(inv, () => 0), acting: ["file-uncovered-symptom" as const] };
  const landed = spec.apply(workspace(root), plan, {});
  assert.ok(landed, "a record was written");
  assert.equal(landed.paths.length, 1);
  const text = readFileSync(join(root, landed.paths[0]!), "utf8");
  // The shared machine-filing header: the filer chooses neither verify nor risk.
  assert.match(text, /^  verify: human$/m);
  assert.match(text, /^  author_class: machine$/m);
  assert.match(text, /^  origin: "scout:widget\.sync_failed"$/m);
  assert.match(text, /src\/lib\/widget\.ts/);
  const filed = loadPlanFromYaml(text, "filed.yaml").tasks[0]!;
  // Once filed, the record cites the step, so the next pass files nothing for it.
  const again = fixture({ ledger, open: [filed], all: [filed] }).spec.inventory();
  assert.deepEqual(again.selected, []);
  assert.deepEqual(again.covered, ["fix.commit_refused", "widget.sync_failed"]);
});

test("W1-T5454: a step a queued or recently merged task cites is never filed", () => {
  const ledger = [...rows("alpha.run_failed", 2, 2), ...rows("beta.run_refused", 2, 2), ...rows("gamma.run_unhealthy", 2, 2)];
  const queued = task("W1-T100", { title: "alpha.run_failed keeps landing" });
  const merged = task("W1-T101", { title: "x", rationale: "beta.run_refused was the symptom" });
  const longAgo = task("W1-T102", { title: "gamma.run_unhealthy was fixed" });
  const { spec } = fixture({
    ledger, open: [queued], all: [queued, merged, longAgo],
    merged: { "W1-T101": NOW - 2 * DAY, "W1-T102": NOW - 30 * DAY },
  });
  const inv = spec.inventory();
  assert.deepEqual(inv.uncovered.map((s) => s.step), ["gamma.run_unhealthy"], "a merge outside the window no longer covers its step");
  assert.deepEqual([...inv.covered].sort(), ["alpha.run_failed", "beta.run_refused"]);
});

test("W1-T5454: filing stops while the queue is over its bound and is capped by the days merges", () => {
  const ledger = [...rows("a.one_failed", 5, 5), ...rows("b.two_failed", 3, 3), ...rows("c.three_failed", 1, 1)];
  const capped = fixture({ ledger, mergedLastDay: 2 }).spec.inventory();
  assert.deepEqual(capped.selected.map((s) => s.step), ["a.one_failed", "b.two_failed"], "at most the day's merges, costliest first");
  assert.equal(fixture({ ledger, mergedLastDay: 0 }).spec.inventory().selected.length, 0, "a day with no merges files nothing");

  const unprioritized = (id: string) => task(id, { priority: undefined });
  const over = [unprioritized("W1-T1"), unprioritized("W1-T2"), task("W1-T3"), task("W1-T4")];
  assert.ok(2 / 4 > SCOUT_UNPRIORITIZED_SHARE_BOUND);
  const blocked = fixture({ ledger, open: over }).spec.inventory();
  assert.equal(blocked.blocked, true);
  assert.deepEqual(blocked.selected, [], "over the bound, nothing is filed");
  assert.equal(blocked.uncovered.length, 3, "the symptoms are still measured");
  const under = fixture({ ledger, open: [task("W1-T1"), task("W1-T2"), task("W1-T3"), unprioritized("W1-T4")].map((x, i) => ({ ...x, files: [`src/${i}.ts`] })) }).spec.inventory();
  assert.equal(under.blocked, false);
  assert.ok(under.selected.length > 0);
});

test("W1-T5454: the class is judged by whether the symptom stopped not by the merge", () => {
  const stepOf = (n: number) => `scout${n}.sync_failed`;
  const filed = (n: number) => task(`W1-T90${n}`, { origin: `scout:${stepOf(n)}`, status: "done" as Task["status"], title: "filed" });
  const mergedAt = NOW - 3 * SCOUT_SURVIVAL_WINDOW_MS;
  const around = (n: number, before: number, after: number) => [
    ...Array.from({ length: before }, (_, i) => ({ ts: new Date(mergedAt - DAY - i * 1000).toISOString(), step: stepOf(n) })),
    ...Array.from({ length: after }, (_, i) => ({ ts: new Date(mergedAt + DAY + i * 1000).toISOString(), step: stepOf(n) })),
  ];
  const all = [filed(1), filed(2), filed(3), filed(4)];
  const { spec } = fixture({
    all, open: [],
    ledger: [...around(1, 6, 1), ...around(2, 3, 5), ...around(3, 2, 2)],
    // 4 merged only two days ago: its window has not passed. 5 never merged.
    merged: { "W1-T901": mergedAt, "W1-T902": mergedAt, "W1-T903": mergedAt, "W1-T904": NOW - 2 * DAY },
  });
  const inv = spec.inventory();
  const verdicts = Object.fromEntries(inv.tracked.map((x) => [x.task, x.verdict]));
  assert.deepEqual(verdicts, { "W1-T901": "credit", "W1-T902": "debit", "W1-T903": "debit", "W1-T904": "pending" });
  // Four merges, but only a symptom that fell is a credit; a merge alone earns nothing.
  assert.deepEqual(spec.metric!(inv, "file-uncovered-symptom"), { trials: 3, successes: 1 });
});

test("W1-T5454: the default ledger read keeps only failure-shaped rows inside the window", (t) => {
  const { dir } = writeLedger([
    ...rows("disk.probe_unavailable", 2, 3),
    ...rows("disk.probe_ok", 2, 3),
    { ts: at(SCOUT_WINDOW_MS * 2), step: "disk.probe_unavailable" },
  ]);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const deps: GardenerDeps = {
    repoRoot: "/unused", stateDir: dir, clock: fixedClock(NOW), log: () => {},
    openWorkspace: () => { throw new Error("unexpected workspace"); },
  };
  const spec = scoutGardenSpec(deps, {
    mintTaskId: () => "W1-T9100", plan: () => planOf([]), mergedTasks: () => new Map(), mergedLastDay: () => 1,
  });
  const inv = spec.inventory();
  assert.deepEqual(inv.symptoms.map((s) => [s.step, s.older, s.newer]), [["disk.probe_unavailable", 2, 3]]);
});

function commitAt(dir: string, iso: string, message: string): void {
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", message], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
      GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
      GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso,
    },
  });
}

test("W1-T5454: merged tasks are read from the trailers on main's history, earliest merge winning", () => {
  const repo = gitRepo({ kind: "scout-merged" });
  commitAt(repo.dir, "2026-01-01T00:00:00Z", "feat: long ago (#1)\n\nRemudero-Task: W1-T1");
  commitAt(repo.dir, "2026-10-01T10:00:00Z", "feat: first (#2)\n\nRemudero-Task: W1-T2");
  commitAt(repo.dir, "2026-10-02T10:00:00Z", "fix: two at once (#3)\n\nRemudero-Task: W1-T3\nRemudero-Task: W1-T4");
  commitAt(repo.dir, "2026-10-03T10:00:00Z", "fix: a rerun of the first (#4)\n\nRemudero-Task: W1-T2");
  commitAt(repo.dir, "2026-10-03T11:00:00Z", "chore: mentions Remudero-Task: W1-T9 inline, not as a trailer (#5)");
  // No origin/main in this fixture: HEAD's history is read instead.
  const merged = readMergedTasks(repo.dir, "2026-09-01T00:00:00Z");
  assert.deepEqual([...merged.entries()].sort(([a], [b]) => a.localeCompare(b)), [
    ["W1-T2", Date.parse("2026-10-01T10:00:00Z")],
    ["W1-T3", Date.parse("2026-10-02T10:00:00Z")],
    ["W1-T4", Date.parse("2026-10-02T10:00:00Z")],
  ]);

  // With an origin/main, that ref is the history: a commit only HEAD holds has not merged.
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  commitAt(repo.dir, "2026-10-04T10:00:00Z", "feat: local only (#6)\n\nRemudero-Task: W1-T7");
  const onMain = readMergedTasks(repo.dir, "2026-09-01T00:00:00Z");
  assert.equal(onMain.has("W1-T7"), false, "a commit absent from origin/main is not a merge");
  assert.equal(onMain.has("W1-T3"), true);
});

test("W1-T5454: a merge history that cannot be read is an error, never an empty answer", (t) => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}scout-nogit-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => readMergedTasks(dir, "2026-09-01T00:00:00Z"), /scout gardener: git log HEAD failed/);
});

test("W1-T5454: the scorecard counts what the pass saw and what it proposes", () => {
  const ledger = rows("widget.sync_failed", 3, 4, { file: "src/lib/widget.ts" });
  const { spec } = fixture({ ledger });
  const inv = spec.inventory();
  const plan = { actions: spec.candidates(inv, () => 0), acting: ["file-uncovered-symptom" as const] };
  assert.deepEqual(spec.scorecard(inv, plan), {
    symptoms: 1, covered: 0, uncovered: 1, proposed: 1, merge_budget: 5, open: 0, unprioritized_share: 0, blocked: false, survival: [],
  });
});

test("W1-T5454: a record the lint refuses is logged and never written", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}scout-refused-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // An id that cannot render into a parseable record is refused by the renderer, not thrown.
  const { spec, logs } = fixture({ ledger: rows("widget.sync_failed", 3, 4), mint: () => "W1-T9: [" });
  const inv = spec.inventory();
  const plan = { actions: spec.candidates(inv, () => 0), acting: ["file-uncovered-symptom" as const] };
  assert.equal(spec.apply(workspace(root), plan, {}), undefined, "nothing written means nothing to land");
  const refused = logs.find((l) => l.step === "scout.record_refused");
  assert.ok(refused, "the refusal is logged");
  assert.equal(refused.fields?.step, "widget.sync_failed");
  assert.match(String(refused.fields?.reason), /^unparseable: /);
  assert.equal(existsSync(join(root, "plan")), false, "no shard directory was created");
});
