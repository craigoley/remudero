# task-id-existence-check.mjs forensics

The measured forensics, incident narratives and design arguments removed from
`scripts/task-id-existence-check.mjs` when its comments were compacted to the plain-language
standard. Every block below is the removed text verbatim, marker characters stripped and nothing
else changed. Headings name the symbol or section the text explained; the code keeps a one-line
`// Why:` pointer where the history mattered. Base revision: `origin/main` at
1aec2871bc4d380d1f6bfbd558d32226287729ab; the line numbers below are that revision's.

## Module header

### Base lines 2-55 — scripts/task-id-existence-check.mjs, the #2251 incident and the read-only/baseline reasoning

```
// scripts/task-id-existence-check.mjs
//
// TASK-ID EXISTENCE gate (W1-T1048).
//
// #2251 cited an id as its OWN task id in shipped code -- two comments in
// deploy/recycle-container.sh and five references in test/recycle-container.test.ts -- and named
// it three times in its PR body, yet no plan record ever declared it and no reservation ref ever
// held it. It was orphaned because the hand lane's only id source, `rmd next-task-id`, prints an
// id and reserves NOTHING (its own comment: "a process that exits microseconds later reserves
// nothing anyway"), so a later `rmd plan`/`rmd triage` mint handed the same number out as free.
// Nothing noticed until an open PR had to be renumbered.
//
// THE PREDICATE IS EXISTENCE, NEVER OWNERSHIP. Ids legitimately appear in shipped source -- a
// task that ships code routinely names itself in comments and test titles -- so a lint forbidding
// ids in source would break the house convention within a day. The rule this script enforces
// instead: every `W1-T<n>` cited under `src/` or `deploy/` must resolve to EITHER a reservation
// ref (`refs/rmd-id/W1-T<n>` on the remote) OR a declared plan record (`- id: W1-T<n>` in
// plan/tasks.yaml or plan/tasks.d/*.yaml). Either alone is a valid claim (W1-T509's reservation
// allocator predates most declared ids, and a freshly reserved id has no plan record yet).
//
// `test/` IS EXCLUDED BY CONSTRUCTION, NOT BY EXEMPTION -- the default scan roots are simply
// `src` and `deploy`; the fixture corpus test/ carries (~25 of the 31 ids that fail across all
// three trees, measured 2026-08-20) is synthetic test data, invented as fixture ids, and is never
// a claim. Widening the scan to test/ would turn a real gate into a permanent, growing exemption
// list instead.
//
// A SMALL, WRITTEN BASELINE IS UNAVOIDABLE AND SAID PLAINLY. A handful of ids predate the
// reservation allocator (W1-T509) or the plan schema itself, were filed/retired before either
// existed, and never got a plan record (the same phenomenon plan/tasks.d/W1-T278-*.yaml
// documents for its low-numbered siblings: completed/retired ids "absent from every source the
// minter consults"), so they resolve to neither surface today and never will. Each is exempted
// only with a written reason (scripts/task-id-existence-baseline.json) -- an entry with no reason
// is REJECTED, so the exemption list cannot grow silently. (The count is deliberately not quoted
// here -- re-run this script to see it live rather than trust a number that can drift.)
//
// THIS SCRIPT IS READ-ONLY. It shells out to `git ls-remote` (a read) to resolve reservation
// refs and reads files from disk; it never writes a ref, never mints an id, and never invokes any
// verb that would. An unreachable remote is a DEGRADED READ, not a failure: an id that would
// otherwise fail is reported as a STATED UNKNOWN rather than failing the whole gate closed on a
// network blip (the remote is the same origin the CI checkout already authenticated to, but a
// transient failure there says nothing about whether the id is real).
//
// Usage:
//   node scripts/task-id-existence-check.mjs
//     [--dir <path>]...            (default: src, deploy -- relative to --cwd)
//     [--plan-tasks-file <path>]   (default: plan/tasks.yaml)
//     [--plan-tasks-dir <path>]    (default: plan/tasks.d)
//     [--baseline <path>]         (default: scripts/task-id-existence-baseline.json)
//     [--remote <name-or-path>]   (default: origin)
//     [--cwd <path>]              (default: process.cwd())
//
// The pure pieces (scanCitedIds, scanDeclaredPlanIds, resolveReservedIds, loadBaseline,
// evaluateIds) are exported so the falsifier fixture test can drive each surface independently,
// plus the CLI directly (spawn + exit code) for the end-to-end proof.
```

## DECLARED_ID_LINE_RE

### Base lines 64-78 — the id grammar, measured 2026-08-26, and the dropped-vs-truncated distinction

```
// THE ID GRAMMAR, DERIVED FROM WHAT THE PLAN ACTUALLY DECLARES, not from the `W1-T<n>` shorthand
// every brief uses. Measured 2026-08-26 over plan/tasks.yaml + plan/tasks.d/: 901 declared ids, of
// which 21 carry a single-letter suffix (W1-T1B, W1-T9a, W1-T12e, W1-T3F, ...) and 14 sit in another
// workstream (W2-T1, W3-T3, W12-T1). The previous `W1-T[0-9]+` form saw 866 of them and DROPPED 35.
//
// DROPPED, NEVER TRUNCATED, and the difference decides what kind of defect this was. The `$` anchor
// means `- id: W1-T1B` matches NOTHING; it does not read as `W1-T1`. So there was no false collision
// between lettered siblings — there was a HOLE: a re-issued lettered or non-W1 id was invisible to
// the collision check, which is the worse direction for a gate. Driven directly: the old regex
// returns NO MATCH for `W1-T1B`, `W1-T9a` and `W3-T3`, and `W1-T1` only for `- id: W1-T1`.
//
// THE BOUNDARY IS THE LINE ANCHOR, NOT A CHARACTER CLASS. This repo's other id matches use
// `W1-T<n>([^0-9]|$)`, which is right for finding an id inside prose and WRONG here for the same
// reason the old form was: it would accept `W1-T1` as a prefix of `W1-T1B`. A declared id is the
// WHOLE line after `- id:`, so `^...$` is the exact boundary and needs no class.
```

## resolveBaseDeclaredIds

### Base lines 248-269 — origin/main-at-check-time vs merge-base, the W1-T2316 incident, and the false-zero rule

```
/**
 * Ids DECLARED in the plan at `baseRef`, used to attribute which side of a collision this PR added.
 *
 * `origin/main` AT CHECK TIME, NOT the PR's merge-base, and the difference is the defect itself: a
 * merge-base answers "what did main look like when this branch was cut", and main landed a PR about
 * every twenty minutes on 2026-08-26. W1-T2316 merged at 14:59:02Z, AFTER the branch that reissued
 * it was cut, so a merge-base read would have found nothing. What this read cannot see is an id
 * added by another still-open PR (open-vs-open) — those ids sit on no ref it can reach; getting
 * them needs the mint's open-PR surface (W1-T2324's Q1: REST, never GraphQL — `openPrMintTexts`,
 * src/run-task.ts). That half is {@link evaluateOpenPrIdCollisions} below, cross-referencing
 * {@link addedIdsAtHead}'s output (this function's own "added" shape, generalized to every added
 * id rather than only ones that already collide with THIS base) against {@link fetchOpenPrRows}'s
 * REST read of every other open PR's title/body/head-ref text.
 *
 * `readable: false` is the read FAILING (shallow clone with no `origin/main`, unresolvable ref).
 * It is never "the base declares nothing" — reading an unreadable surface as an empty one is the
 * false zero that produced all three 2026-08-26 collisions, so the caller REFUSES on it.
 *
 * Returns id -> the plan files declaring it AT THE BASE. The files, not just the ids: an id whose
 * declaring file is the SAME on both sides is a shard this change merely carries along, while the
 * SAME id declared from a DIFFERENT file is a re-issue. `-l` with the ref prefix gives both.
 */
```

## fetchOpenPrRows

### Base lines 322-334 — REST vs GraphQL discriminator, and the measured CI GH_TOKEN absence

> **SUPERSEDED IN PART BY W1-T3055 (2026-09-07).** The quoted docblock is the text as W1-T2324
> shipped it and is preserved as the record. The token absence it measures is FIXED: ci.yml's
> `task-id-existence` step now passes `GH_TOKEN: ${{ github.token }}` and `--require-open-prs`.
> `reachable: false` still degrades to a stated SKIP for every caller that does NOT require the
> read — the reasoning below is unchanged for them — but a REQUIRED read now refuses instead.
> See [The half that never ran](#the-half-that-never-ran).

```
/**
 * Every OPEN pull request's number, url, head ref and mention-scannable text, read over REST —
 * `GET /repos/<owner>/<repo>/pulls?state=open&per_page=100`, never `gh pr list --json`
 * (GraphQL) — the SAME discriminator W1-T2324's Q1 fixed in the mint itself
 * (`openPrMintTexts`, src/run-task.ts): the field set decides the transport, not the subcommand.
 *
 * `reachable: false` covers a `gh` that cannot run AT ALL (no network, no credentials — MEASURED:
 * CI's `task-id-existence` job carries no `GH_TOKEN` today, so `gh api` fails fast with "gh: To
 * use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable") as well as
 * a response this could not parse. The caller treats it exactly like {@link resolveReservedIds}'s
 * own `reachable: false` — read-only, degrade to a STATED SKIP, never fail the whole gate closed
 * on a blip, and never read it as "no other open PR claims this id".
 */
```

## evaluateOpenPrIdCollisions

### Base lines 386-401 — the W1-T2324 rationale (4 open PRs, 1 collision, 0 open-vs-open) and the self-exclusion fail-open argument

```
/**
 * Cross-reference ids THIS PR adds ({@link addedIdsAtHead}) against every OTHER open PR's mention
 * surface (title + body + head ref) — the OTHER half of Q3 {@link resolveBaseDeclaredIds}'s own
 * doc names as out of its reach: not just "does main already declare this id" but "has another
 * still-open PR already claimed it". MEASURED at filing (W1-T2324's rationale): of 4 open PRs
 * adding a plan id, exactly one collided with main and ZERO collided with another open PR — so
 * this check is expected to stay silent on a healthy board and fire only on the genuine defect
 * class it exists for.
 *
 * `ownHeadRef` EXCLUDES this PR's own row — otherwise every added id would trivially "collide"
 * with itself, since this branch's own title/body/branch name is exactly what mentions the id it
 * is adding. An `ownHeadRef` this cannot resolve (`undefined`) excludes nothing, which is the
 * FAIL-OPEN direction for the exclusion (a missed self-exclusion could only ever flag a PR's own
 * id against itself, which {@link main} would report as a false collision an author notices
 * immediately — never a silent miss of a REAL cross-PR collision).
 */
```

## evaluateAddedIdCollisions

### Base lines 413-427 — the 232-false-collision measurement from retrofitting a per-file scan

```
/**
 * Ids the working tree declares MORE THAN ONCE — two differently-named shards carrying one id, the
 * shape git merges cleanly and `loadPlan` then refuses on `origin/main`, taking every plan-reading
 * verb with it.
 *
 * DETECTION IS A DUPLICATE AT HEAD AND NEEDS NO BASE READ. `base` only ATTRIBUTES: an id the base
 * already declares is one this PR re-issued, which is the sentence an author needs. An unreadable
 * base therefore costs the attribution and never the refusal — deliberately, because the alternative
 * (treat an unreadable base as empty) is the exact false zero this gate exists to stop.
 *
 * ADDED IS A SET DIFFERENCE, NEVER A PER-FILE SCAN. Measured while retrofitting: reading every
 * `- id:` out of each plan file a PR merely TOUCHED reports 232 "added" ids for an open PR that
 * edits the monolith and adds none — every one a false collision. A PR that only CITES an existing
 * id declares nothing new and stays silent, which is what this gate already did and must keep doing.
 */
```

## Third exit comment (main)

### Base lines 699-704 — the doc-example-read-as-a-claim incident behind the placeholder-form remedy

```
    // THE THIRD EXIT, AND THE ONE THIS GATE USED TO LEAVE UNSAID. The two remedies above both
    // assume the id was MEANT as a claim. The case that actually cost this repo was neither: a
    // doc example, written to illustrate a call, which `TASK_ID_MENTION_RE` then read as a real
    // ceiling. A code span does not help -- the extractor reads `W1-T9999`, "`W1-T9999`" and a
    // fenced block identically -- so an author who backticked it and moved on had no sanctioned
    // way to write an example at all. Say the placeholder form here, where the refusal is read.
```

## The half that never ran

### W1-T3055 (2026-09-07) — the open-vs-open check was built, wired, required, and dark for its whole life

**The blindness was known at build time, not overlooked.** The `fetchOpenPrRows` docblock above
records it in as many words: *"MEASURED: CI's `task-id-existence` job carries no `GH_TOKEN` today,
so `gh api` fails fast with 'gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN
environment variable'."* W1-T2324 shipped the open-vs-open collision check knowing the surface it
reads was unreachable in the only environment the gate runs in, and chose to degrade rather than
refuse — a defensible call for a best-effort read, and the reason the degraded path is preserved
byte for byte below. What was never done is supply the token, so the check answered nothing on
every pull request between shipping and this task.

**Measured, on the PR that filed the follow-up asking for a gate that already existed.** Run
`34118136551`, job `101729656513`, head `eb907a0b` — a PR that ADDED three shards, so
`addedIdsAtHead` produced a non-empty set and the half was reached by construction:

```
task-id-existence: open-PR collision check SKIPPED -- could not read the open-PR list for
craigoley/remudero (network blip, or `gh` has no credentials in this environment). ...
task-id-existence: OK -- every id cited under src, deploy resolves to a reservation or a plan
record (7 baselined, 0 unknown), and no declared id collides with "origin/main".
```

Job conclusion: `success`. A green check whose own log says it could not perform the check.

**What it cost.** W1-T3016 was filed off four id collisions in one evening. `W1-T2996` is the one
this half exists to catch: it read "free on main" while an open `run-W1-T2996-*` head already held
it. W1-T3016 then specified a NEW script to do what this one already did, and its own falsifier —
*"Close without implementation if an existing gate already refuses a newly added shard id that
collides with an open PR's shard"* — is what closed it. A gate reporting OK while blind does not
merely fail to catch things; it causes duplicate work by looking healthy.

### The remedy, and why each half is shaped the way it is

| change | why |
|---|---|
| `env: GH_TOKEN: ${{ github.token }}` on the step | the same idiom the commitlint step has used all along; `gh api` is unauthenticated without it |
| `--require-open-prs` on the step, **not** in the npm entry | `ci-parity` registers this job as `npmScriptEntry("task-id-existence", "task-id-existence:check")` and so runs the npm entry. W1-T2203 records a class of lane with no working `gh` at all; requiring the read there would refuse them for their environment rather than their diff |
| an explicit flag, **never** `GITHUB_ACTIONS` | `scripts/comment-load-ratchet.mjs`'s sibling `scripts/coverage-ratchet.mjs` records the reason at its own opt-in: the suite spawns these scripts over fixtures with no `env` override, so an env-gated requirement fires inside the fixtures too |
| the SKIP text preserved byte for byte | proved by running `origin/main`'s script and this one over one fixture with an unreadable surface and diffing the output: identical, both exit 0 |

`classifyUnreadableOpenPrSurface(kind, ctx, required)` is the whole decision, extracted as a pure
function so both arms are provable. Driving the refusal only through `main` would leave that arm
reachable in exactly one environment — a CI runner whose token has been revoked — which is the
environment a test cannot reproduce.

**The discrimination is on the READ, not on the flag.** With the flag set and a readable surface
naming no collision, the run passes; with the flag set and the surface unreadable, it refuses. A
suite that only asserted "the flag refuses" would pass over a gate that blocks every PR.

FALSIFIER: `test/a-blind-id-collision-gate-is-not-a-clean-one.test.ts`.
