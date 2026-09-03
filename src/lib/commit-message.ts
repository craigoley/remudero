import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { SELF_SYNC_GUARD_ENV } from "./self-sync.js";

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
export const CONVENTIONAL_LIMITS = {
  headerMaxLength: 100,
  bodyMaxLineLength: 100,
} as const;

/** Marker appended to a header whose subject had to be trimmed. */
const ELLIPSIS = "…";

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
export function normalizeSubjectCase(subject: string): string {
  const trimmed = subject.trimStart();
  const firstWord = trimmed.split(/\s+/, 1)[0] ?? "";
  const alpha = firstWord.replace(/[^A-Za-z]/g, "");
  if (alpha.length >= 2 && alpha === alpha.toUpperCase()) {
    return firstWord.toLowerCase() + trimmed.slice(firstWord.length);
  }
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

/** Wrap `text` so no line exceeds `max` chars, breaking on whitespace only. */
export function wrapBodyLines(text: string, max: number = CONVENTIONAL_LIMITS.bodyMaxLineLength): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (line === "") {
        line = word;
      } else if (line.length + 1 + word.length <= max) {
        line += ` ${word}`;
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line !== "") out.push(line);
  }
  return out;
}

/** One rule this module's checks enforce, named to match the real commitlint rule id it
 *  mirrors (`@commitlint/config-conventional`) so a failure reads the same way here as it
 *  would in a CI log. */
export interface CommitMessageViolation {
  rule:
    | "header-max-length"
    | "header-trim"
    | "type-empty"
    | "type-enum"
    | "subject-empty"
    | "subject-case"
    | "subject-full-stop"
    | "body-max-line-length";
  message: string;
}

/** The eleven values `@commitlint/config-conventional`'s `type-enum` rule accepts — read
 *  out of the installed package (node_modules/@commitlint/config-conventional/lib/index.js),
 *  not the README, so a version bump that changes the list fails {@link EMITTER_COMMITLINT_PARITY}
 *  rather than silently diverging here. */
const CONVENTIONAL_TYPES = [
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "style",
  "test",
] as const;

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
export function checkCommitMessage(
  raw: string,
  limits: { headerMaxLength: number; bodyMaxLineLength: number } = CONVENTIONAL_LIMITS,
): CommitMessageViolation[] {
  const violations: CommitMessageViolation[] = [];
  const lines = raw.replace(/\n+$/, "").split("\n");
  const header = lines[0] ?? "";

  if (header.length > limits.headerMaxLength) {
    violations.push({
      rule: "header-max-length",
      message: `header is ${header.length} characters (max ${limits.headerMaxLength}): ${JSON.stringify(header)}`,
    });
  }

  // header-trim — leading or trailing whitespace on the header line, checked against the
  // RAW header before any trimming, since trimming it away would hide the very thing this
  // rule exists to catch.
  if (header !== "" && header.trim() !== header) {
    violations.push({
      rule: "header-trim",
      message: `header has leading or trailing whitespace: ${JSON.stringify(header)}`,
    });
  }

  // `type(scope): subject` — type and subject are captured separately, matching
  // commitlint's own header-parser split. An unparseable header (no `type:` prefix at
  // all, or a type that fails the lower-case anchor — a capitalised type is `type-case`,
  // left to this fallback rather than re-implemented, see CONVENTIONAL_RULE_COVERAGE)
  // falls back to type-empty plus checking the whole header as the subject.
  const match = header.match(/^([a-z][a-z0-9-]*)(?:\([^)]*\))?!?:\s*(.*)$/);
  const type = match ? match[1] : "";
  const subject = (match ? match[2] : header).trim();

  if (type === "") {
    violations.push({
      rule: "type-empty",
      message: `no "type:" prefix found on the header: ${JSON.stringify(header)}`,
    });
  } else if (!(CONVENTIONAL_TYPES as readonly string[]).includes(type)) {
    violations.push({
      rule: "type-enum",
      message: `type ${JSON.stringify(type)} is not one of [${CONVENTIONAL_TYPES.join(", ")}]`,
    });
  }

  if (subject === "") {
    violations.push({
      rule: "subject-empty",
      message: `nothing follows the "type(scope):" prefix: ${JSON.stringify(header)}`,
    });
  } else {
    if (normalizeSubjectCase(subject) !== subject) {
      violations.push({
        rule: "subject-case",
        message: `subject does not start lower-case: ${JSON.stringify(subject)}`,
      });
    }
    if (subject.endsWith(".") && !subject.endsWith("...")) {
      violations.push({
        rule: "subject-full-stop",
        message: `subject ends with a full stop: ${JSON.stringify(subject)}`,
      });
    }
  }

  for (const line of lines.slice(1)) {
    if (line.length > limits.bodyMaxLineLength) {
      violations.push({
        rule: "body-max-line-length",
        message: `body line is ${line.length} characters (max ${limits.bodyMaxLineLength}): ${JSON.stringify(line)}`,
      });
    }
  }

  return violations;
}

/** One `@commitlint/config-conventional` error-level rule's coverage status in this module. */
export type RuleCoverageStatus = "checked" | "incidental";

export interface RuleCoverageEntry {
  /** The commitlint rule id, exactly as `@commitlint/config-conventional` names it. */
  rule: string;
  /** "checked" — {@link checkCommitMessage} tests this rule directly. "incidental" — NOT
   *  re-implemented; a different check in this module happens to reject the same messages,
   *  named so a reader does not mistake the absence for a gap. */
  status: RuleCoverageStatus;
  note: string;
}

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
export const CONVENTIONAL_RULE_COVERAGE: RuleCoverageEntry[] = [
  { rule: "header-max-length", status: "checked", note: "header longer than headerMaxLength characters" },
  { rule: "header-trim", status: "checked", note: "header has leading or trailing whitespace" },
  { rule: "type-empty", status: "checked", note: 'no "type:" prefix found on the header at all' },
  { rule: "type-enum", status: "checked", note: "type is not one of the eleven conventional types" },
  { rule: "subject-empty", status: "checked", note: 'nothing follows "type(scope):" on the header' },
  { rule: "subject-case", status: "checked", note: "subject does not start lower-case" },
  { rule: "subject-full-stop", status: "checked", note: "subject ends with a literal full stop" },
  { rule: "body-max-line-length", status: "checked", note: "a body line exceeds bodyMaxLineLength characters" },
  {
    rule: "type-case",
    status: "incidental",
    note:
      "not implemented directly — a non-lower-case type fails the type-prefix match, so it falls " +
      "into the type-empty/subject-case fallback instead of being reported by its own name",
  },
  {
    rule: "footer-max-line-length",
    status: "incidental",
    note:
      "not implemented directly — body-max-line-length's budget already applies to EVERY line " +
      "after the header, footers included, so a too-long footer line is already rejected",
  },
];

export interface ShapedMessage {
  /** The full message: header, blank line, then the wrapped body (if any). */
  message: string;
  /** The header alone, guaranteed <= headerMaxLength CHARACTERS. */
  header: string;
  /** True when the subject was trimmed to fit (overflow moved into the body). */
  trimmed: boolean;
}

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
export function shapeCommitMessage(
  prefix: string,
  subject: string,
  body = "",
  limits: { headerMaxLength: number; bodyMaxLineLength: number } = CONVENTIONAL_LIMITS,
): ShapedMessage {
  const cleanPrefix = prefix.trim().replace(/:$/, "") + ":";
  const cleanSubject = normalizeSubjectCase(subject.trim().replace(/\.$/, ""));

  const room = limits.headerMaxLength - cleanPrefix.length - 1; // -1 for the space
  if (room <= ELLIPSIS.length) {
    throw new Error(
      `shapeCommitMessage: prefix ${JSON.stringify(cleanPrefix)} leaves no room for a subject ` +
        `within header-max-length ${limits.headerMaxLength}`,
    );
  }

  let header: string;
  let overflow = "";
  let trimmed = false;

  if (cleanSubject.length <= room) {
    header = `${cleanPrefix} ${cleanSubject}`;
  } else {
    trimmed = true;
    const budget = room - ELLIPSIS.length;
    // Break on a word boundary so the header never ends mid-word.
    let cut = cleanSubject.lastIndexOf(" ", budget);
    if (cut <= 0) cut = budget;
    header = `${cleanPrefix} ${cleanSubject.slice(0, cut).trimEnd()}${ELLIPSIS}`;
    overflow = cleanSubject.slice(cut).trim();
  }

  const bodyParts: string[] = [];
  if (overflow !== "") bodyParts.push(overflow);
  if (body.trim() !== "") bodyParts.push(body.trim());

  const wrapped = bodyParts.length > 0 ? wrapBodyLines(bodyParts.join("\n\n"), limits.bodyMaxLineLength) : [];
  const message = wrapped.length > 0 ? `${header}\n\n${wrapped.join("\n")}\n` : `${header}\n`;

  return { message, header, trimmed };
}

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

/** What a subprocess-driving step needs — real `spawnSync` by default, injectable so a
 *  test can prove pass/fail/thrown WITHOUT actually shelling `tsc`/`commitlint` (slow,
 *  and the point under test is the STEP's reporting, not the tool's own correctness —
 *  that half is already proven against the real CLI by test/commit-message.test.ts and
 *  CI's own `tsc -p tsconfig.json --noEmit` step). */
export type PreflightSpawn = (
  file: string,
  args: string[],
  opts?: {
    cwd?: string;
    input?: string;
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
    env?: NodeJS.ProcessEnv;
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
    stream?: boolean;
  },
) => {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set only when the child never produced an exit status at all (killed by a signal, a
   *  buffer ceiling hit, ENOENT, ...) — i.e. exactly when `status` is `null`. A caller must
   *  treat this as a distinct "the spawn itself failed" outcome, never as an ordinary nonzero
   *  exit whose output happens to be empty. */
  error?: string;
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
  signal?: string;
};

// `npm run test:ci` alone currently writes ~1.7MB of TAP output to stdout (no --test-reporter
// override, so node --test's default verbose writer). `spawnSync`'s default `maxBuffer` is
// Node's own default of 1MB, so that command — and any other step whose output grows past 1MB —
// was killed for exceeding it: `status` came back `null` (ENOBUFS), which every caller in this
// file and lib/ci-parity.ts reads as a bare, unexplained FAIL. 64MB is a CEILING against runaway
// output, not a target: comfortably clear of today's ~1.7MB with a lot of room for the suite to
// keep growing, while still catching a genuinely stuck/looping child.
const PREFLIGHT_SPAWN_MAX_BUFFER = 64 * 1024 * 1024;

export function defaultPreflightSpawn(
  file: string,
  args: string[],
  opts: { cwd?: string; input?: string; stream?: boolean; env?: NodeJS.ProcessEnv } = {},
): { status: number | null; stdout: string; stderr: string; error?: string; signal?: string } {
  // MERGED OVER `process.env`, never replacing it: a bare `env` would drop PATH, HOME and the
  // toolchain pins every step here depends on.
  const env = { ...process.env, ...opts.env };
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
  delete env[SELF_SYNC_GUARD_ENV];
  const res = spawnSync(file, args, {
    cwd: opts.cwd,
    input: opts.input,
    env,
    encoding: "utf8",
    maxBuffer: PREFLIGHT_SPAWN_MAX_BUFFER,
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
    ...(opts.stream ? { stdio: ["pipe", "inherit", "inherit"] as const } : {}),
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error ? res.error.message : undefined,
    // `spawnSync` types this `NodeJS.Signals | null`; normalised to `undefined` so it reads the
    // same way as `error` above — absent means absent, never a null a caller has to special-case.
    signal: res.signal ?? undefined,
  };
}

/** One preflight step's outcome — named in BOTH directions (fixture 3: a failure legible
 *  only as a missing success line is barely a check at all). */
export interface PreflightStepResult {
  name: "commitlint" | "typecheck" | "emitter-checks";
  ok: boolean;
  /** Human-readable line(s) — printed unconditionally, pass or fail. */
  detail: string;
}

/** The commit range this hand-authored push is about to send — the "STAGED commits" the
 *  acceptance criteria name. Defaults to everything on HEAD not yet on `origin/main`. */
export interface PreflightRange {
  from: string;
  to: string;
}

const DEFAULT_PREFLIGHT_RANGE: PreflightRange = { from: "origin/main", to: "HEAD" };

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
export function spawnFailureDetail(
  step: string,
  res: { status: number | null; error?: string; signal?: string },
): string | undefined {
  if (res.status !== null) return undefined;
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
  const why = res.error
    ? `${res.error}${res.signal ? `, and the runtime then terminated it with ${res.signal}` : ""}`
    : res.signal
      ? `the child was KILLED by ${res.signal} — it started and was terminated, rather than never starting`
      : "the child produced no exit status, no signal and no error message";
  return `${step}: SPAWN FAILURE — ${why}; the check did NOT run, so this is not a result about the code`;
}


/**
 * Step 1/3 — commitlint over the range, via the SAME binary + config CI uses
 * (`node_modules/.bin/commitlint --config commitlint.config.mjs`), so a local PASS means
 * the same thing a CI PASS does. Independent of the other two steps: a thrown spawn (the
 * binary missing, say) is caught and reported as this step's own failure, never allowed to
 * abort the steps after it.
 */
export function commitlintStep(
  repoRoot: string,
  range: PreflightRange = DEFAULT_PREFLIGHT_RANGE,
  spawn: PreflightSpawn = defaultPreflightSpawn,
): PreflightStepResult {
  try {
    const bin = join(repoRoot, "node_modules", ".bin", "commitlint");
    const config = join(repoRoot, "commitlint.config.mjs");
    const res = spawn(process.execPath, [bin, "--config", config, "--from", range.from, "--to", range.to], {
      cwd: repoRoot,
    });
    const spawnFailed = spawnFailureDetail("commitlint", res);
    if (spawnFailed) return { name: "commitlint", ok: false, detail: spawnFailed };
    const ok = res.status === 0;
    return {
      name: "commitlint",
      ok,
      detail: ok
        ? `commitlint: PASS — ${range.from}..${range.to} conform to Conventional Commits`
        : `commitlint: FAIL — ${range.from}..${range.to}\n${(res.stdout + res.stderr).trim()}`,
    };
  } catch (e) {
    return { name: "commitlint", ok: false, detail: `commitlint: FAIL — ${String((e as Error)?.message ?? e)}` };
  }
}

/**
 * Step 2/3 — `tsc -p tsconfig.json --noEmit`, the SAME invocation CI's `ci` job runs
 * (.github/workflows/ci.yml). This is fixture 2's fix: `npm test` runs through `tsx`,
 * which STRIPS types without checking them, so a green test run (PR #477) is not a
 * compile. Independent of commitlint and the emitter checks — a thrown spawn is caught and
 * reported here rather than aborting the run.
 */
export function typecheckStep(repoRoot: string, spawn: PreflightSpawn = defaultPreflightSpawn): PreflightStepResult {
  try {
    const tsc = join(repoRoot, "node_modules", ".bin", "tsc");
    const res = spawn(tsc, ["-p", "tsconfig.json", "--noEmit"], { cwd: repoRoot });
    const spawnFailed = spawnFailureDetail("typecheck", res);
    if (spawnFailed) return { name: "typecheck", ok: false, detail: spawnFailed };
    const ok = res.status === 0;
    return {
      name: "typecheck",
      ok,
      detail: ok
        ? "typecheck: PASS — tsc -p tsconfig.json --noEmit"
        : `typecheck: FAIL — tsc -p tsconfig.json --noEmit\n${(res.stdout + res.stderr).trim()}`,
    };
  } catch (e) {
    return { name: "typecheck", ok: false, detail: `typecheck: FAIL — ${String((e as Error)?.message ?? e)}` };
  }
}

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
export function splitRangeCommitMessages(stdout: string): string[] {
  if (stdout === "") return [];
  return stdout
    .replace(/^\0/, "")
    .split("\0")
    .map((s) => s.trim());
}

/** `git log` the range's raw commit messages, NUL-separated so a body containing blank
 *  lines can't be mistaken for a message boundary. */
export function readRangeCommitMessages(
  repoRoot: string,
  range: PreflightRange = DEFAULT_PREFLIGHT_RANGE,
  spawn: PreflightSpawn = defaultPreflightSpawn,
): string[] {
  const res = spawn("git", ["log", "--format=%x00%B", `${range.from}..${range.to}`], { cwd: repoRoot });
  // A `git log` that never ran ALSO returns an empty stdout — the same shape as a genuinely
  // empty range — so `spawnFailureDetail` (which reads `res.status`, not `res.stdout`) is what
  // tells the two apart. Skipping it would let a never-run spawn read as zero messages, and
  // zero messages is a PASS over an empty set, the vacuous-pass family.
  const spawnFailed = spawnFailureDetail("emitter-checks", res);
  if (spawnFailed) throw new Error(spawnFailed);
  return splitRangeCommitMessages(res.stdout);
}

/**
 * Step 3/3 — "the emitter's own checks": {@link checkCommitMessage} against every commit
 * message in the range, CALLED rather than restated (the whole point of this task — the
 * hand lane gets a call site into the SAME rules the machine lanes already shape against,
 * so the two can never drift apart the way a second hand-rolled rule-set would). Independent
 * of the other two steps — a `git log` that throws is caught and reported as this step's
 * own failure.
 */
export function emitterChecksStep(
  repoRoot: string,
  range: PreflightRange = DEFAULT_PREFLIGHT_RANGE,
  spawn: PreflightSpawn = defaultPreflightSpawn,
): PreflightStepResult {
  try {
    const messages = readRangeCommitMessages(repoRoot, range, spawn);
    const violations = messages.flatMap((message, i) =>
      checkCommitMessage(message).map((v) => `commit ${i + 1}/${messages.length} (${v.rule}): ${v.message}`),
    );
    const ok = violations.length === 0;
    return {
      name: "emitter-checks",
      ok,
      detail: ok
        ? `emitter-checks: PASS — ${messages.length} commit message(s) in ${range.from}..${range.to} match lib/commit-message.ts`
        : `emitter-checks: FAIL — lib/commit-message.ts rejects ${violations.length} thing(s)\n${violations.join("\n")}`,
    };
  } catch (e) {
    return { name: "emitter-checks", ok: false, detail: `emitter-checks: FAIL — ${String((e as Error)?.message ?? e)}` };
  }
}

export interface PreflightResult {
  steps: PreflightStepResult[];
  ok: boolean;
}

export interface PreflightDeps {
  range?: PreflightRange;
  spawn?: PreflightSpawn;
}

/**
 * ONE COMMAND, THREE INDEPENDENT STEPS, EACH REPORTING ITS OWN EXIT (this task's design).
 * Runs commitlint, then `tsc --noEmit`, then the emitter's header/body checks — never
 * chained with `&&`, so one step failing can neither hide nor block the ones after it
 * (fixtures 3 and 4). `ok` is the AND of all three; every step's `detail` is meant to be
 * printed regardless of `ok`, so a caller sees every problem in one run rather than only
 * the first.
 */
export function runPreflight(repoRoot: string, deps: PreflightDeps = {}): PreflightResult {
  const range = deps.range ?? DEFAULT_PREFLIGHT_RANGE;
  const spawn = deps.spawn ?? defaultPreflightSpawn;
  const steps: PreflightStepResult[] = [
    commitlintStep(repoRoot, range, spawn),
    typecheckStep(repoRoot, spawn),
    emitterChecksStep(repoRoot, range, spawn),
  ];
  return { steps, ok: steps.every((s) => s.ok) };
}
