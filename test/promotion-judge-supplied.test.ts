import assert from "node:assert/strict";
import { test } from "node:test";
import type { Mount } from "../src/lib/mounts.js";
import type { WorkerResult } from "../src/lib/worker.js";
import type { LearningEntry, PromotionJudgeVerdict } from "../src/lib/learnings.js";
import {
  buildPromotionJudgeSpawnArgs,
  DEFAULT_PROMOTION_MAX_ENTRIES_PER_CYCLE,
  promotionProposalSectionFor,
  PROMOTION_JUDGE_TOOLS,
  realPromotionJudge,
  resolvePromotionJudge,
  selectPromotionCycleEntries,
} from "../src/run-task.js";

// W1-T1249: "PROMOTION HAS A CALLER AND NO JUDGE, SO THE PASS HAS NEVER RUN" — W1-T1059 wired
// `runPromotionPass` into the retro as `judge: opts.promotionJudge`, but nothing in production
// ever supplied that field. This task supplies one, at the smallest configured setting, bounded
// at the caller (design (ii)), proposal-only (design (iii): no write path is touched here — see
// test/learnings-promotion-caller.test.ts's own "writes no file" coverage, unchanged), and adds
// a ledger row to the two paths that used to leave none (design (iv)).

function entry(over: Partial<LearningEntry> = {}): LearningEntry {
  return {
    id: "e1",
    subsystem: "ci",
    lifecycle: "active",
    fact: "a fact with no secret in it at all",
    src: "research#somewhere",
    files: ["src/lib/example.ts"],
    ...over,
  } as LearningEntry;
}

function verdict(over: Partial<PromotionJudgeVerdict> = {}): PromotionJudgeVerdict {
  return { applicability: "broadly-applicable", confidence: 0.9, rationale: "generalises", ...over };
}

function mount(over: Partial<Mount> = {}): Mount {
  return { model: "haiku", effort: "low", maxTurns: 400, contextBudget: 60000, ...over };
}

function fakeWorkerResult(text: string): WorkerResult {
  return {
    sessionId: "s-promotion-judge",
    costUsd: 0.001,
    numTurns: 1,
    text,
    blocks: [text],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "haiku",
    effort: "low",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  };
}

// ── acceptance: "a retro with no judge configured still runs and leaves a row saying the pass
//    was skipped" ──────────────────────────────────────────────────────────────────────────

test("W1-T1249: an absent judge still renders the unchanged 'did NOT run' section, and NOW leaves one ledger row naming why", async () => {
  const rows: Array<{ event: string; data: Record<string, unknown> }> = [];
  const text = await promotionProposalSectionFor({
    corpusDir: "/ignored",
    log: (event, data) => rows.push({ event, data }),
  });
  assert.match(text, /did NOT run/);
  assert.deepEqual(rows.map((r) => r.event), ["promotion.skipped"]);
  assert.equal(typeof rows[0]!.data.reason, "string");
  // CONTROL — an omitted `log` is a silent no-op, exactly like every other injected sink here.
  const quiet = await promotionProposalSectionFor({ corpusDir: "/ignored" });
  assert.match(quiet, /did NOT run/);
});

// ── acceptance: "a judge that throws leaves a row and does not erase the report section" ─────

test("W1-T1249: a judge that throws leaves ONE 'promotion.failed' row and a non-empty FAILED section — never the old empty-string erasure", async () => {
  const rows: Array<{ event: string; data: Record<string, unknown> }> = [];
  const text = await promotionProposalSectionFor({
    corpusDir: "/ignored",
    loadCorpus: () => [entry()],
    judge: async () => {
      throw new Error("judge spawn blew up");
    },
    log: (event, data) => rows.push({ event, data }),
  });
  assert.notEqual(text, "", "the section must NOT be erased on a failed pass");
  assert.match(text, /Learnings promotion/);
  assert.match(text, /FAILED/);
  assert.match(text, /judge spawn blew up/);
  // `promotion.scrub` still fires first (scrub runs before the judge, unconditionally); the
  // NEW row this task adds is `promotion.failed`, appended once the catch is reached.
  assert.deepEqual(rows.map((r) => r.event), ["promotion.scrub", "promotion.failed"]);
  const failedRow = rows.find((r) => r.event === "promotion.failed")!;
  assert.match(String(failedRow.data.error), /judge spawn blew up/);
  // CONTROL — the same shape but the judge SUCCEEDS: no failed row, no FAILED section.
  const okRows: string[] = [];
  const ok = await promotionProposalSectionFor({
    corpusDir: "/ignored",
    loadCorpus: () => [entry()],
    judge: async () => verdict(),
    log: (event) => okRows.push(event),
  });
  assert.doesNotMatch(ok, /FAILED/);
  assert.ok(!okRows.includes("promotion.failed"));
});

// ── acceptance: "the pass judges no more entries per cycle than the declared ceiling" ────────

test("selectPromotionCycleEntries: a deterministic, sorted-by-id CEILING — never more than `max`, never re-ordered by input order", () => {
  const entries = ["c", "a", "e", "b", "d", "f", "g"].map((id) => entry({ id }));
  const bounded = selectPromotionCycleEntries(entries, 5);
  assert.equal(bounded.length, 5);
  assert.deepEqual(bounded.map((e) => e.id), ["a", "b", "c", "d", "e"]);
  // CONTROL — running it again over a differently-ordered copy of the SAME corpus picks the
  // IDENTICAL subset (design (ii): "two runs over one corpus judge the same entries").
  const reordered = [...entries].reverse();
  assert.deepEqual(
    selectPromotionCycleEntries(reordered, 5).map((e) => e.id),
    bounded.map((e) => e.id),
  );
  // CONTROL — fewer entries than the ceiling: a ceiling, never a target.
  assert.equal(selectPromotionCycleEntries(entries.slice(0, 2), 5).length, 2);
});

test("W1-T1249 design (ii): the pass judges AT MOST the ceiling, default 5, even when the corpus offers more", async () => {
  const eightEntries = Array.from({ length: 8 }, (_, i) => entry({ id: `entry-${i}` }));
  let judgeCalls = 0;
  const text = await promotionProposalSectionFor({
    corpusDir: "/ignored",
    loadCorpus: () => eightEntries,
    judge: async () => {
      judgeCalls++;
      return verdict();
    },
  });
  assert.equal(judgeCalls, DEFAULT_PROMOTION_MAX_ENTRIES_PER_CYCLE, "the default ceiling is 5");
  assert.match(text, /Learnings promotion/);
  // CONTROL — an explicit, smaller ceiling is honoured too (a caller-tunable CEILING, not a
  // hardcoded 5 baked into the pass itself).
  let smallerCalls = 0;
  await promotionProposalSectionFor({
    corpusDir: "/ignored",
    loadCorpus: () => eightEntries,
    maxEntriesPerCycle: 2,
    judge: async () => {
      smallerCalls++;
      return verdict();
    },
  });
  assert.equal(smallerCalls, 2);
});

// ── acceptance: "the stage writes no learnings entry to any home on any path" ────────────────

test("W1-T1249: no path (absent judge, a real pass, or a failed pass) touches the filesystem anywhere but the ONE injected read", async () => {
  // `node:fs`'s named exports are non-configurable in this runtime (mocking them throws
  // "Cannot redefine property"), so the seam this proves against is the SAME one
  // test/learnings-promotion-caller.test.ts's own "writes no file anywhere" falsifier uses:
  // `loadCorpus` is the ONLY filesystem-shaped call the stage ever makes on any path — a
  // real `fs.writeFileSync`/`appendFileSync` call is simply unreachable code on every arm
  // below, since none of them import or call one (see promotionProposalSectionFor's own body).
  const seenReads: string[] = [];

  // absent judge — short-circuits before `loadCorpus` is even called.
  const skipped = await promotionProposalSectionFor({
    corpusDir: "/should-never-be-read",
    loadCorpus: (dir) => {
      seenReads.push(dir);
      return [entry()];
    },
  });
  assert.match(skipped, /did NOT run/);

  // a real pass that PROMOTES an entry — the interesting case: a promotedEntry exists in
  // memory but must never be persisted anywhere on this path (design (iii)/Law 5).
  const promoted = await promotionProposalSectionFor({
    corpusDir: "/promo-corpus",
    loadCorpus: (dir) => {
      seenReads.push(dir);
      return [entry()];
    },
    judge: async () => verdict(),
  });
  assert.match(promoted, /NOTHING ABOVE HAS BEEN WRITTEN/);
  assert.match(promoted, /e1 -> user-overall/);

  // a failed pass.
  const failed = await promotionProposalSectionFor({
    corpusDir: "/should-never-be-read-either",
    loadCorpus: () => {
      throw new Error("boom");
    },
    judge: async () => verdict(),
  });
  assert.match(failed, /FAILED/);

  // The ONLY filesystem-shaped interaction across all three calls is the ONE real read.
  assert.deepEqual(seenReads, ["/promo-corpus"]);
});

// ── acceptance: "an injected judge still overrides the supplied default" ─────────────────────

test("resolvePromotionJudge: an injected judge wins by IDENTITY — the default is never even constructed", () => {
  const injected = async () => verdict();
  const resolved = resolvePromotionJudge({
    injected,
    mount: mount(),
    cwd: "/tmp/x",
    settingsFile: "/tmp/settings.json",
  });
  assert.equal(resolved, injected, "the exact injected function must be returned, not a wrapper around it");
});

test("resolvePromotionJudge: absent injection falls back to the real, spawn-backed default", async () => {
  const calls: unknown[] = [];
  const spawn = async (args: unknown) => {
    calls.push(args);
    return fakeWorkerResult(
      "PROMOTION_APPLICABILITY: broadly-applicable\nPROMOTION_CONFIDENCE: 0.8\nPROMOTION_RATIONALE: cross-cutting\n",
    );
  };
  const resolved = resolvePromotionJudge({
    injected: undefined,
    mount: mount(),
    cwd: "/tmp/x",
    settingsFile: "/tmp/settings.json",
    spawn: spawn as never,
  });
  const v = await resolved(entry());
  assert.equal(calls.length, 1, "the default judge must reach the injected spawn exactly once per entry");
  assert.deepEqual(v, { applicability: "broadly-applicable", confidence: 0.8, rationale: "cross-cutting" });
});

// ── the real spawn wiring: cheapest mount, empty tool list, no new spawn idiom ────────────────

test("buildPromotionJudgeSpawnArgs carries an EMPTY tool list — the judge cannot read/write the worktree it is spawned into", () => {
  const args = buildPromotionJudgeSpawnArgs({
    entry: entry({ fact: "a very specific fact to find in the prompt" }),
    mount: mount({ model: "haiku", effort: "low", maxTurns: 400 }),
    cwd: "/tmp/x",
    settingsFile: "/tmp/settings.json",
  });
  assert.equal(args.tools, PROMOTION_JUDGE_TOOLS);
  assert.equal((args.tools ?? []).length, 0);
  assert.equal(args.model, "haiku");
  assert.equal(args.effort, "low");
  assert.equal(args.maxTurns, 400);
  assert.equal(args.cwd, "/tmp/x");
  assert.equal(args.settingsFile, "/tmp/settings.json");
  assert.match(args.prompt, /a very specific fact to find in the prompt/);
});

test("realPromotionJudge wires the injected spawn's result through parsePromotionJudgeVerdict — the production judge fn", async () => {
  const calls: unknown[] = [];
  const spawn = async (args: unknown) => {
    calls.push(args);
    return fakeWorkerResult("PROMOTION_APPLICABILITY: project-specific\nPROMOTION_CONFIDENCE: 0.3\nPROMOTION_RATIONALE: names this repo's own tooling\n");
  };
  const judge = realPromotionJudge({ mount: mount(), cwd: "/tmp/x", settingsFile: "/tmp/settings.json", spawn: spawn as never });
  const v = await judge(entry());
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], buildPromotionJudgeSpawnArgs({ entry: entry(), mount: mount(), cwd: "/tmp/x", settingsFile: "/tmp/settings.json" }));
  assert.deepEqual(v, { applicability: "project-specific", confidence: 0.3, rationale: "names this repo's own tooling" });
});

// ── an unparseable judge output fails CLOSED (learnings.ts's own default, exercised end to end
//    through THIS caller — never invented here) ───────────────────────────────────────────────

test("realPromotionJudge: an unparseable spawn result fails CLOSED to project-specific/confidence 0, never a crash", async () => {
  const spawn = async () => fakeWorkerResult("(no machine-readable verdict lines at all)");
  const judge = realPromotionJudge({ mount: mount(), cwd: "/tmp/x", settingsFile: "/tmp/settings.json", spawn: spawn as never });
  const v = await judge(entry());
  assert.equal(v.applicability, "project-specific");
  assert.equal(v.confidence, 0);
});
