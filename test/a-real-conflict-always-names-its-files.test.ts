import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_SWEEP_POLICY,
  deriveDisposition,
  runSweep,
  type OpenPrView,
  type SweepDeps,
} from "#src/lib/sweep.js";
import { hydrateMergeConflictEvidence, type GhApiFetcher } from "#src/lib/open-prs-rest.js";
import { readLedgerLines } from "#src/lib/status.js";
import { appendLedger } from "#src/lib/ledger.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

/**
 * #11991 (W1-T9627), 2026-10-15. Head c94ea474f had one real content conflict with main in
 * deploy/install-host-units.sh. The sweep disposed it `conflicted` at 18:22Z and 18:34Z with that
 * file named. Neither pass dispatched, because host capacity was exhausted. From 18:53Z on,
 * mergeability went unread. W1-T4470 inherited "dirty" but not the files, so every later pass
 * escalated "no valid conflicting-file evidence was captured — files: none captured".
 */

const NOW = Date.parse("2026-10-15T18:34:46.000Z");
const PATH = "deploy/install-host-units.sh";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-w1-t9723-")), "ledger.ndjson");
}

function write(repo: GitRepo, path: string, body: string): void {
  mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
  writeFileSync(join(repo.dir, path), body);
}

/** main and the run branch each rewrite the same line of one file: a real content conflict. */
function seedConflict(): { repo: GitRepo; head: string } {
  const repo = gitRepo({ kind: "w1-t9723" });
  repo.git("config", "user.name", "remudero test fixture");
  repo.git("config", "user.email", "fixture@remudero.invalid");
  const unit = (verdict: string) => `#!/bin/sh\nread_progress_verdict() {\n  ${verdict}\n}\n`;
  write(repo, PATH, unit("verdict=$(cat progress)"));
  write(repo, "README.md", "base\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "base");
  repo.git("checkout", "-q", "-b", "run-W1-T9627-1792065434776");
  write(repo, PATH, unit("verdict=$(cat \"$RMD_REVIVAL_LOG\")"));
  repo.git("commit", "-q", "-am", "fix(watchdog): keep its log (W1-T9627)");
  const head = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "-q", "main");
  write(repo, PATH, unit("verdict=$(timeout 5 cat progress)"));
  write(repo, "README.md", "main moved\n");
  repo.git("commit", "-q", "-am", "fix(deploy): bound the verdict read");
  return { repo, head };
}

/** GitHub's compare and contents endpoints, answered from the fixture repo. */
function gitBackedFetcher(repo: GitRepo): GhApiFetcher {
  return (args) => {
    const route = args[1] ?? "";
    const compare = /\/compare\/([^.]+)\.\.\.(.+)$/.exec(route);
    if (compare) {
      const [, base, head] = compare;
      const mergeBase = repo.git("merge-base", base, head);
      const numstat = repo.git("diff", "--numstat", mergeBase, head);
      const files = numstat ? numstat.split("\n").map((line) => {
        const [, deletions, filename] = line.split("\t");
        return { filename, deletions: Number(deletions) };
      }) : [];
      const log = repo.git("log", "--format=%H%x09%s", `${mergeBase}..${head}`);
      const commits = log ? log.split("\n").map((line) => {
        const [sha, message] = line.split("\t");
        return { sha, commit: { message } };
      }) : [];
      return { merge_base_commit: { sha: mergeBase }, files, commits };
    }
    const contents = /\/contents\/(.+)\?ref=(.+)$/.exec(route);
    if (contents) {
      const bytes = repo.git("show", `${decodeURIComponent(contents[2])}:${decodeURIComponent(contents[1])}`);
      return { encoding: "base64", content: Buffer.from(`${bytes}\n`).toString("base64") };
    }
    throw new Error(`unexpected gh read ${route}`);
  };
}

function runPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 11991,
    prUrl: "https://github.com/craigoley/remudero/pull/11991",
    taskId: "W1-T9627",
    reviewState: "none",
    checksState: "none",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW - 20 * 60_000).toISOString(),
    headSha: "c94ea474f",
    headRefName: "run-W1-T9627-1792065434776",
    autoMergeArmed: false,
    ...over,
  };
}

function fakeDeps(path: string, now: number): SweepDeps {
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: path,
    runId: "SWEEP-W1-T9723",
    now: () => now,
  };
}

function disposedRows(path: string): Array<Record<string, unknown>> {
  return readLedgerLines(path).filter((line) => line.step === "sweep.disposed");
}

test("W1-T9723: a dirty head whose mergeability goes unread keeps the conflicting files a prior pass captured", async () => {
  const { repo, head } = seedConflict();
  const merge = spawnSync("git", ["-C", repo.dir, "merge-tree", "--write-tree", "main", head], { encoding: "utf8" });
  assert.equal(merge.status, 1, "git reports the merge as conflicted");
  assert.match(merge.stdout, new RegExp(`CONFLICT \\(content\\): Merge conflict in ${PATH}`));

  const evidence = hydrateMergeConflictEvidence("craigoley", "remudero", "main", [{ number: 11991, headRefOid: head }], gitBackedFetcher(repo));
  const captured = evidence.get(11991);
  assert.deepEqual(captured?.files.map((file) => file.path), [PATH], "the compare intersection is the one conflicting file");

  const path = ledgerPath();
  const pass1 = await runSweep([runPr({ headSha: head, mergeState: "dirty", mergeableState: "dirty", mergeConflict: captured })], fakeDeps(path, NOW), DEFAULT_SWEEP_POLICY);
  assert.equal(pass1.byDisposition.conflicted, 1, "pass one reads dirty with evidence: conflicted");

  for (const [n, minutes] of [[2, 19], [3, 21]] as const) {
    const pass = await runSweep([runPr({ headSha: head })], fakeDeps(path, NOW + minutes * 60_000), DEFAULT_SWEEP_POLICY);
    const row = disposedRows(path).at(-1)!;
    assert.equal(pass.byDisposition.conflicted, 1, `pass ${n}: mergeability unread, the carried files keep it conflicted: ${String(row.reason)}`);
    assert.equal(pass.byDisposition["blocked-ambiguous"] ?? 0, 0, `pass ${n} never escalates "files: none captured"`);
    assert.match(String(row.reason), new RegExp(PATH), `pass ${n} names the conflicting file`);
    assert.match(String(row.reason), /inherited last known "dirty"/);
    assert.deepEqual(row.conflict_files, [{ path: PATH, ours_deleted: 1, theirs_deleted: 1 }], `pass ${n} records the files forward`);
  }

  const moved = await runSweep([runPr({ headSha: "0000000aa" })], fakeDeps(path, NOW + 25 * 60_000), DEFAULT_SWEEP_POLICY);
  assert.equal(moved.byDisposition.conflicted ?? 0, 0, "nothing carries across a head change");
  assert.equal(disposedRows(path).at(-1)!.conflict_files, undefined);
});

test("W1-T9723: an empty conflict capture names why it is empty", async () => {
  const path = ledgerPath();
  appendLedger(path, { ts: new Date(NOW - 60_000).toISOString(), run_id: "SWEEP-PRIOR", task_id: "W1-T9627", step: "sweep.disposed", pr_number: 11991, head_sha: "c94ea474f", merge_state: "dirty", disposition: "blocked-ambiguous" });
  await runSweep([runPr()], fakeDeps(path, NOW), DEFAULT_SWEEP_POLICY);
  const row = disposedRows(path).at(-1)!;
  assert.equal(row.disposition, "blocked-ambiguous");
  assert.match(
    String(row.reason),
    /no valid conflicting-file evidence was captured: mergeability was unread this pass, so no compare was read for this PR, and no prior pass recorded conflict files for head c94ea47/,
  );

  const empty = deriveDisposition(runPr({ mergeState: "dirty", mergeConflict: { files: [], oursLog: "", theirsLog: "" } }), DEFAULT_SWEEP_POLICY, NOW);
  assert.match(empty.reason, /captured: GitHub's compare found no path changed on both sides since the merge base/);
  const malformed = deriveDisposition(
    runPr({ mergeState: "dirty", mergeConflict: { files: [{ path: " ", oursDeleted: 0, theirsDeleted: 0 }], oursLog: "", theirsLog: "" } }),
    DEFAULT_SWEEP_POLICY,
    NOW,
  );
  assert.match(malformed.reason, /captured: the captured file list was malformed/);
});

test("W1-T9723: a failed or capped compare read is recorded as the evidence gap", () => {
  const gaps = new Map<number, string>();
  const failing: GhApiFetcher = () => {
    throw new Error("gh: HTTP 502 Bad Gateway\n(body)");
  };
  const out = hydrateMergeConflictEvidence("craigoley", "remudero", "main", [
    { number: 11991, headRefOid: "c94ea474f" },
    { number: 12116, headRefOid: "e1560196c" },
  ], failing, 1, gaps);
  assert.equal(out.size, 0);
  assert.equal(gaps.get(11991), "the compare read failed: gh: HTTP 502 Bad Gateway");
  assert.equal(gaps.get(12116), "over the 1-PR conflict-evidence cap this pass");

  const d = deriveDisposition(runPr({ mergeState: "dirty", mergeConflictGap: gaps.get(11991) }), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(d.disposition, "blocked-ambiguous");
  assert.match(d.reason, /no valid conflicting-file evidence was captured: the compare read failed: gh: HTTP 502 Bad Gateway/);
});
