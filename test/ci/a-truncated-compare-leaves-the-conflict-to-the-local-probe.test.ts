import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { appendLedger } from "#src/lib/ledger.js";
import { applyMergeProbeEvidence, MERGE_PROBE_STEP, probeOpenPrMerges } from "#src/lib/merge-probe.js";
import { compareRestArgs, hydrateMergeConflictEvidence } from "#src/lib/open-prs-rest.js";
import { readLedgerLines } from "#src/lib/status.js";
import type { OpenPrView } from "#src/lib/sweep.js";
import { gitRepo } from "#test/helpers/git-repo.js";

// #15520 (W1-T10842, head 8a8bdb3) as the 2026-11-03 conflict findings read it. Since the merge base 2871269, the PR side
// touched 6 paths and main 942. GitHub's compare lists at most 300 files, and the one conflicting path,
// test/worker/spawn/compress-src-lib-worker-provider-ts.test.ts, is 922nd on main's side. So the compare intersection
// was empty: "GitHub's compare found no path changed on both sides since the merge base" from 18:38Z to 19:54Z. The empty
// list then outranked the local merge probe, which found that path at 20:37Z.
const CONFLICTING = "test/worker/spawn/compress-src-lib-worker-provider-ts.test.ts";
const HEAD = "8a8bdb386f9d60649b11af4f44018ac3e8e0f9f1";
const BASE = "28712695a6b2dc362f5a9ef0fbad5b481f5b976f";
const GITHUB_COMPARE_FILE_LIST = 300;

function compareFetch(mainFiles: string[]) {
  const ours = { merge_base_commit: { sha: BASE }, commits: [{ sha: HEAD, commit: { message: "codex balanced arms" } }],
    files: ["src/lib/worker-provider.ts", CONFLICTING].map(filename => ({ filename, deletions: 3 })) };
  const theirs = { merge_base_commit: { sha: BASE }, commits: [{ sha: "995bd36", commit: { message: "main" } }],
    files: mainFiles.map(filename => ({ filename, deletions: 10 })) };
  return (args: string[]): unknown => {
    if (args[1] === compareRestArgs("craigoley", "remudero", "main", HEAD)[1]) return ours;
    if (args[1] === compareRestArgs("craigoley", "remudero", BASE, "main")[1]) return theirs;
    throw new Error(`unexpected read ${args.join(" ")}`);
  };
}

test("W1-T11174: a compare that lists GitHub's full 300 files is not read as conflict evidence", () => {
  const truncated = Array.from({ length: GITHUB_COMPARE_FILE_LIST }, (_, i) => `docs/main-side-${String(i).padStart(3, "0")}.md`);
  const gaps = new Map<number, string>();
  const evidence = hydrateMergeConflictEvidence("craigoley", "remudero", "main", [{ number: 15520, headRefOid: HEAD }],
    compareFetch(truncated), undefined, gaps);
  assert.equal(evidence.has(15520), false, "a truncated main side cannot prove which paths both sides touched");
  assert.match(gaps.get(15520) ?? "", /300/);

  const complete = hydrateMergeConflictEvidence("craigoley", "remudero", "main", [{ number: 15520, headRefOid: HEAD }],
    compareFetch([...truncated.slice(0, GITHUB_COMPARE_FILE_LIST - 2), CONFLICTING]));
  assert.deepEqual(complete.get(15520)?.files.map(f => f.path), [CONFLICTING], "a complete list still yields its intersection");
});

function fixture(t: TestContext) {
  const repo = gitRepo();
  t.after(() => repo.cleanup());
  writeFileSync(join(repo.dir, "shared.ts"), "base\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "base file");
  const heads: string[] = [];
  for (const name of ["pr-one", "pr-two"]) {
    repo.git("checkout", "-q", "main");
    repo.git("checkout", "-qb", name);
    writeFileSync(join(repo.dir, "shared.ts"), `${name} edit\n`);
    repo.git("commit", "-qam", `${name} edit`);
    heads.push(repo.git("rev-parse", "HEAD"));
  }
  repo.git("checkout", "-q", "main");
  writeFileSync(join(repo.dir, "shared.ts"), "main edit\n");
  repo.git("commit", "-qam", "main edit");
  repo.addRemote("origin", repo.dir);
  repo.git("update-ref", "refs/pull/15520/head", heads[0]!);
  repo.git("update-ref", "refs/pull/15521/head", heads[1]!);
  const ledgerPath = join(repo.dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: "probe-W1-T11174", task_id: "W1-T11174", step, ...extra });
  return { repo, heads, ledgerPath, log };
}

const view = (prNumber: number, headSha: string, over: Partial<OpenPrView> = {}): OpenPrView => ({
  prNumber, prUrl: `https://github.com/craigoley/remudero/pull/${prNumber}`, taskId: "W1-T10842",
  headRefName: `run-W1-T10842-${prNumber}`, headSha, reviewState: "none", checksState: "none", unmetCriteria: [],
  priorStrikes: 0, autoMergeArmed: false, lastActivityAt: "2026-11-02T18:38:46.000Z", ...over,
});

test("W1-T11174: every dirty PR without file evidence is probed this pass, and the probe outranks an empty compare", async (t) => {
  const f = fixture(t);
  const empty = { files: [], oursLog: "", theirsLog: "" };
  const one = view(15520, f.heads[0]!, { mergeState: "dirty", mergeableState: "dirty", mergeConflict: empty });
  const two = view(15521, f.heads[1]!, { mergeState: "dirty", mergeableState: "dirty",
    mergeConflictGap: "the compare read failed: compare listed GitHub's full 300 files" });
  const summary = await probeOpenPrMerges([one, two], f.ledgerPath, f.log, f.repo.dir, { limit: 1 });
  assert.equal(summary.probed, 2, "the per-pass limit bounds optional probes, never a dirty PR waiting on its files");
  assert.deepEqual(readLedgerLines(f.ledgerPath).filter(r => r.step === MERGE_PROBE_STEP).map(r => r.pr_number).sort(), [15520, 15521]);

  const prs = [one, two];
  applyMergeProbeEvidence(prs, summary);
  assert.equal(prs[0]!.mergeConflictSource, "merge-probe", "an empty compare list is missing evidence, not evidence of none");
  assert.deepEqual(prs[0]!.mergeConflict?.files.map(file => file.path), ["shared.ts"]);
  assert.deepEqual(prs[1]!.mergeConflict?.files.map(file => file.path), ["shared.ts"]);

  const captured = { files: [{ path: "compare.ts", oursDeleted: 1, theirsDeleted: 2 }], oursLog: "ours", theirsLog: "theirs" };
  const compared = [view(15520, f.heads[0]!, { mergeState: "dirty", mergeableState: "dirty", mergeConflict: captured })];
  applyMergeProbeEvidence(compared, summary);
  assert.equal(compared[0]!.mergeConflict, captured, "captured compare evidence still wins");
});
