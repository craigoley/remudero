/**
 * lib/onboarding-readiness.ts — W1-T4264: A NEW REPO CANNOT BE JUDGED READY TO ONBOARD.
 *
 * `rmd onboard` (lib/onboard/{recon,inventory,synthesize,session}.ts) already answers this
 * question, but only against a LOCAL CLONE, and only from the CLI. The console's `/onboard`
 * wizard has no core endpoint at all — step 1 (`githubAppVerified`) is hard-coded false (task
 * rationale). This module answers the SAME question — is this candidate repo ready to onboard —
 * read purely through the Fleet GitHub App's API, no clone required, so the console can ask it.
 *
 * EIGHT CHECKS, EACH `{ id, status, reason, evidence? }` (task design): app-access, default
 * branch, branch protection + required checks, CI workflows, agent instructions
 * (AGENTS.md/CLAUDE.md), a detected test command, an existing plan/ layout, and whether the repo
 * is already in the fleet's one registry (W1-T4227) — never a second instance.
 *
 * UNKNOWN NEVER PASSES (task design: "A GitHub read that fails is `unknown` with the reason,
 * never pass"), and never MASQUERADES AS A CONFIRMED NEGATIVE either: {@link onboardingReadinessGateway}
 * distinguishes a definitive HTTP status (200, 404, …) — parsed from `gh api ... -i`'s header
 * block, or from the status `gh` itself reports on a non-2xx exit (`gh: Not Found (HTTP 404)`) —
 * from a genuinely unreadable call (network failure, auth failure, an unparsable body), which
 * alone degrades to `undefined` and reads as `unknown`. Mirrors `github-posture.ts`'s own
 * bare-`gh-api`-read, degrade-to-`undefined` discipline; this module is its "arbitrary candidate
 * repo, not remudero's own posture" sibling.
 */

import { ghExec, splitGhHeaderBlock } from "./github-transport.js";

// ── The report shape ────────────────────────────────────────────────────────────────────────

export type OnboardingReadinessStatus = "pass" | "warn" | "fail" | "unknown";

export type OnboardingReadinessCheckId =
  | "app-access"
  | "default-branch"
  | "branch-protection"
  | "ci-workflows"
  | "agent-instructions"
  | "test-command"
  | "plan-layout"
  | "already-onboarded";

export interface OnboardingReadinessCheck {
  id: OnboardingReadinessCheckId;
  status: OnboardingReadinessStatus;
  reason: string;
  evidence?: string;
}

export interface OnboardingReadinessReport {
  /** `owner/name`. */
  repo: string;
  checks: OnboardingReadinessCheck[];
}

function check(
  id: OnboardingReadinessCheckId,
  status: OnboardingReadinessStatus,
  reason: string,
  evidence?: string,
): OnboardingReadinessCheck {
  return evidence === undefined ? { id, status, reason } : { id, status, reason, evidence };
}

// ── The gateway: bare `gh api` reads, a definitive HTTP status kept distinct from a failed read ─

/** A definitively answered read (any HTTP status GitHub actually returned), or `undefined` for a
 *  read that could not be completed at all (network failure, auth failure, an unparsable body) —
 *  the ONLY value that ever degrades a check to `"unknown"` rather than a confirmed `fail`/`warn`
 *  built from a real 404. */
export interface OnboardingReadinessApiRead {
  status: number;
  body: unknown;
}

export interface OnboardingReadinessGateway {
  /** `GET /installation/repositories` (first page) — the repos the Fleet App's installation can
   *  see, as `owner/name`. `undefined` on a failed/unreadable read. */
  listInstallationRepos(): string[] | undefined;
  /** `GET /repos/{owner}/{repo}`. */
  getRepo(owner: string, repo: string): OnboardingReadinessApiRead | undefined;
  /** `GET /repos/{owner}/{repo}/branches/{branch}/protection`. */
  getBranchProtection(owner: string, repo: string, branch: string): OnboardingReadinessApiRead | undefined;
  /** `GET /repos/{owner}/{repo}/contents/{path}` — a file (object, base64 `content`) or a
   *  directory (array of entries); a 404 status means "confirmed absent", not a failed read. */
  getContents(owner: string, repo: string, path: string): OnboardingReadinessApiRead | undefined;
}

/** DETECTION ONLY, mirroring `github-posture.ts`'s own module header: every call below is a bare
 *  `gh api <path> -i` GET — no `-X`/`--method`/`-f`/`-F`/`--input` flag is ever passed. */
export function onboardingReadinessGateway(execFileFn: (args: string[]) => string = defaultExec): OnboardingReadinessGateway {
  function apiRead(path: string): OnboardingReadinessApiRead | undefined {
    try {
      const raw = execFileFn(["api", path, "-i"]);
      const { headers, body } = splitGhHeaderBlock(raw);
      const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d+)/.exec(headers);
      const status = statusMatch ? Number(statusMatch[1]) : 200;
      const trimmed = body.trim();
      const parsed = trimmed === "" ? undefined : safeJsonParse(trimmed);
      if (trimmed !== "" && parsed === undefined) return undefined; // 2xx with an unparsable body — read failed.
      return { status, body: parsed };
    } catch (err) {
      // `gh` exits non-zero for every non-2xx response AND for a genuine transport failure; only
      // the former names its status in the error text (`gh: Not Found (HTTP 404)`) — a definitive
      // answer this module can still classify. Anything else is truly unreadable.
      const text = `${(err as { stderr?: string | Buffer })?.stderr ?? ""} ${(err as { message?: string })?.message ?? ""}`;
      const statusMatch = /\bHTTP\s+(\d+)\b/.exec(text);
      return statusMatch ? { status: Number(statusMatch[1]), body: undefined } : undefined;
    }
  }
  return {
    listInstallationRepos: () => {
      // First page only (100 repos) — a follow-up would add `--paginate` once an installation
      // grows past it; see this module's header. `--paginate` is a GET-shaped flag, never a write.
      const read = apiRead("installation/repositories");
      if (read === undefined || read.status !== 200) return undefined;
      const repositories = (read.body as { repositories?: unknown } | undefined)?.repositories;
      if (!Array.isArray(repositories)) return undefined;
      return repositories
        .map((r) => (r as { full_name?: unknown } | null)?.full_name)
        .filter((n): n is string => typeof n === "string");
    },
    getRepo: (owner, repo) => apiRead(`repos/${owner}/${repo}`),
    getBranchProtection: (owner, repo, branch) => apiRead(`repos/${owner}/${repo}/branches/${branch}/protection`),
    getContents: (owner, repo, path) => apiRead(`repos/${owner}/${repo}/contents/${path}`),
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function defaultExec(args: string[]): string {
  return ghExec(args, { encoding: "utf8" });
}

// ── Individual checks — each reads ONLY what it needs, and each degrades to "unknown" on any ──
// ── read it could not complete, never guessing a pass from a partial answer ─────────────────────

function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function checkAppAccess(owner: string, repo: string, gateway: OnboardingReadinessGateway): OnboardingReadinessCheck {
  const target = `${owner}/${repo}`;
  const installed = gateway.listInstallationRepos();
  if (installed === undefined) {
    return check("app-access", "unknown", "could not list the Fleet GitHub App's installation repositories");
  }
  if (!installed.some((r) => sameRepo(r, target))) {
    return check(
      "app-access",
      "fail",
      `${target} is not listed among the Fleet GitHub App's installation repositories — install the app on it first`,
    );
  }
  return check("app-access", "pass", `${target} is listed in the Fleet GitHub App's installation`, `${installed.length} repos installed`);
}

function checkDefaultBranch(
  owner: string,
  repo: string,
  gateway: OnboardingReadinessGateway,
): { check: OnboardingReadinessCheck; defaultBranch?: string } {
  const read = gateway.getRepo(owner, repo);
  if (read === undefined) {
    return { check: check("default-branch", "unknown", "repo metadata read failed") };
  }
  if (read.status === 404) {
    return { check: check("default-branch", "fail", `${owner}/${repo} was not found`) };
  }
  if (read.status !== 200) {
    return { check: check("default-branch", "unknown", `repo metadata read returned HTTP ${read.status}`) };
  }
  const branch = (read.body as { default_branch?: unknown } | null)?.default_branch;
  if (typeof branch !== "string" || !branch) {
    return { check: check("default-branch", "unknown", "repo metadata carried no default_branch") };
  }
  return { check: check("default-branch", "pass", `default branch is ${branch}`, branch), defaultBranch: branch };
}

function checkBranchProtection(
  owner: string,
  repo: string,
  defaultBranch: string | undefined,
  gateway: OnboardingReadinessGateway,
): OnboardingReadinessCheck {
  if (defaultBranch === undefined) {
    return check("branch-protection", "unknown", "default branch unknown — cannot check its protection");
  }
  const read = gateway.getBranchProtection(owner, repo, defaultBranch);
  if (read === undefined) {
    return check("branch-protection", "unknown", "branch protection read failed");
  }
  if (read.status === 404) {
    return check("branch-protection", "fail", `${defaultBranch} has no branch protection configured`);
  }
  if (read.status !== 200) {
    return check("branch-protection", "unknown", `branch protection read returned HTTP ${read.status}`);
  }
  const body = read.body as { required_status_checks?: { contexts?: unknown } } | null;
  const contexts = body?.required_status_checks?.contexts;
  const requiredChecks = Array.isArray(contexts) ? contexts.filter((c): c is string => typeof c === "string") : [];
  if (requiredChecks.length === 0) {
    return check("branch-protection", "warn", `${defaultBranch} is protected but declares no required status checks`);
  }
  return check(
    "branch-protection",
    "pass",
    `${defaultBranch} is protected with ${requiredChecks.length} required status check(s)`,
    requiredChecks.join(", "),
  );
}

function checkCiWorkflows(owner: string, repo: string, gateway: OnboardingReadinessGateway): OnboardingReadinessCheck {
  const read = gateway.getContents(owner, repo, ".github/workflows");
  if (read === undefined) return check("ci-workflows", "unknown", "workflows directory read failed");
  if (read.status === 404) return check("ci-workflows", "fail", "no .github/workflows directory found");
  if (read.status !== 200) return check("ci-workflows", "unknown", `workflows directory read returned HTTP ${read.status}`);
  const entries = Array.isArray(read.body) ? read.body : [];
  const workflowFiles = entries
    .map((e) => (e as { name?: unknown } | null)?.name)
    .filter((n): n is string => typeof n === "string" && /\.ya?ml$/i.test(n));
  if (workflowFiles.length === 0) {
    return check("ci-workflows", "warn", ".github/workflows exists but declares no workflow files");
  }
  return check("ci-workflows", "pass", `${workflowFiles.length} CI workflow(s) found`, workflowFiles.join(", "));
}

function checkAgentInstructions(owner: string, repo: string, gateway: OnboardingReadinessGateway): OnboardingReadinessCheck {
  const agents = gateway.getContents(owner, repo, "AGENTS.md");
  const claude = gateway.getContents(owner, repo, "CLAUDE.md");
  const agentsPresent = agents?.status === 200;
  const claudePresent = claude?.status === 200;
  if (agentsPresent && claudePresent) return check("agent-instructions", "pass", "AGENTS.md and CLAUDE.md both present", "AGENTS.md, CLAUDE.md");
  if (agentsPresent) return check("agent-instructions", "pass", "AGENTS.md present", "AGENTS.md");
  if (claudePresent) return check("agent-instructions", "pass", "CLAUDE.md present", "CLAUDE.md");
  // Neither is present — but only a CONFIRMED absence (a real read, status !== 200, most likely
  // 404) for BOTH files lets this fall to warn; any read that never completed keeps it unknown,
  // per this module's "unknown never masquerades as a confirmed negative" rule (see file header).
  if (agents === undefined || claude === undefined) {
    return check("agent-instructions", "unknown", "AGENTS.md/CLAUDE.md read failed");
  }
  return check("agent-instructions", "warn", "no AGENTS.md or CLAUDE.md found");
}

function decodeContentsText(read: OnboardingReadinessApiRead | undefined): string | undefined {
  if (read === undefined || read.status !== 200) return undefined;
  const body = read.body as { content?: unknown; encoding?: unknown } | null;
  if (typeof body?.content !== "string") return undefined;
  try {
    return Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8").toString("utf8");
  } catch {
    return undefined;
  }
}

function checkTestCommand(owner: string, repo: string, gateway: OnboardingReadinessGateway): OnboardingReadinessCheck {
  const pkg = gateway.getContents(owner, repo, "package.json");
  const pkgText = decodeContentsText(pkg);
  if (pkgText !== undefined) {
    const parsed = safeJsonParse(pkgText) as { scripts?: { test?: unknown } } | undefined;
    const testScript = parsed?.scripts?.test;
    if (typeof testScript === "string" && testScript.trim() && !/no test specified/i.test(testScript)) {
      return check("test-command", "pass", "package.json declares an npm test script", `npm test — ${testScript}`);
    }
  }
  const makefile = gateway.getContents(owner, repo, "Makefile");
  if (makefile?.status === 200) {
    return check("test-command", "pass", "Makefile present", "make test (target not verified)");
  }
  const pyproject = gateway.getContents(owner, repo, "pyproject.toml");
  if (pyproject?.status === 200) {
    return check("test-command", "pass", "pyproject.toml present", "pytest (assumed)");
  }
  if (pkg === undefined || makefile === undefined || pyproject === undefined) {
    return check("test-command", "unknown", "one or more test-command reads failed");
  }
  return check("test-command", "warn", "no package.json test script, Makefile, or pyproject.toml found");
}

function checkPlanLayout(owner: string, repo: string, gateway: OnboardingReadinessGateway): OnboardingReadinessCheck {
  const read = gateway.getContents(owner, repo, "plan");
  if (read === undefined) return check("plan-layout", "unknown", "plan/ directory read failed");
  if (read.status === 404) return check("plan-layout", "warn", "no plan/ directory found");
  if (read.status !== 200) return check("plan-layout", "unknown", `plan/ directory read returned HTTP ${read.status}`);
  return check("plan-layout", "pass", "plan/ directory present");
}

function checkAlreadyOnboarded(owner: string, repo: string, registryRepos: readonly string[]): OnboardingReadinessCheck {
  const target = `${owner}/${repo}`;
  const already = registryRepos.some((r) => sameRepo(r, target));
  if (already) {
    return check("already-onboarded", "warn", `${target} is already onboarded in the fleet registry — do not create a second instance`, target);
  }
  return check("already-onboarded", "pass", `${target} is not yet onboarded in the fleet registry`);
}

// ── The report ──────────────────────────────────────────────────────────────────────────────

export interface OnboardingReadinessDeps {
  /** Defaults to {@link onboardingReadinessGateway}'s real `gh api` reads. */
  gateway?: OnboardingReadinessGateway;
  /** `owner/name` of every LIVE repo already in the fleet's one registry (W1-T4227,
   *  `parseInstanceRegistry(...).instances.filter(i => i.live).map(i => i.repo)`) — a plain local
   *  comparison, never a GitHub read, so an unreadable registry is the caller's concern, not this
   *  check's; an empty/absent list just reads as "not yet onboarded". */
  registryRepos?: readonly string[];
}

/**
 * `GET /v1/onboarding/readiness?repo=<owner/name>`'s answer: the eight checks above, each
 * independently `pass`/`warn`/`fail`/`unknown` with its own reason — never a single verdict that
 * hides which check said what.
 */
export function onboardingReadiness(owner: string, repo: string, deps: OnboardingReadinessDeps = {}): OnboardingReadinessReport {
  const gateway = deps.gateway ?? onboardingReadinessGateway();
  const registryRepos = deps.registryRepos ?? [];
  const { check: defaultBranchCheck, defaultBranch } = checkDefaultBranch(owner, repo, gateway);
  const checks: OnboardingReadinessCheck[] = [
    checkAppAccess(owner, repo, gateway),
    defaultBranchCheck,
    checkBranchProtection(owner, repo, defaultBranch, gateway),
    checkCiWorkflows(owner, repo, gateway),
    checkAgentInstructions(owner, repo, gateway),
    checkTestCommand(owner, repo, gateway),
    checkPlanLayout(owner, repo, gateway),
    checkAlreadyOnboarded(owner, repo, registryRepos),
  ];
  return { repo: `${owner}/${repo}`, checks };
}
