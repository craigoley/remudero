import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { fileEligibleFollowups, followupFilingPresentation, followupProvenance, selectFileableFollowups } from "#src/lib/followup-filing.js";
import { fileRatificationBatch, inboxDraftExampleFragmentYaml, type DraftRungOutcome } from "#src/lib/inbox.js";
import { mineFollowups, retireSettledFollowups, routeFollowupsToRegistry, type FollowupCandidate, type FollowupRouteOutcome } from "#src/lib/retro.js";
import { harvestFollowupsFromReport } from "#src/run-task.js";

const headSha = "a".repeat(40);
const candidate: FollowupCandidate = { entryId: "run:timestamp:0", taskId: "W1-T12117", runId: "run",
  prUrl: "https://github.com/craigoley/remudero/pull/18415", headSha, type: "task",
  text: 'Preserve the concrete follow-up: "quotes" and YAML punctuation.\nKeep this second line.' };
const routed = (c = candidate): FollowupRouteOutcome => ({ candidate: c, routed: true, proposalId: `followup:${c.entryId}` });
const origin = `followup#${candidate.entryId}`;
const source = { id: candidate.taskId, origin: "architect", risk: "low" as const };

function draft(c = candidate): DraftRungOutcome {
  const task = parse(inboxDraftExampleFragmentYaml())[0];
  task.id = "W1-T5507";
  task.verify = "human";
  task.origin = `followup#${c.entryId}`;
  task.rationale = followupProvenance(c);
  return { ok: true, proposalId: `followup:${c.entryId}`, candidate: {
    proposalId: `followup:${c.entryId}`, fragmentYaml: stringify([task]),
    stampLine: `- followup:${c.entryId} (plan) — RATIFIED 2026-11-14 -> W1-T5507.`, anchorFingerprint: "",
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
        fileBatch: async (payloads, onFiled) => {
          calls++;
          const filed = fileRatificationBatch(root, payloads, p => p,
            { mkdirSync, writeFileSync, readFileSync }, join, new Set(["remudero"]));
          assert.equal(filed.writtenPaths.length, 1);
          assert.ok(filed.writtenPaths.every(p => p.startsWith("plan/tasks.d/")));
          const shard = parse(readFileSync(join(root, filed.writtenPaths[0]), "utf8"))[0];
          assert.equal(shard.origin, origin);
          assert.equal(shard.verify, "human");
          assert.equal(shard.rationale, followupProvenance(c));
          assert.ok(shard.rationale.includes(c.text));
          const receipt = { prUrl: "https://github.com/craigoley/remudero/pull/20000", proposalIds: payloads.map(p => p.proposalId) };
          const presentation = followupFilingPresentation(receipt.proposalIds, payloads.map(p => p.stampLine));
          assert.doesNotMatch(presentation.commitMessage + presentation.intro, /^Remudero-Task:/m);
          assert.match(presentation.intro, /ordinary plan-PR CI and semantic review gates/);
          assert.match(presentation.title, /^chore\(plan\): file 1 follow-up proposals$/);
          if (type === "task") {
            onFiled(receipt);
            assert.ok(rows.some(r => r.step === "followup.filed"), "the receipt precedes waiting for plan-PR gates");
          }
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
    const proposals = update([])!;
    assert.ok(proposals[0].summary.includes(headSha));
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

test("the report harvest reads the exact local head and names an unreadable head", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-followup-head-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "fixture"]);
    const expected = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    for (const unreadable of [false, true]) {
      const rows: Record<string, unknown>[] = [];
      harvestFollowupsFromReport("REPORT\n## Follow-ups\ntask: preserve the exact source revision", {
        label: "implement", worktreePath: unreadable ? join(root, "absent") : root, seen: new Set(),
        log: (step, extra) => rows.push({ step, ...extra }), say: () => {},
      });
      const report = rows.find(r => r.step === "report.followups");
      assert.ok(report);
      assert.equal(report.head_sha, unreadable ? undefined : expected);
      assert.equal(rows.some(r => r.step === "followup.head_unreadable"), unreadable);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
