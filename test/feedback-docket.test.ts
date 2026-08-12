import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildFeedbackDocket,
  extractReferent,
  feedbackDocketDue,
  feedbackDocketLookbackWindow,
  readFeedbackDocketMarker,
  synthesizeFeedbackDocketProposal,
  writeFeedbackDocketMarker,
  type FeedbackDocketWindow,
  type RawFeedbackDocketInputs,
} from "../src/lib/feedback-docket.js";
import { appendLedger } from "../src/lib/ledger.js";
import { parseProposalRegistry } from "../src/lib/inbox.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const WINDOW: FeedbackDocketWindow = { sinceIso: "2026-08-01T00:00:00.000Z", untilIso: "2026-08-08T00:00:00.000Z" };

function emptyInputs(window: FeedbackDocketWindow = WINDOW): RawFeedbackDocketInputs {
  return { ledgerLines: [], rejectedFeedback: [], questionLines: [], operatorNotes: [], window };
}

// ── extractReferent — deterministic, never an LLM ──────────────────────────────────────────

test("extractReferent: a trailing bracket tag is read as the referent", () => {
  assert.equal(extractReferent("the retry banner overlaps the pill. [CLAUDE.md#7]", "fallback"), "CLAUDE.md#7");
  assert.equal(extractReferent("re-probe host state. [learnings#standing-rule-7]", "fallback"), "learnings#standing-rule-7");
});

test("extractReferent: no tag falls back to the surface's own identifier", () => {
  assert.equal(extractReferent("the retry banner overlaps the pill", "P25"), "P25");
  assert.equal(extractReferent("", "P25"), "P25");
  assert.equal(extractReferent("trailing brackets but empty [ ]", "P25"), "P25");
});

// ── buildFeedbackDocket — the pure gather ───────────────────────────────────────────────────

test("buildFeedbackDocket: normalizes all five surfaces to {source, ts, verbatim, referent}", () => {
  const inputs: RawFeedbackDocketInputs = {
    ledgerLines: [
      { ts: "2026-08-02T00:00:00.000Z", task_id: "P1", step: "ratify.reframed", feedback: "reframe text [Rule-A]" },
      { ts: "2026-08-03T00:00:00.000Z", task_id: "T1", step: "operator_feedback", verdict: "wrong", note: "steering note [Rule-B]" },
      // A ledger line for an UNRELATED step must never leak into the docket.
      { ts: "2026-08-03T00:00:00.000Z", task_id: "T1", step: "pr.opened" },
    ],
    rejectedFeedback: [{ id: "fb-1", ts: "2026-08-04T00:00:00.000Z", raw: "rejected raw text [Rule-C]" }],
    questionLines: [
      { ts: "2026-08-05T00:00:00.000Z", task: "T2", answer: "the answer text [Rule-D]" },
      // A bare QUESTION line (no answer) must never be read as an item.
      { ts: "2026-08-05T00:00:00.000Z", task: "T2", question: "why?" },
    ],
    operatorNotes: [{ ts: "2026-08-06T00:00:00.000Z", taskId: "T3", note: "operator note text [Rule-E]" }],
    window: WINDOW,
  };

  const docket = buildFeedbackDocket(inputs);

  assert.equal(docket.items.length, 5, "exactly one item per surface, no leakage from unrelated steps");
  assert.deepEqual(
    docket.countsBySource,
    { reframe: 1, operator_feedback: 1, rejected_feedback: 1, question_answer: 1, operator_note: 1 },
  );
  assert.deepEqual(docket.emptySources, [], "nothing is empty when every surface has one item");
  assert.deepEqual(
    docket.items.map((i) => i.referent),
    ["Rule-A", "Rule-B", "Rule-C", "Rule-D", "Rule-E"],
  );
  // Oldest first.
  assert.deepEqual(
    docket.items.map((i) => i.source),
    ["reframe", "operator_feedback", "rejected_feedback", "question_answer", "operator_note"],
  );
});

test("buildFeedbackDocket: EMPTY SOURCES ARE NAMED, not silently omitted", () => {
  const docket = buildFeedbackDocket({
    ...emptyInputs(),
    rejectedFeedback: [{ id: "fb-1", ts: "2026-08-02T00:00:00.000Z", raw: "one rejected entry" }],
  });
  assert.equal(docket.items.length, 1);
  assert.deepEqual(docket.countsBySource.rejected_feedback, 1);
  assert.deepEqual(
    [...docket.emptySources].sort(),
    ["operator_feedback", "operator_note", "question_answer", "reframe"].sort(),
    "a docket that omits a silent channel reads as coverage — every empty source is named",
  );
});

test("buildFeedbackDocket: items outside [sinceIso, untilIso) are excluded", () => {
  const docket = buildFeedbackDocket({
    ...emptyInputs(),
    rejectedFeedback: [
      { id: "fb-before", ts: "2026-07-31T23:59:59.999Z", raw: "just before the window" },
      { id: "fb-in", ts: "2026-08-01T00:00:00.000Z", raw: "exactly at sinceIso — inclusive" },
      { id: "fb-at-until", ts: "2026-08-08T00:00:00.000Z", raw: "exactly at untilIso — exclusive" },
      { id: "fb-after", ts: "2026-08-09T00:00:00.000Z", raw: "well after the window" },
    ],
  });
  assert.deepEqual(
    docket.items.map((i) => (i as { verbatim: string }).verbatim),
    ["exactly at sinceIso — inclusive"],
  );
});

// ── THE FALSIFIER, both directions (design v) ───────────────────────────────────────────────
//
// "a fixture docket with three reframe texts indicting the same rule yields exactly ONE inbox
// proposal whose draft quotes all three verbatim (deleting the synthesis input plumbing fails
// this), AND an empty-window fixture files no proposal and ledgers docket.empty (an
// unconditional weekly emitter fails this)."

test("THE FALSIFIER: three reframes indicting the same rule yield exactly ONE proposal quoting all three verbatim", () => {
  const inputs: RawFeedbackDocketInputs = {
    ledgerLines: [
      { ts: "2026-08-02T00:00:00.000Z", task_id: "P1", step: "ratify.reframed", feedback: "first correction about the retry banner [CLAUDE.md#7]" },
      { ts: "2026-08-03T00:00:00.000Z", task_id: "P2", step: "ratify.reframed", feedback: "second, same rule, different words [CLAUDE.md#7]" },
      { ts: "2026-08-04T00:00:00.000Z", task_id: "P3", step: "ratify.reframed", feedback: "third time typing the same correction [CLAUDE.md#7]" },
      // A DIFFERENT referent must never be pulled into the winning cluster.
      { ts: "2026-08-05T00:00:00.000Z", task_id: "P4", step: "ratify.reframed", feedback: "unrelated feedback about something else [Other-Rule]" },
    ],
    rejectedFeedback: [],
    questionLines: [],
    operatorNotes: [],
    window: WINDOW,
  };

  const docket = buildFeedbackDocket(inputs);
  assert.equal(docket.items.length, 4);

  const result = synthesizeFeedbackDocketProposal(docket);
  assert.equal(result.kind, "proposal");
  if (result.kind !== "proposal") return;

  assert.equal(result.referent, "CLAUDE.md#7");
  assert.equal(result.consumed.length, 3, "exactly the three items indicting the same rule, no more");
  assert.equal(
    result.consumed.some((i) => i.verbatim.includes("Other-Rule") || i.referent === "Other-Rule"),
    false,
    "the fourth, differently-referented item must never be pulled into the winning cluster",
  );

  // ALL THREE quoted VERBATIM in the candidate — deleting the synthesis input plumbing fails this.
  assert.match(result.candidate.summary, /first correction about the retry banner \[CLAUDE\.md#7\]/);
  assert.match(result.candidate.summary, /second, same rule, different words \[CLAUDE\.md#7\]/);
  assert.match(result.candidate.summary, /third time typing the same correction \[CLAUDE\.md#7\]/);
  // And the unrelated item is NOT quoted in this candidate.
  assert.doesNotMatch(result.candidate.summary, /unrelated feedback about something else/);

  // Exactly ONE candidate — synthesizeFeedbackDocketProposal never returns more than one.
  assert.equal(typeof result.candidate.id, "string");
  assert.ok(result.candidate.id.length > 0);
});

test("THE FALSIFIER: an empty window files no proposal (the no-op path is first-class)", () => {
  const docket = buildFeedbackDocket(emptyInputs());
  assert.equal(docket.items.length, 0);
  assert.deepEqual(docket.emptySources, ["reframe", "operator_feedback", "rejected_feedback", "question_answer", "operator_note"]);

  const result = synthesizeFeedbackDocketProposal(docket);
  assert.deepEqual(result, { kind: "empty" }, "an unconditional weekly emitter fails this");
});

// ── feedbackDocketDue / feedbackDocketLookbackWindow ────────────────────────────────────────

test("feedbackDocketDue: never twice inside a rolling 7-day period", () => {
  const now = new Date("2026-08-10T00:00:00.000Z");
  assert.equal(feedbackDocketDue(undefined, now), true, "absent marker fires — the honest pre-population state");
  assert.equal(feedbackDocketDue({ lastFireIso: "2026-08-09T00:00:00.000Z" }, now), false, "1 day since the last fire: not due");
  assert.equal(feedbackDocketDue({ lastFireIso: "2026-08-03T00:00:00.000Z" }, now), true, "exactly 7 days since the last fire: due");
  assert.equal(feedbackDocketDue({ lastFireIso: "not-a-date" }, now), true, "a corrupt marker fails open, not closed");
});

test("readFeedbackDocketMarker: absent file, malformed shape, and unparseable JSON all fail open", () => {
  const dir = tmp("rmd-fd-marker-");
  try {
    const path = join(dir, "last-feedback-docket.json");
    assert.equal(readFeedbackDocketMarker(path), undefined, "no file at all: fails open");

    writeFileSync(path, "not json at all {{{");
    assert.equal(readFeedbackDocketMarker(path), undefined, "unparseable JSON: the catch branch fails open, not throws");

    writeFileSync(path, JSON.stringify({ lastFireIso: 12345 }));
    assert.equal(readFeedbackDocketMarker(path), undefined, "wrong-typed field: fails open");

    writeFileSync(path, JSON.stringify(["not", "an", "object"]));
    assert.equal(readFeedbackDocketMarker(path), undefined, "non-object JSON: fails open");

    writeFileSync(path, JSON.stringify({ lastFireIso: "2026-08-01T00:00:00.000Z" }));
    assert.deepEqual(readFeedbackDocketMarker(path), { lastFireIso: "2026-08-01T00:00:00.000Z" }, "a well-formed marker round-trips");

    writeFeedbackDocketMarker(path, { lastFireIso: "2026-08-02T00:00:00.000Z" });
    assert.deepEqual(readFeedbackDocketMarker(path), { lastFireIso: "2026-08-02T00:00:00.000Z" }, "write then read round-trips");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("feedbackDocketLookbackWindow: a 7-day window ending at now", () => {
  const now = new Date("2026-08-10T12:00:00.000Z");
  const w = feedbackDocketLookbackWindow(now);
  assert.equal(w.untilIso, now.toISOString());
  assert.equal(w.sinceIso, "2026-08-03T12:00:00.000Z");
});

// ── THE RUNG inside run-task.ts — real files, the pure-path form against a declared file ──

test("runFeedbackDocketRung: files exactly one proposal quoting three same-rule reframes, then goes quiet for the week", async () => {
  const { runFeedbackDocketRung } = await import("../src/run-task.js");
  const instanceRoot = tmp("rmd-fd-instance-");
  const repo = tmp("rmd-fd-repo-");
  try {
    const config = { root: instanceRoot } as never;
    const ledgerPath = join(instanceRoot, "state", "ledger.ndjson");
    const now = new Date("2026-08-10T00:00:00.000Z");

    // Three reframes on the SAME referent, inside the 7-day lookback ending at `now`. `ts` is
    // passed EXPLICITLY: appendLedger's own auto-stamp (real wall-clock time) would otherwise
    // land these outside this fixture's fixed window — the line object's `ts` key overrides it
    // (object-spread key order in appendLedger's `record`).
    appendLedger(ledgerPath, {
      run_id: "r1",
      task_id: "P1",
      step: "ratify.reframed",
      feedback: "first correction about the retry banner [CLAUDE.md#7]",
      ts: "2026-08-04T00:00:00.000Z",
    });
    appendLedger(ledgerPath, {
      run_id: "r1",
      task_id: "P2",
      step: "ratify.reframed",
      feedback: "second, same rule, different words [CLAUDE.md#7]",
      ts: "2026-08-05T00:00:00.000Z",
    });
    appendLedger(ledgerPath, {
      run_id: "r1",
      task_id: "P3",
      step: "ratify.reframed",
      feedback: "third time typing the same correction [CLAUDE.md#7]",
      ts: "2026-08-06T00:00:00.000Z",
    });

    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    const log = (step: string, extra: Record<string, unknown> = {}) => lines.push({ step, extra });

    const outcome = runFeedbackDocketRung(config, ledgerPath, "run-1", log, { root: repo, now: () => now });

    assert.equal(outcome.fired, true);
    assert.equal(lines.filter((l) => l.step === "feedback_docket.published").length, 1);

    const registryPath = join(instanceRoot, "state", "inbox-proposals.json");
    const { readFileSync } = await import("node:fs");
    const proposals = parseProposalRegistry(readFileSync(registryPath, "utf8"));
    assert.equal(proposals.length, 1, "exactly ONE inbox proposal filed, per the falsifier");
    assert.match(proposals[0].summary, /first correction about the retry banner \[CLAUDE\.md#7\]/);
    assert.match(proposals[0].summary, /second, same rule, different words \[CLAUDE\.md#7\]/);
    assert.match(proposals[0].summary, /third time typing the same correction \[CLAUDE\.md#7\]/);

    // Firing again immediately (same week) must be a no-op: the marker gates it shut.
    const second = runFeedbackDocketRung(config, ledgerPath, "run-2", log, { root: repo, now: () => now });
    assert.equal(second.fired, false);
    const stillOne = parseProposalRegistry(readFileSync(registryPath, "utf8"));
    assert.equal(stillOne.length, 1, "no duplicate proposal from a second poll inside the same week");
  } finally {
    rmSync(instanceRoot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runFeedbackDocketRung: an empty window ledgers feedback_docket.empty and files nothing", async () => {
  const { runFeedbackDocketRung } = await import("../src/run-task.js");
  const instanceRoot = tmp("rmd-fd-empty-instance-");
  const repo = tmp("rmd-fd-empty-repo-");
  try {
    const config = { root: instanceRoot } as never;
    const ledgerPath = join(instanceRoot, "state", "ledger.ndjson");
    const now = new Date("2026-08-10T00:00:00.000Z");

    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    const log = (step: string, extra: Record<string, unknown> = {}) => lines.push({ step, extra });

    const outcome = runFeedbackDocketRung(config, ledgerPath, "run-1", log, { root: repo, now: () => now });

    assert.equal(outcome.fired, false);
    assert.equal(lines.filter((l) => l.step === "feedback_docket.empty").length, 1);
    assert.equal(lines.filter((l) => l.step === "feedback_docket.published").length, 0);

    const { existsSync } = await import("node:fs");
    const registryPath = join(instanceRoot, "state", "inbox-proposals.json");
    assert.equal(existsSync(registryPath), false, "an unconditional weekly emitter fails this — no file at all is written");
  } finally {
    rmSync(instanceRoot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runFeedbackDocketRung: an unreadable/absent capture surface is skipped, never a reason to refuse the whole gather", async () => {
  const { runFeedbackDocketRung } = await import("../src/run-task.js");
  const instanceRoot = tmp("rmd-fd-unread-instance-");
  const repo = tmp("rmd-fd-unread-repo-");
  try {
    // plan/feedback does not exist at all in this fixture repo — the rung must not throw.
    mkdirSync(join(repo, "plan"), { recursive: true });
    const config = { root: instanceRoot } as never;
    const ledgerPath = join(instanceRoot, "state", "ledger.ndjson");
    const now = new Date("2026-08-10T00:00:00.000Z");

    const lines: Array<{ step: string }> = [];
    const outcome = runFeedbackDocketRung(config, ledgerPath, "run-1", (step) => lines.push({ step }), {
      root: repo,
      now: () => now,
    });

    assert.equal(outcome.fired, false);
    assert.equal(lines.filter((l) => l.step === "feedback_docket.error").length, 0, "a missing plan/feedback dir is not an error");
  } finally {
    rmSync(instanceRoot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runFeedbackDocketRung: gathers rejected-feedback, question-answer, and operator-note surfaces from real files", async () => {
  const { runFeedbackDocketRung } = await import("../src/run-task.js");
  const instanceRoot = tmp("rmd-fd-surfaces-instance-");
  const repo = tmp("rmd-fd-surfaces-repo-");
  try {
    const now = new Date("2026-08-10T00:00:00.000Z");
    const inWindowTs = "2026-08-05T00:00:00.000Z";

    const fbDir = join(repo, "plan", "feedback");
    mkdirSync(fbDir, { recursive: true });
    writeFileSync(
      join(fbDir, "fb-1.yaml"),
      `id: fb-1\nts: ${inWindowTs}\nraw: "rejected: this correction keeps recurring [Shared-Rule]"\nattachments: []\norigin: cli\nstatus: rejected\nproposal_pr: null\n`,
    );
    writeFileSync(
      join(repo, "plan", "questions.ndjson"),
      `${JSON.stringify({ ts: inWindowTs, task: "T9", answer: "answer text agreeing with the correction [Shared-Rule]" })}\n`,
    );
    writeFileSync(
      join(repo, "plan", "operator-notes.ndjson"),
      `${JSON.stringify({ ts: inWindowTs, taskId: "T9", author: "operator", note: "note text on the same subject [Shared-Rule]" })}\n`,
    );

    const config = { root: instanceRoot } as never;
    const ledgerPath = join(instanceRoot, "state", "ledger.ndjson");
    const outcome = runFeedbackDocketRung(config, ledgerPath, "run-1", () => {}, { root: repo, now: () => now });

    assert.equal(outcome.fired, true);
    const { readFileSync } = await import("node:fs");
    const registryPath = join(instanceRoot, "state", "inbox-proposals.json");
    const proposals = parseProposalRegistry(readFileSync(registryPath, "utf8"));
    assert.equal(proposals.length, 1);
    assert.match(proposals[0].summary, /rejected: this correction keeps recurring \[Shared-Rule\]/);
    assert.match(proposals[0].summary, /answer text agreeing with the correction \[Shared-Rule\]/);
    assert.match(proposals[0].summary, /note text on the same subject \[Shared-Rule\]/);
  } finally {
    rmSync(instanceRoot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runFeedbackDocketRung: a non-empty docket whose synthesis still reports empty ledgers feedback_docket.empty", async () => {
  const { runFeedbackDocketRung } = await import("../src/run-task.js");
  const instanceRoot = tmp("rmd-fd-synthempty-instance-");
  const repo = tmp("rmd-fd-synthempty-repo-");
  try {
    const config = { root: instanceRoot } as never;
    const ledgerPath = join(instanceRoot, "state", "ledger.ndjson");
    const now = new Date("2026-08-10T00:00:00.000Z");

    appendLedger(ledgerPath, {
      run_id: "r1",
      task_id: "P1",
      step: "ratify.reframed",
      feedback: "one item, non-empty docket [CLAUDE.md#7]",
      ts: "2026-08-04T00:00:00.000Z",
    });

    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    const log = (step: string, extra: Record<string, unknown> = {}) => lines.push({ step, extra });

    // Injected: even though the docket itself is non-empty (an item was gathered above),
    // the synthesis step is forced to report `{kind: "empty"}` — this is the seam covering
    // that second, defensive empty-check inside the rung (as distinct from the docket-level
    // empty-window check the earlier test above exercises).
    const outcome = runFeedbackDocketRung(config, ledgerPath, "run-1", log, {
      root: repo,
      now: () => now,
      synthesize: () => ({ kind: "empty" }),
    });

    assert.equal(outcome.fired, false);
    assert.equal(lines.filter((l) => l.step === "feedback_docket.empty").length, 1);
    assert.equal(lines.filter((l) => l.step === "feedback_docket.published").length, 0);

    const { existsSync } = await import("node:fs");
    const registryPath = join(instanceRoot, "state", "inbox-proposals.json");
    assert.equal(existsSync(registryPath), false, "a forced-empty synthesis result files no proposal");
  } finally {
    rmSync(instanceRoot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runFeedbackDocketRung: a marker-write failure is caught, ledgers feedback_docket.error, and never throws", async () => {
  const { runFeedbackDocketRung } = await import("../src/run-task.js");
  // `instanceRoot` is a FILE, not a directory: `config.root/state/...` can never be created,
  // so `writeFeedbackDocketMarker`'s mkdirSync throws — exercising the rung's own try/catch
  // (its doc: "a read failure here must never take down the sweep composite it rides inside").
  const instanceRoot = tmp("rmd-fd-errfile-instance-");
  rmSync(instanceRoot, { recursive: true, force: true });
  writeFileSync(instanceRoot, "i am a file, not a directory");
  const repo = tmp("rmd-fd-errfile-repo-");
  try {
    const config = { root: instanceRoot } as never;
    const ledgerPath = join(instanceRoot, "state", "ledger.ndjson");
    const now = new Date("2026-08-10T00:00:00.000Z");

    const lines: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const log = (step: string, extra?: Record<string, unknown>) => lines.push({ step, extra });

    const outcome = runFeedbackDocketRung(config, ledgerPath, "run-1", log, { root: repo, now: () => now });

    assert.equal(outcome.fired, false, "a caught internal error never reports fired");
    assert.equal(lines.filter((l) => l.step === "feedback_docket.error").length, 1, "the failure is ledgered, not swallowed silently");
  } finally {
    rmSync(instanceRoot, { force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
