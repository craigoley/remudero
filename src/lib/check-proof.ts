import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { loadDefaultPolicy } from "./policy.js";
import { breMetacharsIn } from "./bre-metachars.js";
import { classifyGrepZeroHit } from "./grep-zero-cause.js";
import { grepOnlyBaseTargets, materialiseBaseGrepTree, type BaseGrepTreeReaders } from "./proof-base-stale.js";
import { spawnSync } from "node:child_process";
import { PROOF_FILE_READ_BYTES } from "./proof-file-reader-child.js";
import { hostWorktreeGit, WorktreePointerRefusedError, type HostWorktreeGitOptions } from "./worktree-git.js";
import { resolveTestPath } from "./test-path-resolver.js";
import {
  explainGrepProofRefusal, explainUnitTestProofRefusal, materialiseBaseProofBlobs,
  parseWhitelistedProof, resolveNameFilteredCandidates, narrowNameFilteredArgs, resolveProofTestPath, wrappedGrepPattern,
  execWhitelistedProof, defaultProofSpawner, proofFailureTail, registerReviewerCheckout, type ProofSpawner,
} from "./review.js";

const CHECK_PROOF_USAGE = "usage: rmd check-proof <proof> [--allow-full-suite] [--base <ref>] [--repo <owner/name>]";
export const CHECK_PROOF_CHILD_ENTRY = "src/check-proof-main.ts";
export const MISSING_EXPORT_OBSERVATION_FLAG = "--observe-missing-exports";

/** A missing materialised file alone proves nothing: independently read the literal Git tree. */
export function verifyBaseGrepAbsence(
  cwd: string, base: string, target: string,
  git: typeof hostWorktreeGit = hostWorktreeGit,
): { state: "absent"; tree: string } | { state: "unknown"; reason: string } {
  const rel = posix.normalize(target).replace(/\/+$/, "");
  if (!rel || rel === "." || posix.isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.includes("\0")) {
    return { state: "unknown", reason: "target is not a literal repository-relative path" };
  }
  try {
    const tree = git(cwd, ["rev-parse", "--verify", "--end-of-options", `${base}^{tree}`]).trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree)) return { state: "unknown", reason: "base tree identity is invalid" };
    const options = { env: { GIT_LITERAL_PATHSPECS: "1" }, maxBuffer: 1 << 26 };
    const list = (paths: string[]) => git(cwd, ["ls-tree", "-z", "--full-tree", tree, "--", ...paths], options);
    if (list([rel]) !== "") return { state: "unknown", reason: "target exists in the base tree despite missing materialisation" };
    const parts = rel.split("/");
    const ancestors = parts.slice(1).map((_, i) => parts.slice(0, i + 1).join("/"));
    // ls-tree cannot follow a symlink or gitlink; absence below one is not evidence about grep.
    if (ancestors.length > 0 && list(ancestors).split("\0").some((row) => {
      const tab = row.indexOf("\t");
      return tab >= 0 && ancestors.includes(row.slice(tab + 1)) && !row.startsWith("040000 tree ");
    })) return { state: "unknown", reason: "a non-directory ancestor prevents a literal tree comparison" };
    return { state: "absent", tree };
  } catch {
    return { state: "unknown", reason: "base tree could not be read" };
  }
}

function proofChildEntryArgv(root = fileURLToPath(new URL("../../", import.meta.url))): string[] {
  return ["--import", createRequire(import.meta.url).resolve("tsx"), resolve(root, CHECK_PROOF_CHILD_ENTRY)];
}

/** Resolve the harness entry and tsx from this package, even when cwd is a consumer repository. */
export function checkProofChildArgv(
  proof: string, base: string, root = fileURLToPath(new URL("../../", import.meta.url)),
): string[] {
  return [...proofChildEntryArgv(root), proof, "--base", base];
}

export function checkProofObservationChildArgv(): string[] {
  return [...proofChildEntryArgv(), MISSING_EXPORT_OBSERVATION_FLAG];
}

export type MissingExportObservation =
  | { state: "attributed"; note: string }
  | { state: "unproven" }
  | { state: "unavailable"; reason: "request-too-large" | "child-failed" | "invalid-response" | "invalid-request" | "observer-error" };

/** The synchronous CLI retains its reservation while a narrow child awaits confined reads. */
export function observeCliMissingExports(output: string, base: string, head: string, run = spawnSync): MissingExportObservation {
  try {
    const input = JSON.stringify({ output, base, head });
    if (Buffer.byteLength(input) > PROOF_FILE_READ_BYTES) return { state: "unavailable", reason: "request-too-large" };
    const args = checkProofObservationChildArgv();
    const child = run(process.execPath, args, { input, encoding: "utf8",
      env: { ...process.env, NODE_V8_COVERAGE: "" }, timeout: checkProofTimeoutMs(), maxBuffer: PROOF_FILE_READ_BYTES });
    if (child.error || child.signal || child.status !== 0) return { state: "unavailable", reason: "child-failed" };
    const response: unknown = JSON.parse(child.stdout);
    if (typeof response !== "object" || response === null) return { state: "unavailable", reason: "invalid-response" };
    const observed = response as Record<string, unknown>;
    if (observed.state === "attributed" && typeof observed.note === "string" && observed.note.length > 0)
      return { state: "attributed", note: observed.note };
    if (observed.state === "unproven") return { state: "unproven" };
    if (observed.state === "unavailable" && (observed.reason === "invalid-request" || observed.reason === "observer-error"))
      return { state: "unavailable", reason: observed.reason };
    return { state: "unavailable", reason: "invalid-response" };
  } catch { return { state: "unavailable", reason: "observer-error" }; }
}

/**
 * (R-11) What {@link buildBaseProofDir} hands back — the evidence fields it becomes, plus the one
 * fact the caller needs for teardown. `baseCheckoutDir` is a REAL CHECKOUT (a detached worktree at
 * the merge-base) exactly when `baseIsCheckout` is true; otherwise it is the blob-only fallback
 * (or absent), and `baseWorktreeFailure` names why the worktree could not be created.
 */
export interface BaseProofDir {
  baseCheckoutDir: string | undefined;
  baseUnreadablePaths: ReadonlySet<string>;
  baseIsCheckout: boolean;
  /** (W1-T5528) Set only on the `detachedAsync` path: the base probe's checkout still in flight. */
  pendingCheckout?: Promise<void>;
  /** True when every proof was a house-dialect `grep:` and `baseCheckoutDir` holds exactly the merge-base
   *  bytes at each target and nothing else ({@link materialiseBaseGrepTree}), never a checkout. A complete
   *  base for THOSE proofs; teardown is a plain delete ({@link releaseBaseProofDir}). */
  baseIsGrepTree?: boolean;
  baseWorktreeFailure?: string;
  /** (W1-T3190) Exactly the `test/**` paths COPIED in above, so `classifyBaseProofOutcome` reads
   *  the same set the copy used: a `grep:` naming one would otherwise find the copy and read as
   *  non-discriminating about a file the merge-base never had. Empty when no copy happened. */
  addedTestFiles: ReadonlySet<string>;
}

/** Build a detached base checkout, or a grep-only tree. Report missing or unreadable base evidence. */
export function buildBaseProofDir(
  criteria: ReadonlyArray<{ proof?: string }>,
  headCheckoutDir: string,
  deps: {
    detachedAsync?: { path: string; revision: string; run: (args: string[]) => Promise<void> };
    mergeBase?: (cwd: string) => string;
    showBlob?: (cwd: string, rev: string, repoRelPath: string) => string;
    makeDir?: () => string;
    /** (R-11) `git worktree add --detach <worktreePath> <revision>` run from `repoDir` — the same
     *  shape {@link ReviewWorktreeDeps.addWorktree} has for the head. Injected by tests to force the
     *  fallback (throw) or to observe the call; real callers omit it. */
    addWorktree?: (repoDir: string, worktreePath: string, revision: string) => void;
    /** (W1-T3098) The diff's ADDED `test/**` paths between `base` and the head checkout's
     *  `HEAD` — what {@link buildBaseProofDir} copies into the base worktree so a `unit test:` proof
     *  for a PR-added test can be RE-RUN there instead of failing on a file the merge-base checkout
     *  never had. Injected by tests against a real temp repo; real callers omit it. */
    changedTestFiles?: (headDir: string, base: string) => string[];
    /** (W1-T3098) Copies one file from the head checkout into the base worktree, creating parent
     *  directories as needed. Injected by tests to observe/force failure; real callers omit it. */
    copyFile?: (src: string, dest: string) => void;
    /** The grep tree's own git readers ({@link materialiseBaseGrepTree}); injected by tests only. */
    grepTree?: Omit<BaseGrepTreeReaders, "showBlob">;
  } = {},
): BaseProofDir {
  const detachedArgs = (path: string, revision: string) => ["worktree", "add", "--detach", path, revision];
  if (deps.detachedAsync) {
    const { path, revision, run } = deps.detachedAsync;
    return {
      baseCheckoutDir: path, baseUnreadablePaths: new Set(), addedTestFiles: new Set(), baseIsCheckout: false,
      pendingCheckout: run(detachedArgs(path, revision)),
    };
  }
  const mergeBase = deps.mergeBase ?? ((cwd: string) => hostWorktreeGit(cwd, ["merge-base", "origin/main", "HEAD"]).trim());
  const showBlob =
    deps.showBlob ??
    ((cwd: string, rev: string, rel: string) =>
      // W1-T460: `stdio` PIPES git's stderr instead of letting it inherit the reviewer's. Without
      // it, the routine absent-at-base read (every filing PR has one) printed `fatal: path … does
      // not exist in …` straight through a PASSING review — it surfaced on #1732/#1734/#1735/#1736
      // and reads as breakage. Piping does not change what the caller can tell apart: the
      // absence-vs-read-failure classification `baseBlobErrorIsAbsence` keys on (`status: 128` vs a
      // Node `code`) was MEASURED with stderr already piped, and is locked by
      // test/base-blob-read-failure.test.ts Group 0.
      hostWorktreeGit(cwd, ["show", `${rev}:${rel}`], { maxBuffer: 1 << 26 }));
  const addWorktree =
    deps.addWorktree ??
    ((repoDir: string, worktreePath: string, revision: string) =>
      // stderr PIPED for the same reason `showBlob` pipes it: a base the repo cannot check out is
      // a degrade this function REPORTS (`baseWorktreeFailure`), never a `fatal:` line through a
      // passing review. `--detach`: no branch name is ever wanted here (W1-T232's lesson at the head).
      hostWorktreeGit(repoDir, detachedArgs(worktreePath, revision)));
  const makeDir = deps.makeDir ?? (() => mkdtempSync(join(tmpdir(), "rmd-proof-base-")));
  // (W1-T3098) `--diff-filter=A` — ADDED ONLY, never M/D/R/C. The narrowing from `AM` is this
  // seam's correctness, and the two halves are asymmetric:
  //
  // ADDED IS THE POINT. A file the base never had makes `node --test` fail on a MISSING FILE there,
  // and "absent" is not "fails" — that result says nothing about the code. Copying it in makes the
  // base run the SAME test, which is what separates a new test passing at base anyway (proves
  // nothing, graded `executed_stale`) from one that needs this PR's own source change (real
  // discrimination, because its import or assertion is what is missing at base).
  //
  // MODIFIED MUST NOT BE COPIED. A modified file EXISTS at base and its own version already runs
  // there — that run IS the evidence. Overwriting it with the head version manufactures a pass: a
  // test legitimately FAILING at base passes instead, and the single strongest discrimination
  // signal (a task REPAIRING a failing test, the case CLAUDE.md names) silently grades stale.
  // MEASURED on this branch 2026-09-08, running
  // test/check-proof-declines-on-a-parity-that-no-longer-holds.test.ts under each filter: with `AM`
  // exactly one case reddens — "a unit-test proof that passes at head and fails at base reports
  // discrimination, verdict unchanged" — and with `A` the file is 8/8. That case is this rule's
  // falsifier; restore the `M` and it fails again.
  //
  // The pathspec restricts the walk to `test/` itself, matching design (iv): only files a
  // `unit test:` proof could ever name are ever copied.
  const changedTestFiles =
    deps.changedTestFiles ??
    ((headDir: string, base: string) =>
      hostWorktreeGit(headDir, ["diff", "--name-only", "--diff-filter=A", base, "HEAD", "--", "test/"])
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean));
  const copyFile =
    deps.copyFile ??
    ((src: string, dest: string) => {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(src));
    });

  const noBase: BaseProofDir = { baseCheckoutDir: undefined, baseUnreadablePaths: new Set<string>(), baseIsCheckout: false, addedTestFiles: new Set<string>() };
  // No DIALECT proof at all (prose only, or no criteria) ⇒ nothing will ever be re-run against a
  // base, so no checkout is paid for. A single `grep:` OR `unit test:` proof is enough to want one.
  if (!criteria.some((c) => typeof c.proof === "string" && parseWhitelistedProof(c.proof) !== null)) return noBase;
  let base: string;
  try {
    base = mergeBase(headCheckoutDir);
  } catch {
    return noBase; // unresolvable base ⇒ no staleness signal, never a false positive
  }
  if (!base) return noBase;
  // W1-T9860: the BASE tree resolves each cited test path in its own index, so a test that sat elsewhere at the base
  // is materialised where the base really had it. An exact hit or an unresolved path leaves the proof as cited.
  const baseCriteria = criteria.map((c) =>
    typeof c.proof === "string" ? { ...c, proof: resolveProofTestPath(c.proof, headCheckoutDir, { tree: base }).proof } : c);

  const dir = makeDir();
  // A review whose every proof is a `grep:` reads the base blobs it names and checks nothing out: the
  // grep reads one path, and a checkout of the whole tree for it was observed taking 66 minutes on a loaded host.
  const grepTargets = grepOnlyBaseTargets(baseCriteria);
  if (grepTargets !== undefined) {
    const tree = materialiseBaseGrepTree(headCheckoutDir, base, grepTargets, dir, { ...deps.grepTree, showBlob: deps.showBlob });
    if (tree.needsCheckout.length === 0) {
      // (W1-T3190) The same ADDED set the worktree path copies, so a grep naming a test file this diff adds
      // still classifies `discriminates`; nothing is copied, since no test re-runs in a grep tree.
      let added: string[] = [];
      try {
        if (grepTargets.some((t) => t.startsWith("test/"))) added = changedTestFiles(headCheckoutDir, base);
      } catch {
        // `git diff` broke: no added file is known, which is the pre-W1-T3098 reading and never a false stale.
      }
      return { baseCheckoutDir: dir, baseUnreadablePaths: new Set(tree.unreadable), baseIsCheckout: false, baseIsGrepTree: true, addedTestFiles: new Set(added) };
    }
    // A symlink or submodule on the way to a target: only a real checkout resolves it, into an empty dir.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
  let worktreeFailure: string;
  try {
    addWorktree(headCheckoutDir, dir, base);
    registerReviewerCheckout(dir);
    // (W1-T3098) THE DIFFERENTIAL RUN: a bare `git worktree add --detach <dir> <base>` (R-11) is a
    // checkout of the MERGE-BASE and so never contains a test the PR itself added — `node --test`
    // there finds nothing, exits nonzero, and the classifier used to read that as `discriminates`.
    // Copy the diff's ADDED `test/**` files in at the same repo-relative paths so the SAME
    // proof that just passed on the head can actually be re-run here. Best-effort and isolated in
    // its own try: a copy failure (or a `git diff` that itself throws) narrows what gets re-run —
    // that one file's proof falls back to whatever it graded before this change — it must never
    // downgrade `baseIsCheckout`, which is a fact about the WORKTREE, already true by this point,
    // not about any one file inside it.
    const copiedTestFiles = new Set<string>();
    try {
      for (const rel of changedTestFiles(headCheckoutDir, base)) {
        try {
          copyFile(join(headCheckoutDir, rel), join(dir, rel));
          copiedTestFiles.add(rel); // W1-T3190: only on SUCCESS, so set and tree agree
        } catch {
          // per-file: leave this one path absent from the base tree, exactly as before this change
        }
      }
    } catch {
      // `changedTestFiles` itself failed to run (e.g. `git diff` broke) — no files copied, no worse
      // than the pre-W1-T3098 checkout.
    }
    return { baseCheckoutDir: dir, baseUnreadablePaths: new Set<string>(), baseIsCheckout: true, addedTestFiles: copiedTestFiles };
  } catch (e) {
    // Not erased: the reason rides out on `baseWorktreeFailure` below, where `rmd check-proof`
    // prints it and the classifier reads the fallback's `baseIsCheckout: false` (R-11).
    worktreeFailure = String((e as Error)?.message ?? e);
  }
  // FALLBACK: the pre-R-11 blob materialisation, byte-for-byte, into the same dir.
  const { written, unreadable } = materialiseBaseProofBlobs(
    baseCriteria,
    base,
    (rev: string, rel: string) => showBlob(headCheckoutDir, rev, rel),
    (rel: string, contents: string) => {
      const dest = join(dir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, contents);
    },
  );
  return {
    baseCheckoutDir: written > 0 ? dir : undefined,
    baseUnreadablePaths: new Set(unreadable),
    baseIsCheckout: false,
    addedTestFiles: new Set<string>(), // the blob fallback copies nothing in; absent means absent

    baseWorktreeFailure: worktreeFailure,
  };
}

/** `rmd check-proof <proof>`. */
/** Opt-in for the one `check-proof` path that would otherwise run the ENTIRE suite — see the
 *  `unresolvable` branch in {@link checkProofCommand}. */
export const CHECK_PROOF_FULL_SUITE_FLAG = "--allow-full-suite";

/** Stable verdict exits: pass 0, fail 1, refused 2, no-match 3, execution error 4, stale 5. */
export const CHECK_PROOF_EXIT = {
  pass: 0,
  fail: 1,
  refused: 2,
  noMatch: 3,
  execError: 4,
  executedStale: 5,
} as const;

/** Fallback when plan/policy.yaml cannot be read: that file's own documented floor for
 *  `proofTimeoutMs`, so this verb is never less bounded than the reviewer. */
const CHECK_PROOF_TIMEOUT_FLOOR_MS = 60_000;

/**
 * How long `check-proof` lets a proof run. Time-boxed for the SAME reason the reviewer time-boxes,
 * reading the SAME policy field (`proofTimeoutMs`) so the two cannot drift: a proof that hangs must
 * fail rather than wedge the operator's terminal — this verb had no timeout at all, which is half of
 * what made the whole-suite fallback below so expensive.
 *
 * Best-effort by design: an unreadable policy must not turn a diagnostic verb into a crash, so it
 * degrades to that field's own documented floor. `readPolicy` is injected LAST and defaulted, so no
 * caller shifts — and so the catch arm is reachable from a test rather than being dead code that
 * only fires on a broken checkout.
 */
export function checkProofTimeoutMs(readPolicy?: () => number): number {
  try {
    // THE SEAM IS THE `??` FORM DELIBERATELY. test/config-reader-seams.test.ts detects an
    // injectable policy read by the literal `?? loadDefaultPolicy(` shape; a defaulted PARAMETER
    // is just as injectable but reads to that detector as unseamed, and allowlisting it would
    // trip its own stale-entry lock (an allowlisted reader that HAS a seam is a failure). Writing
    // the seam in the house form is cheaper than teaching the detector a second shape.
    return readPolicy?.() ?? loadDefaultPolicy().values.proofTimeoutMs;
  } catch (error) {
    console.error(`(proof timeout policy unreadable; using ${CHECK_PROOF_TIMEOUT_FLOOR_MS}ms: ${String(error)})`);
    return CHECK_PROOF_TIMEOUT_FLOOR_MS;
  }
}


export function checkProofCommand(
  rest: string[],
  deps: {
    pathStatus?: (cwd: string, path: string) => string;
    observeMissingExports?: typeof observeCliMissingExports;
    /** W1-T912: injectable ONLY for tests. Real callers (the CLI dispatch below) omit this and
     *  get {@link buildBaseProofDir}'s own default `git show` — see its doc for why that is the
     *  right default. Overriding `showBlob` here is what makes a `--base` comparison decidable
     *  from two literal fixture trees with NO spawn beyond the executor this verb already
     *  drives (execWhitelistedProof's own grep/`node --test`) — the "base" tree never needs a
     *  real git rev to exist for a test. */
    baseBlobDeps?: {
      showBlob?: (cwd: string, rev: string, repoRelPath: string) => string;
      makeDir?: () => string;
      /** (R-11) the merge-base worktree seam — thrown from, in a test, to reach the blob fallback. */
      addWorktree?: (repoDir: string, worktreePath: string, revision: string) => void;
      /** (R-11) teardown of that worktree — thrown from, in a test, to prove a failed teardown never
       *  masks the verdict already computed. */
      removeWorktree?: (repoDir: string, worktreePath: string) => void;
    };
  } = {},
  usage: string = CHECK_PROOF_USAGE,
): number {
  // Matched as STANDALONE tokens, never a substring: a proof body is free text that could
  // legitimately quote either flag's name.
  const allowFullSuite = rest.includes(CHECK_PROOF_FULL_SUITE_FLAG);
  const baseFlagIdx = rest.indexOf("--base");
  const baseRef = baseFlagIdx >= 0 ? rest[baseFlagIdx + 1] : undefined;
  if (baseFlagIdx >= 0 && baseRef === undefined) {
    console.error("rmd check-proof: --base needs a <ref> argument, e.g. `--base origin/main`\n" + usage);
    return CHECK_PROOF_EXIT.refused;
  }
  // W1-T4590: `--repo <owner/name>` resolves the proof against THAT repository's registered suite
  // roots, as the reviewer does (W1-T3525). Omitted, the default target is unchanged.
  const repoFlagIdx = rest.indexOf("--repo");
  const repoSlug = repoFlagIdx >= 0 ? rest[repoFlagIdx + 1] : undefined;
  const [repoOwner, repoName] = repoSlug?.split("/") ?? [];
  if (repoFlagIdx >= 0 && (!repoOwner || !repoName)) {
    console.error("rmd check-proof: --repo needs <owner/name>, e.g. `--repo craigoley/remudero-console`\n" + usage);
    return CHECK_PROOF_EXIT.refused;
  }
  const target = repoOwner && repoName ? { owner: repoOwner, repo: repoName } : undefined;
  const flagTokens = new Set<number>();
  for (const idx of [baseFlagIdx, repoFlagIdx]) if (idx >= 0) flagTokens.add(idx).add(idx + 1);
  const proof = rest
    .filter((t, i) => {
      if (t === CHECK_PROOF_FULL_SUITE_FLAG) return false;
      // Only ever excludes a PRESENT flag's own token and its value token, so a caller who omits
      // both --base and --repo keeps a byte-identical proof string.
      return !flagTokens.has(i);
    })
    .join(" ")
    .trim();
  if (!proof) {
    console.error("rmd check-proof: give me a proof, e.g. `rmd check-proof 'grep: foo in src/lib/bar.ts'`\n" + usage);
    return CHECK_PROOF_EXIT.refused;
  }
  // W1-T9860: a cited test path that moved resolves by its unique basename at the head, and this verb says so.
  const headResolution = resolveProofTestPath(proof, process.cwd(), { target });
  const w = parseWhitelistedProof(headResolution.proof, target);
  if (!w) {
    console.log(`proof:      ${proof}`);
    console.log("parse:      REFUSED — parseWhitelistedProof returned null.");
    // R-12: name the cause when the parser can — a directory-shaped target, a missing `in <path>`
    // clause, a traversal — instead of only the generic hint below.
    const why = explainGrepProofRefusal(proof) ?? explainUnitTestProofRefusal(proof, target);
    if (why !== undefined) console.log(`            reason: ${why}`);
    console.log(
      "            A `grep:` proof needs an explicit `in <path>` clause; a `unit test:` proof needs a\n" +
        "            test path or title. A proof wrapped in markdown backticks parses since #1063, but a\n" +
        "            proof with no dialect prefix at all is prose and never executes.",
    );
    return CHECK_PROOF_EXIT.refused;
  }
  console.log(`proof:      ${proof}`);
  console.log(`parse:      OK — kind=${w.kind}${w.nameFiltered ? " (name-filtered)" : ""}`);
  if (headResolution.note !== undefined) console.log(`resolved:   ${headResolution.note}`);
  else if (headResolution.resolution !== undefined && "unresolved" in headResolution.resolution && headResolution.resolution.unresolved === "ambiguous")
    console.log(`resolved:   NOT — ${headResolution.cited} is absent and its basename names ${headResolution.resolution.candidates.join(", ")}; not guessed`);

  let args = w.args as readonly string[];
  if (w.nameFiltered && w.runner === "vitest") {
    // The registered Vitest target already scopes the run to its own tests/ root. The
    // Node-only grep resolver searches this repo's test/ root and would refuse a valid
    // site/console proof before the shared reviewer executor could run it.
    console.log("candidates: delegated to the registered Vitest suite root");
  } else if (w.nameFiltered) {
    const r = resolveNameFilteredCandidates(process.cwd(), w.label);
    if (r.status === "resolved") {
      console.log(`candidates: ${r.files.length} file(s) — ${r.files.join(", ")}`);
      args = narrowNameFilteredArgs(w.args, r.files);
    } else {
      console.log(`candidates: ${r.status}${"reason" in r ? ` — ${r.reason}` : ""}`);
      if (r.status === "absent") {
        console.log("verdict:    no-match — the executor fast-fails here and never spawns node.");
        return CHECK_PROOF_EXIT.noMatch;
      }
      // UNRESOLVABLE ⇒ `narrowNameFilteredArgs` returns the args UNCHANGED, still carrying
      // TEST_GLOB — so executing here runs the ENTIRE SUITE. That fallback is defensible inside
      // the reviewer, whose own comment argues it: with no evidence either way, the wide run is
      // the honest attempt. It was NOT defensible here, because this verb called `spawnSync` with
      // no `timeout` — so an operator asking a one-line question about one proof got an UNBOUNDED
      // full-suite run. review.ts's comment names what that costs: "the full glob loads every file
      // including several that drive a real headless browser and hang when the name filter matches
      // none of their tests".
      //
      // The trigger is not exotic. `resolveNameFilteredCandidates` answers `unresolvable` whenever
      // `couldBeInterpolatedTitle` is true — i.e. whenever the proof's title merely SHARES A
      // STATIC CHUNK with any template-literal title in the corpus — which happens in a perfectly
      // ordinary checkout, and is indistinguishable to the author from a title that simply typo'd.
      //
      // So: report, and decline to be the thing that runs the suite. Everything an author came for
      // (parse kind, the resolution and its reason, the exact argv) is printed either way; only
      // the spawn is withheld.
      if (!allowFullSuite) {
        console.log(`argv:       ${w.command} ${args.join(" ")}`);
        console.log(
          "verdict:    NOT EXECUTED — this proof resolved to no file, so running it would run the\n" +
            "            WHOLE test suite (note the trailing glob in the argv above), unbounded.\n" +
            `            Re-run with ${CHECK_PROOF_FULL_SUITE_FLAG} to do it anyway (time-boxed to the\n` +
            "            same proofTimeoutMs the reviewer uses), or name a test/<file>.test.ts path —\n" +
            "            the path form runs exactly one file.",
        );
        return CHECK_PROOF_EXIT.refused;
      }
    }
  }
  console.log(`argv:       ${w.command} ${args.join(" ")}`);

  // W1-T1224: resolve the grep TARGET PATH and PATTERN once, up front — {@link grepZeroHitCauseLine}
  // below and the exec_error branch's path-absent check both need them, and the --base block
  // further down already relied on this same "argv's last element is the path" assumption (see its
  // own comment, unchanged) before this task; pattern is the element right before it, matching how
  // parseDialectGrep (review.ts) always compiles a `grep:` proof's args as `[..flags, "--", pattern,
  // path]`.
  const grepTargetPath = w.kind === "grep" && w.args.length >= 1 ? w.args[w.args.length - 1] : undefined;
  const grepPattern = w.kind === "grep" && w.args.length >= 2 ? w.args[w.args.length - 2] : undefined;

  // W1-T1224: the static BRE-metacharacter note used to print unconditionally on every non-pass
  // grep verdict, whether or not the pattern actually carried one — now gated (below) behind
  // breMetacharsIn actually finding one of `[ * ^ $` in the pattern, the SAME check
  // proofGrepSafetyViolations (task-linter.ts) already uses to decide whether a pattern is
  // BLOCKING-unsafe.
  const GREP_METACHAR_NOTE =
    "note:       a `grep:` pattern is a BASIC REGULAR EXPRESSION, not a literal — `[`, `*`, `^`, `$`\n" +
    "            are metacharacters. Do NOT re-check this with `grep -F`; that is a different matcher.";
  const grepPatternHasBlockingMetachar = grepPattern !== undefined && breMetacharsIn(grepPattern).blocking.length > 0;

  /**
   * W1-T1224 — WHY a zero-hit `grep:` proof read zero, as a `cause:` line alongside the unchanged
   * `verdict:`/exit code (design (iii): report, do not re-rank). Calls {@link classifyGrepZeroHit}
   * (src/lib/grep-zero-cause.ts) — this file derives NO cause of its own, only reads the file and
   * formats what the classifier returns. `undefined` when there is nothing to say: a non-grep
   * proof, or a target path/pattern argv could not resolve.
   */
  function grepZeroHitCauseLine(): string | undefined {
    // grepTargetPath/grepPattern are only ever set (above) when w.kind === "grep" — reading them
    // rather than w.kind again keeps this closure from needing TS to re-narrow `w` (a `const` from
    // an outer scope; type guards on it do not apply inside a nested function declaration).
    if (grepTargetPath === undefined || grepPattern === undefined) return undefined;
    let fileText: string;
    try {
      fileText = readFileSync(join(process.cwd(), grepTargetPath), "utf8");
    } catch {
      return undefined; // the file the executor just read a moment ago is now unreadable — say nothing rather than guess
    }
    switch (classifyGrepZeroHit(grepPattern, fileText)) {
      case "line-seam":
        return (
          "cause:      line-seam — the pattern's text IS in the file, but a line break falls inside\n" +
          "            it (a YAML fold or a wrapped paragraph). grep is line-based and this can NEVER\n" +
          "            match as written — rejoin the phrase onto one physical line, or rewrite the\n" +
          "            pattern to match text that already lives on one line."
        );
      case "case-only":
        return (
          "cause:      case-only — the pattern's text IS in the file with different capitalisation.\n" +
          "            grep here is case-sensitive and this can NEVER match as written — match the\n" +
          "            file's actual case, or write a separate case-insensitive proof if that is truly\n" +
          "            the intent."
        );
      case "absent": {
        const wrapped = wrappedGrepPattern(proof);
        // A literal identifier needs no second regex dialect to establish its presence.
        if (wrapped && /^[A-Za-z0-9_-]+$/.test(wrapped.bare) && fileText.includes(wrapped.bare)) {
          return (
            "cause:      literal-wrapper — the unquoted identifier IS present on a physical line,\n" +
            "            but the proof also requires its literal surrounding delimiters. The executor\n" +
            "            passes argv directly: quotes/backticks inside the pattern are data, not shell\n" +
            "            quoting. The original proof still fails; this is not unwritten future work."
          );
        }
        return (
          "cause:      absent — the pattern's text is not in the file in any form (line-wrap and case\n" +
          "            both probed). This reads as a legitimate FORWARD REFERENCE to work not yet\n" +
          "            written, not as a broken proof."
        );
      }
      case "matched":
        return (
          "cause:      matched — this classifier's own probe found a line match despite the real grep\n" +
          "            reading zero hits; that is a matcher disagreement, not a fact about the file —\n" +
          "            treat it as a bug report against the classifier, never as evidence either way."
        );
    }
  }

  // W1-T387: THE COLLAPSE. Everything above this line is UNCHANGED diagnostics (parse kind,
  // candidate resolution, the exact argv) — the whole point is that they survive. From here down,
  // the VERDICT is decided by execWhitelistedProof itself, the SAME function judgeCriterion calls
  // at review time, never by this file re-deriving pass/fail from a raw exit code again.
  //
  // execWhitelistedProof returns only "pass" | "fail" | "no-match" (or throws) — no stdout, no
  // exit code, no signal. `capturingSpawn` wraps the REAL spawner (review.ts's own
  // `defaultProofSpawner`, the identical primitive execWhitelistedProof would use by default) and
  // records what it observed on the side, purely so the diagnostics below (`exit:`, `hits:`) can
  // still be printed — this file never reads `diag` to decide the verdict.
  type SpawnDiagnostics = { stdout: string; stderr: string; status: number | null; signal: NodeJS.Signals | null };
  // Use the reviewer's bounded, redacted tail: the CLI must preserve the runner's refusal evidence,
  // not its entire output (or credentials), and must never turn that evidence into a new verdict.
  function printFailureOutput(side: "head" | "base", observed: SpawnDiagnostics | undefined, tail?: string): void {
    const kept = tail ?? proofFailureTail(observed?.stdout ?? "", observed?.stderr ?? "");
    console.log(`${side} output:\n${kept === "" ? "(no output captured)" : kept}`);
  }
  let diag: SpawnDiagnostics | undefined;
  const capturingSpawn: ProofSpawner = (command, spawnArgs, spawnCwd, spawnTimeoutMs) => {
    const proofPaths = grepTargetPath === undefined
      ? spawnArgs.filter((arg) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(arg))
        .flatMap((arg) => globSync(arg, { cwd: spawnCwd }))
      : [grepTargetPath];
    const pathStatus = deps.pathStatus ?? ((cwd: string, path: string) => hostWorktreeGitAtTopLevel(
      cwd, ["--literal-pathspecs", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--", resolve(cwd, path)],
      { log: () => {} },
    ));
    for (const path of new Set(proofPaths)) {
      let status: { kind: "read"; text: string } | { kind: "unreadable"; error: unknown };
      try {
        status = { kind: "read", text: pathStatus(spawnCwd, path) };
      } catch (error) {
        status = { kind: "unreadable", error };
      }
      if (status.kind === "read" && status.text.trim() !== "") {
        console.error(`warning:    ${path} differs from HEAD; the pushed head may answer differently.`);
      }
    }
    try {
      const out = defaultProofSpawner(command, spawnArgs, spawnCwd, spawnTimeoutMs);
      diag = { stdout: out, stderr: "", status: 0, signal: null };
      return out;
    } catch (e) {
      const err = e as NodeJS.ErrnoException & {
        status?: number | null;
        signal?: NodeJS.Signals | null;
        stdout?: string | Buffer | null;
        stderr?: string | Buffer | null;
      };
      diag = {
        stdout: typeof err.stdout === "string" ? err.stdout : (err.stdout?.toString("utf8") ?? ""),
        stderr: typeof err.stderr === "string" ? err.stderr : (err.stderr?.toString("utf8") ?? ""),
        status: typeof err.status === "number" ? err.status : null,
        signal: err.signal ?? null,
      };
      throw e;
    }
  };

  let outcome: "pass" | "fail" | "no-match";
  try {
    outcome = execWhitelistedProof(w, process.cwd(), checkProofTimeoutMs(), capturingSpawn);
  } catch (e) {
    // exec_error: a timeout, a spawn failure, or (grep only) exit 2 — "could not even look",
    // never treated as evidence of a failing proof (W1-T219). Same class of run the reviewer
    // degrades to the keyword floor rather than an executed_fail.
    if (diag) {
      console.log(`exit:       ${diag.status === null ? `killed by ${diag.signal}` : diag.status}`);
      const hits = diag.stdout.split("\n").filter((l) => l.trim() !== "").length;
      console.log(`hits:       ${hits}`);
    }
    printFailureOutput("head", diag);
    // execFileSync's message repeats stderr; do not leak the unbounded, unredacted copy after the tail.
    console.log(`verdict:    exec_error — ${proofFailureTail(String((e as Error)?.message ?? e).split("\n")[0])}`);
    // W1-T1224 (design (iv)): an ABSENT path is the one exec_error cause this task names — it
    // still reports exec_error and exit 4 exactly as before (no caller shifts), it simply gains
    // this line. Checked with existsSync rather than the classifier: there is no file text to
    // read at all, so classifyGrepZeroHit has nothing to classify.
    if (w.kind === "grep" && grepTargetPath !== undefined && !existsSync(join(process.cwd(), grepTargetPath))) {
      console.log(
        `cause:      path-absent — ${grepTargetPath} does not exist; grep could not even look (a\n` +
          "            renamed/missing target, or a permission error).",
      );
      // W1-T9860: say what the basename lookup found, so a moved test's ambiguity is named rather than silent.
      const lookup = resolveTestPath(grepTargetPath, { root: process.cwd() });
      if ("unresolved" in lookup && lookup.reason === undefined) {
        const named = lookup.candidates.length > 0 ? ` (${lookup.candidates.join(", ")})` : "";
        console.log(`            basename lookup: ${lookup.unresolved}${named} — never guessed`);
      }
    }
    if (grepPatternHasBlockingMetachar) console.log(GREP_METACHAR_NOTE);
    return CHECK_PROOF_EXIT.execError;
  }

  if (diag) {
    console.log(`exit:       ${diag.status === null ? `killed by ${diag.signal}` : diag.status}`);
    const hits = diag.stdout.split("\n").filter((l) => l.trim() !== "").length;
    console.log(`hits:       ${hits}`);
    if (outcome !== "fail" && diag.stdout.trim()) console.log(diag.stdout.trimEnd().split("\n").slice(0, 10).join("\n"));
  }
  if (outcome === "fail") printFailureOutput("head", diag, w.failureTail);
  console.log(`verdict:    ${outcome}`);
  if (w.kind === "grep" && outcome !== "pass") {
    // W1-T1224: check-proof calls the classifier rather than deriving a cause of its own —
    // classifyGrepZeroHit( in src/lib/check-proof.ts, above, is the wiring this line exercises.
    const causeLine = grepZeroHitCauseLine();
    if (causeLine) console.log(causeLine);
    if (grepPatternHasBlockingMetachar) console.log(GREP_METACHAR_NOTE);
  }
  const headExit =
    outcome === "pass" ? CHECK_PROOF_EXIT.pass : outcome === "fail" ? CHECK_PROOF_EXIT.fail : CHECK_PROOF_EXIT.noMatch;

  // W1-T912: --base ABSENT ⇒ nothing below this line ever runs, and every line printed above (and
  // `headExit`, this function's return value with no --base) is byte-identical to before this task —
  // no existing caller shifts. See this function's own doc comment for the full design.
  if (baseRef === undefined) return headExit;

  console.log(`base ref:   ${baseRef}`);
  // Reuses the SAME builder `rmd review` wires (buildBaseProofDir: a detached worktree at <ref>,
  // falling back to materialiseBaseProofBlobs), injected with `<ref>` in place of the real
  // `git merge-base origin/main HEAD` — everything downstream (the worktree, the blob fallback, the
  // absent/unreadable distinction) is the reviewer's own mechanism, not a second implementation
  // kept in sync by hand.
  const { removeWorktree, ...builderDeps } = deps.baseBlobDeps ?? {};
  const built = buildBaseProofDir([{ proof }], process.cwd(), {
    mergeBase: () => baseRef,
    ...builderDeps,
  });
  try {
    return compareAgainstBase(built);
  } finally {
    // (R-11) A worktree or grep tree this verb built is this verb's to remove — the reviewer's
    // `withMaterializedWorktree` does the same for its own. A blob-fallback dir is left to the boot sweep.
    releaseBaseProofDir(process.cwd(), built, removeWorktree);
  }

  function compareAgainstBase(base: BaseProofDir): number {
    const { baseCheckoutDir, baseUnreadablePaths } = base;
    // W1-T9860: the base resolves the CITED path in its own tree, as buildBaseProofDir materialised it. A base that
    // cannot resolve it re-runs the head's proof, as if the plan had cited the moved path itself.
    const baseResolution = resolveProofTestPath(proof, process.cwd(), { tree: baseRef!, target });
    if (baseResolution.note !== undefined) console.log(`base resolved: ${baseResolution.note}`);
    const baseW =
      baseResolution.note !== undefined
        ? (parseWhitelistedProof(baseResolution.proof, target) ?? w!)
        : baseResolution.resolution !== undefined && "path" in baseResolution.resolution
          ? (parseWhitelistedProof(proof, target) ?? w!)
          : w!;
    const baseGrepTargetPath = baseW.kind === "grep" && baseW.args.length >= 1 ? baseW.args[baseW.args.length - 1] : undefined;
    // baseGrepTargetPath mirrors grepProofTargetPath (review.ts, unexported): the argv's last element, read off the
    // base's own resolved proof. It equals the head's grepTargetPath unless a test moved between the two trees.
    // A grep tree holds a target only when the base had it and the read succeeded, so a missing one
    // reads exactly as the blob path's absent or unreadable blob does.
    const grepTreeLacksTarget =
      base.baseIsGrepTree === true &&
      baseGrepTargetPath !== undefined &&
      !base.addedTestFiles.has(baseGrepTargetPath) &&
      !existsSync(join(baseCheckoutDir!, baseGrepTargetPath));

    if (baseCheckoutDir === undefined || grepTreeLacksTarget) {
      if (baseGrepTargetPath !== undefined && baseUnreadablePaths.has(baseGrepTargetPath)) {
        console.log(
          `base:       UNREADABLE — \`git show ${baseRef}:${baseGrepTargetPath}\` failed to read; the base\n` +
            "            comparison is inconclusive and never counted as a false discrimination — the same\n" +
            "            base_unreadable degrade the reviewer itself uses (W1-T460).",
        );
      } else if (baseGrepTargetPath !== undefined) {
        const absence = grepTreeLacksTarget
          ? verifyBaseGrepAbsence(process.cwd(), baseRef!, baseGrepTargetPath)
          : { state: "unknown", reason: "no materialised base tree" } as const;
        if (absence.state === "absent") {
          console.log(`base:       ABSENT at ${baseRef} — ${baseGrepTargetPath}; verified literal tree ${absence.tree}.`);
          console.log("discrimination: discriminates — this proof's target did not exist at the verified base tree.");
          return headExit;
        }
        console.log(
          `base:       ABSENT at ${baseRef} — ${baseGrepTargetPath} was not materialised (possible forward reference).\n` +
            `            Git-tree absence is unverified: ${absence.reason}; this is not evidence of discrimination.`,
        );
      } else {
        // (R-11) A `unit test:` proof with no checkout to run in. The worktree is the only base a
        // test can be re-run against; without one the reviewer grades base_unknown, and so does this.
        console.log(
          `base:       UNKNOWN — a merge-base worktree at ${baseRef} could not be created` +
            (base.baseWorktreeFailure ? ` (${base.baseWorktreeFailure.split("\n")[0]})` : "") +
            `, and a \`unit test:\` proof (kind=${baseW.kind}) cannot be re-run against materialised\n` +
            "            blobs — the reviewer grades exactly this base_unknown (R-11): no downgrade, and NO\n" +
            "            claim that the proof discriminates; the verdict above stands unchanged.",
        );
      }
      console.log("discrimination: unknown — reported verdict above stands unchanged");
      return headExit;
    }

    // `buildBaseProofDir` copies ADDED test files into its base checkout only so a `unit test:`
    // proof can exercise the same test against base source. A `grep:` proof targeting that copied
    // file still names a path absent at the merge base, so it discriminates by construction. The
    // reviewer owns this distinction in `classifyBaseProofOutcome`; without this matching arm the
    // public diagnostic executes grep against the copied head file and falsely reports stale.
    if (baseW.kind === "grep" && baseGrepTargetPath !== undefined && base.addedTestFiles.has(baseGrepTargetPath)) {
      console.log(
        `base:       ABSENT at ${baseRef} — ${baseGrepTargetPath} was copied only to re-run added unit tests; ` +
          "a grep proof still names a path the merge base did not contain.",
      );
      console.log("discrimination: discriminates — this proof's target did not exist at the merge base.");
      return headExit;
    }

    let baseDiag: SpawnDiagnostics | undefined;
    const baseCapturingSpawn: ProofSpawner = (command, spawnArgs, spawnCwd, spawnTimeoutMs) => {
      try {
        const out = defaultProofSpawner(command, spawnArgs, spawnCwd, spawnTimeoutMs);
        baseDiag = { stdout: out, stderr: "", status: 0, signal: null };
        return out;
      } catch (e) {
        const err = e as NodeJS.ErrnoException & {
          status?: number | null;
          signal?: NodeJS.Signals | null;
          stdout?: string | Buffer | null;
          stderr?: string | Buffer | null;
        };
        baseDiag = {
          stdout: typeof err.stdout === "string" ? err.stdout : (err.stdout?.toString("utf8") ?? ""),
          stderr: typeof err.stderr === "string" ? err.stderr : (err.stderr?.toString("utf8") ?? ""),
          status: typeof err.status === "number" ? err.status : null,
          signal: err.signal ?? null,
        };
        throw e;
      }
    };
    let baseOutcome: "pass" | "fail" | "no-match";
    try {
      baseOutcome = execWhitelistedProof(baseW, baseCheckoutDir, checkProofTimeoutMs(), baseCapturingSpawn);
    } catch (e) {
      const loadOutput = (e as { loadOutput?: unknown }).loadOutput;
      printFailureOutput("base", baseDiag, baseDiag === undefined && typeof loadOutput === "string" ? proofFailureTail(loadOutput) : undefined);
      const missingExport =
        baseW.kind === "test" && typeof loadOutput === "string"
          ? (deps.observeMissingExports ?? observeCliMissingExports)(loadOutput, baseCheckoutDir, process.cwd())
          : undefined;
      if (missingExport?.state === "unavailable")
        console.log(`base:       export observation unavailable (${missingExport.reason}) — no attribution made`);
      if (missingExport?.state === "attributed") {
        console.log(`base:       COULD NOT LINK — ${missingExport.note}`);
        console.log("discrimination: discriminates — head and base disagree; this proof tells done from not-done.");
        return headExit;
      }
      console.log(
        `base:       COULD NOT EXECUTE — ${proofFailureTail(String((e as Error)?.message ?? e).split("\n")[0])} — an environment gap, never\n` +
          "            evidence either way, same as the reviewer's own base_unknown degrade.",
      );
      console.log("discrimination: unknown — reported verdict above stands unchanged");
      return headExit;
    }
    if (baseOutcome === "fail") printFailureOutput("base", baseDiag, baseW.failureTail);
    if (baseDiag && baseW.kind === "grep") {
      const baseHits = baseDiag.stdout.split("\n").filter((l) => l.trim() !== "").length;
      console.log(`base hits:  ${baseHits}`);
    }
    console.log(`base:       ${baseOutcome}`);

    if (outcome === "pass" && baseOutcome === "pass") {
      console.log(
        "discrimination: executed_stale — this proof matches BOTH head and base, so it discriminates NOTHING;\n" +
          "                the reviewer downgrades exactly this shape (W1-T273/W1-T362) and this verdict would\n" +
          "                count for nothing in review despite reading pass above.",
      );
      return CHECK_PROOF_EXIT.executedStale;
    }
    console.log("discrimination: discriminates — head and base disagree; this proof tells done from not-done.");
    return headExit;
  }
}

/** Release what {@link buildBaseProofDir} built: a worktree is deregistered, a grep tree deleted, both through
 *  {@link removeBaseProofWorktree}'s best-effort teardown. A blob-fallback dir is left to the boot sweep, as before. */
export function releaseBaseProofDir(
  repoDir: string,
  base: BaseProofDir | undefined,
  removeWorktree?: (repoDir: string, worktreePath: string) => void,
): void {
  if (base?.baseCheckoutDir === undefined) return;
  if (base.baseIsCheckout) removeBaseProofWorktree(repoDir, base.baseCheckoutDir, removeWorktree);
  else if (base.baseIsGrepTree === true) removeBaseProofWorktree(repoDir, base.baseCheckoutDir, (_repo, tree) => rmSync(tree, { recursive: true, force: true }));
}

/**
 * (R-11) `rmd check-proof --base`'s own teardown of the merge-base worktree {@link buildBaseProofDir}
 * added for it — best-effort, never masking the verdict already computed, mirroring
 * {@link withMaterializedWorktree}'s teardown handling for the reviewer's head worktree. The default
 * removes it through {@link hostWorktreeGit}, the hardened leaf the build added it through, so the
 * caller's checkout (a PR head, for a proof amendment) is pinned and inherited git variables are dropped.
 */
export function removeBaseProofWorktree(
  repoDir: string,
  worktreePath: string,
  remove: (repoDir: string, worktreePath: string) => void = (dir, wt) => void hostWorktreeGit(dir, ["worktree", "remove", "--force", wt]),
): void {
  try {
    remove(repoDir, worktreePath);
  } catch (e) {
    console.error(`(base worktree teardown failed for ${worktreePath}: ${String((e as Error)?.message ?? e)})`);
  }
}


export function hostWorktreeGitAtTopLevel(dir: string, args: string[], opts: HostWorktreeGitOptions = {}): string {
  const log = opts.log ?? ((step: string, extra: Record<string, unknown>) => {
    if (extra.observed !== "<absent>") console.error(JSON.stringify({ event: step, ...extra }));
  });
  for (let at = resolve(dir); ; at = dirname(at)) {
    try {
      return hostWorktreeGit(at, args, { ...opts, log });
    } catch (error) {
      if (!(error instanceof WorktreePointerRefusedError) || error.observed !== "<absent>" || dirname(at) === at) throw error;
    }
  }
}
