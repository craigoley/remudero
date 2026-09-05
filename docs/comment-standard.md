# The comment standard

This page says how to write a code comment in this repo, and how much of one. It applies to every
tracked file under `src/`, `scripts/`, `deploy/`, `.github/workflows/`, `bin/` and `hooks/`.

**Why there is a standard at all.** Measured on `main` at ea02cc83 by this repo's own
`npm run comment-load-ratchet -- --print`: 87,888 comment lines against 101,007 code lines across
those directories — 46.5%. `src/run-task.ts` alone carries 16,054 comment lines. Every agent
session that opens a file pays for those lines in context, every time. CLAUDE.md already applies
this reasoning to itself ("a context tax paid per session — keep it compressed") and holds itself
under a byte cap. This extends the same discipline to code.

**Two readers.** A *maintainer* reads a comment once, while changing the code under it. An *agent
session* reads it on every run that touches the file, and cannot skim. Write for the second reader:
the comment that survives is the one that changes what someone does next.

## The four principles, applied to code

This repo adopts [ISO 24495-1](https://www.iso.org/standard/78907.html) plain language. Its four
principles map onto comments like this.

**Relevant** — say who needs this and why it belongs in the code rather than in a record. A fact a
reviewer needs while editing *this function* belongs here. A fact about how the system got this way
belongs in `learnings/*.yaml`, `DECISIONS.md`, or a dated page under `docs/`, cited from here in one
line. If you cannot name the reader, delete it.

**Findable** — lead with a purpose sentence: what this is, in one line, before any argument for it.
One idea per paragraph. Any block over five lines opens with a heading-like first line so a reader
can skip the rest.

**Understandable** — one idea per sentence, about 20 words. Active voice. No ALL-CAPS sentences;
capitals for emphasis stop working once every third sentence uses them. Define a house term the
first time you use it, or link CLAUDE.md's glossary bullet ("Decoding rule citations").

**Usable** — a comment earns its place by stating one of three things: the **invariant** the code
holds, the **trap** that broke it before, or the **falsifier** — the test or symbol that would go
red if the invariant broke. Then cite the record (PR number, task id, `DECISIONS.md` date) instead
of retelling it.

## Limits

| Kind of comment | Limit | Enforced by |
|---|---|---|
| Function or symbol doc | 12 lines | review — read this page |
| File header | 25 lines | review — read this page |
| Any other block | 40 lines | `comment-load-ratchet`, on **added** blocks |
| Comment lines per file | today's count, never more | `comment-load-ratchet`, against `scripts/comment-load-baseline.json` |

Only the last two rows refuse a PR. The 12- and 25-line limits are conventions a reviewer applies;
nothing today measures them, so they bind only because you read this. See "What the ratchet does
not do" below.

Measured forensics — a paragraph beginning "MEASURED … on 2026-08-…", a replayed incident, a table
of observed counts — do not belong in code at all. Put them in `learnings/*.yaml` or a dated page
under `docs/`, and leave a one-line pointer behind.

## Two examples, taken verbatim from this tree

**`src/lib/ledger.ts:338` — 171 consecutive comment lines.** The first 158 are one JSDoc block that
enumerates each ledger `step` a deciding reader consults, with a paragraph per step naming the
reader and the incident that added it. The block ends at line 495 and is followed immediately by
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
table's row ordering in prose, row by row, immediately above a table whose rows are already in that
order and already carry their own per-row comments. Its plain-language form:

```ts
/**
 * The ordered rules mapping observed PR state to a disposition. First match wins.
 *
 * INVARIANT: the last row matches unconditionally, so a disposition is always produced — the
 * "no disposition means none" case is structural, not a branch. Precedence is table order alone;
 * deriveDisposition holds no policy of its own, so a threshold or row edit changes behaviour with
 * no change to it. Each row states its own precedence reason where it is not obvious.
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

That last one is a live trap, not a caution. 206 assertions across 138 test files read `src/` files
as raw **text** and match on a literal substring (R-44, `docs/audits/recon-2026-09-05.md`; frozen by
W1-T2905 / PR #4101). Rewriting a sentence a test pins turns that suite red with a message about a
missing string, not about your edit. Before compacting a block, grep the phrases in it:
`git grep -lF -- '<phrase>' test/`. A compaction PR **migrates or keeps every pinned phrase** — it
never deletes one and leaves the assertion to fail.

## What the ratchet does not do

`scripts/comment-load-ratchet.mjs` refuses two things: a file whose comment count grew past its
recorded baseline, and a newly added comment block longer than 40 lines. It does not judge whether a
comment is good, does not measure the 12- and 25-line limits, and does not read comments inside
`test/`. It is a ceiling on volume, not a verdict on quality. Compaction of the files that are
already large is separate work, one file per PR.
