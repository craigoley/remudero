import { execFileSync } from "node:child_process";
// Imported as the module's DEFAULT export (a plain, mutable object), never as named
// bindings (`import { existsSync } from "node:fs"`) — the same W1-T115 "assert via
// injected fs" discipline src/lib/status.ts and src/lib/ledger.ts already follow (see
// status.ts's header comment for the full rationale). ESM named bindings off `node:fs`
// are non-configurable, so `t.mock.method`/`defineProperty` against them throws "Cannot
// redefine property" — a test that wants to prove "no write syscalls happened outside
// plan/onboarding/" by spying on the REAL module (rather than trusting this module's own
// injected fake) needs every call here to be a live `fs.<method>(...)` property lookup,
// never a destructured local const.
import fs from "node:fs";
import { dirname, join } from "node:path";

/**
 * `rmd onboard <target-dir> --phase inventory` — phase 1 of the four-phase `rmd onboard`
 * family (MASTER-PLAN ★P24(1), W1-T82). A DETERMINISTIC, NO-LLM repo inventory over a
 * TARGET checkout: languages, build/CI systems, docs presence, branch-protection state,
 * issue/milestone counts, test-signal presence. Everything downstream (recon, questions,
 * synthesis — W1-T83/84/85, not built here) cites this artifact; the LLM never re-derives
 * what a detector can already state.
 *
 * RULE 2 (policy as data, not code): every detector is a DATA ROW in one of the tables
 * below (`DEFAULT_LANGUAGE_DETECTORS`, `DEFAULT_BUILD_SYSTEM_DETECTORS`,
 * `DEFAULT_CI_DETECTORS`, `DEFAULT_DOC_DETECTORS`, `DEFAULT_TEST_SIGNAL_DETECTORS`), all
 * consumed by the SAME generic engine ({@link detectPresence}). Adding a new doc type or a
 * new CI system is adding a row to a table — never a new branch/if-statement in the
 * engine (the whole point of the acceptance criterion "detectors are data").
 *
 * READ-ONLY against the target checkout + `gh api` (never Octokit, matching
 * ops.ts/escalate.ts/status.ts/issues-intake.ts); the ONLY write this module performs is
 * the inventory artifact itself, at `<target-dir>/plan/onboarding/inventory.json`, staged
 * to a sibling temp file then `renameSync`'d into place (the same atomic-write idiom as
 * `writeFileAtomic` in ledger.ts / `writeDraftAttemptPair` in inbox.ts).
 *
 * UNKNOWNS ARE RECORDED AS "unknown", NEVER GUESSED: a GitHub fact this module could not
 * resolve (auth/network failure, `gh` unavailable) renders as the literal string
 * `"unknown"` in the emitted JSON for that field — never silently defaulted to `false`/`0`
 * the way issues-intake.ts's fail-soft-to-`[]` gateway does elsewhere in this repo. A 404
 * (repo not found / branch not protected) IS knowable information and is recorded as such
 * (`false`), distinct from a genuinely unresolved read.
 */

// ── Detector engine: ONE generic function, every table below is DATA ───────────────────

/** The injectable fs surface this module needs — see this file's header comment on why
 *  every call site below is a live `fs.<method>` property access, never a destructured
 *  local. Mirrors `LedgerFsDeps` in src/lib/status.ts. */
export interface OnboardFsDeps {
  existsSync: (path: string) => boolean;
  mkdirSync: (path: string, opts: { recursive: true }) => void;
  writeFileSync: (path: string, content: string) => void;
  renameSync: (from: string, to: string) => void;
}

/** Real fs deps, each call a live property lookup on the mutable `fs` default import at
 *  call time (never captured to a local const) — mirrors `realLedgerFs` in status.ts. */
export const realOnboardFsDeps: OnboardFsDeps = {
  existsSync: (path) => fs.existsSync(path),
  mkdirSync: (path, opts) => {
    fs.mkdirSync(path, opts);
  },
  writeFileSync: (path, content) => {
    fs.writeFileSync(path, content, "utf8");
  },
  renameSync: (from, to) => {
    fs.renameSync(from, to);
  },
};

/**
 * One detector: a stable `id` (the JSON key / array entry it produces) plus a list of
 * paths RELATIVE to the target checkout's root — ANY existing candidate is a hit. This is
 * deliberately the simplest data shape that still reads as "a row, not a branch": no glob
 * engine, no match-mode enum, just "does one of these paths exist". Good enough for every
 * detector this phase needs (manifest files, config files, and directories alike — a
 * directory candidate like `.github/workflows` is checked with the same `existsSync`).
 */
export interface PresenceDetector {
  readonly id: string;
  readonly candidates: readonly string[];
}

/**
 * THE engine every detector table below runs through. Adding a detector never touches this
 * function — it is exercised by every one of languages/build-systems/CI/docs/test-signals,
 * and by a CALLER's own extra row passed in via {@link OnboardDetectorTables} (this is what
 * makes acceptance criterion 2 — "a new doc-type row detects without code changes" —
 * provable: a test builds `[...DEFAULT_DOC_DETECTORS, extraRow]` and passes it straight
 * through here).
 */
export function detectPresence(targetDir: string, fsDeps: OnboardFsDeps, detectors: readonly PresenceDetector[]): string[] {
  const hits: string[] = [];
  for (const detector of detectors) {
    if (detector.candidates.some((candidate) => fsDeps.existsSync(join(targetDir, candidate)))) {
      hits.push(detector.id);
    }
  }
  return hits;
}

// ── Detector tables (policy as data) ────────────────────────────────────────────────────

/** Language signals — root-level manifest/config files. Deliberately manifest-based (no
 *  tree walk / glob): a repo either declares itself in one of these ecosystems at its
 *  root or this phase 1 pass honestly reports it did not detect one — the LLM-driven recon
 *  phase (W1-T83) is where a deeper, non-deterministic read belongs, not here. */
export const DEFAULT_LANGUAGE_DETECTORS: readonly PresenceDetector[] = [
  { id: "typescript", candidates: ["tsconfig.json"] },
  { id: "node", candidates: ["package.json"] },
  { id: "python", candidates: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"] },
  { id: "go", candidates: ["go.mod"] },
  { id: "rust", candidates: ["Cargo.toml"] },
  { id: "java", candidates: ["pom.xml", "build.gradle", "build.gradle.kts"] },
  // NOTE: no single top-level filename names a .NET project the way tsconfig.json/go.mod
  // do — project/solution files carry an arbitrary name (`*.csproj`/`*.sln`), which this
  // phase's exact-filename-only matching (no glob engine, see PresenceDetector's doc
  // comment) cannot express. These are the closest-to-universal REPO-root markers that
  // are still dotnet-specific (unlike `.editorconfig`, which is ecosystem-agnostic and
  // would false-positive on any repo that happens to carry one).
  { id: "dotnet", candidates: ["global.json", "Directory.Build.props", "nuget.config", "NuGet.Config"] },
];

/** Build/dependency-manager systems — same manifest signal as languages, a distinct table
 *  because "build system" and "language" are different questions a downstream consumer may
 *  ask independently (e.g. a repo could be TypeScript over either npm or a different
 *  package manager lockfile). */
export const DEFAULT_BUILD_SYSTEM_DETECTORS: readonly PresenceDetector[] = [
  { id: "npm", candidates: ["package.json"] },
  { id: "pip", candidates: ["requirements.txt", "pyproject.toml", "setup.py"] },
  { id: "cargo", candidates: ["Cargo.toml"] },
  { id: "go-modules", candidates: ["go.mod"] },
  { id: "maven", candidates: ["pom.xml"] },
  { id: "gradle", candidates: ["build.gradle", "build.gradle.kts"] },
];

/** CI systems. */
export const DEFAULT_CI_DETECTORS: readonly PresenceDetector[] = [
  { id: "github-actions", candidates: [".github/workflows"] },
  { id: "circleci", candidates: [".circleci/config.yml"] },
  { id: "gitlab-ci", candidates: [".gitlab-ci.yml"] },
  { id: "travis", candidates: [".travis.yml"] },
  { id: "jenkins", candidates: ["Jenkinsfile"] },
  { id: "azure-pipelines", candidates: ["azure-pipelines.yml"] },
];

/** Docs presence — README, CONTRIBUTING, AGENTS.md, CLAUDE.md, ADRs, ROADMAP, TODO (the
 *  exact set MASTER-PLAN P24(1) names). Rendered in the inventory as `{id: boolean}`, not
 *  just a hit list, so every named doc type is always a visible key even when absent. */
export const DEFAULT_DOC_DETECTORS: readonly PresenceDetector[] = [
  { id: "readme", candidates: ["README.md", "README", "Readme.md", "readme.md"] },
  { id: "contributing", candidates: ["CONTRIBUTING.md", "CONTRIBUTING"] },
  { id: "agentsMd", candidates: ["AGENTS.md"] },
  { id: "claudeMd", candidates: ["CLAUDE.md"] },
  { id: "adrs", candidates: ["docs/adr", "docs/adrs", "doc/adr", "adr", "ADRs"] },
  { id: "roadmap", candidates: ["ROADMAP.md", "ROADMAP"] },
  { id: "todo", candidates: ["TODO.md", "TODO"] },
];

/** Test-signal presence — a test directory, or a known test-runner config file. */
export const DEFAULT_TEST_SIGNAL_DETECTORS: readonly PresenceDetector[] = [
  { id: "test-directory", candidates: ["test", "tests", "__tests__", "spec"] },
  { id: "jest-config", candidates: ["jest.config.js", "jest.config.ts", "jest.config.cjs", "jest.config.mjs"] },
  { id: "vitest-config", candidates: ["vitest.config.ts", "vitest.config.js"] },
  { id: "pytest-config", candidates: ["pytest.ini", "tox.ini"] },
  { id: "mocha-config", candidates: [".mocharc.json", ".mocharc.js", ".mocharc.yml", ".mocharc.yaml"] },
];

/** The full set of detector tables {@link buildInventory} runs — bundled so a caller can
 *  override just ONE table (e.g. `{ ...DEFAULT_DETECTOR_TABLES, docs: [...DEFAULT_DOC_DETECTORS, extraRow] }`)
 *  via the existing injectable parameter, without touching the engine. */
export interface OnboardDetectorTables {
  languages: readonly PresenceDetector[];
  buildSystems: readonly PresenceDetector[];
  ci: readonly PresenceDetector[];
  docs: readonly PresenceDetector[];
  testSignals: readonly PresenceDetector[];
}

export const DEFAULT_DETECTOR_TABLES: OnboardDetectorTables = {
  languages: DEFAULT_LANGUAGE_DETECTORS,
  buildSystems: DEFAULT_BUILD_SYSTEM_DETECTORS,
  ci: DEFAULT_CI_DETECTORS,
  docs: DEFAULT_DOC_DETECTORS,
  testSignals: DEFAULT_TEST_SIGNAL_DETECTORS,
};

// ── GitHub gateway: `gh api`, unknowns recorded honestly (never guessed) ────────────────

/** A GitHub-derived fact that is either resolved (`known: true`) or genuinely could not be
 *  read (`known: false` — auth/network/rate-limit/`gh` missing). Distinct from a 404,
 *  which IS knowable information (e.g. "not protected") and renders `known: true`. */
export type Known<T> = { known: true; value: T } | { known: false };

export interface RepoExistenceInfo {
  exists: boolean;
  /** Only meaningful when `exists` — the repo's default branch. */
  defaultBranch: string;
}

export interface OnboardGhGateway {
  repoInfo(owner: string, repo: string): Known<RepoExistenceInfo>;
  /** `true` = branch protection is configured on `branch`; a 404 is knowable ("not
   *  protected") and returns `known: true, value: false`, never `known: false`. */
  branchProtection(owner: string, repo: string, branch: string): Known<boolean>;
  openIssueCount(owner: string, repo: string): Known<number>;
  milestoneCount(owner: string, repo: string): Known<number>;
}

/** Injectable stand-in for the raw `gh api <args>` invocation — mirrors `opts.exec` on
 *  `ghGateway()` in status.ts (W1-T119): real callers omit it and get the actual
 *  `execFileSync("gh", ["api", ...args], ...)` call; unit tests inject a fake that returns
 *  canned JSON or throws a `{stderr}`-shaped error to exercise the 404-vs-unknown split
 *  deterministically, WITHOUT shelling out to a real `gh` binary or hitting the network. */
export type GhExec = (args: string[]) => string;

const defaultGhExec: GhExec = (args) => execFileSync("gh", ["api", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** `gh api <args>` -> parsed JSON, classifying the failure mode (HTTP status parsed off
 *  `gh`'s own "gh: <message> (HTTP <code>)" stderr format when present) so callers can
 *  tell a genuine 404 (knowable) apart from anything else (unknown). */
function ghApiJson<T>(args: string[], exec: GhExec): { ok: true; value: T } | { ok: false; httpStatus?: number } {
  try {
    const raw = exec(args);
    return { ok: true, value: JSON.parse(raw) as T };
  } catch (e) {
    const err = e as { stderr?: unknown; message?: string };
    const stderr = typeof err.stderr === "string" ? err.stderr : String(err.stderr ?? err.message ?? e);
    const m = stderr.match(/HTTP (\d+)/);
    return { ok: false, httpStatus: m ? Number(m[1]) : undefined };
  }
}

function ghRepoInfo(owner: string, repo: string, exec: GhExec): Known<RepoExistenceInfo> {
  const r = ghApiJson<{ default_branch?: string }>([`repos/${owner}/${repo}`], exec);
  if (r.ok) return { known: true, value: { exists: true, defaultBranch: r.value.default_branch ?? "main" } };
  if (r.httpStatus === 404) return { known: true, value: { exists: false, defaultBranch: "" } };
  return { known: false };
}

function ghBranchProtection(owner: string, repo: string, branch: string, exec: GhExec): Known<boolean> {
  const r = ghApiJson<unknown>([`repos/${owner}/${repo}/branches/${branch}/protection`], exec);
  if (r.ok) return { known: true, value: true };
  if (r.httpStatus === 404) return { known: true, value: false };
  return { known: false };
}

/** GitHub's issues-list endpoint returns pull requests too; filtered out exactly like
 *  issues-intake.ts's `normalizeIssue`/`ghIssueListGateway` (presence of `pull_request`
 *  regardless of value is the documented way to tell them apart). */
function ghOpenIssueCount(owner: string, repo: string, exec: GhExec): Known<number> {
  try {
    const raw = exec([`repos/${owner}/${repo}/issues?state=open`, "--paginate"]);
    const parsed = JSON.parse(raw) as unknown;
    const arr = Array.isArray(parsed) ? (parsed as Array<{ pull_request?: unknown }>) : [];
    return { known: true, value: arr.filter((i) => i.pull_request === undefined).length };
  } catch {
    return { known: false };
  }
}

function ghMilestoneCount(owner: string, repo: string, exec: GhExec): Known<number> {
  try {
    const raw = exec([`repos/${owner}/${repo}/milestones`, "--paginate"]);
    const parsed = JSON.parse(raw) as unknown;
    return { known: true, value: Array.isArray(parsed) ? parsed.length : 0 };
  } catch {
    return { known: false };
  }
}

/** Real gateway — `gh api`, never Octokit (matches ops.ts/escalate.ts/status.ts/issues-intake.ts).
 *  `opts.exec` is the same injectable seam as {@link GhExec} above — real callers omit it. */
export function realOnboardGhGateway(opts: { exec?: GhExec } = {}): OnboardGhGateway {
  const exec = opts.exec ?? defaultGhExec;
  return {
    repoInfo: (owner, repo) => ghRepoInfo(owner, repo, exec),
    branchProtection: (owner, repo, branch) => ghBranchProtection(owner, repo, branch, exec),
    openIssueCount: (owner, repo) => ghOpenIssueCount(owner, repo, exec),
    milestoneCount: (owner, repo) => ghMilestoneCount(owner, repo, exec),
  };
}

// ── GitHub-derived facts, folded into the inventory ─────────────────────────────────────

export interface GithubFacts {
  repoExists: boolean | "unknown";
  defaultBranch: string | "unknown";
  branchProtected: boolean | "unknown";
  openIssueCount: number | "unknown";
  milestoneCount: number | "unknown";
}

/** Every field defaults to the literal `"unknown"` and is only ever upgraded to a real
 *  value on a RESOLVED read — never guessed, never silently zeroed. `branchProtected` is
 *  left `"unknown"` when the default branch itself could not be resolved (nothing to ask
 *  the protection endpoint about). `openIssueCount`/`milestoneCount` are independent of
 *  the default branch and are always attempted when owner/repo are known. */
function buildGithubFacts(owner: string | undefined, repo: string | undefined, gh: OnboardGhGateway): GithubFacts {
  if (!owner || !repo) {
    return { repoExists: "unknown", defaultBranch: "unknown", branchProtected: "unknown", openIssueCount: "unknown", milestoneCount: "unknown" };
  }

  const info = gh.repoInfo(owner, repo);
  const repoExists: boolean | "unknown" = info.known ? info.value.exists : "unknown";
  const defaultBranch: string | "unknown" = info.known && info.value.exists ? info.value.defaultBranch : "unknown";

  let branchProtected: boolean | "unknown" = "unknown";
  if (info.known && info.value.exists) {
    const prot = gh.branchProtection(owner, repo, info.value.defaultBranch);
    branchProtected = prot.known ? prot.value : "unknown";
  }

  const issues = gh.openIssueCount(owner, repo);
  const openIssueCount: number | "unknown" = issues.known ? issues.value : "unknown";

  const milestones = gh.milestoneCount(owner, repo);
  const milestoneCount: number | "unknown" = milestones.known ? milestones.value : "unknown";

  return { repoExists, defaultBranch, branchProtected, openIssueCount, milestoneCount };
}

// ── owner/repo resolution — pure, path-parameterized (generalizes run-task.ts's
// resolveOwnerRepo(), which is hardcoded to THIS checkout's own repoRoot) ───────────────

/** Same regex `resolveOwnerRepo()` in run-task.ts uses, lifted here (pure, testable
 *  without a real git remote) so both an arbitrary TARGET checkout (this module) and
 *  remudero's own checkout (run-task.ts) share one implementation of "parse owner/repo out
 *  of a `git remote.origin.url` value" without src/lib importing run-task.ts (forbidden by
 *  `.dependency-cruiser.cjs`'s `lib-no-spike-or-cli` rule) or vice versa creating a second
 *  copy that could drift. */
export function parseOwnerRepoFromRemoteUrl(url: string): { owner: string; repo: string } | undefined {
  const m = url.trim().match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) return undefined;
  return { owner: m[1]!, repo: m[2]! };
}

/** Injectable git-remote reader — a caller can fake `getRemoteUrl` to test
 *  {@link resolveTargetOwnerRepo} without a real git repo on disk. */
export interface GitRemoteDeps {
  getRemoteUrl(targetDir: string): string;
}

export const realGitRemoteDeps: GitRemoteDeps = {
  getRemoteUrl: (targetDir) => execFileSync("git", ["-C", targetDir, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim(),
};

/** Resolve owner/repo from the TARGET checkout's own `git remote.origin.url` —
 *  `undefined` (never guessed) if the read fails or the URL doesn't parse. */
export function resolveTargetOwnerRepo(targetDir: string, deps: GitRemoteDeps = realGitRemoteDeps): { owner: string; repo: string } | undefined {
  try {
    return parseOwnerRepoFromRemoteUrl(deps.getRemoteUrl(targetDir));
  } catch {
    return undefined;
  }
}

// ── The inventory itself ────────────────────────────────────────────────────────────────

export interface Inventory {
  generatedAt: string;
  target: { owner: string | "unknown"; repo: string | "unknown" };
  languages: string[];
  buildSystems: string[];
  ciSystems: string[];
  docs: Record<string, boolean>;
  testSignals: string[];
  github: GithubFacts;
}

export interface OnboardInventoryDeps {
  fs: OnboardFsDeps;
  gh: OnboardGhGateway;
  /** Injectable clock — defaults to the real time; tests fix it for a byte-stable `generatedAt`. */
  now?: () => Date;
}

/**
 * PURE(ish) builder: given a target checkout dir, an owner/repo (or `undefined` to leave
 * every GitHub fact `"unknown"`), and injected fs/gh deps, produce the {@link Inventory}
 * object. No writes — {@link runOnboardInventory} is the thin wrapper that also persists
 * it. `detectorTables` defaults to {@link DEFAULT_DETECTOR_TABLES}; a caller overriding one
 * table (e.g. adding an extra doc-type row) proves the engine is generic over the table,
 * never special-cased (acceptance criterion 2).
 */
export function buildInventory(
  targetDir: string,
  ownerRepo: { owner?: string; repo?: string },
  deps: OnboardInventoryDeps,
  detectorTables: OnboardDetectorTables = DEFAULT_DETECTOR_TABLES,
): Inventory {
  const now = deps.now ? deps.now() : new Date();

  const languages = detectPresence(targetDir, deps.fs, detectorTables.languages);
  const buildSystems = detectPresence(targetDir, deps.fs, detectorTables.buildSystems);
  const ciSystems = detectPresence(targetDir, deps.fs, detectorTables.ci);
  const docHits = detectPresence(targetDir, deps.fs, detectorTables.docs);
  const docs = Object.fromEntries(detectorTables.docs.map((d) => [d.id, docHits.includes(d.id)]));
  const testSignals = detectPresence(targetDir, deps.fs, detectorTables.testSignals);
  const github = buildGithubFacts(ownerRepo.owner, ownerRepo.repo, deps.gh);

  return {
    generatedAt: now.toISOString(),
    target: { owner: ownerRepo.owner ?? "unknown", repo: ownerRepo.repo ?? "unknown" },
    languages,
    buildSystems,
    ciSystems,
    docs,
    testSignals,
    github,
  };
}

export interface OnboardInventoryResult {
  inventory: Inventory;
  /** Absolute path the artifact was written to — always `<targetDir>/plan/onboarding/inventory.json`. */
  writtenPath: string;
}

/** Sibling-temp-file + `renameSync` atomic write (mirrors `writeFileAtomic` in
 *  src/lib/ledger.ts / `writeDraftAttemptPair` in src/lib/inbox.ts) — a reader never
 *  observes a partial/truncated inventory.json. */
function writeInventoryAtomic(fsDeps: OnboardFsDeps, path: string, content: string): void {
  fsDeps.mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  fsDeps.writeFileSync(tmpPath, content);
  fsDeps.renameSync(tmpPath, path);
}

/**
 * Build the inventory ({@link buildInventory}) and write it, ATOMICALLY, to exactly one
 * path: `<targetDir>/plan/onboarding/inventory.json`. This is the ONLY write this whole
 * module performs — acceptance criterion 3 ("the phase is read-only against the target")
 * is a write-spy proving zero writes land anywhere else.
 */
export function runOnboardInventory(
  targetDir: string,
  ownerRepo: { owner?: string; repo?: string },
  deps: OnboardInventoryDeps,
  detectorTables: OnboardDetectorTables = DEFAULT_DETECTOR_TABLES,
): OnboardInventoryResult {
  // Fail loud BEFORE any detection/gh/write work if the target checkout doesn't exist —
  // otherwise a typo'd path would silently `mkdir -p` a brand-new, empty directory tree
  // (writeInventoryAtomic's `mkdirSync(..., {recursive: true})` creates every missing
  // parent) and report every detector as absent / every GitHub fact "unknown", which reads
  // as "I inspected your repo and found nothing" rather than the truth ("there was no repo
  // here to inspect"). Mirrors the control-surface-fail-loud-stop-one-shot discipline
  // (Standing rule / LEARNINGS.md) `parseProjectInitArgs` already applies at the CLI layer.
  if (!deps.fs.existsSync(targetDir)) {
    throw new OnboardError(`rmd onboard: target directory "${targetDir}" does not exist`);
  }
  const inventory = buildInventory(targetDir, ownerRepo, deps, detectorTables);
  const writtenPath = join(targetDir, "plan", "onboarding", "inventory.json");
  writeInventoryAtomic(deps.fs, writtenPath, JSON.stringify(inventory, null, 2) + "\n");
  return { inventory, writtenPath };
}

// ── CLI arg parsing (pure — the thin `rmd onboard` CLI wrapper in run-task.ts delegates
// here, mirroring project-init.ts's parseProjectInitArgs) ───────────────────────────────

/** Phase 1 (`inventory`) is the only phase this task implements. Phases 2-4 (recon,
 *  session, synthesis — W1-T83/84/85) are separate, not-yet-built future tasks; naming
 *  them here as NOT-yet-valid values (rather than silently accepting them) is what makes
 *  an unknown `--phase` fail loud instead of quietly no-op'ing. */
export const KNOWN_ONBOARD_PHASES = ["inventory"] as const;
export type OnboardPhase = (typeof KNOWN_ONBOARD_PHASES)[number];

/** Thrown on a bad `--phase` value, or by {@link parseOnboardArgs} on any malformed CLI
 *  input — the `rmd onboard` analogue of project-init.ts's `ProjectInitError`. */
export class OnboardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnboardError";
  }
}

function parsePhaseFlag(raw: string | undefined): OnboardPhase {
  if (raw === undefined) {
    throw new OnboardError(
      `--phase is required — one of ${KNOWN_ONBOARD_PHASES.join(", ")} ` +
        `(only "inventory" is implemented today; recon/session/synthesis are W1-T83/84/85, not yet built)`,
    );
  }
  if ((KNOWN_ONBOARD_PHASES as readonly string[]).includes(raw)) return raw as OnboardPhase;
  throw new OnboardError(
    `--phase must be one of ${KNOWN_ONBOARD_PHASES.join(", ")}; got "${raw}" ` +
      `(recon/session/synthesis are W1-T83/84/85, not yet built)`,
  );
}

export interface ParsedOnboardArgs {
  targetDir: string;
  phase: OnboardPhase;
  owner?: string;
  repo?: string;
}

export type ParseOnboardArgsResult = { ok: true; args: ParsedOnboardArgs } | { ok: false; error: string };

/** `--flag value` lookup over a raw argv tail. Local copy of run-task.ts's `flagValue`
 *  (see project-init.ts's identical copy for why: this module must not import
 *  run-task.ts, `.dependency-cruiser.cjs`'s `lib-no-spike-or-cli` rule). */
function flagValue(rest: string[], flag: string): string | undefined {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : undefined;
}

const ONBOARD_VALUE_FLAGS = ["--phase", "--owner", "--repo"];

/**
 * Parse+validate `rmd onboard <target-dir> --phase <phase> [--owner <o> --repo <r>]`'s
 * argv tail. FAIL LOUD, BEFORE ANY WORK (Standing rule / LEARNINGS.md
 * control-surface-fail-loud-stop-one-shot — the same discipline `parseProjectInitArgs`
 * already applies): a missing `<target-dir>`, an unrecognized flag, or a missing/unknown
 * `--phase` is rejected here, before `buildInventory`/`runOnboardInventory` ever runs.
 */
export function parseOnboardArgs(rest: string[]): ParseOnboardArgsResult {
  const targetDir = rest[0];
  if (!targetDir || targetDir.startsWith("--")) {
    return { ok: false, error: "rmd onboard: <target-dir> is required as the first positional argument" };
  }

  const tail = rest.slice(1);
  for (let i = 0; i < tail.length; i++) {
    const tok = tail[i]!;
    if (ONBOARD_VALUE_FLAGS.includes(tok)) {
      i++; // skip its value
      continue;
    }
    return { ok: false, error: `rmd onboard: unrecognized argument '${tok}'` };
  }

  let phase: OnboardPhase;
  try {
    phase = parsePhaseFlag(flagValue(tail, "--phase"));
  } catch (e) {
    return { ok: false, error: e instanceof OnboardError ? e.message : String(e) };
  }

  return {
    ok: true,
    args: { targetDir, phase, owner: flagValue(tail, "--owner"), repo: flagValue(tail, "--repo") },
  };
}
