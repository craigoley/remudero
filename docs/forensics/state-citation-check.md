# state-citation-check.mjs comment forensics

The measured incidents, design arguments and rejected alternatives that were removed from
`scripts/state-citation-check.mjs` when its comments were compacted to the plain-language standard
(docs/comment-standard.md). Nothing was cut: each section below is the file's own prose, verbatim,
under a heading naming the symbol it explained. The file itself keeps a one-line `// Why:` pointer
wherever the history mattered.

Line numbers below are positions in `scripts/state-citation-check.mjs` at the merge base of the
compaction PR (`origin/main` at dd4684effcfe55dbdec3cad943fa7cdb789c556c; the file's content is
unchanged there from 7febdd0, its last prior edit on `main`).

## The file header

Removed from lines 2-82.

```
// scripts/state-citation-check.mjs
//
// STATE-CITATION gate (W1-T1263).
//
// THE DEFECT IS PLACEMENT, NOT SCRATCH. `state/` is gitignored runtime exhaust and is SUPPOSED
// to be swept -- `sweepStaleTempDirs` (src/lib/tmp.ts), `scratchReap` (src/lib/policy.ts),
// `reapStaleWorktrees` (src/lib/worker.ts) and container recreation all reap it, correctly, by
// design. The failure this gate exists to catch is different: a document meant to be DURABLE --
// a census, a research report, a numbered set of governing constraints -- gets written into that
// swept tree anyway, and a TRACKED file then cites it BY PATH as the source of record. The
// tracked file survives every sweep; the thing it points at does not. CLAUDE.md already states
// the convention ("a report written to state/ is SCRATCH, not a record"), and that sentence is
// exactly why this gate exists: it was UNENFORCED PROSE, and the citations kept accruing after it
// was written -- repaired twice, twelve days apart (#1587 / 710b18b5, then the Law 4/5 loss),
// with the writing path untouched both times.
//
// THE PREDICATE IS THE FILE EXTENSION, NOT INTENT. Nothing in this repo WRITES a `state/*.md`
// file -- every hit under src/ or scripts/ for that shape is a prose comment CITING a recon
// document, against a control of over a hundred legitimate runtime `state/` path references
// (`state/ledger.ndjson`, `state/PAUSE`, `state/service-tokens.json`, `state/drain.lock`,
// `state/logs/...`) that this gate must never touch and never does -- the regex below requires a
// literal `.md` suffix, so an ordinary runtime path simply cannot match it. `.md` under `state/`
// is a human-authored document by construction; this gate guards ONLY that narrow class. It does
// NOT guard `state/` generally -- a broad form would have to adjudicate every real runtime
// reference by intent, which is a check nobody could keep correct.
//
// A SMALL, WRITTEN-REASON BASELINE CARRIES THE PRE-EXISTING CITERS, mirroring
// scripts/task-id-existence-check.mjs's idiom exactly: every `state/*.md` path already cited from
// a tracked file at filing time is seeded into scripts/state-citation-baseline.json with a
// written reason, so day one is not universally red. The gate only refuses a citation of a path
// ABSENT from that baseline -- this cannot recover what is already lost, and does not pretend to.
// An entry with no reason is REJECTED, so the exemption list cannot grow silently.
//
// THE ESCAPE HATCH IS KEYED ON CONTENT SHAPE, NEVER A PATH OR FILE ALLOWLIST (both rot). A
// citation is permitted, independent of the baseline, when the citing line or the few lines
// around it (its "block") also carries an unrecoverability marker -- the word "unrecoverable" (or
// "unrecoverably"). This is the design's hardest case, worked out against MASTER-PLAN.md's own
// real citations of a lost research census: it cites that path TWICE, once as ground-truth
// evidence (must FAIL if the path were ever new) and once in the very sentence recording that the
// path is unrecoverable (must PASS). The falsifier test drives exactly that shape.
//
// THE CHECK REFUSES RATHER THAN REPORTING SUCCESS WHEN IT SCANS NOTHING. A run that walks its
// target directories and finds zero eligible files is the same "empty because my query was
// malformed, not because there was nothing to find" defect class MASTER-PLAN.md's P48 entry
// names for boundary reads generally -- so an empty scan is a hard failure here too, never a
// silent, vacuous pass.
//
// SCOPE: unlike scripts/task-id-existence-check.mjs (which deliberately excludes test/ -- most of
// its population there is synthetic fixture ids), the durable-citation population is genuinely
// spread across plan/tasks.d/, plan/feedback/, test/, src/, deploy/Dockerfile, MASTER-PLAN.md,
// DECISIONS.md and CLAUDE.md itself, so the default scan root is the whole repository (`.`). The
// file list itself comes from `git ls-files` (a READ, exactly like task-id-existence's `git
// ls-remote`) rather than a raw directory walk: the guard's own subject is "a TRACKED file" --
// scanning by git's own notion of tracked content is both the more faithful predicate and the one
// that automatically keeps untracked scratch, `node_modules`, build output and `state/` itself
// (gitignored runtime exhaust -- the thing being cited, never the citer) out of scope, with no
// separate exclusion list to keep in sync. The baseline file is excluded from its own scan by
// construction: it exists to ENUMERATE the paths this gate already knows about, not to cite one
// as authority.
//
// NOT YET WIRED INTO .github/workflows/ci.yml, DELIBERATELY, THIS PR. Doing so requires
// registering this file on `INSTRUMENT_SURFACE` (src/lib/review.ts) so
// test/instrument-surface-completeness.test.ts stays green once a workflow/package.json
// references it -- but that registration is a `src/` product-path edit, and landing it beside
// `.github/workflows/ci.yml` and scripts/state-citation-baseline.json (both already on
// `INSTRUMENT_SURFACE`) in the SAME diff trips `detectInstrumentEntanglement`, remudero-review's
// own merge-blocking logic (docs/operator-guide.md documents the identical conflict for every
// prior gate of this shape and prescribes landing the pieces as separate PRs). This script is
// complete and proven correct against the real repository (test/state-citation-check.test.ts);
// wiring it into ci.yml/package.json plus the INSTRUMENT_SURFACE registration is the tracked
// follow-up, unblocked once this file exists on `main`.
//
// Usage:
//   node scripts/state-citation-check.mjs
//     [--dir <path>]...            (default: . -- the whole repo, relative to --cwd)
//     [--baseline <path>]         (default: scripts/state-citation-baseline.json)
//     [--cwd <path>]              (default: process.cwd())
//
// The pure pieces (listTrackedFiles, scanCitations, loadBaseline, evaluateCitations) are exported
// so the falsifier fixture test can drive each surface independently, plus the CLI directly
// (spawn + exit code) for the end-to-end proof.
```

WHY THIS MATTERS. The gate exists because CLAUDE.md's own prose convention against citing a
`state/*.md` path as a durable record went unenforced twice, twelve days apart (#1587/710b18b5,
then the Law 4/5 loss), with the writing path untouched both times — the remedy per CLAUDE.md's own
preamble is to make something refuse it rather than sharpen the wording again. The predicate is the
`.md` extension rather than intent, because nothing in the repo writes a `state/*.md` file — every
hit is a prose citation, checked against a control of over a hundred legitimate runtime `state/`
references (`state/ledger.ndjson`, `state/PAUSE`, `state/service-tokens.json`, `state/drain.lock`,
`state/logs/...`) that must never be flagged. The scope deliberately covers the whole repository
(unlike the narrower `scripts/task-id-existence-check.mjs`, which excludes `test/` because most of
its population there is synthetic), because the durable-citation population is genuinely spread
across `plan/tasks.d/`, `plan/feedback/`, `test/`, `src/`, `deploy/Dockerfile`, `MASTER-PLAN.md`,
`DECISIONS.md` and `CLAUDE.md` itself. The escape hatch is keyed on content shape (the word
"unrecoverable"/"unrecoverably" near the citing line) rather than a path or file allowlist, because
both rot; the hardest case driving that design is `MASTER-PLAN.md`'s own citation of a lost research
census, once as live evidence and once recording that the path is unrecoverable — the same path
must fail on one occurrence and pass on the other in the same file. Wiring this gate into
`ci.yml` is deferred, deliberately, to a separate PR: doing it here would require registering the
file on `INSTRUMENT_SURFACE` (`src/lib/review.ts`) in the same diff as `.github/workflows/ci.yml`
and `scripts/state-citation-baseline.json` (both already on that surface), which trips
`detectInstrumentEntanglement`, remudero-review's own merge-blocking logic — see
`scripts/unwired-gate-check.mjs`'s `ALLOWANCE` entry for this file, which records that follow-up.

## CITATION_RE and PATH_RE

Removed from lines 90-93.

```
// A citation is a literal `state/` followed by one or more path characters ending in `.md`. This
// is the SAME predicate the shard's own rationale re-derived and measured against: it separates
// durable documents (`.md`) from the ~166 ordinary runtime paths under `state/` mechanically,
// never by judgement.
```

MEASURED: the `.md`-suffix predicate separates durable documents from roughly 166 ordinary runtime
paths under `state/` mechanically, with no judgement call per path.

## UNRECOVERABLE_MARKER_RE

Removed from line 97: `// The content-shape escape hatch (design note iv) -- see the file header
for the derivation.` The derivation is in "The file header" section above (the paragraph beginning
"THE ESCAPE HATCH IS KEYED ON CONTENT SHAPE").

## CONTEXT_WINDOW

Removed from lines 100-105.

```
// How many lines before/after the citing line count as its "block" when looking for the marker.
// MASTER-PLAN.md hard-wraps prose at ~100 chars, so a marker word can land on the line AFTER the
// one carrying the path (measured: the real tombstone citation's own "unrecoverable" sits exactly
// one line below the path) -- this window is sized to catch that with room to spare, while
// staying far short of an entire multi-paragraph bullet block (which would wrongly pass BOTH of
// MASTER-PLAN.md's citations of the same path instead of separating them).
```

MEASURED: `MASTER-PLAN.md`'s real tombstone citation carries its "unrecoverable" marker exactly one
line below the cited path (the document hard-wraps prose at roughly 100 characters), which is why
the window is sized to 3 lines each side rather than 1 — while staying well short of an entire
multi-paragraph bullet block, which would wrongly mark both of `MASTER-PLAN.md`'s citations of the
same path instead of separating them.

## listTrackedFiles

Removed from lines 113-119 (the JSDoc; the function body was unchanged).

```
/**
 * Every file `git ls-files` reports as TRACKED under `dirs` (resolved against `cwd`), as paths
 * relative to `cwd`. THROWS if the read itself fails (not a git repo, `git` unavailable, etc.) --
 * distinct from a git repo that legitimately tracks nothing under `dirs`, which returns an empty
 * array and is for the caller to decide what to do with (main() below treats it identically to
 * "scanned zero files", which is exactly the silent-zero shape this gate refuses to pass on).
 */
```

## scanCitations

Removed from lines 131-139 (the JSDoc; the function body was unchanged).

```
/**
 * Scan every TRACKED file under `dirs` (resolved against `cwd`, via {@link listTrackedFiles}) for
 * every `state/*.md`-shaped citation, returning the flat list of occurrences -- `{ path, file,
 * line, marked }`, `file` relative to `cwd`, `marked` true when the citing line's block (±
 * CONTEXT_WINDOW lines) carries the unrecoverability marker -- plus `filesScanned`, the count of
 * files actually read, so a caller can refuse a run that read nothing rather than silently
 * reporting success on an empty scan. `skipAbs` (an ABSOLUTE path, typically the baseline file) is
 * never scanned, if given -- the baseline exists to ENUMERATE citations, not to make one.
 * Read-only: nothing is ever written, and `git ls-files` never mutates the tree it reads.
 */
```

## loadBaseline

Removed from lines 177-182 (the JSDoc; the function body was unchanged).

```
/**
 * Parse+validate scripts/state-citation-baseline.json into a Map from `state/*.md` path to its
 * written reason. THROWS on a structurally invalid file, on an entry whose `path` does not match
 * the citation shape, on any entry missing a non-empty `reason`, or on a duplicate path -- an
 * exemption with no recorded reason would let the baseline grow silently, which is exactly the
 * failure this gate exists to prevent for itself (same discipline as task-id-existence's).
 */
```

## evaluateCitations

Removed from lines 221-229 (the JSDoc; the function body was unchanged).

```
/**
 * Pure decision layer: classify every occurrence as "marked" (its block carries the
 * unrecoverability marker -- passes regardless of the baseline), "baselined" (unmarked, but its
 * path has a written baseline exemption -- passes) or "failed" (neither -- a genuine new,
 * unrecorded durable-record citation). Evaluated PER OCCURRENCE, not per path, because the same
 * path can legitimately land on both sides in the same file (MASTER-PLAN.md's own hardest case:
 * one citation records the path as unrecoverable, a different citation of the SAME path asserts
 * it as live evidence).
 */
```
