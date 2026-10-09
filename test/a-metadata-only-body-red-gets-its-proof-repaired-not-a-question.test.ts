import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

import { gitRepo } from "./helpers/git-repo.js";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import {
  proofAmendmentIneligibleReason,
  requestProofAmendment,
  type ProofAmendmentPrState,
  type ProofAmendmentWritePorts,
} from "../src/lib/proof-amendment.js";
import { deriveFixMode } from "../src/lib/prompt-render.js";
import { wrappedGrepPattern } from "../src/lib/review.js";
import {
  proofRepairLadder,
  proofRepairRouteEvidence,
  runSweep,
  type CiFailure,
  type FixDispatchEvidence,
  type OpenPrView,
  type ProofDiscriminationEvidence,
  type SweepDeps,
} from "./helpers/sweep-test.js";
import type { Config } from "../src/lib/config.js";
import type { Mount } from "../src/lib/mounts.js";
import {
  acceptanceGateBodyRepair,
  buildFixRungDispatchArgs,
  PROOF_REPAIR_FIX_MODE_RULES,
  planCriteriaAtHeadForRepair,
  proofRepairPromptLines,
  proofRepairRefusal,
  proofRepairRoundRefusalInWorktree,
  proofRepairStageablePaths,
  repairPrMetadata,
  runFixRung,
  trailerBodyDivergenceRepair,
  wrappedGrepBodyRepair,
} from "./helpers/run-task-test.js";

const authorGate = (await import(pathToFileURL(join(fileURLToPath(new URL(".", import.meta.url)), "..", "scripts", "acceptance-author-gate.mjs")).href)) as {
  trailerBodyProofDivergenceRefusal: (input: {
    body: string;
    taskAcceptanceForId?: (taskId: string) => readonly { claim: string; proof: string }[] | undefined;
  }) => { defect?: string } | undefined;
};

const TASK = "W1-T5544-FIXTURE";
const PR_URL = "https://github.com/acme/remudero/pull/8866";
const HEAD = "5544aaaa";
const NOW = Date.parse("2026-10-04T06:00:00Z");
const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 20_000 };
const FLEET = "remudero-fleet[bot]";

const PLAN: AcceptanceCriterion[] = [
  { claim: "the cure rewrites the block", proof: "grep: export function trailerBodyDivergenceRepair in src/run-task.ts" },
  { claim: "the renamed test carries the claim", proof: "unit test: a renamed test title carrying the claim in test/x.test.ts" },
];
const STALE_PROOF = PLAN[1]!.proof;

const DIVERGED_BODY = [
  "This PR records the new state.",
  "",
  "## Acceptance",
  "",
  "- claim: something the author wrote by hand",
  "  proof: grep: nothing at all in src/other.ts",
  "",
  `Remudero-Task: ${TASK}`,
  "",
].join("\n");

const STALE_LOG = [
  "2026-10-04T05:00:00.0000000Z proof-discrimination: FAIL — 1 proof(s) pass at both PR head and merge base (abc123):",
  `2026-10-04T05:00:00.0000000Z   proof: ${STALE_PROOF}`,
  "2026-10-04T05:00:00.0000000Z   head hits: 1; base hits: 1",
  "2026-10-04T05:00:00.0000000Z Remedy: replace each stale proof with one that names behavior this PR changes, then rerun this check.",
].join("\n");

function failure(name: string, logTail: string): CiFailure {
  return { name, logTail, conclusion: "FAILURE" };
}

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 8866,
    prUrl: PR_URL,
    taskId: TASK,
    body: `Remudero-Task: ${TASK}\n`,
    reviewState: "pending",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-10-04T05:30:00.000Z", // expiring-fixture: exempt -- compared only against this suite's INJECTED now (NOW), never the wall clock
    headSha: HEAD,
    autoMergeArmed: false,
    redRequiredChecks: ["proof-discrimination"],
    ciFailures: [failure("proof-discrimination", STALE_LOG)],
    changedFiles: ["src/lib/views.ts", "test/views.test.ts"],
    ...over,
  };
}

interface Observed {
  fixed: FixDispatchEvidence[];
  escalated: string[];
  planFlags: number;
  ledgerPath: string;
}

function ledgerWith(rows: Array<Record<string, unknown>>): string {
  const path = join(mkdtempSync(join(tmpdir(), "rmd-proof-repair-")), "ledger.ndjson");
  writeFileSync(path, rows.map((row) => `${JSON.stringify({ ts: "2026-10-04T05:40:00.000Z", ...row })}\n`).join(""));
  return path;
}

async function sweep(view: OpenPrView, extra: Partial<SweepDeps> = {}, rows: Array<Record<string, unknown>> = []): Promise<Observed> {
  const observed: Observed = { fixed: [], escalated: [], planFlags: 0, ledgerPath: ledgerWith(rows) };
  await runSweep([view], {
    arm: () => "armed",
    close: () => {},
    dispatchFix: (_pr, evidence) => {
      observed.fixed.push(evidence);
    },
    escalate: (_pr, reason) => {
      observed.escalated.push(reason);
    },
    repairMetadata: () => ({ repaired: false, noCure: true, reason: "the body red has no deterministic acceptance repair; scope or proof amendment is required" }),
    readPlanRepairFacts: () => ({ authorLogin: FLEET }),
    ledgerPath: observed.ledgerPath,
    runId: "SWEEP-W1-T5544",
    now: () => NOW,
    ...extra,
  });
  return observed;
}

function refusedRound(id: string): Array<Record<string, unknown>> {
  return [
    { task_id: TASK, step: "fix.dispatch", round_id: id, strike: 1, head_sha: HEAD },
    { task_id: TASK, step: "fix.commit_refused", round_id: id, strike: 1, head_sha: HEAD, reason: "proof-repair round committed no test edit — nothing was pushed" },
  ];
}

test("W1-T5544: a diverged or wrapped body is cured deterministically", async () => {
  // Divergence: the body names proofs the plan does not. The cure renders the plan's criteria, and the gate's OWN
  // refusal predicate agrees (it refused the original, it passes the repaired body).
  const taskAcceptanceForId = () => PLAN;
  assert.equal(authorGate.trailerBodyProofDivergenceRefusal({ body: DIVERGED_BODY, taskAcceptanceForId })?.defect, "trailer-body-proof-divergence");
  const cured = trailerBodyDivergenceRepair(DIVERGED_BODY, PLAN);
  assert.equal(cured?.defect, "trailer-body-proof-divergence");
  assert.equal(authorGate.trailerBodyProofDivergenceRefusal({ body: cured!.repairedBody, taskAcceptanceForId }), undefined);
  assert.match(cured!.repairedBody, /This PR records the new state\./, "the author's prose survives");
  assert.match(cured!.repairedBody, /Remudero-Task: W1-T5544-FIXTURE\n$/, "the trailer is re-appended last");
  assert.equal(trailerBodyDivergenceRepair(cured!.repairedBody, PLAN), undefined, "an equal block is left alone");
  assert.equal(trailerBodyDivergenceRepair(DIVERGED_BODY.replace(/Remudero-Task:.*\n/, ""), PLAN), undefined, "no trailer, no cure");
  assert.equal(trailerBodyDivergenceRepair(DIVERGED_BODY, []), undefined, "a task with no criteria at head is never guessed");
  assert.equal(
    trailerBodyDivergenceRepair(DIVERGED_BODY, [{ claim: "credited earlier", proof: "", satisfied_by: "#1" }]),
    undefined,
    "a satisfied_by row carries no proof text, so there is nothing to render",
  );

  // Wrapped grep patterns: backticks and quotes both unwrap to the bare pattern, and nothing else changes.
  const wrapped = (proof: string) => `Body.\n\n## Acceptance\n\n- claim: the pattern is bare\n  proof: ${proof}\n`;
  for (const proof of ["grep: `export function cure` in src/run-task.ts", 'grep: "export function cure" in src/run-task.ts']) {
    const repaired = wrappedGrepBodyRepair(wrapped(proof));
    assert.equal(repaired?.defect, "proof-shape");
    assert.equal(repaired?.repairedBody, wrapped("grep: export function cure in src/run-task.ts"));
    assert.equal(wrappedGrepPattern("grep: export function cure in src/run-task.ts"), undefined);
  }
  assert.equal(wrappedGrepBodyRepair(wrapped("grep: export function cure in src/run-task.ts")), undefined, "an unwrapped body has nothing to cure");
  assert.equal(wrappedGrepBodyRepair(wrapped("just run the suite and see")), undefined, "an unparseable proof is not a wrapping defect");
  assert.equal(
    wrappedGrepBodyRepair(`${wrapped("grep: `a` in src/run-task.ts")}- claim: second\n  proof: run it by hand\n`),
    undefined,
    "wrapping fixed beside an unparseable proof is NOT a wrapping-only cause",
  );

  // Through acceptanceGateBodyRepair: only when the gate-refusal cures are offered, so every old caller is unchanged.
  assert.equal(acceptanceGateBodyRepair(DIVERGED_BODY), undefined);
  assert.equal(acceptanceGateBodyRepair(DIVERGED_BODY, undefined, { planCriteria: PLAN })?.defect, "trailer-body-proof-divergence");

  // End to end through repairPrMetadata: no worker, no title edit, one body write — and a body red the gate does not
  // own (proof-discrimination alone) is never cured by rewriting a body that gate does not read.
  const writes: Array<{ title?: string; body?: string }> = [];
  const metadata = (checks: string[]) =>
    repairPrMetadata(
      { prUrl: PR_URL, headSha: HEAD },
      checks,
      (_url, fields) => {
        writes.push(fields);
      },
      () => ({ title: "fix(views): record the new state", body: DIVERGED_BODY }),
      (body, headSha) => {
        assert.equal(headSha, HEAD);
        assert.match(body, /Remudero-Task: W1-T5544-FIXTURE/);
        return PLAN;
      },
    );
  const repaired = await metadata(["acceptance-author-gate"]);
  assert.equal(repaired.repaired, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.title, undefined);
  assert.equal(writes[0]!.body, cured!.repairedBody);
  const uncured = await metadata(["proof-discrimination"]);
  assert.deepEqual([uncured.repaired, uncured.noCure], [false, true]);
  assert.equal(writes.length, 1, "no write for a red the body cannot cure");
});

test("W1-T5544: metadata repair unwraps grep when the plan proofs already match", async () => {
  for (const proof of ['grep: "export function cure" in src/run-task.ts', "grep: `export function cure` in src/run-task.ts"]) {
    const body = `## Acceptance\n\n- claim: the pattern is bare\n  proof: ${proof}\n\nRemudero-Task: ${TASK}\n`;
    const expectedBody = body.replace(proof, "grep: export function cure in src/run-task.ts");
    const planCriteria = [{ claim: "the pattern is bare", proof }];
    assert.equal(authorGate.trailerBodyProofDivergenceRefusal({ body, taskAcceptanceForId: () => planCriteria }), undefined);
    for (const cures of [{}, { planCriteria }]) {
      assert.deepEqual(acceptanceGateBodyRepair(body, undefined, cures), {
        defect: "proof-shape",
        repairedBody: expectedBody,
      });
    }

    const writes: Array<{ title?: string; body?: string }> = [];
    const repaired = await repairPrMetadata(
      { prUrl: PR_URL, headSha: HEAD },
      ["acceptance-author-gate"],
      (_url, fields) => { writes.push(fields); },
      () => ({ title: "fix(views): record the new state", body }),
      (_body, headSha) => {
        assert.equal(headSha, HEAD);
        return planCriteria;
      },
    );
    assert.equal(repaired.repaired, true);
    assert.deepEqual(writes, [{ body: expectedBody }]);
  }
});

test("W1-T5544: a stale-proof metadata red is routed past the escalation", async () => {
  // Today's path: a proof-discrimination-only red with no deterministic cure escalates and breaks. Now it dispatches a
  // proof-repair round carrying the gate-log evidence, with no ci-log shape and no escalation.
  const routed = await sweep(pr());
  assert.deepEqual(routed.escalated, [], "no per-PR question is opened");
  assert.equal(routed.fixed.length, 1);
  const evidence = routed.fixed[0]!;
  assert.equal(evidence.ciFailures, undefined, "the round is not a ci-log round");
  assert.equal(evidence.proofDiscrimination?.source, "gate-log");
  assert.deepEqual(evidence.proofDiscrimination?.proofs.map((p) => p.proof), [STALE_PROOF]);
  assert.equal(
    deriveFixMode({ proofDiscrimination: evidence.proofDiscrimination }, PROOF_REPAIR_FIX_MODE_RULES),
    "proof-repair",
    "gate-log evidence selects the proof-repair mode",
  );
  assert.equal(
    deriveFixMode({ proofDiscrimination: { proofs: evidence.proofDiscrimination!.proofs } }, PROOF_REPAIR_FIX_MODE_RULES),
    "proof-discrimination",
    "a capped green review's evidence keeps its own mode",
  );

  // Every other uncured metadata red keeps today's escalation.
  const operator = await sweep(pr(), { readPlanRepairFacts: () => ({ authorLogin: "craigoley" }) });
  assert.equal(operator.fixed.length, 0, "an operator's PR is never handed a worker");
  assert.equal(operator.escalated.length, 1);
  assert.match(operator.escalated[0]!, /metadata-only required checks proof-discrimination need title\/body repair/);
  const unreadableAuthor = await sweep(pr(), { readPlanRepairFacts: () => { throw new Error("gh down"); } });
  assert.deepEqual([unreadableAuthor.fixed.length, unreadableAuthor.escalated.length], [0, 1], "an unreadable author is not a fleet author");
  const unwired = await sweep(pr(), { readPlanRepairFacts: undefined });
  assert.deepEqual([unwired.fixed.length, unwired.escalated.length], [0, 1]);
  const notACure = await sweep(pr(), { repairMetadata: () => ({ repaired: false, reason: "live PR body is unavailable" }) });
  assert.deepEqual([notACure.fixed.length, notACure.escalated.length], [0, 1], "only 'no deterministic cure' routes; a failed read still escalates");
  const noEvidence = await sweep(pr({ ciFailures: [failure("proof-discrimination", "proof-discrimination: REFUSED — could not run")] }));
  assert.deepEqual([noEvidence.fixed.length, noEvidence.escalated.length], [0, 1], "no stale-proof evidence, no route");
  assert.equal(proofRepairRouteEvidence(pr({ body: "no trailer here\n" })), undefined, "an untrailered PR carries no plan proof to repair");

  // THE LADDER: refused twice at this head -> W1-T4943's plan-shard flag -> the exhausted escalation. No strike anywhere.
  const twice = [...refusedRound("r1"), ...refusedRound("r2")];
  assert.equal(proofRepairLadder(pr(), twice).refusals, 2);
  let flagged = 0;
  // The view carries `repeatedFixRefusal` exactly as buildOpenPrViews derives it from the same two rows; without the
  // W1-T5544 override that would read as strike exhaustion and skip rung two.
  const repeated = pr({ repeatedFixRefusal: "proof-repair round committed no test edit — nothing was pushed", fixRefusalsAtHead: 2 });
  const flag = await sweep(repeated, { dispatchPlanOnlyRepair: () => { flagged++; return true; } }, twice);
  assert.deepEqual([flag.fixed.length, flag.escalated.length, flagged], [0, 0, 1], "rung two: the plan-shard flag, not a third round");
  const exhausted = await sweep(repeated, {}, twice);
  assert.equal(exhausted.fixed.length, 0);
  assert.equal(exhausted.escalated.length, 1, "rung three: the exhausted state escalates once");
  assert.match(exhausted.escalated[0]!, /refused twice at this head/, "named for what happened, by the strike ladder's own exhausted state");
  const once = await sweep(pr(), {}, refusedRound("r1"));
  assert.equal(once.fixed.length, 1, "one refusal still earns the second round");

  // A proof amendment already filed for this exact head stands the PR down: no round, no flag, no strike.
  const key = `${TASK}:8866:${HEAD}:digest`;
  const filed = [{ task_id: TASK, step: "fix.dispatch", kind: "proof_amendment", pr_number: 8866, identity_key: key, amendment_url: "https://github.com/acme/remudero/pull/9100", amendment_number: 9100 }];
  const standing = await sweep(pr(), { dispatchPlanOnlyRepair: () => { flagged++; return true; } }, filed);
  assert.deepEqual([standing.fixed.length, standing.escalated.length, flagged], [0, 0, 1], "the amendment holds the PR; the flag count is unchanged");
  assert.equal(proofRepairLadder(pr(), filed).amendmentUrl, "https://github.com/acme/remudero/pull/9100");
  assert.equal(proofRepairLadder(pr({ headSha: "5544bbbb" }), filed).amendmentUrl, undefined, "a new head is a new identity");
});

test("W1-T5544: the repair round stages only test files and pushes only discriminating proofs", () => {
  assert.deepEqual(
    proofRepairStageablePaths(["src/lib/views.ts", "test/views.test.ts", "plan/tasks.d/x.yaml"], ["src/run-task.ts", "test/new.test.ts", "test/views.test.ts"]),
    ["test/new.test.ts", "test/views.test.ts"],
    "the PR's test paths plus the task's declared test paths — never a src or plan path",
  );
  const stageable = ["test/views.test.ts"];
  const proofs = ["unit test: a", "grep: b in src/x.ts"];
  const status = (map: Record<string, number | null>) => (proof: string) => map[proof] ?? null;
  const base = { stageable, proofs };

  assert.match(proofRepairRefusal({ ...base, changedFiles: [], checkProofStatus: status({}) })!.reason, /committed no test edit/);
  const src = proofRepairRefusal({ ...base, changedFiles: ["test/views.test.ts", "src/lib/views.ts"], checkProofStatus: status({}) });
  assert.deepEqual(src?.undeclared, ["src/lib/views.ts"], "a src path is refused by name, whatever the proofs say");
  assert.match(src!.reason, /outside the PR's test files/);
  assert.match(
    proofRepairRefusal({ ...base, changedFiles: stageable, checkProofStatus: status({ "unit test: a": 0, "grep: b in src/x.ts": 5 }) })!.reason,
    /grep: b in src\/x\.ts` still passes at the merge base/,
  );
  assert.match(proofRepairRefusal({ ...base, changedFiles: stageable, checkProofStatus: status({ "unit test: a": 1 }) })!.reason, /does not pass at the PR head/);
  assert.match(proofRepairRefusal({ ...base, changedFiles: stageable, checkProofStatus: status({ "unit test: a": 3 }) })!.reason, /names no test or line/);
  assert.match(proofRepairRefusal({ ...base, changedFiles: stageable, checkProofStatus: status({ "unit test: a": null }) })!.reason, /inconclusive/);
  assert.equal(
    proofRepairRefusal({ ...base, changedFiles: stageable, checkProofStatus: status({ "unit test: a": 0, "grep: b in src/x.ts": 0 }) }),
    undefined,
    "every proof passes at head and fails at base: the round may push",
  );

  // The same gate over a REAL worktree: a round that staged a src path, and a round that staged nothing, are refused
  // from git alone — before any proof is run.
  const fixture = gitRepo({ seedCommit: false, kind: "proof-repair-git" });
  const repo = fixture.dir;
  const git = fixture.git;
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, "test"));
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "test", "views.test.ts"), "// base\n");
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "base");
  const start = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", start);
  const worktreeInput = { worktreePath: repo, roundStartSha: start, stageable, proofs };
  assert.match(proofRepairRoundRefusalInWorktree(worktreeInput)!.reason, /committed no test edit/);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "touch src");
  assert.deepEqual(proofRepairRoundRefusalInWorktree(worktreeInput)?.undeclared, ["src/a.ts"]);
  assert.match(proofRepairRoundRefusalInWorktree({ ...worktreeInput, roundStartSha: undefined })!.reason, /could not be read from git/);

  // The dispatch carries the plan's own claim for a gate-log proof, so a rename names the claim's words.
  const evidence: ProofDiscriminationEvidence = {
    source: "gate-log",
    proofs: [{ claim: STALE_PROOF, proof: STALE_PROOF, proofExec: "executed_stale" }],
  };
  const args = buildFixRungDispatchArgs({
    task: { id: TASK, title: "Stale proof fixture", acceptance: PLAN },
    runId: "W1-T5544-RUN",
    prUrl: PR_URL,
    branch: "run-W1-T5544",
    worktreePath: process.cwd(),
    mount: MOUNT,
    settingsFile: "/tmp/rmd-proof-repair-settings.json",
    config: {} as Config,
    budgetUsd: 1,
    strikeCap: 2,
    evidence: { unmetCriteria: [], proofDiscrimination: evidence },
    pr: { headSha: HEAD },
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: process.cwd(), reviewerMount: MOUNT },
  });
  assert.equal(args.ciFailures, undefined);
  assert.equal(args.proofDiscrimination?.source, "gate-log");
  assert.equal(args.proofDiscrimination?.proofs[0]?.claim, "the renamed test carries the claim");
  const prompt = proofRepairPromptLines({ proofs: args.proofDiscrimination!.proofs, stageable }).join("\n");
  assert.match(prompt, /You MAY edit ONLY these test paths: test\/views\.test\.ts/);
  assert.match(prompt, /REFUSED \(a refusal, not a strike\)/);
  assert.match(proofRepairPromptLines({ proofs: evidence.proofs, stageable: [] }).join("\n"), /make NO file edit/);
});

test("W1-T5544: gate-log evidence makes a proof-only amendment eligible", () => {
  const prState: ProofAmendmentPrState = { isOpen: true, planOnly: false, taskId: TASK, criteria: [] };
  const claim = PLAN[1]!.claim;
  const gateLog: ProofDiscriminationEvidence = {
    source: "gate-log",
    proofs: [{ claim, proof: STALE_PROOF, proofExec: "executed_stale" }],
  };
  assert.equal(proofAmendmentIneligibleReason(prState, gateLog), undefined, "no success review is needed on gate-log evidence");
  assert.equal(
    proofAmendmentIneligibleReason(prState, { proofs: gateLog.proofs }),
    "review-not-success",
    "the same PR on review-sourced evidence still needs its success review",
  );
  assert.equal(proofAmendmentIneligibleReason(prState, { source: "gate-log", proofs: [] }), "no-evidence");
  assert.equal(proofAmendmentIneligibleReason({ ...prState, isOpen: false }, gateLog), "not-open", "the open/plan-only/trailer gates still run first");
  assert.equal(proofAmendmentIneligibleReason({ ...prState, planOnly: true }, gateLog), "plan-only-pr");
  assert.equal(proofAmendmentIneligibleReason({ ...prState, taskId: undefined }, gateLog), "no-task-trailer");

  const shardText = [
    `- id: ${TASK}`,
    "  acceptance:",
    `    - claim: ${claim}`,
    `      proof: ${STALE_PROOF}`,
    "",
  ].join("\n");
  const newProof = "grep: export function proofRepairRefusal in src/run-task.ts";
  const created: Array<{ title: string; body: string }> = [];
  let written: string | undefined;
  const ports: ProofAmendmentWritePorts = {
    repoDir: "/repo",
    findShard: () => ({ path: "plan/tasks.d/x.yaml", text: shardText }),
    worktreeAdd: () => {},
    worktreeRemove: () => {},
    writeFile: (_path, text) => {
      written = text;
    },
    gitAdd: () => {},
    gitCommit: () => "amendsha",
    gitPush: () => {},
    probeExisting: () => undefined,
    createPr: (opts) => {
      created.push({ title: opts.title, body: opts.body });
      return { prUrl: "https://github.com/acme/remudero/pull/9100", prNumber: 9100 };
    },
    worktreePathFor: () => "/wt",
    lookupIdentity: () => undefined,
    recordIdentity: () => {},
    updateBranch: () => ({ ok: true }),
  };
  const request = {
    taskId: TASK,
    prNumber: 8866,
    prUrl: PR_URL,
    pr: prState,
    evidence: gateLog,
    headSha: HEAD,
    currentHeadSha: HEAD,
    headCwd: "/head",
    baseCwd: "/base",
    execAtHead: () => "pass" as const,
    execAtBase: () => "fail" as const,
  };

  const outcome = requestProofAmendment({ ...request, proposal: [{ claim, oldProof: STALE_PROOF, newProof }] }, ports);
  assert.equal(outcome.kind, "created", "one proof-only plan PR is opened");
  assert.equal(created.length, 1);
  assert.equal(written, shardText.replace(STALE_PROOF, newProof), "exactly one proof scalar changed, nothing else in the shard");

  // Any other field edit is refused: a changed claim is not a row the gate log named, and a replacement that does not
  // discriminate (passes at the base) is refused before any write.
  const claimEdit = requestProofAmendment({ ...request, proposal: [{ claim: `${claim} (reworded)`, oldProof: STALE_PROOF, newProof }] }, ports);
  assert.deepEqual([claimEdit.kind, claimEdit.kind === "refused" ? claimEdit.reason : undefined], ["refused", "claim-not-recognised"]);
  const oldProofEdit = requestProofAmendment({ ...request, proposal: [{ claim, oldProof: "grep: something else in src/x.ts", newProof }] }, ports);
  assert.equal(oldProofEdit.kind === "refused" ? oldProofEdit.reason : undefined, "claim-not-recognised");
  const nonDiscriminating = requestProofAmendment(
    { ...request, execAtBase: () => "pass" as const, proposal: [{ claim, oldProof: STALE_PROOF, newProof }] },
    ports,
  );
  assert.equal(nonDiscriminating.kind === "refused" ? nonDiscriminating.reason : undefined, "not-discriminating");
  assert.equal(created.length, 1, "no refused proposal opened a second PR");

});

// ── the repair round through runFixRung itself ──────────────────────────────────────────────────────────────────

function seedProofRepairTree(): string {
  const fixture = gitRepo({ seedCommit: false, kind: "proof-repair-rung" });
  const repo = fixture.dir;
  const git = fixture.git;
  mkdirSync(join(repo, "test"));
  writeFileSync(join(repo, "test", "views.test.ts"), "// base\n");
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
  return repo;
}

async function proofRepairRung(refusal: { reason: string; undeclared: string[] } | undefined) {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const prompts: string[] = [];
  const pushes: string[] = [];
  const worktreePath = seedProofRepairTree();
  const outcome = await runFixRung({
    taskId: TASK,
    runId: `${TASK}-1791090003045`,
    task: { id: TASK, title: "stale proof fixture", acceptance: PLAN, files: ["src/lib/views.ts", "test/views.test.ts"] },
    prUrl: PR_URL,
    branch: `run-${TASK}-1791090003045`,
    worktreePath,
    initialSessionId: "",
    mount: MOUNT,
    settingsFile: "/tmp/rmd-proof-repair-rung-settings.json",
    config: {} as Config,
    budgetUsd: 5,
    strikeCap: 1,
    initialReview: {
      state: "failure",
      criteria: [{ claim: PLAN[1]!.claim, proof: STALE_PROOF, met: true, reason: "capped proof requires base discrimination", proof_exec: "executed_stale" }],
      testTheater: false,
      summary: "sweep-reconstructed capped review (1 proof(s) need discrimination)",
      floorDegraded: false,
      capped: true,
      keywordOnly: false,
      planOnly: false,
      headSha: HEAD,
      reviewerOutcome: "sweep-reconstructed",
    },
    proofDiscrimination: {
      source: "gate-log",
      proofs: [{ claim: PLAN[1]!.claim, proof: STALE_PROOF, proofExec: "executed_stale" }],
    },
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: worktreePath, reviewerMount: MOUNT },
    deps: {
      spawn: async (args) => {
        prompts.push(args.prompt);
        return {
          sessionId: "fix-session",
          costUsd: 0,
          numTurns: 1,
          text: "Renamed the test.\n\nCOMMIT_MESSAGE: test(views): name the claim\n",
          blocks: [],
          stderr: "",
          subtype: "success",
          isError: false,
          apiError: false,
          permissionDenials: [],
          childEnvKeys: [],
          model: "default",
          effort: "default",
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
          modelUsage: {},
          compactionEvents: [],
          qualitySuspect: false,
        };
      },
      proofRepairRoundRefusal: () => refusal,
      waitForCiGreen: async () => "red",
      fetchPrBody: async () => `Remudero-Task: ${TASK}`,
      runReview: async () => {
        throw new Error("no review is reachable while CI is red");
      },
      push: (_wt, branch) => {
        pushes.push(branch);
      },
      issues: { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], comment: () => {} },
      ledgerPath: join(mkdtempSync(join(tmpdir(), "rmd-proof-repair-rung-ledger-")), "ledger.ndjson"),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
    },
  });
  return { outcome, logs, prompts, pushes };
}

test("W1-T5544: the repair round stages only test files and pushes only discriminating proofs — through runFixRung", async () => {
  const refused = await proofRepairRung({ reason: "proof-repair round pushed nothing: proof `x` still passes at the merge base", undeclared: [] });
  assert.equal(refused.pushes.length, 0, "a refused proof-repair round never pushes");
  assert.equal(refused.outcome.outcome, "stood_down");
  assert.match(refused.prompts[0]!, /PROOF-REPAIR ROUND \(W1-T5544\)/);
  assert.match(refused.prompts[0]!, /You MAY edit ONLY these test paths: test\/views\.test\.ts\./, "src/lib/views.ts is declared but is not stageable");
  assert.equal(refused.logs.find((l) => l.step === "fix.dispatch")?.extra?.mode, "proof-repair");
  const row = refused.logs.find((l) => l.step === "fix.commit_refused");
  assert.match(String(row?.extra?.reason), /still passes at the merge base/, "the refusal is a ledgered commit refusal, which is never a strike");
  assert.equal(refused.logs.find((l) => l.step === "fix.dispatch")?.extra?.strike, 1);

  const accepted = await proofRepairRung(undefined);
  assert.equal(accepted.pushes.length, 1, "a round whose proofs pass at head and fail at base is pushed");
  assert.equal(accepted.logs.some((l) => l.step === "fix.commit_refused"), false);
});

test("W1-T5544: the worktree gate runs check-proof against the merge base, and the body cure reads the plan at head", () => {
  // A real child process per proof: the stub run-task answers 5 (stale at base) for a proof named `stale`, 0 otherwise. The
  // scratch repo gets this checkout's node_modules linked in AFTER its commits, so `--import tsx` resolves the loader the
  // real child uses without the link ever entering a commit.
  const fixture = gitRepo({ seedCommit: false, kind: "proof-repair-gate" });
  const repo = fixture.dir;
  try {
    const git = fixture.git;
    mkdirSync(join(repo, "src"));
    mkdirSync(join(repo, "test"));
    writeFileSync(join(repo, "src", "run-task.ts"), "process.exit(String(process.argv[3]).includes('stale') ? 5 : 0);\n");
    writeFileSync(join(repo, "test", "views.test.ts"), "// base\n");
    git("add", "-A");
    git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "base");
    const start = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", start);
    writeFileSync(join(repo, "test", "views.test.ts"), "// renamed\n");
    git("add", "-A");
    git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "rename");
    symlinkSync(join(process.cwd(), "node_modules"), join(repo, "node_modules"));
    const input = { worktreePath: repo, roundStartSha: start, stageable: ["test/views.test.ts"] };
    assert.equal(proofRepairRoundRefusalInWorktree({ ...input, proofs: ["unit test: discriminates"] }), undefined);
    const stale = proofRepairRoundRefusalInWorktree({ ...input, proofs: ["unit test: discriminates", "unit test: stale one"] });
    assert.match(stale!.reason, /unit test: stale one` still passes at the merge base/);

    // The body cure's plan read: an unreadable head is no cure (never a guessed plan); a readable head resolves the
    // task's real criteria through the same resolver the gate uses.
    assert.deepEqual(planCriteriaAtHeadForRepair(`Remudero-Task: ${TASK}`, "0123456789abcdef0123456789abcdef01234567", repo), []);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const real = planCriteriaAtHeadForRepair("Remudero-Task: W1-T5544", head);
    assert.ok(real.length > 0 && real.every((c) => c.proof.length > 0), "W1-T5544's own criteria resolve at this checkout's head");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("W1-T5544: the body repair uses the last anchored trailer and the supplied head contract", () => {
  const fixture = gitRepo({ kind: "metadata-repair-contract" });
  const planPath = join(fixture.dir, "plan", "tasks.yaml");
  const writePlan = (acceptance: AcceptanceCriterion[]) => writeFileSync(planPath, JSON.stringify([
    { id: TASK, title: "fixture", repo: "remudero", type: "implement", acceptance },
  ]));
  try {
    mkdirSync(join(fixture.dir, "plan", "tasks.d"), { recursive: true });
    writePlan(PLAN);
    fixture.git("add", "plan/tasks.yaml");
    fixture.git("commit", "-q", "-m", "original contract");
    const originalHead = fixture.git("rev-parse", "HEAD");
    const currentPlan = [{ claim: "the current contract", proof: "unit test: current contract" }];
    writePlan(currentPlan);
    fixture.git("add", "plan/tasks.yaml");
    fixture.git("commit", "-q", "-m", "current contract");
    const currentHead = fixture.git("rev-parse", "HEAD");
    writePlan([{ claim: "uncommitted contract", proof: "unit test: uncommitted contract" }]);

    const body = `Remudero-Task: W1-MISSING\n\n${DIVERGED_BODY}`;
    assert.deepEqual(planCriteriaAtHeadForRepair(body, originalHead, fixture.dir), PLAN);
    assert.deepEqual(planCriteriaAtHeadForRepair(body, currentHead, fixture.dir), currentPlan);
    assert.deepEqual(planCriteriaAtHeadForRepair(`${body}\nRemudero-Task: W1-MISSING`, currentHead, fixture.dir), []);
    assert.deepEqual(planCriteriaAtHeadForRepair(`prose Remudero-Task: ${TASK}`, currentHead, fixture.dir), []);
  } finally {
    fixture.cleanup();
  }
});
