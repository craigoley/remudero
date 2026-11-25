import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { fileEligibleFollowups, followupFilingPresentation, followupProvenance, selectFileableFollowups } from "#src/lib/followup-filing.js";
import { approveBatch, draftedShardSlugs, fileRatificationBatch, inboxDraftExampleFragmentYaml, materializeDraftTaskIds, type DraftRungOutcome } from "#src/lib/inbox.js";
import { buildPlanPrBody, filingAcceptanceCriteria } from "#src/lib/plan-pr-emitter.js";
import { armAutoMerge, type ArmDeps } from "#src/lib/arm-auto-merge.js";
import { parseAcceptanceBlock, parseWhitelistedProof } from "#src/lib/review.js";
import { mineFollowups, retireSettledFollowups, routeFollowupsToRegistry, type FollowupCandidate, type FollowupRouteOutcome } from "#src/lib/retro.js";
import { stripMintedFollowupAffix } from "#src/lib/followup-dedup-census.js";
import type { Proposal } from "#src/lib/inbox.js";
import type { Config } from "#src/lib/config.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { captureWorktreeSnapshotViaGit, runFixRung } from "#test/helpers/run-task-test.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const headSha = "a".repeat(40);
const candidate: FollowupCandidate = { entryId: "run:timestamp:0", taskId: "W1-T12117", runId: "run",
  prUrl: "https://github.com/craigoley/remudero/pull/18415", headSha, type: "task",
  text: 'Preserve NEW-1, NEW-10 and NEW-1A: "quotes" and YAML punctuation.\nKeep NEW-1 on this second line.' };
const routed = (c = candidate): FollowupRouteOutcome => ({ candidate: c, routed: true, proposalId: `followup:${c.entryId}` });
const origin = `followup#${candidate.entryId}`;
const source = { id: candidate.taskId, origin: "architect", risk: "low" as const };

function draft(c = candidate): DraftRungOutcome {
  const task = parse(inboxDraftExampleFragmentYaml())[0];
  task.verify = "auto"; // W1-T14659: an approved proposal files verify: auto; its approval IS the human judgment
  task.origin = `followup#${c.entryId}`;
  task.rationale = followupProvenance(c);
  return { ok: true, proposalId: `followup:${c.entryId}`, candidate: {
    proposalId: `followup:${c.entryId}`, fragmentYaml: stringify([task]),
    stampLine: `- followup:${c.entryId} (plan) — RATIFIED 2026-11-14 -> NEW-1.`, anchorFingerprint: "",
  } };
}

test("an eligible task or research follow-up is filed as one plan-only shard with its provenance", async () => {
  for (const type of ["task", "research"] as const) {
    const c = { ...candidate, type };
    const root = mkdtempSync(join(tmpdir(), "rmd-followup-filing-"));
    try {
      writeFileSync(join(root, "MASTER-PLAN.md"), "# Plan\n");
      mkdirSync(join(root, "src/lib"), { recursive: true });
      writeFileSync(join(root, "src/lib/plan.ts"), "");
      const rows: Record<string, unknown>[] = [];
      let calls = 0;
      const result = await fileEligibleFollowups([routed(c)], {
        planOnMain: [source], openPrOrigins: new Set(), ratifiedIds: new Set(),
        draft: async proposals => { assert.ok(proposals[0].summary.includes(headSha)); return [draft(c)]; },
        fileBatch: async (payloads, onFiled, finalize) => {
          calls++;
          let branches = 0, prs = 0, reservations = 0;
          let filed!: ReturnType<typeof fileRatificationBatch>;
          const approved = approveBatch(payloads.map(p => ({ proposalId: p.proposalId,
            state: "ready", reasons: [], draft: { ...p, anchorFingerprint: "" } })), "# Plan\n", {
            createRatificationBranch(accepted) {
              branches++;
              filed = fileRatificationBatch(root, accepted, p => {
                const materialized = materializeDraftTaskIds(p, {
                  mint: () => ({ n: 20001, degraded: [] }),
                  reserveBlock: (start, count) => {
                    reservations++;
                    assert.equal(count, 1);
                    return { ids: [start] };
                  },
                });
                assert.ok(materialized.ok);
                assert.deepEqual(materialized.ids, ["W1-T20001"]);
                return finalize({ proposalId: p.proposalId, ...materialized });
              }, { mkdirSync, writeFileSync, readFileSync }, join, new Set(["remudero"]));
              return "run-APPROVE-BATCH-fixture";
            },
            openPlanPr(branch, proposalIds) {
              prs++;
              assert.equal(branch, "run-APPROVE-BATCH-fixture");
              const presentation = followupFilingPresentation(proposalIds, payloads.map(p => p.stampLine));
              const criteria = filingAcceptanceCriteria(filed.filedIds, filed.writtenPaths);
              let proofs = 0;
              const body = buildPlanPrBody({ intro: presentation.intro, criteria,
                changedFiles: filed.writtenPaths, baseRef: "fixture-base", proofCheck: proof => {
                  proofs++;
                  const parsed = parseWhitelistedProof(proof);
                  assert.ok(parsed && parsed.kind === "grep");
                  assert.ok(filed.writtenPaths.includes(parsed.args[3]));
                  assert.match(execFileSync(parsed.command, parsed.args, { cwd: root, encoding: "utf8" }), /id: W1-T20001/);
                  return 0;
                } });
              assert.equal(proofs, 1);
              assert.deepEqual(parseAcceptanceBlock(body), criteria);
              assert.match(criteria[0].claim, /filed as a well-formed plan task shard/);
              assert.doesNotMatch(presentation.commitMessage + body, /^Remudero-Task:/m);
              assert.match(presentation.title, /^chore\(plan\): file 1 follow-up proposals$/);
              return "https://github.com/craigoley/remudero/pull/20000";
            },
          }, { ledgerPath: join(root, "ledger.ndjson"), runId: "filing-run" });
          assert.ok(approved.ok);
          assert.deepEqual([branches, prs, reservations], [1, 1, 1]);
          assert.equal(filed.writtenPaths.length, 1);
          assert.ok(filed.writtenPaths.every(p => p.startsWith("plan/tasks.d/")));
          const shard = parse(readFileSync(join(root, filed.writtenPaths[0]), "utf8"))[0];
          assert.equal(shard.id, "W1-T20001");
          assert.equal(shard.origin, origin);
          assert.equal(shard.verify, "auto");
          assert.equal(shard.rationale,
            `Source task: ${c.taskId}; PR: ${c.prUrl}; head: ${headSha}; run: ${c.runId}\n${c.text}`);
          assert.ok(shard.rationale.includes(c.text));
          const receipt = { prUrl: approved.prUrl, proposalIds: approved.accepted.map(p => p.proposalId) };
          onFiled(receipt);
          assert.ok(rows.some(r => r.step === "followup.filed"), "the receipt precedes waiting for plan-PR gates");
          const filingHead = "b".repeat(40), writes: string[] = [];
          let checksGreen = false;
          const gate: ArmDeps = {
            headSha: () => filingHead, ledgerLines: () => rows,
            readPlanTouch: () => "touched",
            readMergeFacts: () => ({ mergeable: "MERGEABLE", mergeableState: "blocked", behindBy: 0 }),
            updateBranch: () => assert.fail("the current plan branch needs no refresh"),
            readChecksGreenReviewed: (url, sha) => {
              assert.equal(url, receipt.prUrl); assert.equal(sha, filingHead); return checksGreen;
            },
            armAuto: () => assert.fail("ordinary plan PRs must not be armed while gates are pending"),
            mergeDirect: url => { writes.push(url); }, disableAuto: () => assert.fail("no standing arm"), say: () => {},
          };
          const tryMerge = () => armAutoMerge(receipt.prUrl, "PR-20000", gate);
          assert.equal(tryMerge(), "ledger-refused");
          for (const [state, sha] of [["success", headSha], ["failure", filingHead], ["success", filingHead]] as const) {
            rows.push({ step: "review.posted", task_id: "PR-20000", pr_url: receipt.prUrl,
              context: "remudero-review", state, head_sha: sha });
            assert.equal(tryMerge(), state === "success" && sha === filingHead ? "plan-pr-held" : "ledger-refused");
            assert.deepEqual(writes, []);
          }
          checksGreen = true;
          assert.equal(tryMerge(), "direct-merged");
          assert.deepEqual(writes, [receipt.prUrl]);
          return receipt;
        },
        log: (step, extra) => rows.push({ step, ...extra }),
      });
      assert.equal(calls, 1);
      assert.equal(result.filed.length, 1);
      assert.equal(rows.filter(r => r.step === "followup.filed").length, 1);
      assert.deepEqual(rows.find(r => r.step === "followup.filed"), { step: "followup.filed", entry_id: c.entryId,
        task_id: c.taskId, pr_url: c.prUrl, head_sha: headSha, run_id: c.runId,
        filing_pr: "https://github.com/craigoley/remudero/pull/20000" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("a materialized follow-up is revalidated before any shard is published", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-followup-final-validation-"));
  try {
    mkdirSync(join(root, "src/lib"), { recursive: true });
    writeFileSync(join(root, "src/lib/plan.ts"), "");
    writeFileSync(join(root, "MASTER-PLAN.md"), "# Plan\n");
    for (const [reason, change] of [
      ["empty-files", (t: any) => { t.files = []; }],
      ["unsupported-proof", (t: any) => { t.acceptance[0].proof = "manual inspection"; }],
      ["over-risk-band", (t: any) => { t.files = ["deploy/Dockerfile"]; }],
    ] as const) {
      const rows: Record<string, unknown>[] = [], writes: string[] = [];
      await assert.rejects(fileEligibleFollowups([routed()], {
        planOnMain: [source], openPrOrigins: new Set(), ratifiedIds: new Set(), draft: async () => [draft()],
        fileBatch: async (payloads, _onFiled, finalize) => {
          fileRatificationBatch(root, payloads, p => {
            const materialized = materializeDraftTaskIds(p, {
              mint: () => ({ n: 20001, degraded: [] }), reserveBlock: start => ({ ids: [start] }),
            });
            assert.ok(materialized.ok);
            const tasks = parse(materialized.fragmentYaml);
            change(tasks[0]);
            return finalize({ ...p, ...materialized, fragmentYaml: stringify(tasks) });
          }, { readFileSync, mkdirSync: path => { writes.push(path); },
            writeFileSync: path => { writes.push(path); } }, join, new Set(["remudero"]));
          assert.fail("a rejected final shard must not reach PR creation");
        }, log: (step, extra) => rows.push({ step, ...extra }),
      }), new RegExp(reason));
      assert.deepEqual(writes, []);
      assert.deepEqual(rows, [{ step: "followup.file_refused", entry_id: candidate.entryId, reason }]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an action or already-handled follow-up is never filed", async () => {
  const base = { planOnMain: [source], openPrOrigins: new Set<string>(), ratifiedIds: new Set<string>() };
  for (const opts of [
    { ...base, planOnMain: [source, { ...source, id: "W1-T5507", origin }] },
    { ...base, openPrOrigins: new Set([origin]) },
    { ...base, ratifiedIds: new Set([`followup:${candidate.entryId}`]) },
  ]) {
    assert.equal(selectFileableFollowups([routed()], opts).selected.length, 0);
  }
  const outcomes: FollowupRouteOutcome[] = [routed({ ...candidate, type: "action" })];
  for (const arm of ["title-dedup", "type-not-plan-shaped", "self-referential", "dispatch-only", "settled-question"] as const) {
    outcomes.push({ candidate, routed: false, arm, reason: arm });
  }
  await fileEligibleFollowups(outcomes, { ...base,
    draft: async () => { assert.fail("handled entries must not draft"); },
    fileBatch: async () => { assert.fail("handled entries must not file"); }, log: () => {},
  });
  let files = 0;
  const ratifiedIds = new Set<string>();
  const deps = { ...base, ratifiedIds, draft: async () => [draft()],
    fileBatch: async () => { files++; ratifiedIds.add(`followup:${candidate.entryId}`);
      return { prUrl: "filing", proposalIds: [`followup:${candidate.entryId}`] }; }, log: () => {} };
  await fileEligibleFollowups([routed(), routed()], deps);
  await fileEligibleFollowups([routed()], deps);
  assert.equal(files, 1);
});

test("an under-specified or over-band follow-up draft is refused with a named reason", async (t) => {
  for (const [reason, change] of [
    ["empty-files", (t: any) => { t.files = []; }],
    ["unsupported-proof", (t: any) => { t.acceptance[0].proof = "manual inspection"; }],
    ["over-risk-band", (t: any) => { t.files = ["deploy/Dockerfile"]; }],
    ["missing-provenance", (t: any) => { t.rationale = candidate.text; }],
    ["wrong-origin", (t: any) => { t.origin = "architect"; }],
  ] as const) {
    const d = draft();
    assert.ok(d.ok);
    const task = parse(d.candidate.fragmentYaml)[0];
    change(task);
    d.candidate.fragmentYaml = stringify([task]);
    const rows: Record<string, unknown>[] = [];
    await fileEligibleFollowups([routed()], { planOnMain: [source], openPrOrigins: new Set(), ratifiedIds: new Set(),
      draft: async () => [d], fileBatch: async () => assert.fail("refused draft reached publisher"),
      log: (step, extra) => rows.push({ step, ...extra }),
    });
    assert.ok(rows.some(r => r.step === "followup.file_refused" && String(r.reason).includes(reason)), reason);
  }
  const rows: Record<string, unknown>[] = [];
  await fileEligibleFollowups([routed({ ...candidate, headSha: undefined })], {
    planOnMain: [source], openPrOrigins: new Set(), ratifiedIds: new Set(),
    draft: async () => assert.fail("unreadable head reached drafter"),
    fileBatch: async () => assert.fail("unreadable head reached publisher"),
    log: (step, extra) => rows.push({ step, ...extra }),
  });
  assert.ok(rows.some(r => r.reason === "unreadable-head-sha"));
  for (const bound of [100, NaN, Infinity]) {
    assert.equal(selectFileableFollowups(Array.from({ length: 5 }, (_, i) => routed({ ...candidate, entryId: `${i}` })), {
      planOnMain: [source], openPrOrigins: new Set(), ratifiedIds: new Set(), bound,
    }).selected.length, 3);
  }
  const overBand = draft();
  assert.ok(overBand.ok);
  const task = parse(overBand.candidate.fragmentYaml)[0];
  task.files = ["deploy/Dockerfile"];
  overBand.candidate.fragmentYaml = stringify([task]);
  const riskRefusals: unknown[] = [];
  await fileEligibleFollowups([routed()], {
    planOnMain: [{ ...source, risk: "high" }], sourceRisk: () => "low", openPrOrigins: new Set(), ratifiedIds: new Set(),
    draft: async () => [overBand], fileBatch: async () => assert.fail("today's plan risk replaced the run's declared risk"),
    log: (_step, extra) => riskRefusals.push(extra.reason),
  });
  assert.ok(riskRefusals.includes("over-risk-band"));
  const malformed = draft();
  assert.ok(malformed.ok);
  malformed.candidate.fragmentYaml = "- id: [unterminated";
  const parseRefusals: string[] = [];
  await fileEligibleFollowups([routed()], {
    planOnMain: [source], openPrOrigins: new Set(), ratifiedIds: new Set(), draft: async () => [malformed],
    fileBatch: async () => assert.fail("an unparseable draft reached the ratifier"),
    log: (_step, extra) => parseRefusals.push(String(extra.reason)),
  });
  assert.ok(parseRefusals.some(reason => reason.startsWith("unparseable-draft:")));
  await t.test("an unreadable follow-up head preserves legacy summaries and source-merge retirement", async () => {
    for (const type of ["task", "research"] as const) for (const prUrl of [candidate.prUrl, undefined]) {
      const c = { ...candidate, type, prUrl, headSha: undefined };
      const summary = `follow-up harvest [${type}]: ${c.text} — from ${c.taskId} (run ${c.runId}${prUrl ? `, ${prUrl}` : ""})`;
      // Include receipts marked by the earlier filing path; that suffix cannot change merge semantics.
      for (const existingSummary of [undefined, summary, summary.slice(0, -1) + "; kept for the operator: automatic filing refused it)"]) {
        const legacy: Proposal = { id: `followup:${c.entryId}`, summary: existingSummary ?? summary, evidenceAnchors: [] };
        const unrelated: Proposal = { id: "operator-proposal", summary: "operator-owned work", evidenceAnchors: [] };
        let registry: Proposal[] = existingSummary === undefined ? [unrelated] : [legacy, unrelated];
        const updateRegistry = (_path: string, update: (current: Proposal[]) => Proposal[] | null) => {
          const next = update(registry);
          if (next !== null) registry = next;
          return next;
        };
        const deps = { registryPath: "unused", updateRegistry };
        const outcomes = routeFollowupsToRegistry({ candidates: [c], deduped: [], harvestLines: [] },
          { ...deps, settledQuestions: [] });
        const before = structuredClone(registry);
        assert.deepEqual(registry.find(p => p.id === legacy.id), legacy);
        const rows: Record<string, unknown>[] = [];
        const result = await fileEligibleFollowups(outcomes, {
          planOnMain: [source], openPrOrigins: new Set(), ratifiedIds: new Set(),
          draft: async () => assert.fail("unreadable head reached drafter"),
          fileBatch: async () => assert.fail("unreadable head reached publisher"),
          log: (step, extra) => rows.push({ step, ...extra }),
        });
        assert.deepEqual(result, { filed: [], refused: [{ entryId: c.entryId, reason: "unreadable-head-sha" }] });
        assert.deepEqual(rows, [{ step: "followup.file_refused", entry_id: c.entryId, reason: "unreadable-head-sha" }]);
        assert.deepEqual(registry, before, "filing refusal leaves the existing operator proposal intact");
        assert.equal(stripMintedFollowupAffix(registry.find(p => p.id === legacy.id)!.summary), c.text);
        assert.deepEqual(retireSettledFollowups({ kind: "unreadable" }, deps), []);
        assert.deepEqual(retireSettledFollowups({ kind: "ok", merged: new Set() }, deps), []);
        assert.deepEqual(registry, before, "a refused proposal stays available while its source is unmerged");
        const retired = retireSettledFollowups({ kind: "ok", merged: new Set([c.taskId]) }, deps);
        assert.deepEqual(retired.map(r => [r.proposalId, r.taskId]), [[legacy.id, c.taskId]]);
        assert.deepEqual(registry, [unrelated], "source merge keeps its prior retirement behavior after refusal");
        assert.deepEqual(retireSettledFollowups({ kind: "ok", merged: new Set([c.taskId]) }, deps), []);
      }
    }
  });
});

test("follow-up head provenance survives mining and registry publication", () => {
  const harvest = mineFollowups([{ step: "report.followups", run_id: "run", task_id: candidate.taskId,
    ts: "timestamp", pr_url: candidate.prUrl, head_sha: headSha, entries: [{ type: "task", text: candidate.text }] }]);
  assert.equal(harvest.candidates[0].headSha, headSha);
  routeFollowupsToRegistry(harvest, { registryPath: "unused", updateRegistry: (_p, update) => {
    const routedOnly = update([])!;
    assert.ok(routedOnly[0].summary.includes(headSha));
    assert.equal(retireSettledFollowups({ kind: "ok", merged: new Set([candidate.taskId]) }, {
      registryPath: "unused", updateRegistry: (_path, retire) => retire(routedOnly) }).length, 1,
    "a routed follow-up that filing never refused still retires when its source merges");
    return routedOnly;
  } });
});

test("an unreadable follow-up head preserves the proposal and its source-merge retirement", async () => {
  const harvest = mineFollowups([{ step: "report.followups", run_id: "run", task_id: candidate.taskId,
    ts: "timestamp", entries: [{ type: "task", text: candidate.text }] }]);
  let proposals: Proposal[] = [];
  const routedOutcomes = routeFollowupsToRegistry(harvest, { registryPath: "unused", updateRegistry: (_p, update) => {
    proposals = update(proposals) ?? proposals;
    return proposals;
  } });
  assert.equal(proposals.length, 1);
  const before = structuredClone(proposals);
  const rows: Record<string, unknown>[] = [];
  const filing = await fileEligibleFollowups(routedOutcomes, {
    planOnMain: [source], openPrOrigins: new Set(), ratifiedIds: new Set(),
    draft: async () => assert.fail("an unreadable source head reached the drafter"),
    fileBatch: async () => assert.fail("an unreadable source head reached the publisher"),
    log: (step, extra) => rows.push({ step, ...extra }),
  });
  assert.deepEqual(filing, { filed: [], refused: [{ entryId: harvest.candidates[0].entryId,
    reason: "unreadable-head-sha" }] });
  assert.deepEqual(rows, [{ step: "followup.file_refused", entry_id: harvest.candidates[0].entryId,
    reason: "unreadable-head-sha" }]);
  assert.deepEqual(proposals, before, "the refused proposal stays unchanged for operator approval");
  const deps = { registryPath: "unused", updateRegistry: (_path: string, update: (current: Proposal[]) => Proposal[] | null) => {
      proposals = update(proposals) ?? proposals;
      return proposals;
    } };
  assert.deepEqual(retireSettledFollowups({ kind: "ok", merged: new Set() }, deps), []);
  assert.deepEqual(proposals, before, "the proposal remains available while its source is unmerged");
  const retired = retireSettledFollowups({ kind: "ok", merged: new Set([candidate.taskId]) }, deps);
  assert.deepEqual(retired.map(r => [r.proposalId, r.taskId]), [[before[0].id, candidate.taskId]]);
  assert.deepEqual(proposals, [], "source merge keeps its prior retirement behavior after refusal");
});

test("a draft that duplicates a filed shard is skipped by the batch planner and refused with its reason", async () => {
  const d = draft();
  assert.ok(d.ok);
  const corpus = draftedShardSlugs(d.candidate.fragmentYaml);
  assert.ok(corpus.length > 0);
  const rows: Record<string, unknown>[] = [];
  const result = await fileEligibleFollowups([routed()], {
    planOnMain: [source], openPrOrigins: new Set(), ratifiedIds: new Set(), draft: async () => [d],
    duplicateCorpus: corpus.map(e => ({ id: "plan/tasks.d/W1-T1-already-filed.yaml", text: e.text })),
    fileBatch: async () => assert.fail("a duplicate draft reached the publisher"),
    log: (step, extra) => rows.push({ step, ...extra }),
  });
  assert.deepEqual(result.filed, []);
  assert.equal(result.refused.length, 1);
  assert.equal(result.refused[0].entryId, candidate.entryId);
  assert.match(result.refused[0].reason, /already on origin\/main/);
  assert.deepEqual(rows, [{ step: "followup.file_refused", entry_id: candidate.entryId, reason: result.refused[0].reason }]);
});

test("a batch the ratifier does not file is refused as batch-not-filed and records no filing", async () => {
  const rows: Record<string, unknown>[] = [];
  const result = await fileEligibleFollowups([routed()], {
    planOnMain: [source], openPrOrigins: new Set(), ratifiedIds: new Set(), draft: async () => [draft()],
    fileBatch: async () => undefined, log: (step, extra) => rows.push({ step, ...extra }),
  });
  assert.deepEqual(result.filed, []);
  assert.deepEqual(result.refused, [{ entryId: candidate.entryId, reason: "batch-not-filed" }]);
  assert.deepEqual(rows, [{ step: "followup.file_refused", entry_id: candidate.entryId, reason: "batch-not-filed" }]);
});

test("a fix round's follow-up carries the head of the checkout the fix round used", async () => {
  const repo = gitRepo({ kind: "fix-round-followup-head" });
  try {
    writeFileSync(join(repo.dir, "feature.ts"), "export const value = 1;\n");
    repo.git("add", "feature.ts"); repo.git("commit", "-q", "-m", "seed feature");
    const head = repo.git("rev-parse", "HEAD");
    const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const review = { state: "failure" as const, headSha: head, reviewerOutcome: "success", criteria: [], testTheater: false,
      summary: "fixture", floorDegraded: false, capped: false, keywordOnly: false, planOnly: false };
    const worker: WorkerResult = {
      sessionId: "fixture", costUsd: 0, numTurns: 0, blocks: [], stderr: "", subtype: "success",
      text: "## Follow-ups\ntask: carry the sweep checkout head on a fix-round follow-up\n",
      isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "fixture", effort: "fixture",
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
    };
    await runFixRung({
      taskId: "W1-T12117", runId: "W1-T12117-FIX-HEAD-1", task: { id: "W1-T12117", title: "fixture repair" },
      prUrl: "https://github.com/fixture/repo/pull/1", branch: "run-W1-T12117-FIX-HEAD-1", worktreePath: repo.dir,
      initialSessionId: "fixture", mount: { model: "fixture", effort: "medium", maxTurns: 2, contextBudget: 1_000 },
      settingsFile: join(repo.dir, "settings.json"), config: {} as Config, budgetUsd: 0, strikeCap: 1,
      reviewBase: { owner: "fixture", repo: "repo", headCheckoutDir: repo.dir, reviewerMount: { model: "fixture", effort: "medium", maxTurns: 2, contextBudget: 1_000 } },
      initialReview: review, ciFailures: [{ name: "check-a", logTail: "fixture attributable failure" }],
      deps: {
        spawn: async () => worker,
        waitForCiGreen: async () => "red", fetchCiFailures: async () => [{ name: "check-a", logTail: "fixture attributable failure" }],
        runReview: async () => review, push: () => {},
        issues: { create: () => "https://github.com/fixture/repo/issues/1", listOpen: () => [] },
        ledgerPath: join(repo.dir, ".git/fixture-ledger.ndjson"), log: (step, extra) => { rows.push({ step, extra }); }, say: () => {},
        account: r => r, readLiveState: async () => ({ ok: true, state: "OPEN" }),
        captureWorktreeSnapshot: async path => captureWorktreeSnapshotViaGit(path),
      },
    });
    const harvested = rows.filter(row => row.step === "report.followups");
    assert.equal(harvested.length, 1, "the fix round harvests its follow-up once");
    assert.equal(harvested[0]!.extra?.head_sha, head, "the row carries the fix round's own checkout head");
  } finally { repo.cleanup(); }
});
