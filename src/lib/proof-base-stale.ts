import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { visibleCriteria } from "./plan.js";
import {
  execWhitelistedProof,
  materialiseBaseProofBlobs,
  parseWhitelistedProof,
  preexistingProofHits,
  type ProofExecutor,
  type WhitelistedProof,
} from "./review.js";
import { RMD_TMP_PREFIX } from "./tmp.js";

/**
 * W1-T4921 — A `grep:` PROOF THE REVIEWER WILL GRADE STALE, ASKED IN MILLISECONDS AND IN-PROCESS.
 *
 * `proof-discrimination` wants a proof to FAIL at the merge base and PASS at the head. `rmd check-proof --base` answers
 * that with one process tree per proof (7-11 s measured); the reviewer's own classifier, {@link preexistingProofHits},
 * answers it for a `grep:` proof from ONE base blob and no worktree. ONE PREDICATE: the pre-push precheck and
 * `rmd preflight --proofs` both call this, so the hook and the verb cannot disagree about which proofs are stale.
 * `unit test:` proofs are left to the gate, because running a test at the base is not cheap.
 */
export interface StaleProofRow {
  claim: string;
  proof: string;
  why: string;
}

export type ProofCriterion = { claim?: string; proof?: string; satisfied_by?: string; holdout?: boolean; kind?: string };

export interface StaleProofReaders {
  showBlob?: (cwd: string, rev: string, repoRelPath: string) => string;
  makeDir?: () => string;
  exec?: ProofExecutor;
}

/** The dialect `grep:` shape the reviewer's executor reads at both commits; a legacy fenced grep is not one. */
export function isDialectGrepProof(proof: string): boolean {
  const w = parseWhitelistedProof(proof.trim());
  return w?.kind === "grep" && w.authorSelectedArgv !== true && w.args.length === 4 && w.args[0] === "-arn" && w.args[1] === "--";
}

export function certainStaleProofs(
  criteria: readonly ProofCriterion[],
  cwd: string,
  baseRev: string,
  deps: StaleProofReaders = {},
): StaleProofRow[] {
  const showBlob =
    deps.showBlob ??
    ((dir: string, rev: string, rel: string) =>
      execFileSync("git", ["-C", dir, "show", `${rev}:${rel}`], {
        encoding: "utf8",
        maxBuffer: 1 << 26,
        stdio: ["ignore", "pipe", "pipe"],
      }));
  const makeDir = deps.makeDir ?? (() => mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}proof-base-stale-`)));
  const exec = deps.exec ?? execWhitelistedProof;

  const atHead: { c: ProofCriterion; w: WhitelistedProof }[] = [];
  for (const c of visibleCriteria([...criteria])) {
    const proof = (c.proof ?? "").trim();
    if (c.satisfied_by || c.kind === "guard" || !isDialectGrepProof(proof)) continue;
    const w = parseWhitelistedProof(proof) as WhitelistedProof;
    try {
      if (exec(w, cwd) === "pass") atHead.push({ c, w });
    } catch {
      continue; // deliberate: an exec error is an environment gap, never a finding
    }
  }
  if (atHead.length === 0) return [];

  const dir = makeDir();
  try {
    const { unreadable } = materialiseBaseProofBlobs(
      atHead.map((x) => x.c),
      baseRev,
      (rev, rel) => showBlob(cwd, rev, rel),
      (rel, contents) => {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), contents);
      },
    );
    const unreadablePaths = new Set(unreadable);
    return atHead
      .filter(({ w }) => preexistingProofHits(w, exec, dir, unreadablePaths, false))
      .map(({ c }) => ({
        claim: c.claim ?? "",
        proof: (c.proof ?? "").trim(),
        why: `the same grep also matches at the merge base ${baseRev.slice(0, 9)}, so proof-discrimination grades it executed_stale`,
      }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
