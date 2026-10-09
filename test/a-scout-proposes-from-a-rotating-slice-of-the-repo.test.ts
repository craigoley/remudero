import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import type { GardenCheckout, GardenerDeps } from "../src/lib/gardener.js";
import { loadPlanFromYaml, type Task } from "../src/lib/plan.js";
import type { PlanInventory } from "../src/lib/plan-gardener.js";
import { SCOUT_UNPRIORITIZED_SHARE_BOUND, scoutAdmission, scoutGardenSpec } from "../src/lib/scout-gardener.js";
import {
  SCOUT_SLICE_SURVIVAL_WINDOW_MS, emptySliceCursor, pickScoutSlice, readSliceCursor, sliceSurvival, writeSliceCursor, type SliceFile, type SliceSources,
} from "../src/lib/scout-slice.js";
import { EXPORT_GARDEN_WINDOW_DAYS } from "../src/lib/export-gardener.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const NOW = Date.UTC(2026, 9, 9, 12);
const DAY = 24 * 3_600_000;

function task(id: string, fields: Partial<Task> = {}): Task {
  return { id, title: `task ${id}`, repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "low", status: "queued", attempts: 0, files: [`src/${id}.ts`], priority: 3, ...fields };
}
const planOf = (open: Task[], all: Task[] = open): PlanInventory => ({ open, all, shards: new Map() });
const file = (path: string, bytes: number, changedAtMs = 0): SliceFile => ({ path, bytes, changedAtMs });

// A tiny repository at HEAD: widget.ts holds the cited text on line 2.
const HEAD_AT_START: Record<string, string> = {
  "src/lib/widget.ts": "export const A = 1;\n// TODO(`legacyRetry`): remove once the daemon stops calling it\nexport const B = 2;\n",
  "src/lib/gadget.ts": "export function gadget(): number {\n  return 3;\n}\n",
};

interface Fixture {
  open?: Task[];
  all?: Task[];
  merged?: Record<string, number>;
  mergedLastDay?: number;
  answer?: string;
  files?: SliceFile[];
}

function fixture(root: string, opts: Fixture = {}) {
  const logs: Array<{ step: string; fields?: Record<string, unknown> }> = [];
  const prompts: string[] = [];
  const head: Record<string, string> = { ...HEAD_AT_START };
  const deps: GardenerDeps = {
    repoRoot: "/unused", stateDir: "/unused", clock: fixedClock(NOW), log: (step, fields) => logs.push({ step, fields }),
    openWorkspace: () => { throw new Error("unexpected workspace"); },
  };
  const sliceSources: SliceSources = {
    listFiles: () => opts.files ?? [file("src/lib/widget.ts", 90), file("src/lib/gadget.ts", 60)],
    readAtHead: (p) => head[p],
  };
  let next = 9000;
  const sources: ScoutSpecSourcesForTest = {
    clock: fixedClock(NOW),
    ledger: () => [],
    plan: () => planOf(opts.open ?? [], opts.all ?? opts.open ?? []),
    mergedTasks: () => new Map(Object.entries(opts.merged ?? {})),
    mergedLastDay: () => opts.mergedLastDay ?? 5,
    pricedSteps: () => new Set(),
    fileExists: () => false,
    mintTaskId: () => `W1-T${++next}`,
    sliceReverted: () => new Set(),
    sliceSources,
    sliceCursorPath: join(root, "scout-slice-cursor.json"),
    sliceModel: async (prompt) => {
      prompts.push(prompt);
      return opts.answer ?? "[]";
    },
  };
  return { spec: scoutGardenSpec(deps, sources), logs, prompts, head, cursorPath: join(root, "scout-slice-cursor.json") };
}
type ScoutSpecSourcesForTest = Parameters<typeof scoutGardenSpec>[1];

function workspace(root: string): GardenCheckout {
  return { root, branch: "scout-garden-123", land: () => { throw new Error("unexpected landing"); }, dispose: () => {} } as unknown as GardenCheckout;
}
function tmp(t: { after: (fn: () => void) => void }, label: string): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${label}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const GOOD = { file: "src/lib/widget.ts", line: 2, claim: "`legacyRetry` is still named in a TODO although nothing calls it", check: "git grep legacyRetry shows only this comment" };

test("W1-T5455: the slice rotates from a persisted cursor and reads changed files first", (t) => {
  const root = tmp(t, "scout-slice-rot");
  const files = [
    file("docs/guide.md", 10), file("scripts/run.mjs", 10), file("src/lib/a.ts", 10), file("src/lib/b.ts", 10), file("src/lib/c.ts", 10),
    file("src/lib/sub/x.ts", 10), file("test/one.test.ts", 10), file("README.md", 10),
  ];
  // The rotation visits every directory in order and wraps; a path outside every root is never read.
  let cursor = emptySliceCursor();
  const seen: string[] = [];
  for (let i = 0; i < 6; i++) {
    const pick = pickScoutSlice(files, cursor, NOW + i)!;
    seen.push(pick.dir);
    cursor = pick.cursor;
  }
  assert.deepEqual(seen, ["docs", "scripts", "src/lib", "src/lib/sub", "test", "docs"]);

  // The cursor survives a restart: it is read back from disk and the rotation continues after it.
  const path = join(root, "cursor.json");
  assert.deepEqual(readSliceCursor(path), emptySliceCursor(), "a missing file is a first read");
  const afterScripts = pickScoutSlice(files, pickScoutSlice(files, emptySliceCursor(), NOW)!.cursor, NOW)!;
  assert.equal(afterScripts.dir, "scripts");
  writeSliceCursor(path, afterScripts.cursor);
  const reread = readSliceCursor(path);
  assert.deepEqual(reread, afterScripts.cursor);
  assert.equal(pickScoutSlice(files, reread, NOW)!.dir, "src/lib");

  // Within one directory, files changed since its last read come first, then the rest resume where they stopped.
  const lib = [file("src/lib/a.ts", 40, 0), file("src/lib/b.ts", 40, 0), file("src/lib/c.ts", 40, 0), file("src/lib/d.ts", 40, NOW + 5)];
  const first = pickScoutSlice(lib, emptySliceCursor(), NOW, 80)!;
  assert.deepEqual(first.files.map((f) => f.path), ["src/lib/a.ts", "src/lib/b.ts"], "a never-read directory starts at its first file, within the byte budget");
  const again = pickScoutSlice(lib, { ...first.cursor, dir: "docs" }, NOW + 10, 80)!;
  assert.deepEqual(again.files.map((f) => f.path), ["src/lib/d.ts", "src/lib/c.ts"], "the changed file leads, then the unread rest resumes after b");
  assert.ok(again.bytes <= 80);

  // A damaged cursor is refused rather than silently restarted from the top.
  writeFileSync(path, "{");
  assert.throws(() => readSliceCursor(path), /is not JSON/);
  writeFileSync(path, JSON.stringify({ readAt: { docs: "yesterday" }, resume: {} }));
  assert.throws(() => readSliceCursor(path), /is malformed/);
});

test("W1-T5455: a finding whose cited line does not hold what its claim names is discarded and never filed", async (t) => {
  const root = tmp(t, "scout-slice-premise");
  const answer = JSON.stringify([
    GOOD,
    { ...GOOD, line: 3, claim: "`legacyRetry` is still named here" },                       // line 3 holds `B`, not the symbol
    { ...GOOD, file: "src/lib/gone.ts" },                                                     // no such file at HEAD
  ]);
  const { spec, logs, prompts, cursorPath, head } = fixture(root, { answer });
  await spec.prepareSlice();
  assert.equal(prompts.length, 1, "the model is asked once and never again to repair a discarded finding");
  assert.match(prompts[0]!, /=== src\/lib\/widget\.ts ===/);
  const inv = spec.inventory();
  assert.deepEqual(inv.slice.held!.kept, [GOOD], "only the finding the cited line bears out survives");
  assert.deepEqual(inv.slice.held!.dropped.map((d) => d.finding.file), ["src/lib/widget.ts", "src/lib/gone.ts"]);
  assert.ok(inv.slice.held!.dropped.some((d) => /does not exist at HEAD/.test(d.reason)));
  const reasons = logs.filter((l) => l.step === "scout.slice_finding_dropped").map((l) => String(l.fields?.reason));
  assert.ok(reasons.some((r) => /does not hold `legacyRetry`/.test(r)) || inv.slice.held!.dropped.some((d) => /does not hold/.test(d.reason)), `reasons: ${reasons.join(" | ")}`);
  assert.ok(reasons.length >= 1, "a discard is ledgered with its reason");
  assert.ok(existsSync(cursorPath), "the slice counts as read once the model answered");

  // A line past the end of the file, and a claim that quotes nothing checkable, are discarded too.
  const edge = fixture(root, { answer: JSON.stringify([{ ...GOOD, line: 99 }, { ...GOOD, claim: "a comment looks stale" }]) });
  await edge.spec.prepareSlice();
  assert.deepEqual(edge.spec.inventory().slice.held!.kept, []);
  assert.deepEqual(edge.spec.inventory().slice.held!.dropped.map((d) => d.reason.replace(/`[^`]*`/g, "X")), [
    "src/lib/widget.ts has 4 lines; line 99 is outside it",
    "the claim quotes no symbol or text in backticks, so nothing can be checked on the cited line",
  ]);
  assert.deepEqual(edge.spec.candidates(edge.spec.inventory(), () => 0), [], "nothing is offered to file");

  // The cap: a fourth finding is past the three-finding limit however good it is.
  const many = JSON.stringify([GOOD, GOOD, GOOD, { ...GOOD, line: 1, claim: "`A` is exported" }]);
  const capped = fixture(root, { answer: many });
  await capped.spec.prepareSlice();
  assert.equal(capped.logs.filter((l) => /past the 3-finding cap/.test(String(l.fields?.reason))).length, 1);

  // The cited line is re-checked when the shard is filed, not only when the model answered.
  const plan = { actions: spec.candidates(inv, () => 0), acting: ["propose-from-slice" as const] };
  assert.equal(plan.actions.length, 1);
  head["src/lib/widget.ts"] = "export const A = 1;\nexport const B = 2;\n";
  assert.equal(spec.apply(workspace(root), plan, {}), undefined, "a finding that stopped holding at filing time files nothing");
});

test("W1-T5455: a finding that duplicates an open or recently merged task is discarded", async (t) => {
  const root = tmp(t, "scout-slice-dup");
  const byFile = task("W1-T100", { files: ["src/lib/widget.ts", "test/widget.test.ts"] });
  const answer = JSON.stringify([GOOD, { file: "src/lib/gadget.ts", line: 1, claim: "`gadget` has no test beside it", check: "ls test | grep gadget" }]);

  const open = fixture(root, { answer, open: [byFile] });
  await open.spec.prepareSlice();
  assert.deepEqual(open.spec.inventory().slice.held!.kept.map((f) => f.file), ["src/lib/gadget.ts"], "an open task declaring the file covers it");
  assert.ok(open.logs.some((l) => /W1-T100 \(open\) already covers src\/lib\/widget\.ts/.test(String(l.fields?.reason))));

  const byTitle = task("W1-T101", { title: "the `gadget` helper needs a test", files: ["src/other.ts"] });
  const titled = fixture(root, { answer, open: [byTitle] });
  await titled.spec.prepareSlice();
  assert.deepEqual(titled.spec.inventory().slice.held!.kept.map((f) => f.file), ["src/lib/widget.ts"], "an open task whose title names the symbol covers it");

  const recent = fixture(root, { answer, all: [byFile], merged: { "W1-T100": NOW - 2 * DAY } });
  await recent.spec.prepareSlice();
  assert.ok(recent.logs.some((l) => /W1-T100 \(recently merged\)/.test(String(l.fields?.reason))));

  const old = fixture(root, { answer, all: [byFile], merged: { "W1-T100": NOW - 60 * DAY } });
  await old.spec.prepareSlice();
  assert.equal(old.spec.inventory().slice.held!.kept.length, 2, "a merge outside the coverage window no longer covers the file");
});

test("W1-T5455: a surviving finding is filed through the machine filing renderer under the slice origin", async (t) => {
  const root = tmp(t, "scout-slice-file");
  const { spec } = fixture(root, { answer: JSON.stringify([GOOD]) });
  await spec.prepareSlice();
  const inv = spec.inventory();
  assert.equal(inv.slice.held!.dir, "src/lib");
  const actions = spec.candidates(inv, () => 0);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.class, "propose-from-slice");
  const landed = spec.apply(workspace(root), { actions, acting: ["propose-from-slice"] }, {});
  assert.ok(landed, "a record was written");
  assert.equal(landed.paths.length, 1);
  const text = readFileSync(join(root, landed.paths[0]!), "utf8");
  // The shared machine-filing header: the filer chooses neither verify nor risk.
  assert.match(text, /^  verify: human$/m);
  assert.match(text, /^  author_class: machine$/m);
  assert.match(text, /^  origin: "scout:slice:src\/lib"$/m);
  assert.match(text, /src\/lib\/widget\.ts/);
  const filed = loadPlanFromYaml(text, "filed.yaml").tasks[0]!;
  assert.equal(filed.origin, "scout:slice:src/lib");
  assert.deepEqual(filed.files, ["src/lib/widget.ts", "test/scout-slice-src-lib-widget-ts-2.test.ts"]);
  assert.match(filed.acceptance![0]!.proof, /^grep: test\("W1-T9001: src-lib-widget-ts no longer has the weak spot at line 2" in test\/scout-slice-/);
  assert.equal(inv.symptoms.length, 0, "the ledger class saw nothing: the slice class acted alone");
  assert.equal(readFileSync(join(root, "scout-slice-cursor.json"), "utf8").includes('"dir": "src/lib"'), true);
});

test("W1-T5455: a reverted change debits the class and filing respects the shared queue bound", async (t) => {
  const root = tmp(t, "scout-slice-judge");
  const filed = (id: string): Task => task(id, { origin: "scout:slice:src/lib", acceptance: [{ claim: "c", proof: `grep: test("${id}: x" in test/${id}.test.ts` }] });
  const [kept, reverted, young, closed, failing] = [filed("W1-T1"), filed("W1-T2"), filed("W1-T3"), { ...filed("W1-T4"), retirement: "closed" as const }, filed("W1-T5")];
  const mergedAt = NOW - (EXPORT_GARDEN_WINDOW_DAYS + 1) * DAY;
  const merged = new Map([["W1-T1", mergedAt], ["W1-T2", mergedAt], ["W1-T3", NOW - DAY], ["W1-T5", mergedAt]]);
  const { outcome, tracked } = sliceSurvival(planOf([], [kept, reverted, young, closed, failing]), merged, {
    reverted: (id) => id === "W1-T2",
    closed: (id) => id === "W1-T4",
    checkPasses: (id) => id !== "W1-T5",
  }, NOW);
  assert.deepEqual(outcome, { trials: 4, successes: 1 }, "one credit; a revert, a closed PR and a failing check each debit; a young merge waits");
  assert.deepEqual(tracked.map((r) => `${r.task}:${r.verdict}`), ["W1-T1:credit", "W1-T2:debit", "W1-T3:pending", "W1-T4:debit", "W1-T5:debit"]);
  assert.equal(SCOUT_SLICE_SURVIVAL_WINDOW_MS, EXPORT_GARDEN_WINDOW_DAYS * DAY, "the window is the export gardener's revert window");

  // The spec reads the same judgement from the plan and the main history, and a revert is what it debits.
  const open = [kept, reverted].map((x, i) => ({ ...x, files: [`src/${i}.ts`] }));
  const probes = fixture(root, { open: [], all: open, merged: { "W1-T1": mergedAt, "W1-T2": mergedAt } });
  const inv = probes.spec.inventory();
  assert.equal(inv.slice.survival.trials, 2);
  assert.equal(probes.spec.metric!(inv, "propose-from-slice").trials, 2, "the slice class is judged by its own survival");
  assert.equal(probes.spec.metric!(inv, "file-uncovered-symptom").trials, 0, "not by the ledger class's");

  // The queue bound is ONE function for both classes; over it, a finding never files and the model is never asked.
  const unprioritized = (id: string) => task(id, { priority: undefined });
  const over = [unprioritized("W1-T11"), unprioritized("W1-T12"), task("W1-T13"), task("W1-T14")];
  assert.ok(scoutAdmission(planOf(over), 5).unprioritizedShare > SCOUT_UNPRIORITIZED_SHARE_BOUND);
  assert.equal(scoutAdmission(planOf(over), 5).blocked, true);
  assert.equal(scoutAdmission(planOf([task("W1-T13")]), 0).budget, 0);
  const blocked = fixture(root, { open: over, answer: JSON.stringify([GOOD]) });
  await blocked.spec.prepareSlice();
  assert.equal(blocked.prompts.length, 0, "no model call while the queue is over its bound");
  assert.equal(existsSync(blocked.cursorPath), false, "and the slice stays unread");
  assert.deepEqual(blocked.spec.inventory().slice.selected, []);
  assert.ok(blocked.logs.some((l) => l.step === "scout.slice_skipped"));

  // Under the bound, the day's merges cap how many findings one pass files.
  const capped = fixture(root, { answer: JSON.stringify([GOOD, { file: "src/lib/gadget.ts", line: 1, claim: "`gadget` has no test", check: "ls test" }]), mergedLastDay: 1 });
  await capped.spec.prepareSlice();
  assert.equal(capped.spec.inventory().slice.selected.length, 1);
  assert.equal(fixture(root, { mergedLastDay: 0, answer: JSON.stringify([GOOD]) }).prompts.length, 0);
});
