import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  type OperatorMessageSlot,
} from "./operator-message.js";

/**
 * Conventional-Commits shaping for commit messages the harness builds (MASTER-PLAN §6A, the
 * W1-T136/W1-T137 class). `commitlint` runs only in CI as a required check, so nothing local
 * warns a committer beforehand; this shapes what the harness builds, never a worker LLM's own
 * commit (that is lib/compaction.ts's output contract instead). {@link CONVENTIONAL_LIMITS}
 * mirrors `@commitlint/config-conventional`; test/commit-message.test.ts proves every output
 * against the real CLI. Why: archived in docs/forensics/commit-message.md.
 */

/**
 * Limits mirroring `@commitlint/config-conventional` (see commitlint.config.mjs).
 *
 * `headerMaxLength` governs the PR TITLE commitlint lints — a PRE-image, not the header that
 * lands on `main`: this repo squash-merges and GitHub appends a ` (#NNNN)` suffix afterward,
 * unlinted. Not enforced against that smaller real budget, since doing so would either refuse a
 * compliant header or measure one squash-merge discards. Why: archived in docs/forensics/commit-message.md.
 */
export const CONVENTIONAL_LIMITS = {
  headerMaxLength: 100,
  bodyMaxLineLength: 100,
} as const;

/** Marker appended to a header whose subject had to be trimmed. */
const ELLIPSIS = "…";

/**
 * Lower-case the start of a subject so it cannot trip `subject-case`. Verified against the real
 * CLI: there is no acronym exemption, so a leading all-caps word (`SSE stream …`) fails the
 * gate like any other and is lower-cased WHOLE; a mixed-case word is lower-cased at its first
 * character only, the minimal reversible edit. Why: archived in docs/forensics/commit-message.md.
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

/** One rule this module's checks enforce, named after the real commitlint rule id
 *  (`@commitlint/config-conventional`) so a failure reads the same here as in a CI log. */
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

/** The eleven values `@commitlint/config-conventional`'s `type-enum` rule accepts, read from
 *  the installed package so a version bump fails {@link EMITTER_COMMITLINT_PARITY} instead. */
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
 * Check a full commit message against the same rules {@link shapeCommitMessage} shapes for —
 * this VALIDATES a message already written (the hand/CLI lane's missing half, W1-T221), reusing
 * the same limits and {@link normalizeSubjectCase}. Covers eight of ten
 * `@commitlint/config-conventional` rules; see {@link CONVENTIONAL_RULE_COVERAGE} for the rest.
 * Never throws: an unparseable header reports as type-empty instead.
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

  // header-trim: checked against the raw header before trimming, since trimming first would hide it.
  if (header !== "" && header.trim() !== header) {
    violations.push({
      rule: "header-trim",
      message: `header has leading or trailing whitespace: ${JSON.stringify(header)}`,
    });
  }

  // `type(scope): subject`, split like commitlint's own parser. No `type:` prefix, or a
  // capitalised type (`type-case`, see CONVENTIONAL_RULE_COVERAGE), falls back to type-empty
  // plus checking the whole header as the subject.
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
  /** "checked" — {@link checkCommitMessage} tests this rule directly. "incidental" — a
   *  different check happens to reject the same messages, named so it doesn't read as a gap. */
  status: RuleCoverageStatus;
  note: string;
}

/**
 * Which of `@commitlint/config-conventional`'s ten error-level rules {@link checkCommitMessage}
 * enforces, recorded as DATA rather than inferred by counting branches — that inference let a
 * 3-of-10 checker sit beside a 10-of-10 linter unnoticed (W1-T416).
 * {@link EMITTER_COMMITLINT_PARITY} proves every row against the real CLI.
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
 * Shape a machine-built commit message so it passes commitlint: the header stays within
 * `headerMaxLength` CHARACTERS (not bytes), the subject cannot trip `subject-case`, no body
 * line exceeds `bodyMaxLineLength`, and overflow from a trimmed subject is preserved in the
 * body. `prefix` is never trimmed: if it alone cannot fit, that is a caller bug and throws.
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

// ── Operator message standard — the generated commit's narrative half (W1-T2807) ────────────
//
// Everything above governs SHAPE; none of it asks whether a later reader learns anything.
// docs/operator-message-standard.md freezes the parsed half (prefix, every shapeCommitMessage
// limit, the `Remudero-Task:` trailer, the `(W1-Tnnn)` citation); the narrative slots below
// render as ordinary body paragraphs shapeCommitMessage wraps like any other text. The
// conformance check is RETURNED beside the message, never spliced in, and never blocks. Why:
// archived in docs/forensics/commit-message.md.

/**
 * The narrative half of a generated commit, as the presence check reads it. `whatToDo` and
 * `consequence` are optional; omitting both renders nothing. An explicit `null` differs from
 * omitting it: it means "there is nothing here", counted as present. Why: archived in docs/forensics/commit-message.md.
 */
export interface GeneratedCommitNarrative {
  /** The conventional `type(scope)` prefix — a commit's declared speaker. */
  prefix: string;
  /** The commit subject: what happened. */
  subject: string;
  /** What a reader who finds this commit later can do about it. */
  whatToDo?: OperatorMessageSlot;
  /** Why it matters to that reader — the standard's part (ii). */
  consequence?: OperatorMessageSlot;
}

/**
 * The narrative slots rendered as body paragraphs, in the standard's own order. Returns `""`
 * when neither carries text; an explicit `null` also renders nothing — a statement to the
 * record, not a sentence this module invents on the author's behalf.
 */
export function renderCommitNarrativeParagraphs(narrative: GeneratedCommitNarrative): string {
  const paragraphs: string[] = [];
  if (typeof narrative.consequence === "string" && narrative.consequence.trim() !== "") {
    paragraphs.push(narrative.consequence.trim());
  }
  if (typeof narrative.whatToDo === "string" && narrative.whatToDo.trim() !== "") {
    paragraphs.push(narrative.whatToDo.trim());
  }
  return paragraphs.join("\n\n");
}

// ── W1-T221: `rmd preflight` — the hand route's missing gate ─────────────────────────────────
//
// The machine lane already reaches this module's shaping through the plan-PR emitter; the
// hand/CLI lane never called any of it, and a "remember to run commitlint" memory note is not a
// gate. This gives it one command running commitlint, `tsc --noEmit`, and this module's own
// checks as three INDEPENDENT steps, each printing its own pass/fail regardless of an earlier
// step's outcome. Why: archived in docs/forensics/commit-message.md.

/** What a subprocess-driving step needs — real `spawnSync` by default, injectable so a test can
 *  prove pass/fail/thrown without actually shelling `tsc`/`commitlint` (already proven against
 *  the real CLI by test/commit-message.test.ts and CI's own typecheck step). */
export type PreflightSpawn = (
  file: string,
  args: string[],
  opts?: {
    cwd?: string;
    input?: string;
    /**
     * Extra environment for this child, merged OVER `process.env`. `TMPDIR` relocates the test
     * runner's coverage scratch off `os.tmpdir()` (a killed run once leaked enough to fill the
     * root disk); `NODE_V8_COVERAGE` looks like the fix and is NOT. Why: docs/forensics/commit-message.md.
     */
    env?: NodeJS.ProcessEnv;
    /**
     * Stream this child's output to the operator's terminal instead of capturing it — otherwise
     * `spawnSync` buffers it until exit, making a long step look hung. OPT-IN per call: callers
     * here parse captured stdout as data, which streaming would break. Why: docs/forensics/commit-message.md.
     */
    stream?: boolean;
  },
) => {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set only when the child never produced an exit status (`status: null`) — its own "the
   *  spawn itself failed" outcome, never an ordinary nonzero exit with empty output. */
  error?: string;
  /**
   * The signal that terminated the child, when one did. A KILLED child reports `status: null`,
   * this set, and NO `error` — without it, a policy kill looked like a spawn that never
   * happened (#1553). A `maxBuffer`/`timeout` breach sets both; the errno is the cause, so
   * {@link spawnFailureDetail} reports it first. Why: archived in docs/forensics/commit-message.md.
   */
  signal?: string;
};

// `spawnSync`'s 1MB default `maxBuffer` kills an oversized step (ENOBUFS) as a bare, unexplained
// FAIL — `npm run test:ci`'s TAP output alone runs ~1.7MB. 64MB is a ceiling, not a target.
const PREFLIGHT_SPAWN_MAX_BUFFER = 64 * 1024 * 1024;

// The LITERAL, never an import off self-sync.js: that module already imports back to this one
// transitively, so a value import the other way would close a dependency-cruiser cycle. Must
// stay byte-identical to self-sync.ts's own SELF_SYNC_GUARD_ENV export.
// Why: docs/forensics/commit-message.md.
const SELF_SYNC_GUARD_ENV_NAME = "RMD_SELF_SYNC_DONE";

export function defaultPreflightSpawn(
  file: string,
  args: string[],
  opts: { cwd?: string; input?: string; stream?: boolean; env?: NodeJS.ProcessEnv } = {},
): { status: number | null; stdout: string; stderr: string; error?: string; signal?: string } {
  // Merged OVER `process.env`, never replacing it: a bare `env` would drop PATH, HOME and toolchain pins.
  const env = { ...process.env, ...opts.env };
  // Unconditionally scrubbed: every child here is a build/test process, never a re-exec of
  // `rmd` itself, so an inherited `RMD_SELF_SYNC_DONE` has no meaning and once crossed into a
  // spawned child, turning 45 unrelated tests red. Why: archived in docs/forensics/commit-message.md.
  delete env[SELF_SYNC_GUARD_ENV_NAME];
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

/** One preflight step's outcome, named in both directions — a failure legible only as a
 *  missing success line is barely a check at all. */
export interface PreflightStepResult {
  name: "commitlint" | "typecheck" | "emitter-checks";
  ok: boolean;
  /** Human-readable line(s) — printed unconditionally, pass or fail. */
  detail: string;
}

/** The commit range this hand-authored push is about to send; defaults to HEAD not yet on `origin/main`. */
export interface PreflightRange {
  from: string;
  to: string;
}

const DEFAULT_PREFLIGHT_RANGE: PreflightRange = { from: "origin/main", to: "HEAD" };

/**
 * A step whose subprocess NEVER STARTED, named as its own outcome — or `undefined` when the
 * child produced an exit status and the ordinary pass/fail reading applies. Enforces the
 * contract {@link PreflightSpawn}'s `error` field declares: `status: null` is "the spawn itself
 * failed", never an ordinary nonzero exit with empty output — three hand-route steps once broke
 * that and read a false FAIL. Why: archived in docs/forensics/commit-message.md; falsifier:
 * test/preflight-spawn-failure.test.ts.
 */
export function spawnFailureDetail(
  step: string,
  res: { status: number | null; error?: string; signal?: string },
): string | undefined {
  if (res.status !== null) return undefined;
  // Three states, kept apart because their remedies differ: (a) an errno — ENOENT means the
  // path isn't there, EACCES/EPERM means it was refused; (b) a signal with no errno — the child
  // started and was terminated; (c) neither, now rare. ORDER IS LOAD-BEARING: a
  // `maxBuffer`/`timeout` breach sets both, so (a) is tested first and names the signal second.
  const why = res.error
    ? `${res.error}${res.signal ? `, and the runtime then terminated it with ${res.signal}` : ""}`
    : res.signal
      ? `the child was KILLED by ${res.signal} — it started and was terminated, rather than never starting`
      : "the child produced no exit status, no signal and no error message";
  return `${step}: SPAWN FAILURE — ${why}; the check did NOT run, so this is not a result about the code`;
}


/**
 * Step 1/3 — commitlint over the range, via the same binary + config CI uses, so a local PASS
 * means what a CI PASS means. Independent of the other two: a thrown spawn is caught and
 * reported as this step's own failure.
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
 * Step 2/3 — `tsc -p tsconfig.json --noEmit`, the same invocation CI's `ci` job runs. `npm test`
 * strips types via `tsx` without checking them, so a green test run is not a compile (PR #477).
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
 * Pure NUL-split of `git log --format=%x00%B`'s raw stdout into one entry per commit. `%x00%B`
 * prefixes EVERY body with a NUL, including the first, so a bare `"\0"` split would leave an
 * empty artifact before the first entry — stripped here. Every remaining piece is kept even
 * when it trims to empty, since that is what `subject-empty`/`type-empty` exist to catch. An
 * entirely empty `stdout` (zero commits) returns `[]`, not `[""]`.
 */
export function splitRangeCommitMessages(stdout: string): string[] {
  if (stdout === "") return [];
  return stdout
    .replace(/^\0/, "")
    .split("\0")
    .map((s) => s.trim());
}

/** `git log` the range's raw commit messages, NUL-separated so blank lines in a body can't be
 *  mistaken for a message boundary. */
export function readRangeCommitMessages(
  repoRoot: string,
  range: PreflightRange = DEFAULT_PREFLIGHT_RANGE,
  spawn: PreflightSpawn = defaultPreflightSpawn,
): string[] {
  const res = spawn("git", ["log", "--format=%x00%B", `${range.from}..${range.to}`], { cwd: repoRoot });
  // A `git log` that never ran also returns empty stdout, the same shape as a genuinely empty
  // range — spawnFailureDetail (which reads status, not stdout) is what tells them apart;
  // skipping it would let a never-run spawn read as zero messages, a vacuous pass.
  const spawnFailed = spawnFailureDetail("emitter-checks", res);
  if (spawnFailed) throw new Error(spawnFailed);
  return splitRangeCommitMessages(res.stdout);
}

/**
 * Step 3/3 — {@link checkCommitMessage} against every commit message in the range, called
 * rather than restated, so the hand lane and the machine lanes share one rule set instead of
 * drifting apart. Independent of the other two steps.
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
 * One command, three independent steps, each reporting its own exit — never chained with `&&`,
 * so one step's failure can neither hide nor block the ones after it. `ok` is the AND of all
 * three; every `detail` is meant to be printed regardless, so a caller sees every problem in
 * one run rather than only the first.
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
