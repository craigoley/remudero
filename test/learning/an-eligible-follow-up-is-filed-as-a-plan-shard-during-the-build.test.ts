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
import { keepRefusedFollowupsForOperator, mineFollowups, retireSettledFollowups, routeFollowupsToRegistry, type FollowupCandidate, type FollowupRouteOutcome } from "#src/lib/retro.js";
import { stripMintedFollowupAffix } from "#src/lib/followup-dedup-census.js";
import type { Proposal } from "#src/lib/inbox.js";

const headSha = "a".repeat(40);
const candidate: FollowupCandidate = { entryId: "run:timestamp:0", taskId: "W1-T12117", runId: "run",
  prUrl: "https://github.com/craigoley/remudero/pull/18415", headSha, type: "task",
  text: 'Preserve NEW-1, NEW-10 and NEW-1A: "quotes" and YAML punctuation.\nKeep NEW-1 on this second line.' };
const routed = (c = candidate): FollowupRouteOutcome => ({ candidate: c, routed: true, proposalId: `followup:${c.entryId}` });
const origin = `followup#${candidate.entryId}`;
const source = { id: candidate.taskId, origin: "architect", risk: "low" as const };

function draft(c = candidate): DraftRungOutcome {
  const task = parse(inboxDraftExampleFragmentYaml())[0];
  task.verify = "human";
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
          assert.equal(shard.verify, "human");
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

test("an under-specified or over-band follow-up draft is refused with a named reason", async () => {
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
  // A refused proposal with neither a head nor a PR URL still stays for the operator after its source merges.
  let registry: Proposal[] = [];
  const updateRegistry = (_path: string, update: (current: Proposal[]) => Proposal[] | null) => {
    const next = update(registry);
    if (next !== null) registry = next;
    return next;
  };
  const bare = { ...candidate, entryId: "bare:timestamp:0", headSha: undefined, prUrl: undefined };
  const bareOutcomes = routeFollowupsToRegistry({ candidates: [bare], deduped: [], harvestLines: [] },
    { registryPath: "unused", updateRegistry, settledQuestions: [] });
  const bareRows: Record<string, unknown>[] = [];
  const bareFiling = await fileEligibleFollowups(bareOutcomes, { planOnMain: [source], openPrOrigins: new Set(), ratifiedIds: new Set(),
    draft: async () => assert.fail("unreadable head reached drafter"),
    fileBatch: async () => assert.fail("unreadable head reached publisher"),
    log: (step, extra) => bareRows.push({ step, ...extra }),
  });
  assert.ok(bareRows.some(r => r.step === "followup.file_refused" && r.reason === "unreadable-head-sha"));
  assert.deepEqual(keepRefusedFollowupsForOperator(bareFiling.refused.map(r => r.entryId), { registryPath: "unused", updateRegistry }),
    [`followup:${bare.entryId}`]);
  assert.equal(stripMintedFollowupAffix(registry[0].summary), bare.text, "the referent still parses for dedup");
  const bareRetired = retireSettledFollowups({ kind: "ok", merged: new Set([bare.taskId]) }, { registryPath: "unused", updateRegistry });
  assert.equal(bareRetired.length, 0);
  assert.deepEqual(registry.map(p => p.id), [`followup:${bare.entryId}`], "the refused proposal is kept for the operator");
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
    let proposals = routedOnly;
    keepRefusedFollowupsForOperator([candidate.entryId], { registryPath: "unused",
      updateRegistry: (_path, mark) => { proposals = mark(proposals) ?? proposals; return proposals; } });
    const retired = retireSettledFollowups({ kind: "ok", merged: new Set([candidate.taskId]) }, {
      registryPath: "unused", updateRegistry: (_path, retire) => {
        assert.equal(retire(proposals), null, "a refused draft must keep its operator fallback after the source merges");
        return null;
      },
    });
    assert.deepEqual(retired, []);
    return proposals;
  } });
});

test("an unreadable follow-up head is retained for the operator when its source merges", async () => {
  const harvest = mineFollowups([{ step: "report.followups", run_id: "run", task_id: candidate.taskId,
    ts: "timestamp", entries: [{ type: "task", text: candidate.text }] }]);
  let proposals: Proposal[] = [];
  const routedOutcomes = routeFollowupsToRegistry(harvest, { registryPath: "unused", updateRegistry: (_p, update) => {
    proposals = update(proposals) ?? proposals;
    return proposals;
  } });
  const filing = await fileEligibleFollowups(routedOutcomes, {
    planOnMain: [source], openPrOrigins: new Set(), ratifiedIds: new Set(),
    draft: async () => assert.fail("an unreadable source head reached the drafter"),
    fileBatch: async () => assert.fail("an unreadable source head reached the publisher"),
    log: () => {},
  });
  assert.deepEqual(filing.refused.map(r => r.reason), ["unreadable-head-sha"]);
  const kept = keepRefusedFollowupsForOperator(filing.refused.map(r => r.entryId), {
    registryPath: "unused", updateRegistry: (_p, update) => {
      proposals = update(proposals) ?? proposals;
      return proposals;
    },
  });
  assert.equal(kept.length, 1);
  assert.match(proposals[0].summary, /kept for the operator: automatic filing refused it/);
  const retired = retireSettledFollowups({ kind: "ok", merged: new Set([candidate.taskId]) }, {
    registryPath: "unused", updateRegistry: (_path, update) => {
      assert.equal(update(proposals), null, "the refused proposal must survive its source merge");
      return null;
    },
  });
  assert.deepEqual(retired, []);
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
