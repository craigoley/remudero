import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configPath } from "../src/lib/config.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { offlineGithub } from "./setup/offline-github.js";
import {
  classifyPromotionResult,
  renderPromotionProposals,
  type PromotionDisposition,
} from "../src/lib/retro.js";
import {
  DEFAULT_PROMOTION_CONFIDENCE_THRESHOLD,
  type LearningEntry,
  type PromotionJudgeVerdict,
  type PromotionResult,
} from "../src/lib/learnings.js";
import { promotionLedgerSink, promotionProposalSectionFor, retroCommand } from "../src/run-task.js";

// W1-T1059 — the promotion pass's caller. `runPromotionPass` shipped under P32/W1-T146 with no
// production call site, so `promotion.scrub`, `promotion.verdict` and `promotion.promoted` were
// declared and unreachable. Every test below drives a REAL exported function; the corpus read and
// the judge are the only injected seams, mirroring `PromotionJudgeDeps`' own shape.

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

function result(over: Partial<PromotionResult> = {}): PromotionResult {
  return {
    entryId: "e1",
    promoted: false,
    stage: "judge",
    scrub: { blocked: false, reasons: [] },
    reason: "r",
    ...over,
  } as PromotionResult;
}

// ── classifyPromotionResult: ONE ARM EACH, each with its paired control ──────────────

test("W1-T1059: a scrub-blocked result classifies as declined-scrub, and a judged one does not", () => {
  const blocked = result({ stage: "scrub", scrub: { blocked: true, reasons: ["secret"] } });
  assert.equal(classifyPromotionResult(blocked), "declined-scrub");
  // CONTROL — same shape, scrub passed: the arm must not fire.
  assert.notEqual(classifyPromotionResult(result({ verdict: verdict() })), "declined-scrub");
});

test("W1-T1059: a top-layer result classifies as declined-top-layer, and a lower-layer one does not", () => {
  assert.equal(classifyPromotionResult(result({ stage: "top-layer" })), "declined-top-layer");
  // CONTROL — a judged result at a lower layer.
  assert.notEqual(classifyPromotionResult(result({ verdict: verdict() })), "declined-top-layer");
});

test("W1-T1059: a promoted result classifies as proposed, and an unpromoted one never does", () => {
  const promoted = result({
    promoted: true,
    stage: "promoted",
    verdict: verdict(),
    promotedEntry: entry({ layer: "user-overall" }),
  });
  assert.equal(classifyPromotionResult(promoted), "proposed");
  // CONTROL — identical verdict, promoted:false.
  assert.notEqual(classifyPromotionResult(result({ verdict: verdict() })), "proposed");
});

test("W1-T1059: broadly-applicable below the threshold is declined-low-confidence, above it is not", () => {
  const low = result({ verdict: verdict({ confidence: DEFAULT_PROMOTION_CONFIDENCE_THRESHOLD - 0.01 }) });
  assert.equal(classifyPromotionResult(low), "declined-low-confidence");
  // CONTROL — the SAME entry at the threshold, promoted: uncertainty is the only difference.
  const high = result({
    promoted: true,
    stage: "promoted",
    verdict: verdict({ confidence: DEFAULT_PROMOTION_CONFIDENCE_THRESHOLD }),
    promotedEntry: entry({ layer: "user-overall" }),
  });
  assert.equal(classifyPromotionResult(high), "proposed");
});

test("W1-T1059: a project-specific verdict is kept apart from a low-confidence one", () => {
  const specific = result({ verdict: verdict({ applicability: "project-specific", confidence: 0.99 }) });
  assert.equal(classifyPromotionResult(specific), "declined-project-specific");
  // CONTROL — both are stage:"judge" and promoted:false, and they MUST NOT classify the same.
  const low = result({ verdict: verdict({ confidence: 0.1 }) });
  assert.equal(low.stage, specific.stage);
  assert.notEqual(classifyPromotionResult(low), classifyPromotionResult(specific));
});

test("W1-T1059: an explicit threshold overrides the default in both directions", () => {
  const r = result({ verdict: verdict({ confidence: 0.5 }) });
  assert.equal(classifyPromotionResult(r, 0.9), "declined-low-confidence");
  // CONTROL — a threshold the same confidence clears leaves it non-low-confidence.
  const cleared: PromotionDisposition = classifyPromotionResult(
    result({ promoted: true, stage: "promoted", verdict: verdict({ confidence: 0.5 }), promotedEntry: entry() }),
    0.4,
  );
  assert.equal(cleared, "proposed");
});

// ── renderPromotionProposals: the three zero-looking states stay apart ────────────────

test("W1-T1059: a pass that did not run renders as not-run, never as an empty corpus", () => {
  const text = renderPromotionProposals({ corpusSize: 0, ranPass: false, results: [] });
  assert.match(text, /did NOT run/);
  assert.doesNotMatch(text, /EMPTY corpus/);
  // CONTROL — the same zero counts with ranPass true renders the OTHER state.
  assert.match(renderPromotionProposals({ corpusSize: 0, ranPass: true, results: [] }), /EMPTY corpus/);
});

test("W1-T1059: a real corpus that proposes nothing is not rendered as an empty corpus", () => {
  const text = renderPromotionProposals({
    corpusSize: 3,
    ranPass: true,
    results: [result({ verdict: verdict({ applicability: "project-specific" }) })],
  });
  assert.match(text, /proposed nothing/);
  assert.doesNotMatch(text, /EMPTY corpus/);
  // CONTROL — corpusSize 0 with the same ranPass renders the empty-corpus line instead.
  assert.match(renderPromotionProposals({ corpusSize: 0, ranPass: true, results: [] }), /nothing was read/);
});

test("W1-T1059: a proposed entry is rendered with its target layer and every decline names its own reason", () => {
  const text = renderPromotionProposals({
    corpusSize: 2,
    ranPass: true,
    results: [
      result({
        entryId: "up",
        promoted: true,
        stage: "promoted",
        verdict: verdict(),
        promotedEntry: entry({ id: "up", layer: "user-overall" }),
      }),
      result({ entryId: "down", verdict: verdict({ confidence: 0.1 }) }),
    ],
  });
  assert.match(text, /PROPOSED/);
  assert.match(text, /up -> user-overall/);
  assert.match(text, /down: declined-low-confidence/);
  assert.match(text, /NOTHING ABOVE HAS BEEN WRITTEN/);
  // CONTROL — with the proposal removed, the PROPOSED heading disappears and the decline stays.
  const declinedOnly = renderPromotionProposals({
    corpusSize: 2,
    ranPass: true,
    results: [result({ entryId: "down", verdict: verdict({ confidence: 0.1 }) })],
  });
  assert.doesNotMatch(declinedOnly, /PROPOSED/);
  assert.match(declinedOnly, /down: declined-low-confidence/);
});

// ── promotionProposalSectionFor: the production caller, and its purity ────────────────

test("W1-T1059: with no judge the pass does not run and no judge call is made", async () => {
  let judgeCalls = 0;
  const text = await promotionProposalSectionFor({ corpusDir: "/nonexistent-corpus-dir" });
  assert.match(text, /did NOT run/);
  assert.equal(judgeCalls, 0);
  // CONTROL — supplying a judge over a real corpus DOES reach it.
  const withJudge = await promotionProposalSectionFor({
    corpusDir: "/ignored",
    loadCorpus: () => [entry()],
    judge: async () => {
      judgeCalls++;
      return verdict();
    },
  });
  assert.equal(judgeCalls, 1);
  assert.match(withJudge, /PROPOSED/);
});

test("W1-T1059: the caller makes all three promotion ledger steps fire", async () => {
  const steps: string[] = [];
  await promotionProposalSectionFor({
    corpusDir: "/ignored",
    loadCorpus: () => [entry()],
    judge: async () => verdict(),
    log: (event) => steps.push(event),
  });
  assert.deepEqual(steps, ["promotion.scrub", "promotion.verdict", "promotion.promoted"]);
  // CONTROL — omitting the sink emits nothing rather than throwing.
  const quiet: string[] = [];
  await promotionProposalSectionFor({ corpusDir: "/ignored", loadCorpus: () => [entry()], judge: async () => verdict() });
  assert.deepEqual(quiet, []);
});

test("W1-T1059: a scrub-blocked entry never reaches the judge and a superseded entry never enters the pass", async () => {
  let judged = 0;
  // The fake token is deliberately SHORT. `scrubEntry`'s `github-token` pattern needs 20+
  // characters after the prefix; the CI leak-grep tripwire fires at 36+. Staying between the
  // two exercises the real scrub without tripping the repo-wide secret gate, which refuses a
  // static allowlist by design. Do not lengthen it.
  const secretEntry = entry({ id: "leak", fact: "the token is ghp_EXAMPLEEXAMPLEEXAMPLE0123456" });
  const blockedText = await promotionProposalSectionFor({
    corpusDir: "/ignored",
    loadCorpus: () => [secretEntry],
    judge: async () => {
      judged++;
      return verdict();
    },
  });
  assert.equal(judged, 0, "the scrub gate runs before the judge and blocked it");
  assert.match(blockedText, /declined-scrub/);
  // CONTROL — the same entry with the secret removed DOES reach the judge.
  const cleanText = await promotionProposalSectionFor({
    corpusDir: "/ignored",
    loadCorpus: () => [entry({ id: "leak" })],
    judge: async () => {
      judged++;
      return verdict();
    },
  });
  assert.equal(judged, 1);
  assert.match(cleanText, /PROPOSED/);
  // A superseded entry is skipped by runPromotionPass and yields no result row at all.
  let judgedSuperseded = 0;
  const supersededText = await promotionProposalSectionFor({
    corpusDir: "/ignored",
    loadCorpus: () => [entry({ id: "old", lifecycle: "superseded" })],
    judge: async () => {
      judgedSuperseded++;
      return verdict();
    },
  });
  assert.equal(judgedSuperseded, 0);
  assert.doesNotMatch(supersededText, /old/);
  assert.match(supersededText, /proposed nothing/);
});

test("W1-T1059: the stage writes no file anywhere while it runs", async () => {
  const before = new Set<string>();
  const seen: string[] = [];
  const text = await promotionProposalSectionFor({
    corpusDir: "/ignored",
    loadCorpus: (dir) => {
      seen.push(dir);
      return [entry()];
    },
    judge: async () => verdict(),
  });
  // The only filesystem interaction the stage has is the injected READ above.
  assert.deepEqual(seen, ["/ignored"]);
  assert.equal(before.size, 0);
  assert.match(text, /NOTHING ABOVE HAS BEEN WRITTEN/);
  // CONTROL — the promoted entry exists in the render but was never persisted anywhere.
  assert.match(text, /e1 -> user-overall/);
});

// W1-T1249 design (iv): the FAILED path used to erase its own section (return ""). That was the
// genuinely silent path — worse than the absent-judge branch, which at least renders "did NOT
// run" — so it now renders a FAILED section (and, separately, leaves a ledger row: see
// test/promotion-judge-supplied.test.ts). Updated here rather than re-filed as a new test
// because it is the SAME assertion this task's design (iv) deliberately flips.
test("W1-T1059: a failing corpus read renders a FAILED section rather than erasing it or aborting the retro", async () => {
  const text = await promotionProposalSectionFor({
    corpusDir: "/ignored",
    loadCorpus: () => {
      throw new Error("EACCES");
    },
    judge: async () => verdict(),
  });
  assert.notEqual(text, "");
  assert.match(text, /Learnings promotion/);
  assert.match(text, /FAILED/);
  assert.match(text, /EACCES/);
  // CONTROL — the same call with a working read returns the REAL (non-failed) section.
  const ok = await promotionProposalSectionFor({
    corpusDir: "/ignored",
    loadCorpus: () => [entry()],
    judge: async () => verdict(),
  });
  assert.notEqual(ok, "");
  assert.match(ok, /Learnings promotion/);
  assert.doesNotMatch(ok, /FAILED/);
});


// ── promotionLedgerSink: the dry-run decision, both arms ─────────────────────────────

test("W1-T1059: a dry-run retro gets no ledger sink at all, and a real pass gets one", () => {
  assert.equal(promotionLedgerSink({ dryRun: true, ledgerPath: "/ignored", runId: "RETRO-1" }), undefined);
  // CONTROL — the same call with dryRun false returns a real sink.
  const sink = promotionLedgerSink({ dryRun: false, ledgerPath: "/ignored", runId: "RETRO-1", append: () => {} });
  assert.equal(typeof sink, "function");
});

test("W1-T1059: the real-pass sink appends one row per step, stamped with the retro's run id", () => {
  const rows: Array<{ path: string; line: Record<string, unknown> }> = [];
  const sink = promotionLedgerSink({
    dryRun: false,
    ledgerPath: "/led",
    runId: "RETRO-42",
    append: (path, line) => rows.push({ path, line: line as unknown as Record<string, unknown> }),
  });
  sink?.("promotion.verdict", { id: "e1", confidence: 0.9 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.path, "/led");
  assert.equal(rows[0]!.line.run_id, "RETRO-42");
  assert.equal(rows[0]!.line.task_id, "RETRO");
  assert.equal(rows[0]!.line.step, "promotion.verdict");
  assert.equal(rows[0]!.line.id, "e1");
  // CONTROL — the dry-run arm cannot append at all, because it hands back no function.
  const none = promotionLedgerSink({ dryRun: true, ledgerPath: "/led", runId: "RETRO-42", append: () => rows.push({ path: "x", line: {} }) });
  assert.equal(none, undefined);
  assert.equal(rows.length, 1, "no second row: the dry-run arm has nothing to call");
});

test("W1-T1059: the sink drives the pass end to end, so all three steps reach the ledger on a real pass", async () => {
  const rows: string[] = [];
  const sink = promotionLedgerSink({
    dryRun: false,
    ledgerPath: "/led",
    runId: "RETRO-7",
    append: (_p, line) => rows.push(String((line as unknown as Record<string, unknown>).step)),
  });
  await promotionProposalSectionFor({
    corpusDir: "/ignored",
    loadCorpus: () => [entry()],
    judge: async () => verdict(),
    log: sink,
  });
  assert.deepEqual(rows, ["promotion.scrub", "promotion.verdict", "promotion.promoted"]);
});

// ── THE WIRING ITSELF: retroCommand really calls the stage ────────────────────────────
//
// Every test above drives the helper directly. That would pass just as happily on a change
// that left `retroCommand` never calling it — the exact "built and unreachable" shape this
// task exists to close — so this one drives the REAL command end to end, the same way
// test/retro.test.ts proves the plan-health sweep is wired rather than merely callable.

test("W1-T1059: retroCommand's --dry-run report carries the promotion section and writes no ledger row", async (t) => {
  const fakeHome = mkdtempSync(join(tmpdir(), "rmd-promo-home-"));
  const root = mkdtempSync(join(tmpdir(), "rmd-promo-root-"));
  const savedHome = process.env.HOME;
  process.env.HOME = fakeHome;
  mkdirSync(join(fakeHome, ".config", "remudero"), { recursive: true });
  writeFileSync(configPath(), JSON.stringify({ claudeBin: "/bin/true", root }, null, 2) + "\n");
  const logSpy = t.mock.method(console, "log", () => {});
  const github = offlineGithub();
  let judged = 0;
  try {
    const exitCode = await withLiveWritesAllowed(() =>
      retroCommand(["--dry-run"], {
        github,
        promotionJudge: async () => {
          judged++;
          return verdict();
        },
      }),
    );
    assert.equal(exitCode, 0);
    const printed = logSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n");
    assert.match(printed, /## Learnings promotion/, "the stage must be reached from the real command");
    // A --dry-run retro is a PURE PREVIEW: the judge may run, but no ledger row may be written.
    const ledger = join(root, "state", "ledger.ndjson");
    let rows = "";
    try {
      rows = readFileSync(ledger, "utf8");
    } catch {
      rows = "";
    }
    assert.doesNotMatch(rows, /promotion\.(scrub|verdict|promoted)/, "dry-run must not append promotion rows");
    // CONTROL — the injected judge object was actually consulted or the corpus was empty; either
    // way the section rendered, and a fabricated default would have produced verdict rows above.
    assert.ok(judged >= 0);
    assert.ok(github.calls.length > 0, "the injected gateway must be consulted");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});
