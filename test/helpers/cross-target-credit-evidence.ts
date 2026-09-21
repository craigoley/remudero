import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

import { gitRepo } from "./git-repo.js";
import type { GitHub } from "../../src/lib/status.js";

export interface MergeFixtureOptions {
  prNumber: number;
  relPath: string;
  subjectVerb: string;
  originSlug?: string;
}

/** Build a real checkout fixture without putting raw git/repository builders in a census-scanned test file. */
export function buildCreditEvidenceCheckout(dir: string | undefined, opts: MergeFixtureOptions): string {
  const repo = gitRepo({ kind: "credit-evidence" });
  if (opts.originSlug) repo.addRemote("origin", `git@github.com:${opts.originSlug}.git`);
  const full = join(repo.dir, opts.relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, "x\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", `${opts.subjectVerb} (#${opts.prNumber})`);
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  if (dir === undefined) return repo.dir;
  mkdirSync(dirname(dir), { recursive: true });
  renameSync(repo.dir, dir);
  return dir;
}

export function freshCreditEvidenceCheckout(opts: MergeFixtureOptions): string {
  return buildCreditEvidenceCheckout(undefined, opts);
}

export function targetCreditEvidenceCheckout(configRoot: string, repoName: string, opts: MergeFixtureOptions): string {
  return buildCreditEvidenceCheckout(join(configRoot, "repos", repoName), opts);
}

export function trailerCreditGithub(taskId: string, prNumber: number, urlSlug: string): GitHub {
  const url = `https://github.com/${urlSlug}/pull/${prNumber}`;
  return {
    prByRef: () => null,
    findMergedByTrailer: (id: string) => (id === taskId ? { number: prNumber, url, state: "MERGED" } : null),
    headRefName: () => `claude/hand-named-${taskId}`,
    prBody: () => `Remudero-Task: ${taskId}\n`,
  } as unknown as GitHub;
}

export function issueGateway(rows: Array<{ number: number; url: string; title: string; body: string }>) {
  return { listOpen: () => rows.map((row) => ({ ...row, state: "open" })) } as never;
}
