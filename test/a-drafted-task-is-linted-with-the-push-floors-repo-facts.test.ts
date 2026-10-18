/**
 * test/a-drafted-task-is-linted-with-the-push-floors-repo-facts.test.ts — W1-T9039.
 *
 * OBSERVED 2026-10-13 in the core ledger: 26 `rmd approve` pushes since 2026-10-08 were refused by the plan-PR
 * preflight on [blocked-task-disposition], [call-site] and [proof-grep-already-true]. The draft and approve floors
 * linted a new task without the repo facts `lint-plan --base` passes (`blockedDisposition`, `moduleExists`,
 * `readGrepProofFile`, `baseAcceptance`), so those checks were silent until after an id was spent and the shards
 * were written. Here every floor lints a drafted task as the push floor does, the harness owns a new task's status,
 * and a draft is judged as approve's mechanical repair will leave it.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import * as inbox from "#src/lib/inbox.js";
import {
  anchorFingerprint,
  classifyProposal,
  lintDraftedFragment,
  proposalsNeedingDraft,
  relintRatificationFragment,
  runDraftRung,
  type DraftedCandidate,
  type DraftRepoFacts,
  type Proposal,
  type ReadinessContext,
} from "#src/lib/inbox.js";
import { loadPlanFromYaml, type Plan } from "#src/lib/plan.js";
import { relintGuidanceLines } from "#src/lib/relint.js";
import type { WorkerResult } from "#src/lib/worker.js";

const KNOWN = new Set(["remudero", "none"]);
const PROPOSAL_ID = "followup:W1-T5060-1790000000000";
/** W1-T9327: the drafts are sized under their title slug, so the test they name is their own falsifier, not another concern's. */
const OWN_TEST = "test/name-the-actor-on-every-ledger-row-the-panel-renders.test.ts";

// A fixture checkout: one existing src module (holding the symbol an already-true grep finds), a caller, and test/.
const ROOT = mkdtempSync(join(tmpdir(), "rmd-w1-t9039-"));
mkdirSync(join(ROOT, "src", "lib"), { recursive: true });
mkdirSync(join(ROOT, "test"), { recursive: true });
writeFileSync(join(ROOT, "src", "lib", "ledger.ts"), "export function rowActorOf(row: unknown): string {\n  return String(row);\n}\n");
writeFileSync(join(ROOT, "src", "lib", "panel.ts"), "import { rowActorOf } from './ledger.js';\nrowActorOf(1);\n");
writeFileSync(join(ROOT, OWN_TEST), "// fixture\n");
after(() => rmSync(ROOT, { recursive: true, force: true }));

const facts: DraftRepoFacts = {
  moduleExists: (path) => existsSync(join(ROOT, path)),
  readGrepProofFile: (path) => (existsSync(join(ROOT, path)) ? readFileSync(join(ROOT, path), "utf8") : undefined),
};

interface DraftShape {
  id?: string;
  status?: string;
  extra?: string[];
  risk?: string;
  files: string[];
  proofs: Array<[claim: string, proof: string]>;
}

function draft(shape: DraftShape): string {
  return [
    `- id: ${shape.id ?? "NEW-1"}`,
    '  title: "Name the actor on every ledger row the panel renders"',
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    "  verify: auto",
    `  risk: ${shape.risk ?? "medium"}`,
    `  status: ${shape.status ?? "queued"}`,
    ...(shape.extra ?? []),
    "  attempts: 0",
    "  files:",
    ...shape.files.map((f) => `    - ${f}`),
    "  acceptance:",
    ...shape.proofs.flatMap(([claim, proof]) => [`    - claim: ${JSON.stringify(claim)}`, `      proof: ${JSON.stringify(proof)}`]),
    '  origin: "architect"',
    "",
  ].join("\n");
}

/** The ledgerRowActor proposal's cached draft: a NEW module whose only call proof greps the new file itself. */
const UNCALLED_MODULE = draft({
  extra: ["  design: |", "    CREATES: src/lib/ledgerCaller.ts"],
  files: ["src/lib/ledgerCaller.ts", OWN_TEST],
  proofs: [
    ["the caller names the actor", "unit test: the caller names the actor on a ledger row"],
    ["the caller is called", "grep: ledgerCaller( in src/lib/ledgerCaller.ts"],
  ],
});
const CALLED_MODULE = draft({
  risk: "high",
  extra: ["  band_meaning: span", "  design: |", "    CREATES: src/lib/ledgerCaller.ts"],
  files: ["src/lib/ledgerCaller.ts", "src/lib/panel.ts", OWN_TEST],
  proofs: [
    ["the caller names the actor", "unit test: the caller names the actor on a ledger row"],
    ["the caller is called", "grep: ledgerCaller( in src/lib/panel.ts"],
  ],
});

/** A grep proof whose pattern is already on the checkout, so proof-discrimination can never grade it green. */
const ALREADY_TRUE = draft({
  files: ["src/lib/ledger.ts", OWN_TEST],
  proofs: [
    ["the actor is named", "unit test: the actor is named on a ledger row"],
    ["the row names its actor", "grep: rowActorOf( in src/lib/ledger.ts"],
  ],
});
const NOT_YET_TRUE = ALREADY_TRUE.replace("grep: rowActorOf( in src/lib/ledger.ts", "grep: rowActorOfName( in src/lib/ledger.ts");

/** W1-T5060's shape: the drafter copied `status: blocked` from the plan index, and declared no retirement. */
const BLOCKED = draft({
  status: "blocked",
  files: ["src/lib/ledger.ts", OWN_TEST],
  proofs: [["the actor is named", "unit test: the actor is named on a ledger row"]],
});

function checks(violations: ReadonlyArray<{ check: string; severity: string }>): string[] {
  return [...new Set(violations.filter((v) => v.severity === "block").map((v) => v.check))].sort();
}

function worker(text: string): WorkerResult {
  return {
    sessionId: "S-1", costUsd: 0, numTurns: 1, text, blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
    permissionDenials: [], childEnvKeys: [], model: "m", routedModel: "m", effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
}

const BASE_PLAN = loadPlanFromYaml("- id: W1-T1\n  title: \"base\"\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  risk: low\n  status: queued\n  attempts: 0\n  origin: architect\n", "fixture");
const proposal: Proposal = { id: PROPOSAL_ID, summary: "name the ledger row actor", evidenceAnchors: [] };

function ctx(): ReadinessContext {
  return {
    clock: fixedClock(Date.parse("2026-10-13T12:00:00Z")),
    plan: BASE_PLAN as Plan,
    isMerged: () => false,
    grepAnchorTrue: () => true,
    openProposalIds: new Set(),
    isRatified: () => false,
    draftRepoFacts: facts,
  };
}

function stored(fragmentYaml: string): DraftedCandidate {
  return {
    proposalId: PROPOSAL_ID,
    fragmentYaml,
    stampLine: `- ${PROPOSAL_ID} (name the ledger row actor) — RATIFIED 2026-10-13 -> NEW-1.`,
    anchorFingerprint: anchorFingerprint([]),
  };
}

test("W1-T9039: the draft lint blocks a new module with no call site", () => {
  const violations = lintDraftedFragment(UNCALLED_MODULE, PROPOSAL_ID, undefined, KNOWN, facts.moduleExists, facts.readGrepProofFile);
  assert.deepEqual(checks(violations), ["call-site", "draft-call-site-absent"], JSON.stringify(violations));
  assert.match(violations.find((v) => v.check === "call-site")!.message, /new module src\/lib\/ledgerCaller\.ts/);
  assert.match(violations.find((v) => v.check === "draft-call-site-absent")!.message, /ledgerCaller\.ts.*CREATES/);
  assert.deepEqual(lintDraftedFragment(CALLED_MODULE, PROPOSAL_ID, undefined, KNOWN, facts.moduleExists, facts.readGrepProofFile), [],
    "control: a call proof in a different src file clears it");
  // The production default resolves the same facts against the harness checkout, where ledgerCaller.ts is absent too.
  assert.ok(checks(lintDraftedFragment(UNCALLED_MODULE, PROPOSAL_ID, undefined, KNOWN)).includes("call-site"));
});

test("W1-T9039: the draft lint blocks a grep proof that already matches", () => {
  const violations = lintDraftedFragment(ALREADY_TRUE, PROPOSAL_ID, undefined, KNOWN, facts.moduleExists, facts.readGrepProofFile);
  assert.deepEqual(checks(violations), ["proof-grep-already-true"], JSON.stringify(violations));
  assert.deepEqual(lintDraftedFragment(NOT_YET_TRUE, PROPOSAL_ID, undefined, KNOWN, facts.moduleExists, facts.readGrepProofFile), [],
    "control: a grep for text the change adds is not already true");
  // The production facts read the same checkout, and an absent file is no opinion.
  const checkout = inbox.checkoutRepoFacts(ROOT);
  assert.deepEqual(lintDraftedFragment(ALREADY_TRUE, PROPOSAL_ID, undefined, KNOWN, checkout.moduleExists, checkout.readGrepProofFile), violations);
  assert.equal(checkout.readGrepProofFile("src/lib/absent.ts"), undefined);
  // The redraft carries guidance for the new check, so the drafter can act on it.
  const guidance = relintGuidanceLines(violations).join("\n");
  assert.match(guidance, /For a \[proof-grep-already-true\] violation/);
  assert.match(guidance, /grep for text the change ADDS/);
});

test("W1-T9039: a drafted blocked task is cached queued", async () => {
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const spawned: string[] = [];
  const stamp = "STAMP: name the ledger row actor";
  const [outcome] = await runDraftRung([proposal], "- id: W1-T1\n", {
    clock: fixedClock(Date.parse("2026-10-13T12:00:00Z")),
    spawn: async (_p, prompt) => {
      spawned.push(prompt);
      return worker(`=== FRAGMENT START ===\n${BLOCKED}=== FRAGMENT END ===\n${stamp}`);
    },
    log: (step, extra) => events.push({ step, extra }),
    repoFacts: facts,
  }, "run-9039");
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(spawned.length, 1, "the harness owns the field, so no redraft is spent on it");
  const cached = outcome.ok ? outcome.candidate.fragmentYaml : "";
  assert.match(cached, /^ {2}status: queued$/m);
  assert.doesNotMatch(cached, /status: blocked/);
  assert.equal(events.find((e) => e.step === "inbox.drafted")?.extra?.lint_clean, true);
  assert.deepEqual(lintDraftedFragment(cached, PROPOSAL_ID, undefined, KNOWN, facts.moduleExists, facts.readGrepProofFile), []);

  // A drafted task that declares a legal retirement is the author's, byte for byte.
  const retired = BLOCKED.replace("  status: blocked\n", "  status: blocked\n  retirement: withdrawn\n");
  const [kept] = await runDraftRung([proposal], "- id: W1-T1\n", {
    spawn: async () => worker(`=== FRAGMENT START ===\n${retired}=== FRAGMENT END ===\n${stamp}`),
    log: () => undefined,
    repoFacts: facts,
  }, "run-9039b");
  assert.equal(kept.ok ? kept.candidate.fragmentYaml : "", retired.trimEnd());
});

test("W1-T9039: a stored blocked draft becomes ready without a redraft", () => {
  const draftCache = { [PROPOSAL_ID]: stored(BLOCKED) };
  assert.deepEqual(proposalsNeedingDraft([proposal], draftCache), [], "a current cached draft is never re-drafted");
  const result = classifyProposal(proposal, draftCache[PROPOSAL_ID], ctx());
  assert.equal(result.state, "ready", JSON.stringify(result.reasons));
  assert.match(result.draft?.fragmentYaml ?? "", /^ {2}status: queued$/m, "the draft READY hands approve is the one it files");

  // Control: the same floor holds a stored draft the push would refuse, and names why.
  const held = classifyProposal(proposal, stored(UNCALLED_MODULE), ctx());
  assert.equal(held.state, "not_ready");
  assert.match(held.reasons.map((r) => r.detail).join("; "), /\[call-site\]/);
});

test("W1-T9039: a draft the approve repair fixes is not held not ready", () => {
  const wide = draft({
    risk: "low",
    files: ["src/lib/ledger.ts", "src/lib/panel.ts", OWN_TEST],
    proofs: [["the actor is named", "unit test: the actor is named on a ledger row"]],
  });
  assert.ok(lintDraftedFragment(wide, PROPOSAL_ID, undefined, KNOWN, facts.moduleExists, facts.readGrepProofFile)
    .some((v) => v.check === "sizing"), "precondition: the raw draft is dirty on Rule 19 sizing alone");
  const result = classifyProposal(proposal, stored(wide), ctx());
  assert.equal(result.state, "ready", JSON.stringify(result.reasons));
  assert.match(result.draft?.fragmentYaml ?? "", /^ {2}risk: high\n {2}band_meaning: span$/m, "judged as approve's repair leaves it");
});

test("W1-T9039: the approve relint applies the draft floor repo facts", () => {
  for (const [fragment, check] of [[UNCALLED_MODULE, "call-site"], [ALREADY_TRUE, "proof-grep-already-true"]] as const) {
    const relinted = relintRatificationFragment(fragment, PROPOSAL_ID, facts);
    assert.equal(relinted.ok, false, `${check}: approve must refuse what the push floor refuses`);
    assert.match(relinted.ok ? "" : relinted.reason, new RegExp(`\\[${check}\\]`));
    assert.deepEqual(checks(lintDraftedFragment(fragment, PROPOSAL_ID, undefined, KNOWN, facts.moduleExists, facts.readGrepProofFile)),
      check === "call-site" ? ["call-site", "draft-call-site-absent"] : [check],
      "the draft floor refuses the same thing");
  }
  const healed = relintRatificationFragment(BLOCKED, PROPOSAL_ID, facts);
  assert.deepEqual(healed, { ok: true, fragmentYaml: BLOCKED.replace("status: blocked", "status: queued") }, "only the status changes");
  const retired = BLOCKED.replace("  status: blocked\n", "  status: blocked\n  retirement: withdrawn\n");
  assert.deepEqual(relintRatificationFragment(retired, PROPOSAL_ID, facts), { ok: true, fragmentYaml: retired });
  assert.deepEqual(relintRatificationFragment(CALLED_MODULE, PROPOSAL_ID, facts), { ok: true, fragmentYaml: CALLED_MODULE });
  // The approve gate resolves the same facts in the worktree it files into.
  const stamp = stored(UNCALLED_MODULE).stampLine;
  assert.throws(() => inbox.assertRatificationDraftFileable(UNCALLED_MODULE, PROPOSAL_ID, stamp, KNOWN, ROOT), /\[call-site\]/);
  assert.doesNotThrow(() => inbox.assertRatificationDraftFileable(CALLED_MODULE, PROPOSAL_ID, stamp, KNOWN, ROOT));
  // A repair that leaves YAML the parser refuses is a draft-parse refusal, never a filing.
  const flow = "- {id: NEW-1, title: t, repo: remudero, depends_on: [], type: implement, verify: auto, risk: high, status: queued, " +
    "attempts: 0, files: [src/lib/ledger.ts], acceptance: [{claim: c, proof: \"unit test: c holds\"}], origin: architect}\n";
  const broken = relintRatificationFragment(flow, PROPOSAL_ID, facts);
  assert.match(broken.ok ? "" : broken.reason, /^draft-parse: /);
});
