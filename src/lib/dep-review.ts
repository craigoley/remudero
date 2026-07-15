import type { Escalation } from "./escalate.js";

/**
 * The dependency-PR review lane (W1-T54, MASTER-PLAN §5D item 1).
 *
 * Required checks on remudero are `[ci-gate, remudero-review]`. Nothing ever
 * posted `remudero-review` on a Dependabot PR, so every Dependabot PR sat
 * UNMERGEABLE — fail-closed, but FROZEN, never even surfaced as actionable. This
 * module is a SECOND deterministic judge (alongside lib/review.ts's task-acceptance
 * judge), scoped to Dependabot PRs: no LLM, ever, and its only write paths are (a)
 * the `remudero-review` commit status and (b) a MANUAL escalation issue for majors
 * (both posted by the run-task.ts CLI wiring — this module decides, it never
 * shells out).
 *
 * THE THREE-WAY VERDICT is a PURE function ({@link decideDepReview}) so each
 * branch is a unit fixture, proven over RECORDED Dependabot PRs (live #80/#81 on
 * this repo), before any gate depends on it:
 *   - REFUSE   — not authored by Dependabot, or the diff touches a file outside
 *     the manifest/lockfile allowlist (a "dependency bump" that also edits source
 *     is not a dependency bump — refuse rather than rubber-stamp it). No status is
 *     posted: identical to today's silence, but now a DELIBERATE outcome.
 *   - ARM      — a confined minor/patch bump with every required gate green: post
 *     remudero-review=success and arm auto-merge.
 *   - ESCALATE — a MAJOR bump, or one whose level cannot be determined (fail
 *     closed — MASTER-PLAN §5 FLEET FINDING: a 28-minute production outage once
 *     rode in on an unvetted major). Post remudero-review=failure (so the PR
 *     stays blocked — NO auto-merge) and open a MANUAL needs-human issue carrying
 *     the release notes, via the SHIPPED escalate() path (lib/escalate.ts, W1-T8).
 *
 * A fourth outcome, HOLD, covers an otherwise-good PR whose required checks are
 * not yet green (still running, or genuinely red): nothing is posted and the
 * caller tries again later — mirrors run-task.ts's waitForCiGreen/pollToGate,
 * where pending is never treated as pass.
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
 * The PR's overall semver level across its title + body: the WORST (highest-risk)
 * constituent bump wins — major beats unknown beats minor beats patch. A grouped
 * PR with even ONE major constituent escalates the WHOLE PR (fail closed; Standing
 * rules 2/4 — never split the difference on a mixed-risk group). No parseable
 * bump anywhere is `unknown` — also fail-closed, handled the same as `major` by
 * {@link decideDepReview}.
 */
export function overallSemverLevel(title: string, body: string): SemverLevel {
  const bumps = [...parseVersionBumps(title), ...parseVersionBumps(body)];
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
export function redChecks(checks: DepReviewCheck[]): string[] {
  return checks
    .filter((c) => RED_CONCLUSIONS.has(String(c.conclusion ?? c.state ?? "").toUpperCase()))
    .map((c) => c.name ?? c.context ?? "unknown");
}

// ── The three(+one)-way verdict ──────────────────────────────────────────

export type DepReviewDecision = "arm" | "escalate" | "refuse" | "hold";

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
  reason: string;
}

/**
 * The pure verdict function. Order matters and is FAIL-CLOSED throughout: author
 * and diff-confinement are checked before anything else (a REFUSE never even asks
 * whether the gates are green — nothing is posted for a PR this lane should never
 * have opinions on), then gate health, then the semver-level branch. See the
 * module doc for what each of the four decisions means.
 */
export function decideDepReview(input: DepReviewInput): DepReviewResult {
  const semverLevel = overallSemverLevel(input.title, input.body);
  const offending = offendingFiles(input.diff);
  const red = redChecks(input.checks);

  if (!isDependabotAuthor(input.author)) {
    return {
      decision: "refuse",
      semverLevel,
      offendingFiles: offending,
      redChecks: red,
      reason: `author '${input.author.login}' is not dependabot[bot] — this lane reviews Dependabot PRs only`,
    };
  }
  if (offending.length > 0) {
    return {
      decision: "refuse",
      semverLevel,
      offendingFiles: offending,
      redChecks: red,
      reason: `diff touches file(s) outside the manifest/lockfile allowlist: ${offending.join(", ")}`,
    };
  }
  if (red.length > 0) {
    return {
      decision: "hold",
      semverLevel,
      offendingFiles: offending,
      redChecks: red,
      reason: `required check(s) not green: ${red.join(", ")}`,
    };
  }
  if (semverLevel === "major" || semverLevel === "unknown") {
    return {
      decision: "escalate",
      semverLevel,
      offendingFiles: offending,
      redChecks: red,
      reason:
        semverLevel === "major"
          ? "MAJOR version bump — excluded from auto-merge at the dep-review lane (MASTER-PLAN §5 FLEET FINDING)"
          : "semver level could not be determined from the PR title/body — fail closed, treated like a major",
    };
  }
  return {
    decision: "arm",
    semverLevel,
    offendingFiles: offending,
    redChecks: red,
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
