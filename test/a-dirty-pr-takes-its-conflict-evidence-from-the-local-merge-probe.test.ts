import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import * as probes from "#src/lib/merge-probe.js";
import { appendLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import {
  conflictEvidenceRowFields, DEFAULT_SWEEP_POLICY, deriveDisposition,
  MERGEABILITY_UNKNOWN_WAIT_BACKSTOP, runSweep, type OpenPrView,
} from "#src/lib/sweep.js";
import { gitRepo } from "#test/helpers/git-repo.js";

function fixture(t: TestContext) {
  const repo = gitRepo();
  t.after(() => repo.cleanup());
  writeFileSync(join(repo.dir, "conflict.txt"), "base\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "base file");
  repo.git("checkout", "-qb", "head");
  writeFileSync(join(repo.dir, "conflict.txt"), "head edit\n");
  repo.git("commit", "-qam", "head edit");
  const headSha = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "-q", "main");
  writeFileSync(join(repo.dir, "conflict.txt"), "main edit\nextra main line\n");
  repo.git("commit", "-qam", "main edit");
  const mainSha = repo.git("rev-parse", "HEAD");
  repo.addRemote("origin", repo.dir);
  repo.git("update-ref", "refs/pull/9454/head", headSha);
  const now = Date.now();
  const pr: OpenPrView = {
    prNumber: 9454, prUrl: "https://example.test/pull/9454", taskId: "W1-T9454",
    headRefName: "run-W1-T9454-1792834905188", headSha,
    mergeState: "dirty", mergeableState: "unknown", reviewState: "success", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: new Date(now - 60_000).toISOString(),
  };
  const ledgerPath = join(repo.dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: "probe-test", task_id: "W1-T9454", step, ...extra });
  return { repo, pr, mainSha, now, ledgerPath, log };
}

test("W1-T9454: a dirty PR with unknown mergeability is dispositioned from the merge probe", async (t) => {
  const f = fixture(t);
  const clean = { ...f.pr, mergeState: "clean" as const, mergeableState: "clean" };
  const first = await probes.probeOpenPrMerges([clean], f.ledgerPath, f.log, f.repo.dir);
  assert.equal(first.probed, 1);
  assert.equal(readLedgerLines(f.ledgerPath).find(r => r.step === probes.MERGE_PROBE_STEP)?.verdict, "conflict");
  assert.equal(deriveDisposition(f.pr, DEFAULT_SWEEP_POLICY, f.now).disposition, "wait");
  const summary = await probes.probeOpenPrMerges([f.pr], f.ledgerPath, f.log, f.repo.dir);
  assert.equal(summary.probed, 0, "the unchanged pair reuses the conflict captured while GitHub reported clean");
  const prs = [f.pr];
  probes.applyMergeProbeEvidence(prs, summary);
  assert.equal(deriveDisposition(prs[0]!, DEFAULT_SWEEP_POLICY, f.now).disposition, "conflicted");
  assert.equal(prs[0]!.mergeConflictSource, "merge-probe");
  const dispatched: OpenPrView[] = [];
  await runSweep(prs, {
    ledgerPath: f.ledgerPath, runId: "probe-test", now: () => f.now, log: f.log,
    arm: () => assert.fail("conflict cannot arm"), close: () => assert.fail("conflict cannot close"),
    escalate: () => assert.fail("captured conflict cannot escalate"),
    dispatchFix: (pr, evidence) => {
      dispatched.push(pr);
      assert.deepEqual(evidence.mergeConflict, prs[0]!.mergeConflict);
    },
  }, DEFAULT_SWEEP_POLICY);
  assert.equal(dispatched.length, 1);
  const row = readLedgerLines(f.ledgerPath).findLast(r => r.step === "sweep.disposed");
  assert.equal(row?.disposition, "conflicted");
  assert.equal(row?.conflict_evidence_source, "merge-probe");
  assert.deepEqual(row?.conflict_files, [{ path: "conflict.txt", ours_deleted: 1, theirs_deleted: 1 }]);

  const compare = { files: [{ path: "compare.txt", oursDeleted: 7, theirsDeleted: 9 }], oursLog: "compare ours", theirsLog: "compare theirs" };
  const compared = [{ ...f.pr, mergeConflict: compare, mergeConflictSource: undefined }];
  probes.applyMergeProbeEvidence(compared, summary);
  assert.equal(compared[0]!.mergeConflict, compare);
  assert.equal(conflictEvidenceRowFields(compared[0]!).conflict_evidence_source, "compare");
  assert.equal(deriveDisposition(compared[0]!, DEFAULT_SWEEP_POLICY, f.now).disposition, "conflicted");
  const emptyCompare = { files: [], oursLog: "", theirsLog: "" };
  const empty = [{ ...f.pr, mergeConflict: emptyCompare }];
  probes.applyMergeProbeEvidence(empty, summary);
  assert.equal(empty[0]!.mergeConflict, emptyCompare, "even an empty compare result takes precedence");
  for (const blocked of [{ headRefName: "contributor-branch" }, { headRefName: "run-W1-T999-1792834905188" }]) {
    assert.equal(deriveDisposition({ ...prs[0]!, ...blocked }, DEFAULT_SWEEP_POLICY, f.now).disposition, "blocked-ambiguous");
  }
  assert.equal(deriveDisposition(prs[0]!, { ...DEFAULT_SWEEP_POLICY, mergeConflictAdmissionEnabled: false }, f.now).disposition, "blocked-ambiguous");
});

test("W1-T9454: the merge probe returns per-path conflict evidence", async (t) => {
  const f = fixture(t);
  f.pr.mergeState = "clean";
  f.pr.mergeableState = "clean";
  const summary = await probes.probeOpenPrMerges([f.pr], f.ledgerPath, f.log, f.repo.dir);
  assert.equal(summary.probed, 1);
  assert.equal(summary.mainSha, f.mainSha);
  const captured = summary.conflictsByPr.get(f.pr.prNumber);
  assert.ok(captured);
  assert.equal(captured.headSha, f.pr.headSha);
  assert.deepEqual(captured.evidence.files, [{ path: "conflict.txt", oursDeleted: 1, theirsDeleted: 1 }]);
  assert.equal(captured.evidence.oursLog, `${f.pr.headSha.slice(0, 7)} head edit`);
  assert.equal(captured.evidence.theirsLog, `${f.mainSha.slice(0, 7)} main edit`);
  const row = readLedgerLines(f.ledgerPath).find(r => r.step === probes.MERGE_PROBE_STEP);
  assert.deepEqual(row?.conflict_paths, ["conflict.txt"]);
  assert.equal(row?.verdict, "conflict");
  assert.deepEqual(row?.conflict_evidence, captured.evidence);
});

test("W1-T9454: a cached conflict without usable evidence is re-probed for the unchanged pair", async (t) => {
  for (const evidence of [undefined, { files: [] }, { files: [], oursLog: "", theirsLog: "" }]) {
    await t.test(JSON.stringify(evidence) ?? "missing", async (t) => {
      const f = fixture(t);
      f.log(probes.MERGE_PROBE_STEP, {
        pr_number: f.pr.prNumber, head_sha: f.pr.headSha, main_sha: f.mainSha,
        verdict: "conflict", conflict_paths: ["conflict.txt"], github_mergeable_state: "clean",
        ...(evidence ? { conflict_evidence: evidence } : {}),
      });
      const summary = await probes.probeOpenPrMerges([f.pr], f.ledgerPath, f.log, f.repo.dir);
      assert.equal(summary.probed, 1);
      const captured = summary.conflictsByPr.get(f.pr.prNumber);
      assert.ok(captured);
      assert.deepEqual(captured.evidence.files, [{ path: "conflict.txt", oursDeleted: 1, theirsDeleted: 1 }]);
      probes.applyMergeProbeEvidence([f.pr], summary);
      assert.equal(deriveDisposition(f.pr, DEFAULT_SWEEP_POLICY, f.now).disposition, "conflicted");
      assert.equal(f.pr.mergeConflictSource, "merge-probe");
      const cached = await probes.probeOpenPrMerges([f.pr], f.ledgerPath, f.log, f.repo.dir);
      assert.equal(cached.probed, 0);
      assert.deepEqual(cached.conflictsByPr, summary.conflictsByPr);
      assert.equal(readLedgerLines(f.ledgerPath).filter(r => r.step === probes.MERGE_PROBE_STEP).length, 2);
    });
  }
});

test("W1-T9454: a PR waiting on unknown mergeability takes a probe slot first", async (t) => {
  const f = fixture(t);
  const old = { ...f.pr, prNumber: 1, mergeState: "clean" as const, mergeableState: "clean", lastActivityAt: "2000-01-01" };
  const unknown = { ...f.pr, mergeState: undefined };
  const summary = await probes.probeOpenPrMerges([old, unknown], f.ledgerPath, f.log, f.repo.dir, { limit: 1 });
  assert.deepEqual([...summary.conflictsByPr.keys()], [9454]);
  const rows = readLedgerLines(f.ledgerPath).filter(r => r.step === probes.MERGE_PROBE_STEP);
  assert.deepEqual(rows.map(r => r.pr_number), [9454]);
  const prs = [unknown];
  probes.applyMergeProbeEvidence(prs, summary);
  assert.equal(deriveDisposition(prs[0]!, DEFAULT_SWEEP_POLICY, f.now).disposition, "conflicted");
});

test("W1-T9454: unchanged pairs reuse evidence and moved heads cannot inherit it", async (t) => {
  const f = fixture(t);
  const first = await probes.probeOpenPrMerges([f.pr], f.ledgerPath, f.log, f.repo.dir);
  const second = await probes.probeOpenPrMerges([f.pr], f.ledgerPath, f.log, f.repo.dir);
  assert.equal(second.probed, 0);
  assert.deepEqual(second.conflictsByPr, first.conflictsByPr);
  const moved = [{ ...f.pr, headSha: f.mainSha }];
  probes.applyMergeProbeEvidence(moved, second);
  assert.equal(moved[0]!.mergeConflict, undefined);
  f.repo.git("commit", "--allow-empty", "-qm", "main moved");
  const third = await probes.probeOpenPrMerges([f.pr], f.ledgerPath, f.log, f.repo.dir);
  assert.equal(third.probed, 1);
  assert.notEqual(third.mainSha, first.mainSha);
  assert.equal(third.conflictsByPr.size, 1);
});

test("W1-T9454: unreadable probes preserve the wait and escalation backstop", async (t) => {
  const f = fixture(t);
  f.repo.git("update-ref", "refs/pull/9454/head", f.mainSha);
  f.pr.headSha = "f".repeat(40);
  const summary = await probes.probeOpenPrMerges([f.pr], f.ledgerPath, f.log, f.repo.dir);
  assert.equal(summary.conflictsByPr.size, 0);
  const prs = [f.pr];
  probes.applyMergeProbeEvidence(prs, summary);
  assert.equal(prs[0], f.pr);
  assert.equal(deriveDisposition(prs[0]!, DEFAULT_SWEEP_POLICY, f.now).disposition, "wait");
  const d = deriveDisposition(prs[0]!, DEFAULT_SWEEP_POLICY, f.now, { mergeabilityUnknownPasses: MERGEABILITY_UNKNOWN_WAIT_BACKSTOP });
  assert.equal(d.disposition, "blocked-ambiguous");
  assert.match(d.reason, /none captured/);
  assert.equal(readLedgerLines(f.ledgerPath).find(r => r.step === probes.MERGE_PROBE_STEP)?.verdict, "unreadable");
});

test("W1-T9454: failed evidence reads never manufacture deletion counts", async (t) => {
  const faults = ["merge-base", "bad-base", "ours-diff", "theirs-diff", "bad-stat", "missing-path", "binary", "ours-log", "theirs-log", "throw"];
  for (const fault of faults) await t.test(fault, async (t) => {
    const f = fixture(t);
    const real = probes.defaultMergeProbeGit(f.repo.dir);
    let diffs = 0;
    let logs = 0;
    const git: probes.MergeProbeGit = async (args) => {
      if (args[0] === "merge-base") {
        if (fault === "throw") throw new Error("evidence spawn failed");
        if (fault === "merge-base") return { status: 128, stdout: "" };
        if (fault === "bad-base") return { status: 0, stdout: "no base" };
      }
      if (args[0] === "diff") {
        diffs++;
        if ((fault === "ours-diff" && diffs === 1) || (fault === "theirs-diff" && diffs === 2)) return { status: 128, stdout: "" };
        if (fault === "bad-stat") return { status: 0, stdout: "malformed\0" };
        if (fault === "missing-path") return { status: 0, stdout: "1\t0\tother.txt\0" };
        if (fault === "binary") return { status: 0, stdout: "-\t-\tconflict.txt\0" };
      }
      if (args[0] === "log") {
        logs++;
        if ((fault === "ours-log" && logs === 1) || (fault === "theirs-log" && logs === 2)) return { status: 128, stdout: "" };
      }
      return real(args);
    };
    const summary = await probes.probeOpenPrMerges([f.pr], f.ledgerPath, f.log, f.repo.dir, { git });
    assert.equal(summary.conflictsByPr.size, 0);
    const row = readLedgerLines(f.ledgerPath).find(r => r.step === probes.MERGE_PROBE_STEP);
    assert.equal(row?.verdict, "conflict");
    assert.deepEqual(row?.conflict_paths, ["conflict.txt"]);
    assert.match(String(row?.conflict_evidence_error), /conflict evidence|evidence spawn failed/);
    probes.applyMergeProbeEvidence([f.pr], summary);
    assert.equal(deriveDisposition(f.pr, DEFAULT_SWEEP_POLICY, f.now).disposition, "wait");
  });
});

test("W1-T9454: a clean pair and a dry run supply no conflict evidence", async (t) => {
  const f = fixture(t);
  const clean = { ...f.pr, headSha: f.mainSha };
  const summary = await probes.probeOpenPrMerges([clean], f.ledgerPath, f.log, f.repo.dir);
  assert.equal(summary.probed, 1);
  assert.equal(summary.conflictsByPr.size, 0);
  assert.equal(readLedgerLines(f.ledgerPath).find(r => r.step === probes.MERGE_PROBE_STEP)?.verdict, "clean");
  const dry = await probes.probeOpenPrMerges([f.pr], f.ledgerPath, f.log, f.repo.dir, { dryRun: true });
  assert.equal(dry.probed, 0);
  assert.equal(dry.conflictsByPr.size, 0);
});

test("W1-T9454: a truncated conflict list cannot admit a repair", async (t) => {
  const f = fixture(t);
  const real = probes.defaultMergeProbeGit(f.repo.dir);
  const paths = Array.from({ length: probes.MERGE_PROBE_MAX_PATHS + 1 }, (_, i) => `file-${i}.txt`);
  const git: probes.MergeProbeGit = (args) => args[0] === "merge-tree"
    ? { status: 1, stdout: `${f.mainSha}\n${paths.join("\n")}\n` } : real(args);
  const summary = await probes.probeOpenPrMerges([f.pr], f.ledgerPath, f.log, f.repo.dir, { git });
  assert.equal(summary.conflictsByPr.size, 0);
  const row = readLedgerLines(f.ledgerPath).find(r => r.step === probes.MERGE_PROBE_STEP);
  assert.match(String(row?.conflict_evidence_error), /exceeded the probe cap/);
});
