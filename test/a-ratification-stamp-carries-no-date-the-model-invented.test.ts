import assert from "node:assert/strict";
import { test } from "node:test";
import * as inbox from "#src/lib/inbox.js";
import { fixedClock } from "#src/lib/clock.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import type { WorkerResult } from "#src/lib/worker.js";

const clock = fixedClock(Date.parse("2026-10-12T20:30:00-04:00"));
const proposal: inbox.Proposal = {
  id: "verify-human:W1-T147", summary: "route verification", evidenceAnchors: [],
};
const fragmentYaml = inbox.inboxDraftExampleFragmentYaml();
const fragmentIds = ["NEW-1"];
const context: inbox.ReadinessContext = {
  plan: loadPlanFromYaml("[]", "fixture"), isMerged: () => true,
  grepAnchorTrue: () => true, openProposalIds: new Set(), isRatified: () => false, clock,
};

function worker(stamp: string, fragment = fragmentYaml): WorkerResult {
  return {
    text: `=== FRAGMENT START ===\n${fragment.trim()}\n=== FRAGMENT END ===\nSTAMP: ${stamp}`,
    blocks: [], subtype: "success", sessionId: "stamp-fixture", costUsd: 0,
    numTurns: 1, isError: false, stderr: "", apiError: false, permissionDenials: [],
    childEnvKeys: [], model: "default", effort: "default", modelUsage: {},
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    compactionEvents: [], qualitySuspect: false,
  };
}

test("W1-T8828: the harness composes the stamp from the proposal, the clock and the fragment", () => {
  const stamp = inbox.composeStampLine(proposal.id, "route verification", ["NEW-2", "NEW-1"], clock);
  assert.equal(stamp, "- verify-human:W1-T147 (route verification) — RATIFIED 2026-10-13 -> NEW-2, NEW-1.");
  assert.deepEqual(inbox.stampLineViolations(proposal.id, stamp, ["NEW-1", "NEW-2"]), []);
  const before = new Date().toISOString().slice(0, 10);
  const live = inbox.composeStampLine(proposal.id, "route verification", fragmentIds);
  const after = new Date().toISOString().slice(0, 10);
  assert.ok([before, after].some((date) => live.includes(`RATIFIED ${date} -> NEW-1.`)));
});

test("W1-T8828: a prose stamp from the model yields a clean draft", async () => {
  let calls = 0;
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const [outcome] = await inbox.runDraftRung([proposal], "- id: W1-T1\n", {
    clock, spawn: async () => { calls++; return worker("ratified verify-human:W1-T147 -> NEW-1, NEW-2"); },
    log: (step, extra) => logs.push({ step, extra }),
  }, "stamp-test");
  assert.ok(outcome.ok);
  assert.equal(calls, 1);
  assert.equal(outcome.candidate.stampLine, "- verify-human:W1-T147 (verify-human) — RATIFIED 2026-10-13 -> NEW-1.");
  assert.deepEqual(inbox.lintDraftedFragment(fragmentYaml, proposal.id, outcome.candidate.stampLine), []);
  assert.equal(logs.find((entry) => entry.step === "inbox.drafted")?.extra?.lint_clean, true);
});

test("W1-T8828: no date or id the model wrote survives into the stamp", () => {
  for (const label of [
    "- P44 (repair W1-T7739 NEW-88 machine-judge:W1-T5418 RATIFIED 2023-10-10T00:00:00Z) -> NEW-88.",
    "repair verify-human:W1-T147 W1-T7739 NEW-88 P44 ratified 2023-10-10 12:34:56Z -> NEW-88",
    "repair (2023/10/10 12:34:56+02:00) W1-T7739",
    "repair October 10, 2023 at 12:34 pm -> NEW-88",
    "repair 10th October 2023 12:34:56Z W1-T7739",
  ]) {
    const stamp = inbox.composeStampLine(proposal.id, label, fragmentIds, clock);
    const summary = stamp.slice(stamp.indexOf("(") + 1, stamp.indexOf(")"));
    assert.doesNotMatch(summary, /2023|October|12:34|00:00|W1-T|NEW-88|P44|machine-judge|ratified|->/i);
    assert.deepEqual(inbox.stampLineViolations(proposal.id, stamp, fragmentIds), []);
  }
  assert.equal(inbox.composeStampLine("machine-judge:W1-T7739", "(2023-10-10T00:00:00Z) -> NEW-1, NEW-2", fragmentIds, clock),
    "- machine-judge:W1-T7739 (machine-judge) — RATIFIED 2026-10-13 -> NEW-1.");
  const bounded = inbox.composeStampLine(proposal.id, `${"word ".repeat(100)}\nsecond line`, fragmentIds, clock);
  assert.ok(bounded.slice(bounded.indexOf("(") + 1, bounded.indexOf(")")).length <= 120);
  assert.doesNotMatch(bounded, /[\r\n]/);
});

test("W1-T8828: a stored draft held only on its stamp becomes ready without a redraft", () => {
  const storedFragment = `${fragmentYaml}\n${fragmentYaml.replace("NEW-1", "NEW-2").replaceAll("empty", "null")}`;
  const draft: inbox.DraftedCandidate = {
    proposalId: proposal.id, fragmentYaml: storedFragment, stampLine: "ratified verify-human:W1-T147 -> NEW-1, NEW-2",
    anchorFingerprint: inbox.anchorFingerprint([]),
  };
  assert.ok(inbox.stampLineViolations(proposal.id, draft.stampLine, fragmentIds).length > 0);
  const result = inbox.classifyProposal(proposal, draft, context);
  assert.equal(result.state, "ready", JSON.stringify(result.reasons));
  assert.equal(result.draft?.stampLine, "- verify-human:W1-T147 (verify-human) — RATIFIED 2026-10-13 -> NEW-1, NEW-2.");
  assert.equal(result.draft?.fragmentYaml, draft.fragmentYaml);
  assert.ok(inbox.renderInbox([result]).includes(`stamp: ${result.draft?.stampLine}`));
  const batch = inbox.planRatificationBatch([result], `- ${proposal.id} (pending)\n`);
  assert.ok(batch.ok);
  assert.equal(batch.accepted[0].stampLine, result.draft?.stampLine);
  assert.ok(batch.masterPlanMd.includes(result.draft!.stampLine));
  assert.equal(draft.stampLine, "ratified verify-human:W1-T147 -> NEW-1, NEW-2");
  assert.deepEqual(inbox.draftsDueOnDaemon([proposal], { [proposal.id]: draft }, {}, 3), []);
  // W1-T9039: approve repairs a shared whole-file proof, so the dirty draft here is one it cannot repair.
  const dirtyFragment = fragmentYaml.replace("    - src/lib/plan.ts", "    - src/lib/an-uncalled-module.ts");
  const dirty = inbox.classifyProposal(proposal, { ...draft, fragmentYaml: dirtyFragment }, context);
  assert.equal(dirty.state, "not_ready");
  assert.ok(dirty.reasons.some((reason) => reason.predicate === "lint_clean" && reason.detail.includes("call-site")));
  assert.ok(dirty.reasons.every((reason) => !reason.detail.includes("stamp:")));
  const malformed = inbox.classifyProposal(proposal, { ...draft, fragmentYaml: "[broken" }, context);
  assert.equal(malformed.state, "not_ready");
  assert.match(malformed.reasons[0].detail, /failed to parse/);
});

test("W1-T8828: the draft prompt asks only for the summary", () => {
  const prompt = inbox.inboxDraftPrompt(proposal, "- id: W1-T1\n", "stamp-test");
  assert.ok(prompt.includes("STAMP: <the one-line summary>"));
  assert.ok(prompt.includes("The harness supplies the proposal id, UTC date and fragment task ids"));
  assert.ok(prompt.includes("STAMP: illustrative example only"));
  assert.doesNotMatch(prompt, /RATIFIED <YYYY-MM-DD>|STAMP: - EXAMPLE-P|stamp line's task-id list/);
  const relint = inbox.inboxDraftRelintPrompt(proposal, fragmentYaml, []);
  assert.ok(relint.includes("STAMP: <the corrected one-line summary>"));
});

test("W1-T8828: an escalated draft receives the same harness stamp before linting", async () => {
  let escalations = 0;
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const [outcome] = await inbox.runDraftRung([proposal], "- id: W1-T1\n", {
    clock, spawn: async () => worker("summary", "[broken"),
    escalate: async () => { escalations++; return worker("repair 2023-10-10T00:00:00Z -> NEW-99"); },
    log: (step, extra) => logs.push({ step, extra }),
  }, "stamp-escalation");
  assert.ok(outcome.ok);
  assert.equal(escalations, 1);
  assert.equal(outcome.candidate.stampLine, "- verify-human:W1-T147 (repair) — RATIFIED 2026-10-13 -> NEW-1.");
  assert.equal(logs.find((entry) => entry.step === "inbox.drafted")?.extra?.lint_clean, true);
});
