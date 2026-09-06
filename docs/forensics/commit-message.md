# Forensics: src/lib/commit-message.ts

Every measured fact, incident and design argument the comments in `src/lib/commit-message.ts`
used to carry, archived VERBATIM when that file's comments were compacted to the plain-language
standard (`docs/comment-standard.md`).

Nothing here is a rule. `commit-message.ts`'s behaviour lives in the code and its tests, and each
block below is quoted exactly as it stood on `origin/main` at `c185258e`, under a heading naming
the symbol it explained. The code keeps a one-line `// Why:` pointer wherever that history still
matters.

---

## Module header

`src/lib/commit-message.ts:7-34` at `c185258e`, 28 comment lines.

```
/**
 * lib/commit-message.ts — Conventional-Commits shaping for MACHINE-BUILT commit
 * messages (MASTER-PLAN §6A, the W1-T136/W1-T137 class).
 *
 * WHY THIS EXISTS. `commitlint` runs ONLY in CI (.github/workflows/ci.yml), over the
 * whole `origin/main..HEAD` range, and it is a REQUIRED check (ci-gate.yml). There is
 * no husky, no `core.hooksPath`, no `commit-msg` hook — so nothing local ever tells a
 * committer their message is malformed. The first signal is a red required check on an
 * already-open PR, at which point the W1-T76 fix rung has no move for a CI-check failure
 * and escalates a SPEC question instead (issues #304/#306, and #406 on 2026-07-20).
 *
 * Observed failures, all the same class:
 *   - PR #405 header 124 chars (cap 100) AND `FIND layer …` tripping `subject-case`
 *   - PRs #303/#305 headers at 108 and 114 chars
 *   - operator-authored plan PRs #399 (header-max-length) and #403 (subject-case)
 * Machine and human trip the identical rules, which is why the shaping belongs in one
 * tested place rather than in per-site discipline.
 *
 * SCOPE — this module shapes messages the HARNESS builds. It cannot police a message a
 * worker LLM authors inside its own worktree; that half is addressed by stating the rule
 * in the worker OUTPUT CONTRACT (lib/compaction.ts). Both halves are needed: this one is
 * deterministic, that one is instructional.
 *
 * The limits are NOT hard-coded here — {@link CONVENTIONAL_LIMITS} mirrors
 * `@commitlint/config-conventional`, and `test/commit-message.test.ts` proves every
 * output of this module against the REAL `commitlint` CLI, so a config bump that changes
 * a limit fails the test rather than silently diverging.
 */
```

## CONVENTIONAL_LIMITS

`src/lib/commit-message.ts:36-63` at `c185258e`, 28 comment lines.

```
/**
 * Limits mirroring `@commitlint/config-conventional` (see commitlint.config.mjs).
 *
 * `headerMaxLength` 100 GOVERNS A PRE-IMAGE, NOT WHAT LANDS, and that is worth knowing here rather
 * than rediscovering from a history scan. This repo squash-merges, so `main`'s header is the PR
 * TITLE with GitHub's ` (#NNNN)` appended AFTER every gate has run:
 *
 *   - `ci.yml`'s commitlint job lints the PR title (`gh pr view --json title`), pre-suffix;
 *   - `hooks/commit-msg` lints the branch commit, which the squash discards;
 *   - no workflow fires on `push: branches: [main]` except the four security scanners
 *     (codeql, osv-scanner, scorecard, semgrep), none of which reads a header.
 *
 * So NOTHING lints the header that actually ships, and the budget an author is really working
 * against is `100 - suffix`. The suffix is digit-dependent, MEASURED over origin/main at 41ce295:
 * +5 (5 commits), +6 (81), +7 (542), +8 (456). At four-digit PR numbers that is **92**; it becomes
 * 91 from #10000.
 *
 * THE TAX IS REAL AND SMALL, which is why this is a comment and not a check: of 1084 suffixed
 * commits, 30 titles already exceeded 100 (pre-gate history) and **56 passed the gate and landed
 * over 100** — 5.2%. 30 + 56 = 86, which reconciles exactly with the 86 landed headers over 100.
 * The consequence is a truncated title in a list view, not a broken build.
 *
 * DELIBERATELY NOT ENFORCED AT 92, in either direction. Failing there would refuse a header the
 * stated limit permits — the fifth bound in this repo to fire on a healthy condition. Warning there
 * would measure the COMMIT header, which under squash-merge is not what lands; it coincides with
 * the title only when GitHub defaults the squash title to a lone commit's subject, which nothing
 * here enforces. A warning that is right by coincidence is worse than a number written down.
 */
```

## normalizeSubjectCase

`src/lib/commit-message.ts:72-90` at `c185258e`, 19 comment lines.

```
/**
 * Lower-case the start of a subject so it cannot trip `subject-case`.
 *
 * MEASURED against the real CLI, not assumed — an earlier draft of this function
 * exempted a leading acronym on the theory that commitlint tests the subject's overall
 * case. It does not. Every one of these is REJECTED by the project's own config:
 *   `FIND layer — fuzzy search`      FAIL
 *   `SSE stream severed`             FAIL
 *   `URL round-trips on reload`      FAIL
 *   `Add a thing`                    FAIL
 * and the lower-cased forms all pass. There is no acronym exemption, so preserving one
 * would emit a message the gate rejects — the exact failure this module exists to stop.
 *
 * An all-caps leading word is lower-cased WHOLE (`SSE …` -> `sse …`) rather than by its
 * first character alone (`sSE …`). Both pass the gate — verified — but only one reads
 * like English, and a shaper that emits `sSE` teaches nothing to the humans reading the
 * log. A mixed-case word is lower-cased at its first character only, which is the
 * minimal reversible edit.
 */
```

## checkCommitMessage

`src/lib/commit-message.ts:159-181` at `c185258e`, 23 comment lines.

```
/**
 * Check a FULL commit message (header, blank line, body) against the same rules
 * {@link shapeCommitMessage} shapes FOR — but this direction VALIDATES a message someone
 * already wrote (a hand-authored commit) rather than building one from parts.
 *
 * W1-T221: this is the hand lane's other missing half. shapeCommitMessage is consumed by
 * the machine lanes (plan-pr-emitter.ts, plan-architect.ts, triage.ts) to BUILD a
 * compliant message; nothing on the hand/CLI path ever calls that, because there is no
 * `prefix`/`subject`/`body` triple to build from — there is only a message a human already
 * typed. This function reuses the SAME limits and the SAME `normalizeSubjectCase` rule
 * (never restates them) so the hand lane and the emitter lane cannot drift apart.
 *
 * W1-T416: covers EIGHT of `@commitlint/config-conventional`'s TEN error-level rules
 * directly — see {@link CONVENTIONAL_RULE_COVERAGE} for the full table, including the two
 * (`type-case`, `footer-max-line-length`) deliberately left to the mechanisms documented
 * there rather than re-implemented. {@link EMITTER_COMMITLINT_PARITY}
 * (test/commit-message.test.ts) is what proves this table stays true, not this comment.
 *
 * Returns one {@link CommitMessageViolation} per broken rule, empty when the message is
 * clean. Never throws — an unparseable header (no `type: subject` shape at all) is
 * reported as a type-empty violation against the whole header rather than crashing the
 * caller, since the caller's whole point is to run to completion and name every problem.
 */
```

## CONVENTIONAL_RULE_COVERAGE

`src/lib/commit-message.ts:273-284` at `c185258e`, 12 comment lines.

```
/**
 * WHICH of `@commitlint/config-conventional`'s TEN error-level rules
 * {@link checkCommitMessage} enforces, recorded as DATA rather than left for a reader to
 * infer by counting branches — that inference is exactly what let a 3-of-10 checker sit
 * beside a 10-of-10 linter unnoticed for as long as it did (W1-T416's own rationale).
 *
 * {@link EMITTER_COMMITLINT_PARITY} (test/commit-message.test.ts) is what keeps this table
 * honest — a corpus entry per rule below, driven through both the real `commitlint` CLI and
 * `checkCommitMessage`, asserting the two AGREE on every entry. A future config-conventional
 * bump that adds or changes a rule fails that test rather than silently invalidating this
 * table.
 */
```

## shapeCommitMessage

`src/lib/commit-message.ts:319-333` at `c185258e`, 15 comment lines.

```
/**
 * Shape a machine-built commit message so it passes commitlint.
 *
 * Guarantees, each covered by a test against the real CLI:
 *  - the header is <= `headerMaxLength` CHARACTERS (not bytes — an em-dash is 3 bytes
 *    and 1 character, and commitlint counts characters; measuring bytes is how a
 *    "100-char" header lands at 102 and still passes, or a 98-char one is wrongly cut)
 *  - the subject does not trip `subject-case`
 *  - no body line exceeds `bodyMaxLineLength`
 *  - overflow from a trimmed subject is PRESERVED in the body, never discarded
 *
 * `prefix` is the conventional `type(scope):` part and is never trimmed — if the prefix
 * alone cannot fit, that is a caller bug and throws rather than emitting a message that
 * silently fails the gate later.
 */
```

## Operator message standard banner (W1-T2807)

`src/lib/commit-message.ts:377-394` at `c185258e`, 18 comment lines.

```
// ── OPERATOR MESSAGE STANDARD — the generated commit's narrative half (W1-T2807) ─────────────
//
// Everything above this line governs SHAPE: a header length in characters, a subject case, a
// wrapped body, overflow preserved rather than discarded. Every one of those is a commitlint
// contract, and not one of them asks whether a reader learns anything. The reader of a generated
// commit — whoever finds it later doing archaeology, plus the retro — was the one reader this repo
// owed no structure to at all.
//
// WHAT IS FROZEN. docs/operator-message-standard.md names this surface and, in the same breath,
// freezes the parsed half: the conventional `type(scope)` prefix, every limit `shapeCommitMessage`
// enforces, the `Remudero-Task:` trailer and the `(W1-Tnnn)` subject citation. Nothing below moves
// a byte any of those parsers read. The narrative slots render as ordinary body paragraphs, which
// `shapeCommitMessage` then wraps exactly as it wraps any other body text.
//
// AND THE MARK IS NEVER SPLICED IN. A conformance footer appended to a commit message would land
// in the trailer region, where a line-anchored matcher is looking for `Remudero-Task:`. So the
// check is RETURNED BESIDE the message, never written into it — and it never blocks: a commit is
// not withheld because a paragraph is thin.
```

## GeneratedCommitNarrative

`src/lib/commit-message.ts:396-407` at `c185258e`, 12 comment lines.

```
/**
 * The narrative half of a generated commit, as the presence check reads it.
 *
 * `whatToDo` and `consequence` are NEW and OPTIONAL, and most callers will omit them — which is
 * exactly the gap this exists to make visible rather than silently accept, the same way
 * `Escalation.consequence` does on the escalation surface. Omitting one renders nothing, so a
 * caller that passes neither gets a byte-identical commit message.
 *
 * An explicit `null` is DIFFERENT from omitting: it means "there is nothing here", which the
 * checker counts as present. That is part (iv) of the standard — never reporting "observed absent"
 * and "not observed" as the same fact.
 */
```

## W1-T221 preflight banner

`src/lib/commit-message.ts:436-451` at `c185258e`, 16 comment lines.

```
// ── W1-T221: `rmd preflight` — the hand route's missing gate ───────────────────────────
//
// The worker (machine) lane already reaches this module's shaping through the shared
// plan-PR emitter. The operator's hand/CLI lane never called ANY of it — a "remember to
// run commitlint" memory note is not a gate, and this project's own record shows at least
// seven hand-route commitlint firings plus a green `npm test` run (tsx strips types
// without checking them) that hid three TS2353 errors CI alone caught (PR #477). This
// section gives the hand lane ONE command that runs commitlint, `tsc --noEmit`, and this
// module's own header/body checks — as three INDEPENDENT steps, each naming its own
// pass/fail — before a hand-authored push.
//
// A fourth, earlier draft chained these with `&&` and swallowed output into `/dev/null`.
// That is the exact shape fixture 3 in this task's rationale describes: a failing step
// whose only visible trace is the ABSENCE of a success line. Every step below runs
// regardless of whether an earlier one failed, and every step prints its own name in
// both directions — a passing preflight says what it checked, not merely exits 0.
```

## PreflightSpawn — `env` field

`src/lib/commit-message.ts:463-478` at `c185258e`, 16 comment lines.

```
    /**
     * Extra environment for this child, merged OVER `process.env`.
     *
     * THE DEFECT THIS EXISTS FOR. `--experimental-test-coverage` makes the test runner allocate
     * its coverage scratch under `os.tmpdir()` and remove it only on a NORMAL exit, so every
     * killed run leaks one. Measured on this host: 6.0G in a single leaked directory, and enough
     * of them filled a 29G root filesystem to 100% — which then corrupted a later gate that died
     * on ENOSPC with no `# tests` summary while reporting four failures that were artefacts of the
     * full disk rather than of any diff. The coverage leaf now points `TMPDIR` at a repo-local
     * directory it clears each run, and it had no way to say so without this.
     *
     * ⚠ `NODE_V8_COVERAGE` is the obvious guess and it is WRONG: measured, with it set to a repo
     * path the runner still wrote under `/tmp` and never created the named directory — it
     * overrides that variable for the children it spawns. `TMPDIR` is what relocates the scratch.
     */
```

## PreflightSpawn — `stream` field

`src/lib/commit-message.ts:480-503` at `c185258e`, 24 comment lines.

```
    /**
     * STREAM this child's output to the operator's terminal instead of capturing it.
     *
     * THE DEFECT THIS EXISTS FOR: `spawnSync` below pipes stdout/stderr into a buffer, so NOTHING
     * reaches the terminal until the child exits. Measured in a container: `preflight --ci-parity`
     * ran for OVER AN HOUR and produced ZERO output, and the operator resorted to `docker top`
     * three times to learn what a single line would have told him. An hour of silence is
     * indistinguishable from a hang.
     *
     * OPT-IN PER CALL, NEVER GLOBAL, and that is the whole reason this is a flag rather than a
     * change of default. Most callers here spawn `git diff`/`git merge-base` and READ the captured
     * stdout as data (`mergeBaseDiffText`, `changedFilesListPath`, `triggerLeaf`'s
     * `/REQUIRED/.test`); streaming those would both spew diffs at the operator and break the
     * parse. Only the two multi-minute test steps set this.
     *
     * WHAT IT COSTS, STATED PLAINLY: `spawnSync` cannot tee. With `stdio` inherited the child
     * writes straight to the terminal and `res.stdout`/`res.stderr` come back `null`, so a
     * streaming call trades the captured TEXT for live output. The VERDICT is unaffected — it is
     * `status`, which `spawnSync` still reports correctly on an inherited child (verified, both
     * zero and nonzero) — and the text is not lost, it is on screen. A true in-process tee needs
     * an ASYNC spawn, which would ripple through every entry in `CI_PARITY_TABLE` and both callers
     * in this file; that is a refactor, not this fix.
     */
```

## PreflightSpawn — `signal` field

`src/lib/commit-message.ts:514-533` at `c185258e`, 20 comment lines.

```
  /**
   * The signal that terminated the child, when one did — `spawnSync`'s own `signal` field,
   * which this seam previously dropped on the floor.
   *
   * WHY IT IS ITS OWN FIELD AND NOT FOLDED INTO `error`. MEASURED against the real
   * `spawnSync` (SIGKILL/SIGSEGV/SIGTERM self-kills, a `maxBuffer` breach, and a `timeout`):
   * a child KILLED by a signal reports `status: null`, `signal` set, and **no `error` at
   * all** — so before this field existed, a policy kill was indistinguishable from a spawn
   * that never happened, and {@link spawnFailureDetail} could only say "no exit status and no
   * error message". That is the gap #1553 left.
   *
   * THE TWO ARE NOT EXCLUSIVE, WHICH DECIDES THE REPORTING ORDER: a `maxBuffer` breach
   * reports `error: spawnSync … ENOBUFS` **and** `signal: SIGTERM`, and a `timeout` reports
   * `ETIMEDOUT` **and** `SIGTERM`. In both, the errno is the CAUSE and the SIGTERM is merely
   * how the runtime carried it out — so `spawnFailureDetail` leads with the errno and mentions
   * the signal second. Leading with the signal would report the ENOBUFS this file's own
   * `PREFLIGHT_SPAWN_MAX_BUFFER` exists to prevent as a bare "killed by SIGTERM", losing the
   * ceiling story entirely.
   */
```

## PREFLIGHT_SPAWN_MAX_BUFFER

`src/lib/commit-message.ts:536-542` at `c185258e`, 7 comment lines.

```
// `npm run test:ci` alone currently writes ~1.7MB of TAP output to stdout (no --test-reporter
// override, so node --test's default verbose writer). `spawnSync`'s default `maxBuffer` is
// Node's own default of 1MB, so that command — and any other step whose output grows past 1MB —
// was killed for exceeding it: `status` came back `null` (ENOBUFS), which every caller in this
// file and lib/ci-parity.ts reads as a bare, unexplained FAIL. 64MB is a CEILING against runaway
// output, not a target: comfortably clear of today's ~1.7MB with a lot of room for the suite to
// keep growing, while still catching a genuinely stuck/looping child.
```

## SELF_SYNC_GUARD_ENV_NAME

`src/lib/commit-message.ts:545-550` at `c185258e`, 6 comment lines.

```
// W1-T2769: the LITERAL, never an import off self-sync.js -- self-sync.ts already imports
// (transitively, via daemon.ts) back to this module across dozens of existing rings, so a value
// import the other way closes each one into a NEW dependency-cruiser cycle (MEASURED: 13 -> 53
// warnings, cycle-ratchet ceiling in scripts/cycle-baseline.json). Same pattern as
// open-prs-rest.ts's own header note for supersession.ts. self-sync.ts's `SELF_SYNC_GUARD_ENV`
// export is the canonical name for this string; this constant must stay byte-identical to it.
```

## defaultPreflightSpawn — guard scrub

`src/lib/commit-message.ts:561-575` at `c185258e`, 15 comment lines.

```
  // W1-T2769: UNCONDITIONALLY SCRUBBED, regardless of whether `opts.env` was supplied. Every
  // child this function spawns is a build/test process (`npm run test:ci` chief among them, via
  // `ci-parity.ts`'s `ci:test` step) — never a re-exec of `rmd` itself — so this guard has no
  // legitimate meaning for it. `alreadySelfSynced` (self-sync.ts) reads BOTH the injected `env`
  // argument AND its own `process.env` — the latter read is what makes an operator's shell
  // export cross into a spawned child regardless of what `env` object the child's OWN caller
  // constructs. Deleting the key here, in the ONE place every preflight child is spawned, is
  // what keeps that crossing from being possible at all: MEASURED, an operator's
  // `RMD_SELF_SYNC_DONE=1` (documented in self-sync.ts as guarding "every call" for the shell's
  // session) turned 45 of `ci:test`'s own self-sync tests red on an otherwise-green feature
  // branch, because the export reached `node --test`'s children through exactly this
  // inheritance path. `run-task.ts`'s `READ_ONLY_FRESHNESS_EXEMPT_VERBS` addition removes the
  // NEED to export it for `preflight` itself; this removes the RISK of it regardless, for a
  // shell where it is set for some unrelated reason.
```

## defaultPreflightSpawn — `stdio` mode

`src/lib/commit-message.ts:582-593` at `c185258e`, 12 comment lines.

```
    // `stdio[0]` stays a pipe in BOTH modes so `opts.input` keeps working; only the output
    // streams change. Inheriting also retires the `maxBuffer` ceiling for these steps — the
    // ENOBUFS that once read as an unexplained red `ci:test` cannot happen to a child whose
    // output never passes through this process at all.
    //
    // A SECOND EFFECT WORTH NAMING, because it is what actually meets the operator's need:
    // `node --test` picks its default reporter by whether stdout is a TTY — TAP when piped,
    // spec when not. `parseFailingTestNames` (scripts/test-with-retry.mjs) states exactly that.
    // So an inherited run in a real terminal prints per-test spec lines live, and the
    // coverage step (which passes `--test-reporter=spec --test-reporter-destination=stdout`
    // explicitly) streams its per-file lines in either case. No reporter flag changes here.
```

## spawnFailureDetail

`src/lib/commit-message.ts:624-635` at `c185258e`, 12 comment lines.

```
/**
 * A step whose subprocess NEVER STARTED, named as its own outcome — or `undefined` when the child
 * did produce an exit status and the ordinary pass/fail reading applies.
 *
 * ENFORCES THE CONTRACT {@link PreflightSpawn}'s `error` FIELD ALREADY DECLARES and the three
 * hand-route steps below then broke: `status: null` is "the spawn itself failed", NEVER an ordinary
 * nonzero exit whose output happens to be empty. `shellOut` (lib/ci-parity.ts) honours it; these did
 * not, so three drain runs read `commitlint: FAIL` on compliant 71/75/81-char subjects with an empty
 * body, and the run's summary recorded `durationMs: 1` for the WHOLE preflight. A millisecond is not
 * a lint. The full reasoning, the measurements and both falsifiers live in
 * test/preflight-spawn-failure.test.ts, which is where the long form belongs.
 */
```

## spawnFailureDetail — the three-states branch

`src/lib/commit-message.ts:641-652` at `c185258e`, 12 comment lines.

```
  // THREE STATES, KEPT APART BECAUSE THEIR REMEDIES DIFFER. All three were MEASURED against the
  // real `spawnSync` rather than reasoned about (see `signal`'s doc on PreflightSpawn):
  //   (a) errno  — ENOENT means the path is not there from the CHILD's view (a linking problem);
  //       EACCES/EPERM means it IS there and execution was refused (sandbox policy). Opposite
  //       fixes, so the errno is quoted verbatim rather than paraphrased.
  //   (b) signal with NO errno — the child STARTED and was terminated. SIGKILL under a sandbox is
  //       a policy kill; SIGSEGV is a crash. Before this branch existed both landed in (c).
  //   (c) neither — now genuinely rare, and worth saying so, because a reader who sees it should
  //       suspect the seam rather than assume a cause.
  // ORDER IS LOAD-BEARING: `maxBuffer`/`timeout` breaches set errno AND `SIGTERM`, so (a) is
  // tested first and mentions the signal second. Leading with the signal would report an ENOBUFS
  // as "killed by SIGTERM" and lose the ceiling this file's own PREFLIGHT_SPAWN_MAX_BUFFER names.
```

## splitRangeCommitMessages

`src/lib/commit-message.ts:721-737` at `c185258e`, 17 comment lines.

```
/**
 * Pure NUL-split of `git log --format=%x00%B`'s raw stdout into one entry per commit.
 *
 * W1-T416: the range half of the emitter/commitlint divergence. `%x00%B` prefixes EVERY
 * commit's body with a NUL — including the first — so splitting on `"\0"` alone leaves an
 * empty artifact BEFORE the first real entry (nothing precedes the very first NUL). That
 * leading artifact is stripped explicitly; every remaining piece is a real commit's message
 * and is KEPT even when it trims to the empty string, because a message that trims to empty
 * is exactly the case `subject-empty`/`type-empty` exist to catch — dropping it here would
 * vanish it before either judgement is reached, the escape this function used to be half of.
 * The NUL split's real purpose survives unchanged: a body containing blank lines is never
 * mistaken for a message boundary, since only an actual `\0` (never a `\n\n`) splits entries.
 *
 * An entirely EMPTY `stdout` (a zero-commit range — `from` and `to` identical) is the one
 * case treated specially: it is zero commits, not one commit with an empty message, so it
 * returns `[]` rather than `[""]`.
 */
```
