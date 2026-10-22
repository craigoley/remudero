import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fixedClock } from "./clock.js";
import { checkCommitMessage, CONVENTIONAL_LIMITS } from "./commit-message.js";
import { escalate, type Escalation, type EscalateDeps } from "./escalate.js";
import { writeAtomic } from "./fs-race-safe.js";
import { REVIEW_CONTEXT } from "./review.js";
import { TICK_READ_MAX_AGE_MS } from "./read-plane.js";
import { checkRunsRestArgs, combinedStatusRestArgs, jobsForRunRestArgs, rollupFromRest, runsForHeadRestArgs, singlePrRestArgs, type GhApiFetcher } from "./open-prs-rest.js";
// @ts-expect-error a plain .mjs script with no declaration file, as src/lib/plan-index.ts imports its sibling.
import { planNodePin } from "../../scripts/node-pin-follows-the-image.mjs";

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
 *   - ARM      — a confined minor/patch bump, or a diff-proven GitHub Actions SHA-only
 *     pin refresh with unchanged release annotations, with every required gate green:
 *     post remudero-review=success and arm auto-merge.
 *   - MIGRATE  — a parseable MAJOR bump. Capture a durable feedback entry for
 *     the migration, then tell Dependabot to ignore this major proposal and close
 *     the PR without deleting its branch. No status is posted and no auto-merge is armed.
 *   - ESCALATE — an unparseable bump that is not a diff-proven action pin refresh,
 *     or a major whose dependency identity cannot be safely extracted. Fail closed
 *     via the existing MANUAL escalation path.
 *
 * HOLD covers an otherwise-good minor/patch or verified pin-only PR whose required
 * checks are not yet green (still running, or genuinely red): nothing is posted and
 * the caller tries again later — pending is never treated as pass.
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

/** Bumped when this lane's decision contract changes, independently of task-review semantics. */
export const DEP_REVIEW_ENGINE_REVISION = "dep-review-selected-attempts-v2";

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
  return facts.filter((f) => !facts.some((g) => g !== f && g.fromVersion === f.fromVersion && g.toVersion === f.toVersion &&
    !g.dependency.includes(ELIDED_SEGMENT) && elidedDependencyMatches(f.dependency, g.dependency)));
}

const ELIDED_SEGMENT = "/…/";

function elidedDependencyMatches(elided: string, full: string): boolean {
  const at = elided.indexOf(ELIDED_SEGMENT);
  if (at < 0) return false;
  const head = elided.slice(0, at + 1), tail = elided.slice(at + ELIDED_SEGMENT.length - 1);
  return full.length > head.length + tail.length && full.startsWith(head) && full.endsWith(tail);
}

export type DependabotTitleFit =
  | { kind: "fits" }
  | { kind: "fitted"; title: string }
  | { kind: "unfittable"; reason: string };

const VERSION_TEXT = String.raw`v?\d+(?:\.\d+){1,3}(?:[-+][\w.]*)?`;
export const SINGLE_BUMP_RE = new RegExp(String.raw`^(bump)\s+([^\s,]+)\s+from\s+(${VERSION_TEXT})\s+to\s+(${VERSION_TEXT})`, "i");
export const GROUP_BUMP_RE = /^(bump)\s+the\s+([\w./-]+)\s+group/i;
export const TITLE_CLAUSE_RE = /\s+(in the [\w./-]+ group|across \d+ director(?:y|ies)|in \/\S*|with \d+ updates?)/y;

export function overHeaderLimit(title: string): boolean {
  return checkCommitMessage(title).some((v) => v.rule === "header-max-length");
}

function titleClauses(tail: string): string[] | undefined {
  const clauses: string[] = [];
  TITLE_CLAUSE_RE.lastIndex = 0;
  while (TITLE_CLAUSE_RE.lastIndex < tail.length) {
    const m = TITLE_CLAUSE_RE.exec(tail);
    if (!m) return undefined;
    clauses.push(m[1]);
  }
  return clauses;
}

export function fitDependabotTitle(title: string, body: string): DependabotTitleFit {
  if (!overHeaderLimit(title)) return { kind: "fits" };
  const prefix = CONVENTIONAL_TITLE_PREFIX_RE.exec(title)?.[0] ?? "";
  const pin = actionShaPinSummary(title);
  if (pin) {
    // The body retains both full pins. A display abbreviation must never replace the
    // only exact identity evidence consumed by isActionShaPinOnlyProposal.
    const retained = body.split("\n").filter((line) => DEPENDABOT_SUMMARY_LINE_RE.test(line))
      .some((line) => {
        const summary = actionShaPinSummary(line);
        return summary?.action === pin.action && summary.fromSha === pin.fromSha && summary.toSha === pin.toSha;
      });
    if (!retained) return { kind: "unfittable", reason: "the body does not retain the action and both full SHA pins" };
    const fitted = `${prefix}bump ${pin.action} to ${pin.toSha.slice(0, 12)}`;
    if (overHeaderLimit(fitted)) return { kind: "unfittable", reason: "the action identity alone exceeds the title limit" };
    return { kind: "fitted", title: fitted };
  }
  const rest = title.slice(prefix.length).replace(/\s+/g, " ").trim();
  const single = SINGLE_BUMP_RE.exec(rest), group = single ? null : GROUP_BUMP_RE.exec(rest);
  const clauses = single ?? group ? titleClauses(rest.slice((single ?? group)![0].length)) : undefined;
  if (clauses === undefined) return { kind: "unfittable", reason: "the title is not Dependabot's bump grammar" };
  let dependency = single?.[2] ?? "";
  const build = () => prefix + (single ? `${single[1]} ${dependency} from ${single[3]} to ${single[4]}` : `${group![1]} the ${group![2]} group`) +
    clauses.map((c) => ` ${c}`).join("");
  const drop = (re: RegExp) => () => { const i = clauses.findIndex((c) => re.test(c)); if (i >= 0) clauses.splice(i, 1); };
  const elide = () => {
    const segments = dependency.split("/");
    if (segments.length > 3) dependency = [segments[0], segments[1], "…", segments[segments.length - 1]].join("/");
  };
  let fitted = build();
  for (const step of [drop(/^across /), drop(/ group$/), elide, drop(/^in \//)]) {
    if (!overHeaderLimit(fitted)) break;
    step();
    fitted = build();
  }
  if (overHeaderLimit(fitted)) {
    return { kind: "unfittable", reason: `the dependency and versions alone exceed ${CONVENTIONAL_LIMITS.headerMaxLength} characters` };
  }
  const facts = (t: string) => JSON.stringify(parseDependabotBumpFacts(t, body));
  if (facts(fitted) !== facts(title) || overallSemverLevel(fitted, body) !== overallSemverLevel(title, body)) {
    return { kind: "unfittable", reason: "a fitted title would change the bump facts the lane reads" };
  }
  return { kind: "fitted", title: fitted };
}

export type DependabotRetitleOutcome = "fits" | "retitled" | "failed" | "refused";

export async function reconcileDependabotTitle(args: {
  statePath: string;
  prNumber: number;
  headSha: string;
  title: string;
  body: string;
  retitle: (title: string) => Promise<void>;
  log: (step: string, extra: Record<string, unknown>) => void;
}): Promise<DependabotRetitleOutcome> {
  const fit = fitDependabotTitle(args.title, args.body);
  if (fit.kind === "fits") return "fits";
  const at = { pr_number: args.prNumber, head_sha: args.headSha, old_title: args.title };
  if (fit.kind === "unfittable") {
    const state = readRefreshState(args.statePath, args.headSha) as DepReviewHoldState & { retitleRefused?: { headSha?: unknown; title?: unknown } };
    if (state.retitleRefused?.headSha === args.headSha && state.retitleRefused.title === args.title) return "refused";
    state.retitleRefused = { headSha: args.headSha, title: args.title };
    writeAtomic(args.statePath, `${JSON.stringify(state)}\n`);
    args.log("dep-review.retitle_refused", { ...at, reason: fit.reason });
    return "refused";
  }
  try {
    await args.retitle(fit.title);
  } catch (error) {
    args.log("dep-review.retitle_failed", { ...at, candidate: fit.title, error: String((error as Error)?.message ?? error) });
    return "failed";
  }
  args.log("dep-review.retitled", { ...at, new_title: fit.title });
  return "retitled";
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

/**
 * The repository's own declaration of which NESTED manifests are real: the root `package.json`'s
 * `workspaces` globs. Reading it is why this predicate needs no hand-maintained directory list and
 * cannot go stale when a workspace is added or removed — the build notices first.
 *
 * `undefined` when the root manifest cannot be read or declares none. Both mean the same thing to
 * {@link isManifestPath}: ROOT PATHS ONLY, which is this lane's behaviour before W1-T3707 and the
 * safe direction when the declaration is unavailable.
 */
export function declaredWorkspaceGlobs(readRootManifest: () => string): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readRootManifest());
  } catch (error) {
    // W1-T3707: bind and record the failure instead of erasing it into the same `undefined` an
    // honest "no workspaces declared" root manifest also returns — both degrade to the safe
    // ROOT-ONLY direction (see the doc comment above), but only this one is a defect worth a
    // diagnosing reader's attention, so it is not silenced.
    console.error(
      `dep-review: root manifest unreadable or not valid JSON (${String((error as Error)?.message ?? error)}) — degrading to root-only manifest matching`,
    );
    return undefined;
  }
  const ws = (parsed as { workspaces?: unknown } | null)?.workspaces;
  const globs = Array.isArray(ws) ? ws : Array.isArray((ws as { packages?: unknown })?.packages) ? (ws as { packages: unknown[] }).packages : undefined;
  if (globs === undefined) return undefined;
  const out = globs.filter((g): g is string => typeof g === "string" && g.length > 0);
  return out.length > 0 ? out : undefined;
}

/** Does `dir` sit inside one of the declared workspace globs? Only the `<prefix>/*` and plain
 *  `<dir>` forms npm actually supports are honoured — a glob this does not understand matches
 *  nothing rather than everything, because the failure that matters here is admitting too much. */
function dirIsDeclaredWorkspace(dir: string, globs: readonly string[]): boolean {
  return globs.some((g) => {
    if (g.endsWith("/*")) return dir.startsWith(g.slice(0, -1)) && !dir.slice(g.length - 1).includes("/");
    return dir === g;
  });
}

/**
 * Is `path` a dependency manifest? ONE predicate, shared by this lane and
 * `scripts/head-identity-gate.mjs` — W1-T3707: they used to keep separate lists that disagreed,
 * dep-review refusing `apps/dashboard/package.json` (root-anchored) while the gate admitted
 * `test/fixtures/onboard/repo/package.json` (basename). Each was wrong in the opposite direction.
 *
 * A ROOT path matches the patterns directly. A NESTED npm manifest matches only when its directory
 * is a DECLARED workspace, which is what separates a real workspace from a fixture. Everything
 * else — including a nested manifest with no workspaces declared — is refused.
 */
export function isManifestPath(path: string, readRootManifest?: () => string): boolean {
  if (MANIFEST_PATTERNS.some((re) => re.test(path))) return true;
  const slash = path.lastIndexOf("/");
  if (slash < 0) return false;
  const base = path.slice(slash + 1);
  if (base !== "package.json" && base !== "package-lock.json") return false;
  if (readRootManifest === undefined) return false;
  const globs = declaredWorkspaceGlobs(readRootManifest);
  if (globs === undefined) return false;
  return dirIsDeclaredWorkspace(path.slice(0, slash), globs);
}

/** Dependency declarations outside the npm-workspace manifest predicate. The deploy image is a
 * separately packaged surface: Dependabot edits its package manifests directly, and a Node image
 * bump edits the Dockerfile's `FROM` declaration, which W1-T6064 syncs into `.nvmrc`. Keep these
 * paths explicit rather than widening workspace matching (which would admit fixtures). */
const DEPLOY_DEPENDENCY_DECLARATIONS = new Set([
  "deploy/package.json",
  "deploy/package-lock.json",
  "deploy/Dockerfile",
  ".nvmrc",
]);

/** Is `path` safe for a dependency-only PR, using the repository's real root workspace declaration? */
export function isDependencyDeclarationPath(
  path: string,
  readRootManifest: () => string = () => readFileSync("package.json", "utf8"),
): boolean {
  return DEPLOY_DEPENDENCY_DECLARATIONS.has(path) || isManifestPath(path, readRootManifest);
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

/** W1-T6258 — the I/O a node-pin sync needs; the pass decides, the caller reads and pushes. */
export interface NodePinSyncIo {
  /** `git show <sha>:<path>` on the PR head, or undefined when the file cannot be read. */
  readAtHead(headSha: string, path: string): string | undefined;
  /** Commit `.nvmrc` = `nvmrc` on the PR head ref and push it; returns the pushed sha. */
  commitAndPush(input: { headRef: string; headSha: string; nvmrc: string; subject: string }): string;
}

export type NodePinSyncOutcome =
  | { kind: "skipped" }
  | { kind: "in-sync"; pinned: string }
  | { kind: "synced"; from: string; to: string; pushedSha: string }
  | { kind: "refused"; reason: "major" | "unreadable" | "push-failed"; detail: string };

/**
 * W1-T6258 — a Dependabot `deploy/Dockerfile` bump edits `FROM` only, so `.nvmrc` drifts and the
 * exact-pin image tests go red. When the diff touches the Dockerfile, plan the pin on the PR head's
 * own Dockerfile and `.nvmrc`; a within-major drift is committed once on the head ref. A synced head
 * plans `in-sync`, so a second pass pushes nothing. A major or unreadable pin is reported, never synced.
 */
export function syncNodePinForImageBump(
  diff: string,
  head: { sha: string; ref: string | undefined },
  io: NodePinSyncIo,
): NodePinSyncOutcome {
  if (!changedFilesInDiff(diff).includes("deploy/Dockerfile")) return { kind: "skipped" };
  const dockerfile = io.readAtHead(head.sha, "deploy/Dockerfile");
  const nvmrc = io.readAtHead(head.sha, ".nvmrc");
  if (dockerfile === undefined || nvmrc === undefined || head.ref === undefined) {
    return { kind: "refused", reason: "unreadable", detail: "deploy/Dockerfile, .nvmrc or the head ref could not be read" };
  }
  const plan = planNodePin(dockerfile, nvmrc) as { action: string; image?: string; pinned: string };
  if (plan.action === "in-sync") return { kind: "in-sync", pinned: plan.pinned };
  if (plan.action === "major") {
    return { kind: "refused", reason: "major", detail: `the image moves Node ${plan.pinned} -> ${plan.image}, a major` };
  }
  if (plan.action !== "rewrite" || plan.image === undefined) {
    return { kind: "refused", reason: "unreadable", detail: "deploy/Dockerfile must carry exactly one `FROM node:<x.y.z>-` line" };
  }
  try {
    const pushedSha = io.commitAndPush({
      headRef: head.ref,
      headSha: head.sha,
      nvmrc: `${plan.image}\n`,
      subject: `chore(deps): .nvmrc follows the image's Node ${plan.image}`,
    });
    return { kind: "synced", from: plan.pinned, to: plan.image, pushedSha };
  } catch (error) {
    return { kind: "refused", reason: "push-failed", detail: String((error as Error)?.message ?? error) };
  }
}

export const ACTION_SHA_PIN_CHANGE_RE = /^([+-])\s*uses:\s*([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)@([a-f0-9]{40})\s+#\s*(v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\s*$/i;
const ACTION_SHA_SUMMARY = String.raw`([a-f0-9]{40})\s+to\s+([a-f0-9]{40})`;

interface ActionShaPinTransition {
  action: string;
  fromSha: string;
  toSha: string;
  release: string;
}

function actionShaPinTransitions(diff: string): ActionShaPinTransition[] | undefined {
  const files = changedFilesInDiff(diff);
  if (files.length === 0 || files.some((file) => !/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(file))) return undefined;

  let changedRun: string[] = [];
  let valid = true;
  const transitions: ActionShaPinTransition[] = [];
  const flush = () => {
    if (changedRun.length === 0) return;
    const removed = changedRun.filter((line) => line.startsWith("-"));
    const added = changedRun.filter((line) => line.startsWith("+"));
    if (removed.length === 0 || removed.length !== added.length) {
      valid = false;
      changedRun = [];
      return;
    }
    for (let i = 0; i < removed.length; i++) {
      const before = ACTION_SHA_PIN_CHANGE_RE.exec(removed[i]);
      const after = ACTION_SHA_PIN_CHANGE_RE.exec(added[i]);
      if (
        !before || !after || before[2] !== after[2] || before[4] !== after[4] ||
        before[3].toLowerCase() === after[3].toLowerCase()
      ) {
        valid = false;
        continue;
      }
      transitions.push({ action: before[2], fromSha: before[3], toSha: after[3], release: before[4] });
    }
    changedRun = [];
  };

  for (const line of diff.split("\n")) {
    if (
      line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("@@") ||
      line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("new file mode ") ||
      line.startsWith("deleted file mode ") || line.startsWith("rename from ") || line.startsWith("rename to ")
    ) {
      flush();
      continue;
    }
    if (line.startsWith("\\ No newline at end of file")) continue;
    if (line.startsWith("+") || line.startsWith("-")) changedRun.push(line);
    else flush();
  }
  flush();
  return valid && transitions.length > 0 ? transitions : undefined;
}

function actionShaPinSummary(line: string): Omit<ActionShaPinTransition, "release"> | undefined {
  const text = line.replace(CONVENTIONAL_TITLE_PREFIX_RE, "").trim();
  const patterns = [
    new RegExp(String.raw`^Bumps?\s+\[([^\]]+)\]\([^)]+\)\s+from\s+${ACTION_SHA_SUMMARY}\b`, "i"),
    new RegExp(String.raw`^Updates\s+\x60([^\x60]+)\x60\s+from\s+${ACTION_SHA_SUMMARY}\b`, "i"),
    new RegExp(String.raw`^Bumps?\s+\x60([^\x60]+)\x60\s+from\s+${ACTION_SHA_SUMMARY}\b`, "i"),
    new RegExp(String.raw`^Bumps?\s+([^\s,]+)\s+from\s+${ACTION_SHA_SUMMARY}\b`, "i"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return { action: match[1].trim(), fromSha: match[2], toSha: match[3] };
  }
  return undefined;
}

/**
 * True only when a unified diff changes one or more GitHub Actions refs from one full SHA to
 * another while keeping the exact action identity and trailing release-version annotation fixed.
 * Every changed content line must be one side of such a replacement; the Dependabot summary must
 * also name the exact action and old/new SHAs. A claim alone cannot turn an unknown update into a pass.
 */
export function isActionShaPinOnlyDiff(diff: string): boolean {
  return actionShaPinTransitions(diff) !== undefined;
}

/** The Dependabot summary must name and hash-match every action transition in the diff. */
export function isActionShaPinOnlyProposal(title: string, body: string, diff: string): boolean {
  const changes = actionShaPinTransitions(diff);
  if (!changes) return false;
  const changeKeys = new Set(changes.map((change) => `${change.action.toLowerCase()}\0${change.fromSha.toLowerCase()}\0${change.toSha.toLowerCase()}`));
  const summaries = [title, ...body.split("\n").filter((line) => DEPENDABOT_SUMMARY_LINE_RE.test(line))]
    .flatMap((line) => actionShaPinSummary(line) ?? [])
    .map((summary) => `${summary.action.toLowerCase()}\0${summary.fromSha.toLowerCase()}\0${summary.toSha.toLowerCase()}`);
  const summaryKeys = new Set(summaries);
  return changeKeys.size === summaryKeys.size && [...changeKeys].every((key) => summaryKeys.has(key));
}

/** Changed files that fall OUTSIDE the manifest/lockfile allowlist. `[]` ⇒ confined. */
export function offendingFiles(
  diff: string,
  readRootManifest: () => string = () => readFileSync("package.json", "utf8"),
): string[] {
  return changedFilesInDiff(diff).filter((f) => !isDependencyDeclarationPath(f, readRootManifest));
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

export interface DepReviewSelectedHead {
  number: number;
  url: string;
  headSha: string;
  body: string;
}

export type DepReviewChecksObservation =
  | { kind: "observed"; checks: ReturnType<typeof rollupFromRest> }
  | { kind: "unknown"; reason: string };

export async function readSelectedDepReviewChecks(
  owner: string, repo: string, selected: DepReviewSelectedHead, read: GhApiFetcher,
): Promise<DepReviewChecksObservation> {
  const target = { ...selected }, slug = `${owner}/${repo}`.toLowerCase();
  const unknown = (reason: string): DepReviewChecksObservation => ({ kind: "unknown", reason });
  const id = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
  const rows = async (args: string[], key: string, bound?: (body: Record<string, unknown>) => boolean): Promise<Record<string, unknown>[] | undefined> => {
    // GitHub caps a requested REST page at 100 rows. The first declared total bounds
    // this walk; any changing, short or overlapping population remains unknown.
    const pageSize = 100, endpoint = new URL(args[1], "https://api.github.com/");
    endpoint.searchParams.set("per_page", String(pageSize));
    let total: number | undefined;
    const all: Record<string, unknown>[] = [], seen = new Set<unknown>();
    for (let page = 1; total === undefined || all.length < total; page++) {
      endpoint.searchParams.set("page", String(page));
      const body = record(await read([args[0], endpoint.pathname.slice(1) + endpoint.search, ...args.slice(2)]));
      if (!body || !Number.isSafeInteger(body.total_count) || (body.total_count as number) < 0 || (bound && !bound(body))) return undefined;
      total ??= body.total_count as number;
      const list = body[key];
      if (body.total_count !== total || !Array.isArray(list) || list.length !== Math.min(pageSize, total - all.length) ||
          !list.every(row => record(row) !== undefined)) return undefined;
      for (const row of list as Record<string, unknown>[]) {
        if (seen.has(row.id)) return undefined;
        seen.add(row.id);
        all.push(row);
      }
    }
    return all;
  };
  const pull = (value: unknown) => {
    const p = record(value), head = record(p?.head), repository = record(record(p?.base)?.repo);
    if (p === undefined || head === undefined || repository === undefined) return undefined;
    if (!id(p.id) || p.number !== target.number || p.html_url !== target.url || p.state !== "open" || p.merged !== false ||
        head.sha !== target.headSha || (p.body ?? "") !== target.body || !id(repository.id) ||
        typeof repository.full_name !== "string" || repository.full_name.toLowerCase() !== slug) return undefined;
    return { prId: p.id, repoId: repository.id };
  };
  if (!id(target.number) || !/^[a-f0-9]{40}$/.test(target.headSha) ||
      target.url.toLowerCase() !== `https://github.com/${slug}/pull/${target.number}`) return unknown("selected_target_invalid");
  let stage = "selected_pr";
  try {
    const first = pull(await read(singlePrRestArgs(owner, repo, target.number)));
    if (!first) return unknown("selected_target_unavailable_or_changed");
    stage = "check_runs";
    const args = checkRunsRestArgs(owner, repo, target.headSha);
    args[1] += "&filter=all";
    const checks = await rows(args, "check_runs");
    if (!checks || new Set(checks.map(c => c.id)).size !== checks.length || checks.some(c => !id(c.id) || c.head_sha !== target.headSha ||
      typeof c.name !== "string" || !c.name || typeof c.status !== "string" || !timestamp(c.started_at) ||
      (c.conclusion != null && typeof c.conclusion !== "string") || (c.completed_at != null && !timestamp(c.completed_at)))) return unknown("check_runs_incomplete_or_unbound");
    stage = "commit_statuses";
    const statuses = await rows(combinedStatusRestArgs(owner, repo, target.headSha), "statuses", body => body.sha === target.headSha);
    if (!statuses || statuses.some(s => !id(s.id) || typeof s.context !== "string" || !s.context ||
      typeof s.state !== "string" || !timestamp(s.created_at) || (s.updated_at != null && !timestamp(s.updated_at)))) return unknown("commit_statuses_incomplete_or_unbound");
    stage = "workflow_runs";
    const workflows = await rows(runsForHeadRestArgs(owner, repo, target.headSha), "workflow_runs");
    if (!workflows || new Set(workflows.map(r => r.id)).size !== workflows.length || workflows.some(r => !id(r.id) || !id(r.workflow_id) ||
      !id(r.check_suite_id) || !id(r.run_attempt) || r.head_sha !== target.headSha)) return unknown("workflow_runs_incomplete_or_unbound");
    const rollup = rollupFromRest(checks as Parameters<typeof rollupFromRest>[0], statuses as Parameters<typeof rollupFromRest>[1], workflows as NonNullable<Parameters<typeof rollupFromRest>[2]>);
    for (let index = 0; index < checks.length; index++) {
      const check = checks[index], entry = rollup[index], suite = record(check.check_suite)?.id;
      const posted = typeof check.external_id === "string" && /^run:\d+:\d+:job:\d+$/.test(check.external_id);
      const matching = posted ? [] : workflows.filter(r => r.check_suite_id === suite);
      const direct = workflows.find(r => r.id === entry.workflowRunId), run = direct ?? matching[0];
      if (matching.length > 1 || (direct && matching[0] && direct.id !== matching[0].id) ||
          ((entry.workflowRunId !== undefined || record(check.app)?.slug === "github-actions") && run === undefined)) return unknown("workflow_identity_unresolved");
      if (run !== undefined) {
        entry.workflowRunId = run.id as number;
        entry.workflowId = run.workflow_id as number;
      }
    }
    stage = "selected_pr_recheck";
    const final = pull(await read(singlePrRestArgs(owner, repo, target.number)));
    if (!final || final.prId !== first.prId || final.repoId !== first.repoId) return unknown("selected_target_changed_during_read");
    return { kind: "observed", checks: rollup };
  } catch (error) {
    void error; // JSON/transport/shape failures remain explicit unknown; never an empty success or external effect.
    return unknown(`selected_evidence_read_failed:${stage}`);
  }
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

export function redChecks(checks: DepReviewCheck[], required?: DepReviewRequired): string[] {
  return splitRedChecks(checks, required).holding;
}

export type DepReviewRequired = { kind: "required"; names: readonly string[] } | { kind: "all-checks"; fallback: string }; // W1-T9929

export function splitRedChecks(checks: DepReviewCheck[], required?: DepReviewRequired): { holding: string[]; advisory: string[] } { // W1-T9929
  const red = checks
    .filter((c) => RED_CONCLUSIONS.has(String(c.conclusion ?? c.state ?? "").toUpperCase()))
    .map((c) => c.name ?? c.context ?? "unknown")
    // EXACTLY ONE NAME, never a relaxation. Every OTHER red check must keep holding — that is the
    // entire value of the hold, and a fix that widened into "ignore red checks" would arm
    // auto-merge over a genuinely broken bump, which is worse than the deadlock.
    .filter((name) => name !== LANE_OWNED_STATUS_CONTEXT);
  if (required?.kind !== "required") return { holding: red, advisory: [] };
  const names = new Set(required.names);
  return { holding: red.filter((name) => names.has(name)), advisory: [...new Set(red.filter((name) => !names.has(name)))].sort() };
}

export function depReviewRequiredSet( // W1-T9929: protection's contexts ∪ ci-gate's REQUIRED; unreadable ⇒ every check
  protection: { kind: "contexts"; contexts: readonly string[] } | { kind: "none" } | { kind: "unreadable"; reason: string },
  ciGateRequired: readonly string[],
): DepReviewRequired {
  if (protection.kind === "unreadable") return { kind: "all-checks", fallback: `protection-unreadable:${protection.reason}` };
  if (protection.kind === "none") return { kind: "all-checks", fallback: "protection-none" };
  if (protection.contexts.includes("ci-gate") && ciGateRequired.length === 0) return { kind: "all-checks", fallback: "ci-gate-required-empty" };
  return { kind: "required", names: [...new Set([...protection.contexts, ...ciGateRequired])].sort() };
}

// ── The five-way verdict ─────────────────────────────────────────────────

export type DepReviewDecision = "arm" | "escalate" | "refuse" | "hold" | "migrate";

export interface DepReviewInput {
  author: DepReviewAuthor;
  title: string;
  body: string;
  diff: string;
  checks: DepReviewCheck[];
  required?: DepReviewRequired;
}

export interface DepReviewResult {
  decision: DepReviewDecision;
  semverLevel: SemverLevel;
  /** The semver is unknown, but the Dependabot summary and diff prove an unchanged-version action SHA refresh. */
  pinOnly: boolean;
  offendingFiles: string[];
  redChecks: string[];
  migrationBumps: DepReviewBumpFact[];
  reason: string;
  advisoryRed?: string[]; // W1-T9929: reds outside the required set, on every verdict decideDepReview returns
  judgedAgainst?: "required" | "all-checks";
  requiredFallback?: string;
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
  const { holding: red, advisory: advisoryRed } = splitRedChecks(input.checks, input.required);
  const judged: Pick<DepReviewResult, "advisoryRed" | "judgedAgainst" | "requiredFallback"> = input.required?.kind === "required"
    ? { advisoryRed, judgedAgainst: "required" }
    : { advisoryRed, judgedAgainst: "all-checks", ...(input.required ? { requiredFallback: input.required.fallback } : {}) };
  const migrationBumps = majorMigrationBumps(input.title, input.body);
  const dependabot = isDependabotAuthor(input.author);
  const pinOnly = dependabot && offending.length === 0 && semverLevel === "unknown" &&
    isActionShaPinOnlyProposal(input.title, input.body, input.diff);

  if (!dependabot) {
    return {
      decision: "refuse",
      semverLevel,
      pinOnly,
      offendingFiles: offending,
      redChecks: red,
      migrationBumps,
      ...judged,
      reason: `author '${input.author.login}' is not dependabot[bot] — this lane reviews Dependabot PRs only`,
    };
  }
  if (offending.length > 0) {
    return {
      decision: "refuse",
      semverLevel,
      pinOnly,
      offendingFiles: offending,
      redChecks: red,
      migrationBumps,
      ...judged,
      reason: `diff touches file(s) outside the manifest/lockfile allowlist: ${offending.join(", ")}`,
    };
  }
  if (semverLevel === "major" && migrationBumps.length > 0) {
    return {
      decision: "migrate",
      semverLevel,
      pinOnly,
      offendingFiles: offending,
      redChecks: red,
      migrationBumps,
      ...judged,
      reason: `MAJOR dependency proposal requires rmd-owned migration: ${migrationBumps
        .map((b) => `${b.dependency} ${b.fromVersion}->${b.toVersion}`)
        .join(", ")}`,
    };
  }
  if (semverLevel === "major" || (semverLevel === "unknown" && !pinOnly)) {
    return {
      decision: "escalate",
      semverLevel,
      pinOnly,
      offendingFiles: offending,
      redChecks: red,
      migrationBumps,
      ...judged,
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
      pinOnly,
      offendingFiles: offending,
      redChecks: red,
      migrationBumps,
      ...judged,
      reason: `required check(s) not green: ${red.join(", ")}`,
    };
  }
  return {
    decision: "arm",
    semverLevel,
    pinOnly,
    offendingFiles: offending,
    redChecks: red,
    migrationBumps,
    ...judged,
    reason: (pinOnly
      ? "pin-only GitHub Actions SHA refresh, release annotations unchanged, gates green — safe to auto-merge"
      : `${semverLevel} bump, confined to manifests, gates green — safe to auto-merge`) +
      (advisoryRed.length > 0 ? `; advisory red, not holding: ${advisoryRed.join(", ")}` : ""),
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
      `${args.prUrl} was judged safe by deterministic dependency review with green gates, and remudero-review was posted`,
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

function refreshEscalationLines(refresh: DependabotRefreshRecord): string[] {
  const at = fixedClock(refresh.requestedAtMs).iso();
  if (refresh.updateFailed) {
    return [
      `Refresh attempted: the guarded update-branch of this head was refused or does not apply at ${at} (${refresh.cause}): ${refresh.updateError ?? "no reason given"}.`,
      ...(refresh.reply === undefined ? [] : [`Dependabot refused the earlier \`${refresh.command}\`: "${refresh.reply}".`]),
    ];
  }
  if (refresh.via === "update-branch") {
    return [`Refresh requested: the guarded update-branch was applied to this head at ${at} (${refresh.cause}).`];
  }
  if (refresh.answer === "refused") {
    return [`Refresh refused: Dependabot answered \`${refresh.command}\` (posted ${at}, ${refresh.cause}) with "${refresh.reply ?? ""}".`];
  }
  return [`Refresh requested: \`${refresh.command}\` was posted for this head at ${at} (${refresh.cause}), and Dependabot has not produced a new head.`];
}

export function buildDepReviewEscalation(args: {
  prUrl: string;
  prNumber: number;
  title: string;
  body: string;
  semverLevel: SemverLevel;
  hold?: { headSha: string; redChecks: string[]; advisoryRed?: string[]; refresh?: DependabotRefreshRecord };
}): Escalation {
  if (args.hold) {
    const refresh = args.hold.refresh;
    return {
      class: "BLOCKED",
      taskId: `dep-review-hold-PR${args.prNumber}`,
      headSha: args.hold.headSha,
      cause: "ci",
      summary: `Aged dependency review hold: ${args.title}`,
      detail: [
        `Dependabot PR ${args.prUrl} is held on head ${args.hold.headSha}.`,
        `Blocker: required check(s) not green: ${args.hold.redChecks.join(", ")}.`,
        ...(args.hold.advisoryRed?.length ? [`Advisory red, not holding (still visible on the PR): ${args.hold.advisoryRed.join(", ")}.`] : []),
        ...(refresh === undefined ? [] : refreshEscalationLines(refresh)),
        `Owner: repository operator. Inspect the failed check logs, rerun transient failures,`,
        `or repair the dependency/CI failure and ask Dependabot to rebase or recreate the PR.`,
        `Do not override failing checks. Green checks resume deterministic review and auto-merge;`,
        `this issue does not require routine human approval of the dependency bump.`,
      ].join("\n"),
      options: [{
        label: "repair checks",
        detail: "repository operator: investigate and rerun transient failed checks, or repair the failure and request a Dependabot rebase/recreate",
        kind: { type: "operator-only" },
      }],
      recommendation: "repair checks",
      consequence: "The dependency PR remains held while its checks are red.",
    };
  }
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

/** BACKSTOP: allow a full day for transient CI failures before asking the repository operator. */
export const DEP_REVIEW_HOLD_AGE_MS = 24 * 60 * 60 * 1000;

interface DepReviewHoldState {
  headSha: string;
  heldSinceMs: number | null;
  asks: Array<{ headSha: string; issueUrl: string; retired: boolean }>;
  /** W1-T9584 — every head a Dependabot refresh was asked for. Never pruned, so neither a restart
   *  nor a ledger rotation can ask twice for one head. */
  refreshes?: DependabotRefreshRecord[];
  supersededReruns?: SupersededRerunRecord[];
}

/** Durable per-PR state survives ledger rotation; delivered heads stay recorded after retirement. */
export function reconcileDepReviewHold(args: {
  statePath: string;
  prUrl: string;
  prNumber: number;
  title: string;
  body: string;
  headSha: string;
  result: DepReviewResult;
  nowMs: number;
  escalationDeps: () => EscalateDeps;
  log: (step: string, extra: Record<string, unknown>) => void;
}): void {
  if (args.result.decision !== "hold" && !existsSync(args.statePath)) return;
  const state: DepReviewHoldState = existsSync(args.statePath)
    ? JSON.parse(readFileSync(args.statePath, "utf8"))
    : { headSha: args.headSha, heldSinceMs: null, asks: [] };
  if (!state || typeof state !== "object" || typeof state.headSha !== "string" ||
      !(state.heldSinceMs === null || (typeof state.heldSinceMs === "number" && Number.isFinite(state.heldSinceMs))) ||
      !Array.isArray(state.asks) || state.asks.some((ask) =>
        !ask || typeof ask.headSha !== "string" || typeof ask.issueUrl !== "string" || typeof ask.retired !== "boolean")) {
    throw new Error("invalid dependency hold state; refusing to forget delivered heads");
  }
  const save = () => writeAtomic(args.statePath, `${JSON.stringify(state)}\n`);
  for (const ask of state.asks) {
    if (ask.retired || (ask.headSha === args.headSha && args.result.decision === "hold")) continue;
    const issues = args.escalationDeps().issues;
    if (!issues.closeWithComment) throw new Error("dependency hold issue gateway cannot retire issues");
    const reason = ask.headSha !== args.headSha
      ? `Dependency hold head changed from ${ask.headSha} to ${args.headSha}.`
      : args.result.redChecks.length === 0
        ? "Dependency hold checks recovered."
        : `Dependency review no longer holds this head (${args.result.decision}).`;
    issues.closeWithComment(ask.issueUrl, `${reason} Retiring the old operator ask for ${args.prUrl}.`);
    ask.retired = true;
    save();
    args.log("dep-review.hold_retired", { issue_url: ask.issueUrl, head_sha: ask.headSha, reason });
  }
  if (state.headSha !== args.headSha || args.result.decision !== "hold") state.heldSinceMs = null;
  state.headSha = args.headSha;
  if (args.result.decision === "hold") state.heldSinceMs ??= args.nowMs;
  save();
  if (state.heldSinceMs === null || args.nowMs - state.heldSinceMs < DEP_REVIEW_HOLD_AGE_MS ||
      state.asks.some((ask) => ask.headSha === args.headSha)) return;
  const issueUrl = escalate(buildDepReviewEscalation({
    ...args,
    semverLevel: args.result.semverLevel,
    hold: { headSha: args.headSha, redChecks: args.result.redChecks, advisoryRed: args.result.advisoryRed, ...refreshFor(state, args.headSha) },
  }), args.escalationDeps());
  if (!issueUrl) throw new Error("dependency hold escalation not delivered; retry after the issue read recovers");
  state.asks.push({ headSha: args.headSha, issueUrl, retired: false });
  save();
  args.log("dep-review.hold_escalated", { issue_url: issueUrl, head_sha: args.headSha, red_checks: args.result.redChecks });
}

// ── W1-T9584 — a held Dependabot head whose red is MAIN's is refreshed by asking Dependabot, once per head.
// The dep-review row outranks every base-red row, and a fleet merge onto a Dependabot branch ends Dependabot's
// management of it (#11791, #11793 on 2026-10-14). The evidence is decideBaseRed's, never a new rule.

export const DEPENDABOT_REBASE_COMMAND = "@dependabot rebase";
export const DEPENDABOT_RECREATE_COMMAND = "@dependabot recreate";

/** decideBaseRed would refresh the head, or every failing test file passes at main's tip (W1-T6405). */
export type DependabotRefreshCause = "base-red-recovered" | "fixed-on-main";
export const DEPENDABOT_REFRESH_CAUSES: readonly DependabotRefreshCause[] = ["base-red-recovered", "fixed-on-main"];

export interface DependabotRefreshRecord {
  headSha: string;
  command: string;
  cause: DependabotRefreshCause | typeof DEPENDABOT_STALE_EVENT_CAUSE;
  requestedAtMs: number;
  /** False only between the write-ahead record and a comment that has not yet returned. */
  delivered: boolean;
  /** W1-T9994 — Dependabot's reply refused the command: `delivered` means POSTED, never ANSWERED. */
  answer?: "refused";
  answeredAtMs?: number;
  /** The refusal reply's first line, quoted by the escalation. */
  reply?: string;
  /** W1-T9994 — the base refresh went through the guarded REST update-branch, not a command. */
  via?: "update-branch";
  /** The update-branch was refused or does not apply; the record then escalates once. */
  updateFailed?: boolean;
  updateError?: string;
  issueUrl?: string;
}

// ── W1-T9994 — Dependabot refuses the fleet's commands ("Sorry, only users with push access can use that
// command", #11968 at 20:45:17Z), yet a posted command read `delivered: true` for hours. The answer is read.

/** The wording Dependabot answers a command from a commenter without push access, seeded with #11968's reply. */
export const DEPENDABOT_REFUSAL_WORDING = "only users with push access can use that command";
export const DEPENDABOT_UPDATE_BRANCH_COMMAND = "update-branch";

/** The fields of one REST issue comment a command answer reads. */
export interface DependabotIssueComment {
  user?: { login?: string } | null;
  created_at?: string;
  body?: string;
}

export type DependabotCommandAnswer = { kind: "refused"; reply: string } | { kind: "none" };

/** Pure: Dependabot's refusal among the issue comments created at or after `sinceMs`, else `none`. */
export function dependabotCommandAnswer(comments: readonly DependabotIssueComment[], sinceMs: number): DependabotCommandAnswer {
  const sinceSecond = Math.floor(sinceMs / 1000) * 1000; // GitHub stamps whole seconds; the request is stamped in ms
  for (const comment of comments) {
    const created = Date.parse(comment.created_at ?? "");
    if (!Number.isFinite(created) || created < sinceSecond) continue;
    const login = comment.user?.login;
    if (login === undefined || !isDependabotAuthor({ login })) continue;
    const body = comment.body ?? "";
    if (body.toLowerCase().includes(DEPENDABOT_REFUSAL_WORDING)) return { kind: "refused", reply: body.split("\n")[0].trim() };
  }
  return { kind: "none" };
}

/** `wait`: main also fails this check, so a refresh would only inherit it. `request`: main's red has
 *  cleared, or main's tip passes what this head fails. `own`: the red is this head's, or nothing says otherwise. */
export type DependabotRefreshVerdict =
  | { kind: "wait"; check: string }
  | { kind: "request"; cause: DependabotRefreshCause; check: string }
  | { kind: "own" };

/** Folds `decideBaseRed` and `fixedOnMainTestFiles` into a verdict; structural inputs, so no sweep import. */
export function dependabotRefreshVerdict(
  baseRed: { kind: "own" } | { kind: "wait" | "refresh"; check: string },
  fixedOnMainFiles: readonly string[] | undefined,
): DependabotRefreshVerdict {
  if (baseRed.kind === "wait") return { kind: "wait", check: baseRed.check };
  if (baseRed.kind === "refresh") return { kind: "request", cause: "base-red-recovered", check: baseRed.check };
  if (fixedOnMainFiles !== undefined && fixedOnMainFiles.length > 0) {
    return { kind: "request", cause: "fixed-on-main", check: fixedOnMainFiles.join(", ") };
  }
  return { kind: "own" };
}

/** One commit of the PR view's `commits` field. GraphQL leaves a bot author's `login` empty, so the
 *  name and noreply email are read as well. */
export interface DependabotHeadCommit {
  oid?: string;
  authors?: Array<{ login?: string; name?: string; email?: string }>;
}

export const DEPENDABOT_NOREPLY_EMAIL_RE = /^(?:\d+\+)?dependabot\[bot\]@users\.noreply\.github\.com$/i;

function isDependabotCommitAuthor(author: { login?: string; name?: string; email?: string }): boolean {
  return [author.login, author.name].some((who) => typeof who === "string" && who !== "" && isDependabotAuthor({ login: who })) ||
    DEPENDABOT_NOREPLY_EMAIL_RE.test(author.email ?? "");
}

/** True when any commit on the head has an author other than Dependabot. Unread commits count as
 *  edited: `recreate` works on any Dependabot branch, while `rebase` is refused on an edited one. */
export function headCarriesForeignCommit(commits: readonly DependabotHeadCommit[] | undefined): boolean {
  if (commits === undefined || commits.length === 0) return true;
  return commits.some((c) => (c.authors ?? []).length === 0 || (c.authors ?? []).some((a) => !isDependabotCommitAuthor(a)));
}

export function dependabotRefreshCommand(commits: readonly DependabotHeadCommit[] | undefined): string {
  return headCarriesForeignCommit(commits) ? DEPENDABOT_RECREATE_COMMAND : DEPENDABOT_REBASE_COMMAND;
}

function refreshFor(state: DepReviewHoldState, headSha: string): { refresh?: DependabotRefreshRecord } {
  const refresh = state.refreshes?.find((r) => r.headSha === headSha);
  return refresh === undefined ? {} : { refresh };
}

function readRefreshState(statePath: string, headSha: string): DepReviewHoldState {
  const state: DepReviewHoldState = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : { headSha, heldSinceMs: null, asks: [] };
  const refreshes = state?.refreshes;
  if (refreshes !== undefined && (!Array.isArray(refreshes) || refreshes.some((r) =>
    !r || typeof r.headSha !== "string" || typeof r.command !== "string" || typeof r.requestedAtMs !== "number"))) {
    throw new Error("invalid dependency refresh state; refusing to forget requested heads");
  }
  const reruns = state?.supersededReruns;
  if (reruns !== undefined && (!Array.isArray(reruns) || reruns.some((r) =>
    !r || typeof r.headSha !== "string" || typeof r.runId !== "number" || typeof r.attempt !== "number"))) {
    throw new Error("invalid superseded re-run state; refusing to re-run a run twice");
  }
  return state;
}

export type DependabotRefreshOutcome = "requested" | "unanswered" | "refused" | "escalated" | "failed" | "none";

/** Runs after {@link reconcileDepReviewHold} on the same pass and state file. Acts only on a
 *  `hold` with red checks: a hold on pending checks has nothing to refresh.
 *
 *  W1-T9994: a base refresh goes through the guarded REST update-branch (`expected_head_sha`), never a
 *  command Dependabot refuses from this identity. An earlier command record is answered by reading
 *  Dependabot's reply once per pass; a refusal is ledgered and stops pinning the head. Only a refused
 *  update-branch escalates, once, quoting the reply. */
export async function reconcileDependabotRefresh(args: {
  statePath: string;
  prNumber: number;
  headSha: string;
  result: DepReviewResult;
  cause: DependabotRefreshCause | undefined;
  nowMs: number;
  updateBranch: (expectedHeadSha: string) => Promise<{ ok: boolean; error?: string }>;
  readComments: (sinceIso: string) => Promise<readonly DependabotIssueComment[]>;
  escalate: (refresh: DependabotRefreshRecord) => string | null | undefined;
  log: (step: string, extra: Record<string, unknown>) => void;
}): Promise<DependabotRefreshOutcome> {
  if (args.result.decision !== "hold" || args.result.redChecks.length === 0) return "none";
  const state = readRefreshState(args.statePath, args.headSha);
  const save = () => writeAtomic(args.statePath, `${JSON.stringify(state)}\n`);
  const at = { pr_number: args.prNumber, head_sha: args.headSha };

  const escalateOnce = (record: DependabotRefreshRecord): DependabotRefreshOutcome => {
    if (record.issueUrl !== undefined) return "escalated";
    let issueUrl: string | null | undefined;
    try {
      issueUrl = args.escalate(record);
    } catch (error) {
      args.log("dep-review.refresh_failed", { ...at, action: "escalate", error: String((error as Error)?.message ?? error) });
      return "failed";
    }
    if (!issueUrl) return "failed";
    record.issueUrl = issueUrl;
    save();
    args.log("dep-review.refresh_escalated", { ...at, cause: record.cause, issue_url: issueUrl,
      ...(record.reply === undefined ? {} : { reply: record.reply }), ...(record.updateError === undefined ? {} : { error: record.updateError }) });
    return "escalated";
  };

  const refreshByUpdateBranch = async (record: DependabotRefreshRecord): Promise<DependabotRefreshOutcome> => {
    const outcome = await (async (): Promise<{ ok: boolean; error?: string }> => {
      try {
        return await args.updateBranch(args.headSha);
      } catch (error) {
        return { ok: false, error: String((error as Error)?.message ?? error) };
      }
    })();
    if (outcome.ok) {
      record.via = "update-branch";
      record.delivered = true;
      save();
      args.log("dep-review.refresh_requested", { ...at, command: record.command, via: "update-branch", cause: record.cause,
        edited_head: false, red_checks: args.result.redChecks });
      return "requested";
    }
    record.updateFailed = true;
    record.updateError = outcome.error ?? "update-branch did not apply";
    save();
    args.log("dep-review.refresh_failed", { ...at, command: record.command, via: "update-branch", cause: record.cause, error: record.updateError });
    return escalateOnce(record);
  };

  const prior = state.refreshes?.find((r) => r.headSha === args.headSha);
  if (prior !== undefined) {
    if (prior.updateFailed) return escalateOnce(prior);
    if (prior.command === DEPENDABOT_UPDATE_BRANCH_COMMAND && prior.via === undefined) return await refreshByUpdateBranch(prior);
    const read = prior.answer === undefined && prior.via === undefined && prior.delivered
      ? await (async (): Promise<{ answer?: DependabotCommandAnswer; error?: string }> => {
        try {
          return { answer: dependabotCommandAnswer(await args.readComments(fixedClock(prior.requestedAtMs).iso()), prior.requestedAtMs) };
        } catch (error) {
          return { error: String((error as Error)?.message ?? error) };
        }
      })()
      : {};
    const readError = read.error;
    if (read.answer?.kind === "refused") {
      prior.answer = "refused";
      prior.answeredAtMs = args.nowMs;
      prior.reply = read.answer.reply;
      save();
      args.log("dep-review.refresh_refused", { ...at, command: prior.command, cause: prior.cause, reply: read.answer.reply,
        requested_at: fixedClock(prior.requestedAtMs).iso(), age_ms: args.nowMs - prior.requestedAtMs });
    }
    if (prior.answer === "refused") return prior.via === undefined ? await refreshByUpdateBranch(prior) : "refused";
    args.log("dep-review.refresh_unanswered", {
      ...at, command: prior.command, cause: prior.cause, delivered: prior.delivered,
      requested_at: fixedClock(prior.requestedAtMs).iso(), age_ms: args.nowMs - prior.requestedAtMs,
      red_checks: args.result.redChecks, ...(readError === undefined ? {} : { answer_read_error: readError }),
    });
    return "unanswered";
  }
  if (args.cause === undefined) return "none";
  const record: DependabotRefreshRecord = {
    headSha: args.headSha, command: DEPENDABOT_UPDATE_BRANCH_COMMAND, cause: args.cause,
    requestedAtMs: args.nowMs, delivered: false,
  };
  state.refreshes = [...(state.refreshes ?? []), record];
  save();
  return await refreshByUpdateBranch(record);
}


export const DEPENDABOT_STALE_EVENT_CAUSE = "stale-event";

export type DependabotStaleEventVerdict = { kind: "stale-event"; checks: string[] } | { kind: "none" };

export function dependabotStaleEventVerdict(input: {
  mergeStateStatus: string | undefined;
  autoMergeArmed: boolean;
  reviewPosted: boolean;
  supersededReds: readonly string[];
}): DependabotStaleEventVerdict {
  if ((input.mergeStateStatus ?? "").toUpperCase() !== "BLOCKED" || !input.autoMergeArmed || !input.reviewPosted ||
      input.supersededReds.length === 0) return { kind: "none" };
  return { kind: "stale-event", checks: [...new Set(input.supersededReds)].sort() };
}


export const LIVE_READING_RERUN_CHECKS: ReadonlyArray<{ check: string; workflow: string }> = [
  { check: "commitlint", workflow: ".github/workflows/pr-title-lint.yml" },
  { check: "ci-gate", workflow: ".github/workflows/ci.yml" },
  { check: "ci-gate", workflow: ".github/workflows/ci-gate.yml" },
];

export function isLiveReadingCheck(check: string): boolean {
  return LIVE_READING_RERUN_CHECKS.some((c) => c.check === check);
}

export interface DependabotHeadRunJob {
  id: number;
  name: string;
  status?: string;
  conclusion?: string | null;
}

export interface DependabotHeadRun {
  id: number;
  path?: string;
  status?: string;
  conclusion?: string | null;
  run_attempt?: number;
  jobs?: DependabotHeadRunJob[];
}

export interface SupersededRedRerun {
  runId: number;
  attempt: number;
  checks: string[];
  jobIds: number[];
  kind: "rerun-failed-jobs" | "job";
  endpoint: string;
}

const isRed = (conclusion: string | null | undefined): boolean => RED_CONCLUSIONS.has(String(conclusion ?? "").toUpperCase());

export function supersededRedReruns(runs: readonly DependabotHeadRun[], superseded: readonly string[]): SupersededRedRerun[] {
  const order = (s: SupersededRedRerun) => LIVE_READING_RERUN_CHECKS.findIndex((c) => c.check === s.checks[0]);
  return runs.flatMap((run): SupersededRedRerun[] => {
    const live = LIVE_READING_RERUN_CHECKS.filter((c) => c.workflow === run.path && superseded.includes(c.check)).map((c) => c.check);
    if (run.status !== "completed" || !isRed(run.conclusion)) return [];
    const failed = (run.jobs ?? []).filter((j) => isRed(j.conclusion));
    const rerun = failed.filter((j) => live.includes(j.name));
    const at = { runId: run.id, attempt: run.run_attempt ?? 1 };
    if (rerun.length === 0) return [];
    if (rerun.length === failed.length) {
      return [{ ...at, checks: rerun.map((j) => j.name), jobIds: rerun.map((j) => j.id), kind: "rerun-failed-jobs",
        endpoint: `actions/runs/${run.id}/rerun-failed-jobs` }];
    }
    return rerun.map((j) => ({ ...at, checks: [j.name], jobIds: [j.id], kind: "job" as const, endpoint: `actions/jobs/${j.id}/rerun` }));
  }).sort((a, b) => order(a) - order(b));
}

export interface SupersededRerunRecord {
  headSha: string;
  runId: number;
  attempt: number;
  checks: string[];
  endpoint: string;
  requestedAtMs: number;
  result?: "success" | "red";
}

export interface DependabotActionsPort {
  runs(headSha: string): Promise<DependabotHeadRun[]>;
  jobs(runId: number): Promise<DependabotHeadRunJob[]>;
  rerun(endpoint: string): Promise<void>;
}

export function dependabotActionsPort(owner: string, repo: string, read: (args: string[]) => Promise<unknown>,
  post: (path: string) => Promise<unknown>): DependabotActionsPort {
  const list = async <T>(args: string[], key: string): Promise<T[]> => {
    const rows = ((await read(args)) as Record<string, unknown> | null | undefined)?.[key];
    if (!Array.isArray(rows)) throw new Error(`${args[1]}: no ${key} array in the response`);
    return rows as T[];
  };
  return {
    runs: (headSha) => list(runsForHeadRestArgs(owner, repo, headSha), "workflow_runs"),
    jobs: (runId) => list(jobsForRunRestArgs(owner, repo, runId), "jobs"),
    rerun: async (endpoint) => { await post(`repos/${owner}/${repo}/${endpoint}`); },
  };
}

export type SupersededRerunOutcome = {
  kind: "none" | "unavailable" | "requested" | "pending" | "verified" | "red" | "failed" | "unselected";
  checks: string[];
  redNow?: true;
};

function rerunOutcome(records: readonly SupersededRerunRecord[], live: readonly string[], pass: { failed?: boolean; requested?: boolean; redNow?: boolean }): SupersededRerunOutcome {
  const checks = [...new Set([...live, ...records.flatMap((r) => r.checks)])].sort();
  const kind = records.some((r) => r.result === "red") ? "red" : pass.failed ? "failed" : pass.requested ? "requested"
    : records.some((r) => r.result === undefined) ? "pending" : records.length > 0 ? "verified" : live.length > 0 ? "unselected" : "none";
  return { kind, checks, ...(pass.redNow ? { redNow: true as const } : {}) };
}

export async function reconcileSupersededRedReruns(args: {
  statePath: string;
  prNumber: number;
  headSha: string;
  superseded: readonly string[];
  actions: DependabotActionsPort | undefined;
  nowMs: number;
  log: (step: string, extra: Record<string, unknown>) => void;
}): Promise<SupersededRerunOutcome> {
  const live = args.superseded.filter(isLiveReadingCheck).sort();
  const state = readRefreshState(args.statePath, args.headSha);
  const save = () => writeAtomic(args.statePath, `${JSON.stringify(state)}\n`);
  const mine = () => (state.supersededReruns ?? []).filter((r) => r.headSha === args.headSha);
  const at = { pr_number: args.prNumber, head_sha: args.headSha };
  const open = mine().filter((r) => r.result === undefined);
  if (live.length === 0 && open.length === 0) return rerunOutcome(mine(), live, {});
  if (args.actions === undefined) return { kind: "unavailable", checks: live };
  let failed = false, redNow = false;
  const failRow = (action: string, extra: Record<string, unknown>, error: unknown) =>
    ({ ...at, action, ...extra, error: String((error as Error)?.message ?? error) });
  const FAILED = "dep-review.superseded_red.rerun_failed";
  let runs: DependabotHeadRun[];
  try {
    runs = await args.actions.runs(args.headSha);
  } catch (error) {
    args.log(FAILED, failRow("read-runs", {}, error));
    return { kind: "failed", checks: live };
  }
  for (const record of open) {
    const run = runs.find((r) => r.id === record.runId);
    if (run?.status !== "completed" || (run.run_attempt ?? 0) <= record.attempt) continue;
    record.result = String(run.conclusion ?? "").toUpperCase() === "SUCCESS" ? "success" : "red";
    redNow ||= record.result === "red";
    save();
    args.log(record.result === "success" ? "dep-review.superseded_red.rerun_verified" : "dep-review.superseded_red.rerun_red",
      { ...at, checks: record.checks, run_id: record.runId, attempt: run.run_attempt, conclusion: run.conclusion ?? null });
  }
  const done = new Set(mine().map((r) => r.runId));
  const workflows = new Set(LIVE_READING_RERUN_CHECKS.filter((c) => live.includes(c.check)).map((c) => c.workflow));
  const read: DependabotHeadRun[] = [];
  for (const run of runs.filter((r) => !done.has(r.id) && r.status === "completed" && isRed(r.conclusion) && workflows.has(r.path ?? ""))) {
    try {
      read.push({ ...run, jobs: await args.actions.jobs(run.id) });
    } catch (error) {
      failed = true;
      args.log(FAILED, failRow("read-jobs", { run_id: run.id }, error));
    }
  }
  let requested = false;
  for (const selected of supersededRedReruns(read, live)) {
    const extra = { checks: selected.checks, run_id: selected.runId, job_ids: selected.jobIds, endpoint: selected.endpoint, attempt: selected.attempt };
    try {
      await args.actions.rerun(selected.endpoint);
    } catch (error) {
      failed = true;
      args.log(FAILED, failRow("rerun", extra, error));
      continue;
    }
    state.supersededReruns = [...(state.supersededReruns ?? []), { headSha: args.headSha, runId: selected.runId,
      attempt: selected.attempt, checks: selected.checks, endpoint: selected.endpoint, requestedAtMs: args.nowMs }];
    save();
    requested = true;
    args.log("dep-review.superseded_red.rerun_requested", { ...at, ...extra });
  }
  return rerunOutcome(mine(), live, { failed, requested, redNow });
}

export function buildDepReviewStaleEventEscalation(args: {
  prUrl: string;
  prNumber: number;
  title: string;
  headSha: string;
  checks: readonly string[];
  rerun?: SupersededRerunOutcome["kind"];
}): Escalation {
  return {
    class: "MANUAL",
    taskId: `dep-review-stale-event-PR${args.prNumber}`,
    headSha: args.headSha,
    summary: `Dependabot PR is armed but GitHub still blocks it on a superseded red a re-run did not clear: ${args.title}`,
    detail: [
      `${args.prUrl} passed dependency review and auto-merge is armed, but GitHub reports it BLOCKED while`,
      `${args.checks.join(", ")} failed only in a run an older event started; the newest run of each passed.`,
      `rmd re-runs the old run of a check that reads live state (re-run: ${args.rerun ?? "none"}); a check that reads`,
      `the frozen event payload is never re-run, and Dependabot refuses \`@dependabot recreate\` from rmd.`,
      ``,
      `Head: ${args.headSha}`,
    ].join("\n"),
    options: [
      { label: "investigate", detail: `read the old run of ${args.checks.join(", ")} at ${args.headSha.slice(0, 7)} and why its re-run did not clear the block` },
      { label: "recreate", detail: "comment `@dependabot recreate` as a maintainer, so the head's checks start from a fresh event" },
    ],
    recommendation: "investigate",
  };
}

export type DependabotStaleEventOutcome = "observed" | "rerun" | "awaiting-rerun" | "escalated" | "failed";

export function reconcileDependabotStaleEvent(args: {
  statePath: string;
  prNumber: number;
  headSha: string;
  checks: readonly string[];
  rerun: SupersededRerunOutcome;
  nowMs: number;
  escalate: () => string | null | undefined;
  log: (step: string, extra: Record<string, unknown>) => void;
}): DependabotStaleEventOutcome {
  const state = readRefreshState(args.statePath, args.headSha) as DepReviewHoldState & {
    staleEvent?: { headSha?: unknown; firstSeenMs?: unknown; issueUrl?: unknown };
  };
  const save = () => writeAtomic(args.statePath, `${JSON.stringify(state)}\n`);
  const at = { pr_number: args.prNumber, head_sha: args.headSha, stale_checks: args.checks, rerun: args.rerun.kind };
  if (state.staleEvent?.headSha !== args.headSha) {
    state.staleEvent = { headSha: args.headSha, firstSeenMs: args.nowMs };
    save();
    args.log("dep-review.stale_event.observed", at);
    return "observed";
  }
  const payload = args.checks.filter((c) => !isLiveReadingCheck(c));
  if (payload.length === 0) {
    if (args.rerun.kind === "requested") {
      args.log("dep-review.stale_event.rerun_requested", { ...at, rerun_checks: args.rerun.checks });
      return "rerun";
    }
    if (args.rerun.kind === "pending") return "awaiting-rerun";
    if (args.rerun.kind === "failed" || args.rerun.kind === "unavailable") return "failed";
  }
  if (typeof state.staleEvent.issueUrl === "string") return "escalated";
  let issueUrl: string | null | undefined;
  try {
    issueUrl = args.escalate();
  } catch (error) {
    issueUrl = undefined;
    args.log("dep-review.stale_event.failed", { ...at, action: "escalate", error: String((error as Error)?.message ?? error) });
  }
  if (!issueUrl) return "failed";
  state.staleEvent.issueUrl = issueUrl;
  save();
  args.log("dep-review.stale_event.escalated", { ...at, payload_checks: payload, issue_url: issueUrl });
  return "escalated";
}

// ── W1-T9586 — an own red on a minor/patch Dependabot head becomes a migration proposal (W1-T2705's capture path).

/** `main-passes`: main's newest genuine run passes a check this head fails; `unclassified`: nothing says whose red it is. */
export type DependabotOwnRedSignal = "main-passes" | "unclassified";
export const DEPENDABOT_OWN_RED_SIGNALS: readonly DependabotOwnRedSignal[] = ["main-passes", "unclassified"];

export function dependabotOwnRedSignal(
  verdict: DependabotRefreshVerdict | undefined,
  main: { state: string; failingChecks: readonly string[]; observedChecks?: readonly string[] } | undefined,
  failing: readonly string[],
): DependabotOwnRedSignal | undefined {
  if (verdict?.kind !== "own" || failing.length === 0) return undefined;
  const observed = main?.state === "green" || main?.state === "red" ? main.observedChecks : undefined;
  return observed !== undefined && failing.some((name) => observed.includes(name) && !main!.failingChecks.includes(name))
    ? "main-passes" : "unclassified";
}

export function dependabotReviewArgs(refresh: DependabotRefreshVerdict | undefined, ownRed: DependabotOwnRedSignal | undefined): string[] {
  if (refresh?.kind === "request") return ["--dependabot-refresh", refresh.cause];
  return ownRed === undefined ? [] : ["--dependabot-own-red", ownRed];
}

interface DependabotOwnRedBump { dependency: string; fromVersion: string; toVersion: string }

interface DependabotOwnRedRecord {
  headSha: string;
  bumps: DependabotOwnRedBump[];
  redChecks: string[];
  firstSeenMs: number;
  lastSeenMs: number;
  feedbackId?: string;
}

interface DependabotOwnRedProposal { feedbackId: string; submissionKey: string; bumps: string[]; prNumbers: number[]; filedAtMs: number }

const OWN_RED_PROPOSALS_FILE = "own-red-proposals.json";

export interface DepReviewRepairSnapshot {
  owner: string;
  repo: string;
  asOfMs: number;
  prs: readonly {
    prNumber: number;
    headSha?: string;
    headRefName?: string;
    createdAt?: string;
    checksState: "green" | "red" | "pending" | "none";
  }[];
}

/** PRIMARY CONTROL: the operator's stuck-PR horizon; it changes ordering, never admission or spend. */
export const DEPENDABOT_STUCK_PR_AGE_MS = 60 * 60 * 1000;

/** Reorder existing eligible feedback only. Registry, per-head repair state and a fresh OPEN
 * PR snapshot must agree; prose never grants priority. Unknown evidence preserves FIFO. */
export async function prioritizeDepReviewRepairs(
  candidates: readonly string[], stateRoot: string, snapshot: DepReviewRepairSnapshot | undefined, nowMs: number,
  log: (step: string, extra: Record<string, unknown>) => void = () => {},
): Promise<string[]> {
  const ordinary = [...candidates];
  const recordEvent = (step: string, extra: Record<string, unknown>) => {
    try { log(step, extra); } catch { /* Priority telemetry cannot change the eligible queue or admit a run. */ }
  };
  if (!snapshot || !Number.isFinite(nowMs) || !Number.isFinite(snapshot.asOfMs) ||
      nowMs < snapshot.asOfMs || nowMs - snapshot.asOfMs > TICK_READ_MAX_AGE_MS ||
      !/^[\w.-]+$/.test(snapshot.owner) || !/^[\w.-]+$/.test(snapshot.repo)) return ordinary;
  const oldReds = snapshot.prs.filter(pr => Number.isSafeInteger(pr.prNumber) && pr.prNumber > 0 &&
    pr.headRefName?.startsWith("dependabot/") && pr.checksState === "red" &&
    Number.isFinite(Date.parse(pr.createdAt ?? "")) && nowMs - Date.parse(pr.createdAt!) >= DEPENDABOT_STUCK_PR_AGE_MS);
  if (oldReds.length === 0) return ordinary;
  const dir = join(stateRoot, "dep-review-holds", snapshot.owner, snapshot.repo);
  try {
    const registry: unknown = JSON.parse(await readFile(join(dir, OWN_RED_PROPOSALS_FILE), "utf8"));
    const proposals = (registry as { proposals?: unknown } | null)?.proposals;
    if (!Array.isArray(proposals)) throw new Error("invalid dependency repair registry");
    const priority = new Map<string, number>();
    for (const pr of oldReds) {
      if (!proposals.some(p => p && candidates.includes(p.feedbackId) &&
          Array.isArray(p.prNumbers) && p.prNumbers.includes(pr.prNumber))) continue;
      const state: unknown = JSON.parse(await readFile(join(dir, `PR${pr.prNumber}.json`), "utf8"));
      const record = (state as { ownRed?: unknown } | null)?.ownRed;
      if (!isOwnRedRecord(record) || record.headSha !== pr.headSha || !record.feedbackId ||
          !candidates.includes(record.feedbackId)) continue;
      const bumps = record.bumps.map(ownRedBumpKey);
      const linked = proposals.some(p => p && p.feedbackId === record.feedbackId &&
        Array.isArray(p.prNumbers) && p.prNumbers.includes(pr.prNumber) && Array.isArray(p.bumps) &&
        bumps.length > 0 && bumps.every(b => p.bumps.includes(b)));
      if (!linked) continue;
      const created = Date.parse(pr.createdAt!);
      priority.set(record.feedbackId, Math.min(priority.get(record.feedbackId) ?? created, created));
    }
    const ranked = ordinary.filter(id => priority.has(id)).sort((a, b) => priority.get(a)! - priority.get(b)!);
    if (ranked.length > 0) recordEvent("auto_triage.repair_priority", { feedback_ids: ranked, snapshot_as_of_ms: snapshot.asOfMs });
    return [...ranked, ...ordinary.filter(id => !priority.has(id))];
  } catch (error) {
    recordEvent("auto_triage.repair_priority_unavailable", { reason: String(error) });
    return ordinary;
  }
}

function ownRedBumpKey(b: DependabotOwnRedBump): string {
  return `${b.dependency.trim().toLowerCase()}@${b.toVersion}`;
}

function ownRedBumpText(b: DependabotOwnRedBump): string {
  return `${b.dependency} ${b.fromVersion} -> ${b.toVersion}`;
}

export function depReviewOwnRedSubmissionKey(owner: string, repo: string, bumps: readonly DependabotOwnRedBump[]): string {
  const targets = [...new Set(bumps.map(ownRedBumpKey))].sort().join(",");
  return `dep-review:own-red:${owner.trim().toLowerCase()}/${repo.trim().toLowerCase()}:${targets}`;
}

export function renderDepReviewOwnRedFeedback(args: {
  prUrl: string;
  prNumber: number;
  title: string;
  body: string;
  headSha: string;
  basis: "main-passes" | "survived-refresh" | "outside-allowlist";
  bumps: readonly DependabotOwnRedBump[];
  redChecks: readonly string[];
  siblings: ReadonlyArray<{ prNumber: number; bumps: readonly DependabotOwnRedBump[] }>;
  offendingFiles?: readonly string[];
}): string {
  return [
    `Land the dependency bump(s) of Dependabot PR #${args.prNumber}, whose red is its own: ${args.title}`,
    "",
    args.basis === "main-passes"
      ? "Dependabot proposed a minor/patch update whose head fails a required check that main's newest run passes."
      : args.basis === "outside-allowlist"
        ? `Dependabot edited dependency file(s) outside the lane's allowlist: ${(args.offendingFiles ?? []).join(", ")}.`
        : "Dependabot proposed a minor/patch update whose red survived a requested Dependabot refresh.",
    "A companion edit cannot ride the Dependabot branch (dep-review refuses any file outside the manifest",
    "allowlist), so rmd must land the SAME version moves plus the companion edits on an owned task branch:",
    "tests that pin the old version or action SHA literal, derived pins (the image CLI must equal the locked",
    "SDK's claudeCodeVersion), and the bumps of every sibling Dependabot PR named below that the fix needs.",
    "Do not edit or close the Dependabot PRs: the superseded-by row closes them once the owned PR carries",
    "their hunks, or Dependabot does once main carries the versions.",
    "",
    `PR: ${args.prUrl}`,
    `Head: ${args.headSha}`,
    `Bumps: ${args.bumps.map(ownRedBumpText).join(", ")}`,
    `Red checks: ${args.redChecks.join(", ")}`,
    `Sibling Dependabot PRs folded in: ${args.siblings.length === 0 ? "none"
      : args.siblings.map((s) => `#${s.prNumber} (${s.bumps.map(ownRedBumpText).join(", ")})`).join("; ")}`,
    "",
    "Dependabot proposal body:",
    "",
    args.body.trim().length > 0 ? args.body.trim() : "(empty body)",
  ].join("\n");
}

function isOwnRedRecord(r: unknown): r is DependabotOwnRedRecord {
  const o = r as DependabotOwnRedRecord | null;
  return !!o && typeof o.headSha === "string" && Array.isArray(o.bumps) && Array.isArray(o.redChecks) &&
    typeof o.firstSeenMs === "number" && typeof o.lastSeenMs === "number" &&
    (o.feedbackId === undefined || typeof o.feedbackId === "string");
}

function readOwnRedProposals(path: string): DependabotOwnRedProposal[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { proposals?: unknown } | null;
  const proposals = parsed === null || typeof parsed !== "object" ? undefined : parsed.proposals;
  if (!Array.isArray(proposals) || proposals.some((p: DependabotOwnRedProposal) =>
    !p || typeof p.feedbackId !== "string" || !Array.isArray(p.bumps) || !Array.isArray(p.prNumbers))) {
    throw new Error("invalid dependency own-red proposals; refusing to file a duplicate");
  }
  return proposals;
}

/** Siblings held own-red on their current head since this head was first seen; an unreadable one is not named. */
function ownRedSiblings(dir: string, prNumber: number, sinceMs: number): Array<{ prNumber: number; bumps: DependabotOwnRedBump[] }> {
  const siblings: Array<{ prNumber: number; bumps: DependabotOwnRedBump[] }> = [];
  for (const name of readdirSync(dir).sort()) {
    const m = /^PR(\d+)\.json$/.exec(name);
    if (!m || Number(m[1]) === prNumber) continue;
    let state: DepReviewHoldState & { ownRed?: unknown };
    try {
      state = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch (error) {
      void error; // its own dep-review pass fails on the same file
      continue;
    }
    const own = state?.ownRed;
    if (isOwnRedRecord(own) && own.headSha === state.headSha && state.heldSinceMs !== null &&
        own.feedbackId === undefined && own.lastSeenMs >= sinceMs) {
      siblings.push({ prNumber: Number(m[1]), bumps: own.bumps });
    }
  }
  return siblings;
}

export type DependabotOwnRedOutcome = "none" | "observed" | "captured" | "folded" | "proposed" | "unkeyed" | "failed";

/** Pass one records the head so held siblings register; pass two files ONE proposal; named bumps fold into it. */
export function reconcileDependabotOwnRed(args: {
  statePath: string;
  owner: string;
  repo: string;
  prUrl: string;
  prNumber: number;
  title: string;
  body: string;
  headSha: string;
  result: DepReviewResult;
  signal: DependabotOwnRedSignal | undefined;
  nowMs: number;
  capture: (args: { raw: string; submissionKey: string }) => { id: string };
  log: (step: string, extra: Record<string, unknown>) => void;
}): DependabotOwnRedOutcome {
  if (args.result.decision !== "hold" || args.result.redChecks.length === 0 || args.signal === undefined) return "none";
  const state = readRefreshState(args.statePath, args.headSha) as DepReviewHoldState & { ownRed?: unknown };
  if (state.ownRed !== undefined && !isOwnRedRecord(state.ownRed)) throw new Error("invalid dependency own-red state; refusing to file a duplicate");
  const survived = (state.refreshes ?? []).some((r) => r.delivered && r.headSha !== args.headSha && r.cause !== DEPENDABOT_STALE_EVENT_CAUSE);
  const basis = args.signal === "main-passes" ? "main-passes" : survived ? "survived-refresh" : undefined;
  if (basis === undefined) return "none";
  const bumps = parseDependabotBumpFacts(args.title, args.body)
    .map((b) => ({ dependency: b.dependency, fromVersion: b.fromVersion, toVersion: b.toVersion }));
  if (bumps.length === 0) {
    args.log("dep-review.own_red.unkeyed", { pr_number: args.prNumber, head_sha: args.headSha, red_checks: args.result.redChecks });
    return "unkeyed";
  }
  const save = () => writeAtomic(args.statePath, `${JSON.stringify(state)}\n`);
  const prior = isOwnRedRecord(state.ownRed) && state.ownRed.headSha === args.headSha ? state.ownRed : undefined;
  const record: DependabotOwnRedRecord = prior ?? { headSha: args.headSha, bumps, redChecks: args.result.redChecks, firstSeenMs: args.nowMs, lastSeenMs: args.nowMs };
  record.lastSeenMs = args.nowMs;
  record.redChecks = args.result.redChecks;
  state.ownRed = record;
  save();
  if (record.feedbackId !== undefined) return "proposed";
  if (prior === undefined) {
    args.log("dep-review.own_red.observed", { pr_number: args.prNumber, head_sha: args.headSha, basis, red_checks: args.result.redChecks });
    return "observed";
  }
  const registryPath = join(dirname(args.statePath), OWN_RED_PROPOSALS_FILE);
  const proposals = readOwnRedProposals(registryPath);
  const mine = bumps.map(ownRedBumpKey);
  const carrier = proposals.find((p) => mine.every((k) => p.bumps.includes(k)));
  if (carrier !== undefined) {
    record.feedbackId = carrier.feedbackId;
    save();
    args.log("dep-review.own_red.folded", { pr_number: args.prNumber, head_sha: args.headSha, feedback_id: carrier.feedbackId });
    return "folded";
  }
  const siblings = ownRedSiblings(dirname(args.statePath), args.prNumber, record.firstSeenMs)
    .filter((s) => !proposals.some((p) => s.bumps.every((b) => p.bumps.includes(ownRedBumpKey(b)))));
  const all = [...bumps, ...siblings.flatMap((s) => s.bumps)];
  const submissionKey = depReviewOwnRedSubmissionKey(args.owner, args.repo, all);
  const raw = renderDepReviewOwnRedFeedback({ ...args, basis, bumps, redChecks: args.result.redChecks, siblings });
  let entry: { id: string };
  try {
    entry = args.capture({ raw, submissionKey });
  } catch (error) {
    args.log("dep-review.own_red.capture_failed", {
      pr_number: args.prNumber, head_sha: args.headSha, submission_key: submissionKey, error: String((error as Error)?.message ?? error),
    });
    return "failed";
  }
  writeAtomic(registryPath, `${JSON.stringify({ proposals: [...proposals, {
    feedbackId: entry.id, submissionKey, bumps: [...new Set(all.map(ownRedBumpKey))].sort(),
    prNumbers: [args.prNumber, ...siblings.map((s) => s.prNumber)], filedAtMs: args.nowMs,
  }] })}\n`);
  record.feedbackId = entry.id;
  save();
  args.log("dep-review.own_red.feedback_captured", {
    pr_number: args.prNumber, head_sha: args.headSha, feedback_id: entry.id, submission_key: submissionKey, basis,
    red_checks: args.result.redChecks, folded_prs: siblings.map((s) => s.prNumber),
  });
  return "captured";
}


export type DependabotRefusedPathOutcome = "not-proposed" | "captured" | "folded" | "failed";

export function reconcileDependabotRefusedPath(args: {
  registryDir: string;
  owner: string;
  repo: string;
  prUrl: string;
  prNumber: number;
  title: string;
  body: string;
  headSha: string;
  author: DepReviewAuthor;
  commits: readonly DependabotHeadCommit[] | undefined;
  result: DepReviewResult;
  capture: (args: { raw: string; submissionKey: string }) => { id: string };
  nowMs: number;
  log: (step: string, extra: Record<string, unknown>) => void;
}): DependabotRefusedPathOutcome {
  const facts = { pr_number: args.prNumber, head_sha: args.headSha, offending_files: args.result.offendingFiles };
  const bumps = parseDependabotBumpFacts(args.title, args.body)
    .map((b) => ({ dependency: b.dependency, fromVersion: b.fromVersion, toVersion: b.toVersion }));
  const reason = !isDependabotAuthor(args.author) ? "non-dependabot-author"
    : headCarriesForeignCommit(args.commits) ? "foreign-commit"
      : bumps.length === 0 ? "unkeyed" : undefined;
  if (reason !== undefined) {
    args.log("dep-review.refused_path.not_proposed", { ...facts, reason });
    return "not-proposed";
  }
  const registryPath = join(args.registryDir, OWN_RED_PROPOSALS_FILE);
  const submissionKey = depReviewOwnRedSubmissionKey(args.owner, args.repo, bumps);
  try {
    const proposals = readOwnRedProposals(registryPath);
    const mine = bumps.map(ownRedBumpKey);
    const carrier = proposals.find((p) => mine.every((k) => p.bumps.includes(k)));
    if (carrier !== undefined) {
      args.log("dep-review.refused_path.folded", { ...facts, feedback_id: carrier.feedbackId });
      return "folded";
    }
    const raw = renderDepReviewOwnRedFeedback({ ...args, basis: "outside-allowlist", bumps, redChecks: args.result.redChecks,
      siblings: [], offendingFiles: args.result.offendingFiles });
    const entry = args.capture({ raw, submissionKey });
    writeAtomic(registryPath, `${JSON.stringify({ proposals: [...proposals, {
      feedbackId: entry.id, submissionKey, bumps: [...new Set(mine)].sort(), prNumbers: [args.prNumber], filedAtMs: args.nowMs,
    }] })}\n`);
    args.log("dep-review.refused_path.feedback_captured", { ...facts, feedback_id: entry.id, submission_key: submissionKey });
    return "captured";
  } catch (error) {
    args.log("dep-review.refused_path.capture_failed", { ...facts, submission_key: submissionKey, error: String((error as Error)?.message ?? error) });
    return "failed";
  }
}
