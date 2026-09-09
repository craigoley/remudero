# source-size-ratchet.mjs forensics

The measured forensics, incident narratives and design arguments removed from
`scripts/source-size-ratchet.mjs` when its comments were compacted to the plain-language standard.
Every block below is the removed text verbatim, nothing else changed. Headings name the symbol or
section the text explained; the code keeps a one-line `// Why:` pointer where the history mattered.
Base revision: origin/main at deff462828af753d11f4a6b3637f980bd4c39d30; the line numbers below are
that revision's.

## Module header

### Base lines 2-67 — scripts/source-size-ratchet.mjs, the full lineage, ratchet-vs-cap and walk rationale

```
// scripts/source-size-ratchet.mjs
//
// W1-T2734 — SOURCE LINE COUNT IS A REVIEW-RISK SIGNAL, NOT A CORRECTNESS VERDICT.
//
// Default mode refreshes origin/main, measures the merge-base-to-HEAD change for each touched
// src/**/*.ts file, and emits deterministic human plus schema-versioned JSON evidence. Growth is
// always a successful measurement. An unreadable base or other measurement failure is non-zero.
// The historical W1-T2488 shared-baseline ratchet remains reproducible only when the caller passes
// `--baseline`; package.json keeps that explicit compatibility command off the habitual fast gate.
//
// Default usage:
//   node scripts/source-size-ratchet.mjs
//   node scripts/source-size-ratchet.mjs --json
//   node scripts/source-size-ratchet.mjs --base <ref>
//   node scripts/source-size-ratchet.mjs --root <dir>
//
// HISTORICAL W1-T2488 RATCHET (EXPLICIT --baseline MODE ONLY).
//
// THE ASYMMETRY THIS CLOSES. This repo already ratchets CLAUDE.md's injected byte weight
// (scripts/claude-md-budget-ratchet.mjs), diff coverage (scripts/coverage-ratchet.mjs),
// dependency cycles (scripts/cycle-ratchet.mjs), the learnings budget
// (scripts/learnings-budget-ratchet.mjs) and the mutation score (scripts/mutation-ratchet.mjs) --
// every one of those exists because something grew unnoticed. `src/run-task.ts` grew to 32,119
// lines against a next-largest source file of 8,445 with nothing watching. This is the sixth
// ratchet, in the same lineage, for the one dimension the other five do not cover.
//
// A RATCHET, NOT A CAP. Every path recorded in scripts/source-size-baseline.json is a CEILING on
// that ONE file, not a target: today's line count is legal forever, and growing past it is the
// only thing this script refuses. LOWERING a recorded ceiling is always free -- a shrunk file
// rewrites its own baseline entry DOWN, automatically, the moment the run is otherwise clean, so
// the gain can never quietly regress. RAISING a ceiling is the move this gate exists to refuse: a
// grown file BLOCKS, naming the file and its exact overage in lines, and this script never writes
// a growing entry back to disk -- only a human raising scripts/source-size-baseline.json by hand,
// on the record, can move a ceiling up. A file no longer found under `src/` (renamed away or
// deleted) is dropped from the baseline silently -- deleting a file is not growth, and a stale
// entry for a file that no longer exists asserts nothing. A file with no recorded entry at all is
// RECORDED, not refused -- there is nothing to have grown past yet.
//
// THE MEASURE IS `wc -l` SEMANTICS -- a count of trailing `\n` bytes -- so the two SURFACE figures
// this task's own rationale cites (32119 for src/run-task.ts, 8445 for src/lib/sweep.ts) are the
// exact numbers `countLines` returns for the shipped tree, not an approximation of them.
//
// HISTORICAL FAST-GATE BASIS. W1-T2488's baseline mode qualified because it was deterministic,
// seconds-fast and local-only. W1-T2734 changes the ordinary path deliberately: it shells git and
// refreshes origin/main so its PR-relative signal cannot silently measure against a stale base.
// The baseline implementation below remains local-only and is reachable solely through the
// explicit `--baseline` compatibility form.
//
// WHY A FILESYSTEM WALK, NOT `git ls-files`. A subprocess spawn is exactly the cost this step
// exists to avoid paying, and `src/` carries no build output or ignored `.ts` file today (an
// untracked scratch file dropped there is recorded on its first run like any other new file,
// never silently exempted) -- so walking the directory tree directly gives the identical set of
// paths `git ls-files -- src` would, with no process spawned to get it.
//
// Legacy usage:
//   node scripts/source-size-ratchet.mjs --baseline scripts/source-size-baseline.json
//   node scripts/source-size-ratchet.mjs --baseline scripts/source-size-baseline.json --check
//   node scripts/source-size-ratchet.mjs --root <dir> --baseline <path>
//
// Defaults: --root . (resolved to an absolute path), --baseline <root>/scripts/source-size-baseline.json
//
// The pure functions below (countLines, readBaseline, evaluateSourceSizeRatchet) are exported so
// test/a-source-file-cannot-outgrow-its-baseline.test.ts can exercise both the CLI process
// directly (spawn + exit code, against isolated fixture directories) and the measurement/
// comparison logic in isolation, mirroring test/cycle-ratchet.test.ts's own convention for its
// sibling gate.
```

The near-identical footer at base lines 372-379 ("W1-T2734 — SOURCE SIZE IS A SIGNAL, NOT A
CORRECTNESS VERDICT ... Positive growth is always exit 0; only an inability to measure is a
failure.") restated the same two facts already covered above (the shared baseline is untouched by
signal mode; growth is always a successful measurement) and carried no additional measured fact,
incident, or design argument, so it is not archived separately.

## CEILING_BUCKET_LINES

### Base lines 142-182 — W1-T2539's full derivation: the conflict class, the bucket math, three replayed PRs

```
/**
 * W1-T2539 -- THE BUCKET. A recorded ceiling is rounded UP to a multiple of this, never the exact
 * line count, and that single change removes an entire conflict class.
 *
 * WHY AN EXACT COUNT COLLIDES. Every PR that grows a file must edit the SAME LINE of the baseline,
 * so two such PRs always conflict -- and the conflict is UNRESOLVABLE by the merge-conflict rung,
 * because changing a value on an existing JSON key is a deletion plus an addition and
 * `isPureConcurrentAddition` (src/lib/sweep.ts) refuses any deletion. MEASURED 2026-08-31 on the
 * three PRs left dirty after W1-T2536 turned that rung on: ours -1/-2/-2 against theirs -5/-7/-10,
 * all on this file. Two more, resolved by hand the same night, scored the same.
 *
 * WHAT BUCKETING BUYS, AND THE SECOND PROPERTY IS THE ONE THAT MATTERS.
 *   (a) Growth that stays inside the current bucket does not touch the baseline at all, so there
 *       is no line to collide on. MEASURED over 300 first-parent commits (this repo squash-merges,
 *       so `--merges` reads a near-empty corpus -- controlled at 2656 first-parent commits
 *       available): per-commit growth of a single source file is p50 40, p75 85, p90 141, p99 287,
 *       max 441, and the baseline is touched in 19 of 300 commits (6.3%).
 *   (b) When two PRs DO both cross the same boundary they write the SAME VALUE, and git
 *       auto-merges an identical change with no conflict at all. That is what removes the class
 *       rather than merely making it rarer.
 *
 * 500 IS DERIVED, NOT PICKED: it exceeds the observed MAXIMUM single-commit growth (441), so no
 * one commit can traverse a whole bucket from a standing start. REPLAYING THE THREE REAL CONFLICTS
 * AT THIS BUCKET, ALL THREE DISAPPEAR -- each pair rounds to ONE value and each merged truth fits
 * under it, so there is no differing line to conflict on and no breach to record:
 *     3136 / 3138   -> both 3500, merged truth 3230  fits
 *     32692 / 32713 -> both 33000, merged truth 32818 fits
 *     32743 / 32718 -> both 33000, merged truth 32748 fits
 * (An earlier draft of this comment quoted 3250 and 32750 -- those are a 250-bucket's answers,
 * caught by probing `ceilingFor` rather than trusting the arithmetic in the comment.)
 *
 * THE COST, STATED RATHER THAN BURIED: the ratchet is COARSER. A file may grow up to 499 lines
 * past its last recorded ceiling before the gate notices -- 1.5% of a 32k-line file, 15% of a 3k
 * one. This is a ratchet against unbounded growth, not a precise budget (W1-T2526 calls it "a size
 * ledger records how long a file is and grades no falsifier"), so the trade is judged worth it.
 * An operator who disagrees changes ONE exported constant.
 *
 * MIGRATION IS LAZY, DELIBERATELY. The existing entries are exact counts and stay valid ceilings;
 * each file re-records into a bucket the first time it grows past its current value. An EAGER
 * rewrite of all of them would itself be a large diff to this exact file -- a conflict magnet
 * against every in-flight PR, which is the defect this task exists to remove.
 */
```

## The BLOCKED remedy

### Base lines 289-300 — W1-T2532: the remedy must be followable by an agent, four escalations, 6 of 9 PRs blocked

```
    // THE REMEDY MUST BE FOLLOWABLE BY WHOEVER READS IT, INCLUDING AN AGENT (W1-T2532). The
    // earlier wording ended "raise the entry in <absolute runner path> by hand", and both halves
    // were defects in practice: "by hand" reads as "a human must do this", so the sweep's ci-log
    // fix worker declined to touch the file and pushed nothing that moved the finding -- MEASURED
    // as four consecutive `ci-log false-block` escalations (issues #3362, #3368, #3369, #3374)
    // against PRs whose ONLY failing check was this gate, while 6 of 9 open PRs sat blocked. And
    // the absolute path is the CI runner's, which names nothing the reader can edit.
    //
    // NOTHING ABOUT WHAT THIS GATE REFUSES CHANGES. The verdict, the exit code and the violation
    // lines above are untouched; only the sentence explaining what to do about them is. Raising a
    // ceiling is still a deliberate, reviewed edit that lands in the diff where a reviewer reads
    // it -- that visibility, not the difficulty of making the edit, is what the ratchet is for.
```

## PR body goes stale

### Base lines 314-321 — W1-T2532 round 2: bodyContradictsDiff, three PRs, #3365's fix worker corrected its own count

```
    // AND THE PR BODY GOES STALE THE MOMENT YOU DO IT (W1-T2532, round 2). `bodyContradictsDiff`
    // (src/lib/review.ts) OPENS THE DIFF and FAILS the PR when the body's own file claim no longer
    // matches it -- so adding the line above turns a body that said "exactly 4 files" into a
    // refusal, from a DIFFERENT gate, with a message that never mentions this one. MEASURED
    // 2026-08-31: three PRs (#3365, #3373, #3378) landed on that refusal within one sweep, the
    // extra file being scripts/source-size-baseline.json in every case; #3365's fix worker then
    // read this text, recorded the ceiling AND corrected its own file count, which is the whole
    // reason this sentence exists.
```

## The third outcome: "could not determine"

### W1-T3141 — a missing REF and a missing PATH both exit 128, so an unfetched base read as a clean answer

W1-T3037 gave the BLOCKED path an inherited/introduced split: each violating file is re-measured at
`origin/main`, and the author is told which reds they inherited rather than grew. `contentAtRef`
decides `absent` versus `unreadable` on the exit STATUS of `git show <ref>:<path>` — and git exits
**128 for both** a path that is not at the ref and a ref that is not in the checkout. Measured in a
throwaway repository, with a positive control first:

```
git show main:f.txt        -> (content)                                           exit 0    <- control
git show main:nosuch.txt   -> fatal: path 'nosuch.txt' does not exist in 'main'   exit 128
git show origin/main:f.txt -> fatal: invalid object name 'origin/main'.           exit 128
```

So a checkout that never fetched `origin/main` returned `absent` for every file, every violation was
classified INTRODUCED, `inheritedNotice` returned `undefined`, and **nothing printed**. A run that
could not answer the question arrived as a confident answer about every file — the one outcome
`scripts/lib/inherited-violation.mjs`'s own header says it exists to prevent: *"'we could not ask'
and 'the base is fine' must not arrive as the same answer."*

`refResolvable(run, ref)` probes with `git rev-parse --verify --quiet <ref>^{commit}`, which
separates the two cases (0 for a real ref, 1 for a missing one) where the `show` cannot.
`splitInheritedViolations` takes an OPTIONAL `refPresent` predicate: supplied and false, every
violation is `undetermined` and none is `introduced`. Optional on purpose — a caller passing none
behaves exactly as it did, so W1-T3037's contract and all ten of its tests hold unchanged.

**What you will see.** When the split cannot be made, the BLOCKED output carries a third sentence
beside the ceiling list, naming the ref and making no claim either way:

```
  source-size-ratchet: could not determine whether N of these are INHERITED from origin/main
  (<paths>) — that ref is not readable in this checkout, so no claim is made either way. This says
  nothing about whether the violation is yours; it says the comparison could not be run.
```

It is not an accusation and not an absolution. The gate's verdict is unchanged: what it refuses,
and the remedy it prints, are exactly as documented above.

FALSIFIER: `test/an-unfetched-base-is-not-an-absent-file.test.ts`.
