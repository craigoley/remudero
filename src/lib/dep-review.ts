import type { Escalation } from "./escalate.js";
import { REVIEW_CONTEXT } from "./review.js";

/**
 * The dependency-PR review lane (W1-T54, MASTER-PLAN §5D item 1).
 *
 * Required checks on remudero are `[ci-gate, remudero-review]`. Nothing ever
 * posted `remudero-review` on a Dependabot PR, so every Dependabot PR sat
 * UNMERGEABLE — fail-closed, but FROZEN, never even surfaced as actionable. This
 * module is a SECOND deterministic judge (alongside lib/review.ts's task-acceptance
 * judge), scoped to Dependabot PRs: no LLM, ever, and its only write paths are (a)
 * the `remudero-review` commit status and (b) durable migration feedback for majors
 * (both posted by the run-task.ts CLI wiring — this module decides, it never
 * shells out).
 *
 * THE FIVE-WAY VERDICT is a PURE function ({@link decideDepReview}) so each
 * branch is a unit fixture, proven over RECORDED Dependabot PRs (live #80/#81 on
 * this repo), before any gate depends on it:
 *   - REFUSE   — not authored by Dependabot, or the diff touches a file outside
 *     the manifest/lockfile allowlist (a "dependency bump" that also edits source
 *     is not a dependency bump — refuse rather than rubber-stamp it). No status is
 *     posted: identical to today's silence, but now a DELIBERATE outcome.
 *   - ARM      — a confined minor/patch bump with every required gate green: post
 *     remudero-review=success and arm auto-merge.
 *   - MIGRATE  — a parseable MAJOR bump. Capture a durable feedback entry for
 *     the migration, then tell Dependabot to ignore this major proposal and close
 *     the PR without deleting its branch. No status is posted and no auto-merge is armed.
 *   - ESCALATE — an unparseable bump, or a major whose dependency identity cannot
 *     be safely extracted. Fail closed via the existing MANUAL escalation path.
 *
 * HOLD covers an otherwise-good minor/patch PR whose required checks are not
 * yet green (still running, or genuinely red): nothing is posted and the caller
 * tries again later — mirrors run-task.ts's waitForCiGreen/pollToGate, where
 * pending is never treated as pass.
 */

// ── Author ───────────────────────────────────────────────────────────────

export interface DepReviewAuthor {
  login: string;
}

/**
 * Dependabot's login string differs by API surface: the REST API reports
 * `dependabot[bot]`, while `gh pr view --json author` (GraphQL) reports
 * `app/dependabot` (recon: live PRs #80/#81 on craigoley/remudero, both). Neither
 * spelling is "the" spelling — normalise by stripping a leading `app/` and a
 * trailing `[bot]`, then compare case-insensitively, so either API shape matches.
 */
export function isDependabotAuthor(author: DepReviewAuthor): boolean {
  const normalized = author.login
    .toLowerCase()
    .replace(/^app\//, "")
    .replace(/\[bot\]$/, "");
  return normalized === "dependabot";
}

// ── Semver level, parsed from the PR title/body ─────────────────────────

export type SemverLevel = "major" | "minor" | "patch" | "unknown";

function parseVersion(v: string): [number, number, number] | null {
  const m = v.trim().match(/^v?(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? "0")];
}

function bumpLevel(from: string, to: string): SemverLevel {
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b) return "unknown";
  if (b[0] !== a[0]) return "major";
  if (b[1] !== a[1]) return "minor";
  return "patch";
}

const FROM_TO_RE = /\bfrom\s+v?(\d+(?:\.\d+){1,3}(?:[-+][\w.]*)?)\s+to\s+v?(\d+(?:\.\d+){1,3}(?:[-+][\w.]*)?)/gi;

/**
 * Parse every `from X to Y` version pair out of one text block. Dependabot emits
 * one such pair per constituent bump — even a GROUPED PR's body lists each
 * dependency's own "Updates `pkg` from X to Y" line (recon: live PR #80's body).
 * Returns `[]` when nothing parses.
 */
export function parseVersionBumps(text: string): SemverLevel[] {
  return [...text.matchAll(FROM_TO_RE)].map((m) => bumpLevel(m[1], m[2]));
}

/**
 * Dependabot's OWN per-constituent summary lines — `Updates \`pkg\` from X to Y`
 * (grouped PRs, one per dependency) and `Bumps [pkg](url) from X to Y` (single-
 * dependency PRs, the body's first line; also the PR title's own `bump pkg from
 * X to Y`). Anchored to line START because everything else in a Dependabot body
 * is EMBEDDED THIRD-PARTY RELEASE NOTES, which routinely quote other projects'
 * dependency bumps.
 */
const DEPENDABOT_SUMMARY_LINE_RE = /^\s*(?:Updates|Bumps)\b/i;
/** EXPORTED FOR ITS OWN FIXTURE. negative-reachability-ratchet requires a regex surface to be
 *  driven directly with BOTH arms asserted — a match and a non-match — rather than only through a
 *  caller, because a caller that happens to work proves nothing about where the pattern stops.
 *  Not "structurally total": it legitimately does not match an unprefixed line, and that no-op is
 *  the arm the fixture exists to pin. */
export const CONVENTIONAL_TITLE_PREFIX_RE = /^\s*[a-z][\w-]*(?:\([\w./-]+\))?!?:\s*/i;
const DEPENDENCY_VERSION = String.raw`v?(\d+(?:\.\d+){1,3}(?:[-+][\w.]*)?)`;

export interface DepReviewBumpFact {
  dependency: string;
  fromVersion: string;
  toVersion: string;
  level: SemverLevel;
  targetMajor: number | null;
}

function dependencyBumpFact(dependency: string, fromVersion: string, toVersion: string): DepReviewBumpFact {
  const parsedTarget = parseVersion(toVersion);
  return {
    dependency: dependency.trim(),
    fromVersion,
    toVersion,
    level: bumpLevel(fromVersion, toVersion),
    targetMajor: parsedTarget ? parsedTarget[0] : null,
  };
}

function parseDependabotBumpFactLine(line: string): DepReviewBumpFact[] {
  const text = line.replace(CONVENTIONAL_TITLE_PREFIX_RE, "").trim();
  const patterns = [
    new RegExp(String.raw`^Updates\s+\`([^\`]+)\`\s+from\s+${DEPENDENCY_VERSION}\s+to\s+${DEPENDENCY_VERSION}`, "i"),
    new RegExp(String.raw`^Bumps\s+\[([^\]]+)\]\([^)]+\)\s+from\s+${DEPENDENCY_VERSION}\s+to\s+${DEPENDENCY_VERSION}`, "i"),
    new RegExp(String.raw`^Bumps?\s+\`([^\`]+)\`\s+from\s+${DEPENDENCY_VERSION}\s+to\s+${DEPENDENCY_VERSION}`, "i"),
    new RegExp(String.raw`^Bumps?\s+([^\s,]+)\s+from\s+${DEPENDENCY_VERSION}\s+to\s+${DEPENDENCY_VERSION}`, "i"),
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return [dependencyBumpFact(m[1], m[2], m[3])];
  }
  return [];
}

/**
 * Dependency/version facts parsed only from Dependabot's own summary surfaces: the PR title and
 * anchored body summary lines. These facts are stricter than {@link overallSemverLevel}: a
 * parseable version pair without a dependency identity is not enough to dedupe migration work.
 */
export function parseDependabotBumpFacts(title: string, body: string): DepReviewBumpFact[] {
  const seen = new Set<string>();
  const facts: DepReviewBumpFact[] = [];
  for (const line of [title, ...body.split("\n").filter((l) => DEPENDABOT_SUMMARY_LINE_RE.test(l))]) {
    for (const fact of parseDependabotBumpFactLine(line)) {
      const key = `${fact.dependency}\0${fact.fromVersion}\0${fact.toVersion}`;
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push(fact);
    }
  }
  return facts;
}

export function majorMigrationBumps(title: string, body: string): DepReviewBumpFact[] {
  return parseDependabotBumpFacts(title, body).filter((b) => b.level === "major" && b.targetMajor !== null);
}

export function depReviewMigrationSubmissionKey(owner: string, repo: string, bumps: DepReviewBumpFact[]): string {
  const targets = bumps
    .map((b) => `${b.dependency.trim().toLowerCase()}@${b.targetMajor}`)
    .sort()
    .join(",");
  return `dep-review:migration:${owner.trim().toLowerCase()}/${repo.trim().toLowerCase()}:${targets}`;
}

export const DEPENDABOT_IGNORE_MAJOR_COMMAND = "@dependabot ignore this major version";

export function renderDepReviewMigrationFeedback(args: {
  prUrl: string;
  prNumber: number;
  title: string;
  body: string;
  bumps: DepReviewBumpFact[];
  redChecks: string[];
}): string {
  return [
    `Migrate dependency major proposed by Dependabot PR #${args.prNumber}: ${args.title}`,
    "",
    "Dependabot proposed a parseable semver-major dependency update. rmd must migrate the",
    "runtime, manifests, source, and tests together on an owned task branch instead of holding",
    "the bot PR open or editing Dependabot's branch.",
    "",
    `PR: ${args.prUrl}`,
    `Major target(s): ${args.bumps.map((b) => `${b.dependency} ${b.fromVersion} -> ${b.toVersion}`).join(", ")}`,
    `Red checks observed on the proposal: ${args.redChecks.length > 0 ? args.redChecks.join(", ") : "none"}`,
    "",
    "Dependabot proposal body:",
    "",
    args.body.trim().length > 0 ? args.body.trim() : "(empty body)",
  ].join("\n");
}

/**
 * Parse version bumps ONLY from Dependabot's own summary lines, never from the
 * embedded release-notes prose (the 2026-07-22 #533 false-major: actions/checkout
 * 7.0.0→7.0.1 — a PATCH — classified MAJOR because checkout's OWN changelog,
 * quoted inside the PR body, contains "docker/login-action from 3.3.0 to 4.2.0";
 * #534 carried the same hazard via commit-and-tag-version's changelog, and
 * PR #81's 2026-07-15 escalation has the identical signature). A `from X to Y`
 * pair that only ever appears mid-prose is somebody ELSE'S bump, not this PR's.
 */
export function parseAnchoredVersionBumps(text: string): SemverLevel[] {
  return text
    .split("\n")
    .filter((line) => DEPENDABOT_SUMMARY_LINE_RE.test(line))
    .flatMap((line) => parseVersionBumps(line));
}

/**
 * The PR's overall semver level across its title + body: the WORST (highest-risk)
 * constituent bump wins — major beats unknown beats minor beats patch. A grouped
 * PR with even ONE major constituent classifies the WHOLE PR as major (fail
 * closed; Standing rules 2/4 — never split the difference on a mixed-risk
 * group). No parseable bump anywhere is `unknown`, which still reaches manual
 * escalation in {@link decideDepReview}.
 *
 * The TITLE is parsed whole (a one-line Dependabot-authored string); the BODY is
 * parsed via {@link parseAnchoredVersionBumps} only — its non-summary lines are
 * quoted third-party changelogs and must never classify THIS PR's risk.
 */
export function overallSemverLevel(title: string, body: string): SemverLevel {
  const bumps = [...parseVersionBumps(title), ...parseAnchoredVersionBumps(body)];
  if (bumps.length === 0) return "unknown";
  if (bumps.includes("major")) return "major";
  if (bumps.includes("unknown")) return "unknown";
  if (bumps.includes("minor")) return "minor";
  return "patch";
}

// ── Diff confinement: manifest/lockfile allowlist ───────────────────────

/**
 * Files a genuine dependency bump may touch: this repo's configured ecosystems
 * (npm root manifest/lockfile; github-actions workflow files, which carry the
 * pinned SHA + version comment the actions-ecosystem bump edits in place — design
 * note "the grouped-actions workflow files per the fleet grouping") plus common
 * lockfiles for ecosystems this lane may later cover. A diff touching anything
 * else is not a dependency bump — it is source change riding along with one.
 */
const MANIFEST_PATTERNS: RegExp[] = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^npm-shrinkwrap\.json$/,
  /^yarn\.lock$/,
  /^pnpm-lock\.yaml$/,
  /^Gemfile$/,
  /^Gemfile\.lock$/,
  /^go\.mod$/,
  /^go\.sum$/,
  /^Cargo\.toml$/,
  /^Cargo\.lock$/,
  /^requirements(-[\w.]+)?\.txt$/,
  /^\.github\/workflows\/[^/]+\.ya?ml$/,
];

export function isManifestPath(path: string): boolean {
  return MANIFEST_PATTERNS.some((re) => re.test(path));
}

/**
 * Changed file paths out of a unified diff, deduped. A plain modification shows
 * up as a `+++ b/<path>` header; a DELETION shows `+++ /dev/null` with the real
 * path only on `--- a/<path>`; a pure RENAME (no content change) carries neither
 * `+++`/`---` line at all, only `rename from <path>` / `rename to <path>` — all
 * three forms are captured so a rename/delete of a source file cannot slip past
 * {@link offendingFiles} unnoticed.
 */
export function changedFilesInDiff(diff: string): string[] {
  const files = new Set<string>();
  for (const m of diff.matchAll(/^\+\+\+ b\/(\S+)/gm)) files.add(m[1]);
  for (const m of diff.matchAll(/^--- a\/(\S+)/gm)) files.add(m[1]);
  for (const m of diff.matchAll(/^rename (?:from|to) (\S+)/gm)) files.add(m[1]);
  return [...files];
}

/** Changed files that fall OUTSIDE the manifest/lockfile allowlist. `[]` ⇒ confined. */
export function offendingFiles(diff: string): string[] {
  return changedFilesInDiff(diff).filter((f) => !isManifestPath(f));
}

// ── Required-check gate ──────────────────────────────────────────────────

export interface DepReviewCheck {
  name?: string;
  context?: string;
  status?: string;
  /** A CheckRun's terminal result (Actions-based checks: ci-gate, CodeQL, OSV, …). */
  conclusion?: string;
  /** A legacy commit-STATUS's terminal result — this is the shape `remudero-review`
   * itself is posted in (lib/review.ts's postReviewStatus → the Statuses API), so a
   * re-run of this lane against a PR that already carries one must read this field,
   * not just `conclusion`. */
  state?: string;
}

/** Check-run/status conclusions that mean a gate is RED — mirrors run-task.ts's RED_CONCLUSIONS. */
const RED_CONCLUSIONS = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);

/**
 * Names of any check that has actually FAILED. SKIPPED/SUCCESS/pending are all
 * fine here — a SKIPPED conclusion is how OSV-Scanner (PR) reports on Dependabot's
 * own PRs (recon: live PR #81 — it deliberately skips for `github.actor ==
 * 'dependabot[bot]'`, deferring to the scheduled full-tree scan instead), and
 * pending is the caller's concern (poll again — mirrors waitForCiGreen/pollToGate:
 * pending is never treated as pass, but it is also never treated as a failure).
 * `conclusion ?? state` (never `status`, which is a CheckRun's RUN state like
 * "COMPLETED", not its result) mirrors run-task.ts's own rollup reads exactly.
 */
/**
 * W1-T3244 — THE ONE STATUS THIS LANE PUBLISHES CANNOT ALSO BE ONE IT WAITS FOR.
 *
 * `remudero-review` is this module's own write path: `arm` means "post remudero-review=success and
 * arm auto-merge" (see the header). Counting it as a red required check made the lane hold on the
 * status it is the only publisher of — a closed loop with no exit inside the lane, escapable only
 * by `@dependabot recreate` or an admin merge.
 *
 * NEVER HIT UNTIL 2026-09-09 because ABSENT AND RED ARE DIFFERENT. The ordinary case is that
 * nothing ever posted — the state this module's header says every Dependabot PR used to sit in —
 * and absent is not red, so the lane arms every time. Only a RED posting traps it. That day an
 * operator ran the shared task-acceptance verb on a Dependabot PR; it fail-closed correctly on a
 * bot body with no `## Acceptance` block, and #4812 deadlocked. The sweep's own `post-review` rung
 * reaches that path too, as does a transient failure in this lane's write.
 */
export const LANE_OWNED_STATUS_CONTEXT = REVIEW_CONTEXT;

export function redChecks(checks: DepReviewCheck[]): string[] {
  return checks
    .filter((c) => RED_CONCLUSIONS.has(String(c.conclusion ?? c.state ?? "").toUpperCase()))
    .map((c) => c.name ?? c.context ?? "unknown")
    // EXACTLY ONE NAME, never a relaxation. Every OTHER red check must keep holding — that is the
    // entire value of the hold, and a fix that widened into "ignore red checks" would arm
    // auto-merge over a genuinely broken bump, which is worse than the deadlock.
    .filter((name) => name !== LANE_OWNED_STATUS_CONTEXT);
}

// ── The five-way verdict ─────────────────────────────────────────────────

export type DepReviewDecision = "arm" | "escalate" | "refuse" | "hold" | "migrate";

export interface DepReviewInput {
  author: DepReviewAuthor;
  title: string;
  body: string;
  diff: string;
  checks: DepReviewCheck[];
}

export interface DepReviewResult {
  decision: DepReviewDecision;
  semverLevel: SemverLevel;
  offendingFiles: string[];
  redChecks: string[];
  migrationBumps: DepReviewBumpFact[];
  reason: string;
}

/**
 * The pure verdict function. Order matters and is FAIL-CLOSED throughout: author
 * and diff-confinement are checked before anything else (a REFUSE never even asks
 * whether the gates are green — nothing is posted for a PR this lane should never
 * have opinions on), then parseable major migrations before gate health. See the
 * module doc for what each decision means.
 */
export function decideDepReview(input: DepReviewInput): DepReviewResult {
  const semverLevel = overallSemverLevel(input.title, input.body);
  const offending = offendingFiles(input.diff);
  const red = redChecks(input.checks);
  const migrationBumps = majorMigrationBumps(input.title, input.body);

  if (!isDependabotAuthor(input.author)) {
    return {
      decision: "refuse",
      semverLevel,
      offendingFiles: offending,
      redChecks: red,
      migrationBumps,
      reason: `author '${input.author.login}' is not dependabot[bot] — this lane reviews Dependabot PRs only`,
    };
  }
  if (offending.length > 0) {
    return {
      decision: "refuse",
      semverLevel,
      offendingFiles: offending,
      redChecks: red,
      migrationBumps,
      reason: `diff touches file(s) outside the manifest/lockfile allowlist: ${offending.join(", ")}`,
    };
  }
  if (semverLevel === "major" && migrationBumps.length > 0) {
    return {
      decision: "migrate",
      semverLevel,
      offendingFiles: offending,
      redChecks: red,
      migrationBumps,
      reason: `MAJOR dependency proposal requires rmd-owned migration: ${migrationBumps
        .map((b) => `${b.dependency} ${b.fromVersion}->${b.toVersion}`)
        .join(", ")}`,
    };
  }
  if (semverLevel === "major" || semverLevel === "unknown") {
    return {
      decision: "escalate",
      semverLevel,
      offendingFiles: offending,
      redChecks: red,
      migrationBumps,
      reason:
        semverLevel === "major"
          ? "MAJOR version bump parsed without a stable dependency identity — fail closed, treated like unparseable"
          : "semver level could not be determined from the PR title/body — fail closed, treated like a major",
    };
  }
  if (red.length > 0) {
    return {
      decision: "hold",
      semverLevel,
      offendingFiles: offending,
      redChecks: red,
      migrationBumps,
      reason: `required check(s) not green: ${red.join(", ")}`,
    };
  }
  return {
    decision: "arm",
    semverLevel,
    offendingFiles: offending,
    redChecks: red,
    migrationBumps,
    reason: `${semverLevel} bump, confined to manifests, gates green — safe to auto-merge`,
  };
}

// ── The MANUAL escalation for a major bump ──────────────────────────────

/**
 * Build the {@link Escalation} for a major (or unparseable) bump, carrying the
 * Dependabot PR body (release notes + changelog live there) so the issue is
 * actionable without a human having to go dig the PR up first. Posted via the
 * SHIPPED escalate() path (lib/escalate.ts) — class MANUAL, per MASTER-PLAN's own
 * usage ("verify: human ⇒ ... MANUAL escalation, never auto-merge"), matching this
 * lane's "no auto-merge" contract for majors exactly.
 */
/**
 * impl-FR — the DETECTOR for the one failure this lane has no remedy for.
 *
 * A Dependabot PR has NO independent arm path. `sweep.ts`'s `DISPOSITION_RULES` are ordered and
 * first-match-wins (`DISPOSITION_RULES.find(...)`), and the `dep-review` row sits ABOVE both
 * arming rows — so a Dependabot PR never reaches `mergeable` or `post-review` — while the review
 * lane refuses `dependabot/` heads by name ("the dep-review lane owns arming for these"). If this
 * lane decides `arm` and the arm does not take, **nothing else will ever arm that PR**. It goes
 * green, collects no objections, and simply never merges.
 *
 * That silence is the whole risk, so the remedy is a SIGNAL, not a second arming path: a rescue
 * would have to re-derive the semver policy to avoid arming a major bump, and a second copy of
 * that policy is worse than the gap it closes. This escalation cannot arm anything.
 *
 * BOUNDED by construction rather than by a counter: `escalate()`'s composite dedup key is
 * (taskId, PR, headSha, cause) — W1-T195 — so passing `headSha` yields exactly one issue per PR
 * per push, and a re-poll of the same unchanged PR comments rather than opening again. The bound
 * therefore lives in GitHub's open issues, NOT in the ledger, which is what makes it immune to the
 * rotation class that reset `ABSENT_REPUSH_CAP`. The `taskId` is deliberately distinct from
 * {@link buildDepReviewEscalation}'s so the two signals can never dedup against each other.
 */
export function buildDepReviewArmUnreachableEscalation(args: {
  prUrl: string;
  prNumber: number;
  title: string;
  headSha: string;
  outcome: string;
}): Escalation {
  return {
    class: "MANUAL",
    taskId: `dep-review-arm-PR${args.prNumber}`,
    headSha: args.headSha,
    summary: `Dependabot PR passed review but auto-merge did not arm (${args.outcome}): ${args.title}`,
    detail: [
      `${args.prUrl} was judged a minor/patch bump with green gates, and remudero-review was posted`,
      `as success — but arming auto-merge returned "${args.outcome}", so the PR is NOT armed.`,
      ``,
      `This needs a human because NOTHING ELSE WILL ARM IT. The sweep routes Dependabot PRs to the`,
      `dep-review lane above its own arming rules, and the shared review lane refuses`,
      `\`dependabot/\` heads by name. There is no fallback path: left alone, this PR stays green,`,
      `unobjected-to, and unmerged indefinitely.`,
      ``,
      `Head: ${args.headSha}`,
    ].join("\n"),
    options: [
      {
        label: "merge",
        detail: `merge ${args.prUrl} by hand — review already passed, only the arming step failed`,
      },
      {
        label: "investigate",
        detail: `arming returned "${args.outcome}" — check whether armAutoMerge's ledger gate found this run's own review.posted record for this head sha`,
      },
    ],
    recommendation: "merge",
  };
}

export function buildDepReviewEscalation(args: {
  prUrl: string;
  prNumber: number;
  title: string;
  body: string;
  semverLevel: SemverLevel;
}): Escalation {
  return {
    class: "MANUAL",
    taskId: `dep-review-PR${args.prNumber}`,
    summary: `${args.semverLevel === "major" ? "major" : "unparseable"} dependency bump needs human review: ${args.title}`,
    detail: [
      `Dependabot opened ${args.prUrl} (semver level: ${args.semverLevel}).`,
      `remudero-review was posted as failure — auto-merge is NOT armed.`,
      ``,
      `PR body (release notes / changelog, as posted by Dependabot):`,
      ``,
      args.body.trim().length > 0 ? args.body : "(empty body)",
    ].join("\n"),
    options: [
      {
        label: "merge",
        detail: `review the release notes above, then merge ${args.prUrl} by hand (an admin override — remudero-review is failure, so it will never auto-merge)`,
      },
      {
        label: "close",
        detail: `close ${args.prUrl} — this bump is not wanted right now (Dependabot reopens on its next scheduled run unless the dependency is told to ignore this version)`,
      },
    ],
    recommendation: "merge",
  };
}
