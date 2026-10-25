# The comment standard

How to write a code comment in this repo, and how much of one. It applies to every tracked file
under `src/`, `scripts/`, `deploy/`, `.github/workflows/`, `bin/` and `hooks/`.

**Why there is a standard at all.** Measured on `main` at ea02cc83 by `npm run comment-load`:
87,888 comment lines against 101,007 code lines — 46.5%, with 16,054 in `src/run-task.ts` alone.
Every agent session that opens a file pays those lines in context, every time. CLAUDE.md already
applies this reasoning to itself ("a context tax paid per session — keep it compressed") and holds
itself under a byte cap; this extends it to code.

**Two readers.** A *maintainer* reads a comment once, while changing the code under it; an *agent
session* reads it on every run touching that file, and cannot skim. Write for the second.

## The four principles, applied to code

This repo adopts [ISO 24495-1](https://www.iso.org/standard/78907.html) plain language.

**Relevant** — say who needs this and why it belongs in the code rather than in a record. What a
reviewer needs while editing *this function* belongs here; how the system got this way belongs in
`learnings/*.yaml`, `DECISIONS.md`, or a dated `docs/` page, cited in one line. If you cannot name
the reader, delete it.

**Findable** — lead with a purpose sentence: what this is, before any argument for it. One idea per
paragraph. Any block over five lines opens with a heading-like first line.

**Understandable** — one idea per sentence, about 20 words. Active voice. No ALL-CAPS sentences;
capitals stop working as emphasis once every third sentence uses them. Define a house term on first
use, or link CLAUDE.md's glossary bullet.

**Usable** — a comment earns its place by stating the **invariant** the code holds, the **trap**
that broke it before, or the **falsifier** — the test or symbol that would go red if the invariant
broke. Then cite the record (PR number, task id, `DECISIONS.md` date) instead of retelling it.

## Signals and follow-up work

Comment volume does not block a PR. The operator reaffirmed this policy on 2026-10-24: excess prose
must create high-priority compression work rather than clog the merge queue.

`npm run comment-load-signal` reports the measured change and long added blocks without reading or
rewriting a shared ceiling. A successful measurement exits zero regardless of comment volume.
An unreadable measurement is reported as unavailable, not as an absence of debt.

The existing gate gardener nominates the largest untracked comment subject and files a priority-1
compression task through normal reservation, machine-filing admission, CI and review. Queued work,
unresolved retirement and matching open filings prevent duplicates. The originating PR can proceed
while that follow-up is pending. An explicit `--baseline` run remains available
for reproducing historical evidence; it does not decide whether a normal push or merge may proceed.

Twelve lines for a function doc and twenty-five for a header or block remain editing guidance.
They are signals to compress, not pass/fail limits. Keep the operative caveats and citations below.

Measured forensics — a paragraph beginning "MEASURED … on 2026-08-…", a replayed incident, a table
of observed counts — do not belong in code. Put them in `learnings/*.yaml` or a dated `docs/` page,
and leave a one-line pointer behind.

## Two examples, taken verbatim from this tree

**`src/lib/ledger.ts:338` — 171 consecutive comment lines.** The first 158 are one JSDoc block, a
paragraph per ledger `step` a deciding reader consults. It ends at line 495 and is followed by
another JSDoc — the symbol it describes, `DECISION_RELEVANT_LEDGER_STEPS`, now sits at line 529
behind four other declarations. It is orphaned prose. Its plain-language form:

```ts
/**
 * Ledger steps a DECIDING reader consults — never a merely-displaying one. Rotation must never
 * archive one of these away.
 *
 * TRAP: a step that "forgets" is a breaker or a dedup that silently resets. A `daemon.boot` line
 * archived mid-health-window read as "never booted" and rolled back a healthy deploy (W1-T244).
 * Health and `deploy.*` steps are therefore bounded by HEALTH_STEP_RETENTION_WINDOW_MS instead,
 * via isHealthOrDeployStep. Render-only steps live in RENDER_RELEVANT_LEDGER_STEPS.
 *
 * FALSIFIER: test/ledger-rotation.test.ts. Per-step readers: W1-T209, W1-T244, W1-T2244.
 */
```

**`src/lib/sweep.ts:3201` — 174 comment lines above `DISPOSITION_RULES`.** The block re-narrates the
table's row ordering in prose, row by row, above a table already in that order whose rows already
carry their own comments. Its plain-language form:

```ts
/**
 * The ordered rules mapping observed PR state to a disposition. First match wins.
 *
 * INVARIANT: the last row matches unconditionally, so a disposition is always produced — the
 * "no disposition means none" case is structural, not a branch. Precedence is table order alone
 * and deriveDisposition holds no policy, so a row edit changes behaviour without touching it.
 *
 * FALSIFIER: test/fix-rung-no-progress-stop.test.ts exercises deriveDisposition against this table.
 */
```

## What never gets cut

A compaction PR may shorten prose. It may not drop any of these:
- the **invariant** a block states;
- the **trap** — a named failure mode and what it looked like;
- the **falsifier pointer** — the test file or symbol that proves the invariant still holds;
- the **citation** — the PR number, task id, or `DECISIONS.md` date that points at the full record;
- **any phrase a test pins.**

That last one is a live trap. 206 assertions across 138 test files read `src/` files as raw **text**
and match on a literal substring (R-44, `docs/audits/recon-2026-09-05.md`; frozen by W1-T2905 /
#4101). Rewriting a pinned sentence turns that suite red with a message about a missing string, not
about your edit. Grep the phrases first — `git grep -lF -- '<phrase>' test/` — because a compaction
PR **migrates or keeps every pinned phrase**.

## Historical ceiling records

The former ratchet refused comment growth and added blocks over 25 lines. Its baseline and explicit
`--baseline` mode remain available to reproduce historical evidence; the default command, push
precheck and merged-tree judgement use nonblocking measurement. Do not update or redistribute old
comment allowances to make a current PR merge. File compression follow-up work instead.
