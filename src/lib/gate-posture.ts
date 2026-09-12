import {
  runRiskJudge,
  type RiskJudgeInput,
  type RiskJudgeOrchestratorDeps,
  type RiskJudgeResult,
  type RiskJudgeSpendCollector,
} from "./risk-judge.js";
import type { RiskJudgeCache, RiskJudgeGateConsequence } from "./risk-judge.js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";

export type GatePostureOutcome = RiskJudgeGateConsequence;
export type GatePostureRecoverability = "recoverable" | "unrecoverable";

export interface GatePostureFinding {
  gate: string;
  finding: string;
  evidence?: readonly string[];
  recoverability: GatePostureRecoverability;
  currentConsequence: GatePostureOutcome;
}

export interface GatePostureInput {
  finding?: GatePostureFinding;
  change?: RiskJudgeInput["change"];
  planContext?: RiskJudgeInput["planContext"];
  gatesState?: RiskJudgeInput["gatesState"];
  prNumber?: number;
  headSha?: string;
}

export interface GatePostureDecision {
  outcome: GatePostureOutcome;
  reason: string;
  judgmentSpawned: boolean;
  fallback: boolean;
  finding?: GatePostureFinding;
  verdict?: RiskJudgeResult["verdict"];
  action?: RiskJudgeResult["action"];
  debtUrl?: string;
  repairResult?: string;
}

export interface GatePostureRuntime {
  runRiskJudge?: typeof runRiskJudge;
  judge?: RiskJudgeOrchestratorDeps["judge"];
  cache?: RiskJudgeCache;
  spend?: RiskJudgeSpendCollector;
  log?: (step: string, extra?: Record<string, unknown>) => void;
  fileDebt?: (finding: GatePostureFinding, judgment: RiskJudgeResult) => Promise<string | undefined> | string | undefined;
  repair?: (finding: GatePostureFinding, judgment: RiskJudgeResult) => Promise<string | undefined> | string | undefined;
}

export function buildGatePostureRiskJudgeInput(input: Required<Pick<GatePostureInput, "finding">> & GatePostureInput): RiskJudgeInput {
  const finding = input.finding;
  return {
    change: input.change ?? { description: `gate ${finding.gate} produced a deterministic finding` },
    gatesState: {
      ...(input.gatesState ?? {}),
      gate_finding: {
        gate: finding.gate,
        finding: finding.finding,
        ...(finding.evidence === undefined ? {} : { evidence: [...finding.evidence] }),
        recoverability: finding.recoverability,
        current_consequence: finding.currentConsequence,
      },
    },
    planContext: input.planContext ?? {},
    ...(input.prNumber === undefined ? {} : { prNumber: input.prNumber }),
    ...(input.headSha === undefined ? {} : { headSha: input.headSha }),
  };
}

function fallbackDecision(finding: GatePostureFinding, reason: string, judgment?: RiskJudgeResult): GatePostureDecision {
  return {
    outcome: finding.currentConsequence,
    reason,
    judgmentSpawned: true,
    fallback: true,
    finding,
    ...(judgment === undefined ? {} : { verdict: judgment.verdict, action: judgment.action }),
  };
}

function logDecision(
  deps: GatePostureRuntime,
  finding: GatePostureFinding,
  decision: GatePostureDecision,
): GatePostureDecision {
  deps.log?.("gate_posture.decision", {
    gate: finding.gate,
    finding: finding.finding,
    consequence: decision.outcome,
    fallback: decision.fallback,
    reason: decision.reason,
    ...(decision.verdict === undefined
      ? {}
      : {
          verdict: decision.verdict.verdict,
          reasons: decision.verdict.reasons,
          confidence: decision.verdict.confidence,
        }),
    ...(decision.debtUrl === undefined ? {} : { debt_url: decision.debtUrl }),
    ...(decision.repairResult === undefined ? {} : { repair_result: decision.repairResult }),
  });
  return decision;
}

async function applyConsequence(
  consequence: GatePostureOutcome,
  finding: GatePostureFinding,
  judgment: RiskJudgeResult,
  deps: GatePostureRuntime,
): Promise<GatePostureDecision> {
  if (consequence === "REPAIR") {
    const repairResult = await deps.repair?.(finding, judgment);
    return {
      outcome: "REPAIR",
      reason: repairResult === undefined ? judgment.action.reason : repairResult,
      judgmentSpawned: true,
      fallback: false,
      finding,
      verdict: judgment.verdict,
      action: judgment.action,
      ...(repairResult === undefined ? {} : { repairResult }),
    };
  }

  if (consequence === "LAND+DEBT") {
    const debtUrl = await deps.fileDebt?.(finding, judgment);
    if (debtUrl === undefined) {
      return fallbackDecision(finding, "LAND+DEBT could not file its follow-up, so the gate's current behaviour is restored", judgment);
    }
    return {
      outcome: "LAND+DEBT",
      reason: `${judgment.action.reason}; follow-up filed: ${debtUrl}`,
      judgmentSpawned: true,
      fallback: false,
      finding,
      verdict: judgment.verdict,
      action: judgment.action,
      debtUrl,
    };
  }

  return {
    outcome: consequence,
    reason: judgment.action.reason,
    judgmentSpawned: true,
    fallback: false,
    finding,
    verdict: judgment.verdict,
    action: judgment.action,
  };
}

export async function decideGatePosture(input: GatePostureInput, deps: GatePostureRuntime = {}): Promise<GatePostureDecision> {
  const finding = input.finding;
  if (finding === undefined) {
    return {
      outcome: "LAND",
      reason: "no deterministic gate finding",
      judgmentSpawned: false,
      fallback: false,
    };
  }

  const runner = deps.runRiskJudge ?? runRiskJudge;
  let judgment: RiskJudgeResult;
  try {
    judgment = await runner(buildGatePostureRiskJudgeInput({ ...input, finding }), {
      judge:
        deps.judge ??
        (async () => {
          throw new Error("gate posture judge dependency was not supplied");
        }),
      escalate: () => "gate-posture://escalated",
      cache: deps.cache,
      spend: deps.spend,
      log: deps.log,
    });
  } catch (err) {
    const reason = `risk judge unavailable (${err instanceof Error ? err.message : String(err)}) — restoring current gate behaviour`;
    deps.log?.("gate_posture.judge_unavailable", { gate: finding.gate, reason });
    return logDecision(
      deps,
      finding,
      fallbackDecision(finding, reason),
    );
  }

  const consequence = judgment.verdict.gateConsequence;
  if (consequence === undefined) {
    return logDecision(deps, finding, fallbackDecision(finding, "no parseable gate consequence — restoring current gate behaviour", judgment));
  }

  const effectiveConsequence =
    consequence === "STOP" && finding.recoverability !== "unrecoverable" ? "LAND+DEBT" : consequence;
  const decision = await applyConsequence(effectiveConsequence, finding, judgment, deps);
  const reason =
    consequence === "STOP" && effectiveConsequence === "LAND+DEBT"
      ? `STOP requires an unrecoverable finding; ${decision.reason}`
      : decision.reason;
  return logDecision(deps, finding, { ...decision, reason });
}

+export type GatePosture = "REPAIR" | "ROUTE" | "CLOSE";

export type GateSurfaceKind = "refusal" | "state" | "task-stop";

export interface GateSurface {
  id: string;
  kind: GateSurfaceKind;
  path: string;
  name: string;
  evidence: string;
}

export interface GatePostureDeclaration {
  posture: GatePosture;
  complies: boolean;
  reason: string;
}

export interface GatePostureRow extends GateSurface {
  declaration?: GatePostureDeclaration;
}

export interface GatePostureCensus {
  rows: GatePostureRow[];
  missingDeclarations: string[];
  staleDeclarations: string[];
}

export type GatePostureTree = Readonly<Record<string, string>>;

const HOOK_PREFIX = "hooks/";
export const SCRIPT_RE = /^scripts\/[^/]+-(?:check|ratchet)\.mjs$/;
export const NON_ZERO_RE = /\bexit\s+[1-9]\b|process\.exit(?:Code\s*=\s*[1-9]|\(\s*[1-9])|throw new Error\b|\bdeny\(/;
export const REFUSAL_LANGUAGE_RE = /\b(blocked|blocks|refus(?:e|es|ed|ing)|ratchet|gate|violation|failed|failure)\b/i;

function uniqById(surfaces: GateSurface[]): GateSurface[] {
  const seen = new Set<string>();
  const out: GateSurface[] = [];
  for (const surface of surfaces) {
    if (seen.has(surface.id)) continue;
    seen.add(surface.id);
    out.push(surface);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function hookHasRefusal(text: string): boolean {
  return NON_ZERO_RE.test(text) && REFUSAL_LANGUAGE_RE.test(text);
}

function scriptHasRefusal(text: string): boolean {
  if (!NON_ZERO_RE.test(text)) return false;
  if (/\bUsage:/i.test(text) && !/\b(blocked|blocks|refus(?:e|es|ed|ing)|gate|violation|failed|failure)\b/i.test(text)) {
    return false;
  }
  if (REFUSAL_LANGUAGE_RE.test(text)) return true;
  return !/\bUsage:/i.test(text);
}

function ciJobNames(text: string): string[] {
  const parsed = parseYaml(text) as { jobs?: unknown } | null;
  if (!parsed || typeof parsed.jobs !== "object" || Array.isArray(parsed.jobs)) return [];
  return Object.keys(parsed.jobs as Record<string, unknown>).sort();
}

function pushIfContains(
  out: GateSurface[],
  tree: GatePostureTree,
  path: string,
  needle: string,
  surface: Omit<GateSurface, "path">,
): void {
  const text = tree[path];
  if (text?.includes(needle)) out.push({ ...surface, path });
}

export function deriveGateSurfaces(tree: GatePostureTree): GateSurface[] {
  const out: GateSurface[] = [];

  for (const [path, text] of Object.entries(tree)) {
    if (path.startsWith(HOOK_PREFIX) && !path.slice(HOOK_PREFIX.length).includes("/") && hookHasRefusal(text)) {
      out.push({
        id: `hook:${path}`,
        kind: "refusal",
        path,
        name: path,
        evidence: "hook exits non-zero with blocking/refusal language",
      });
    }

    if (SCRIPT_RE.test(path) && scriptHasRefusal(text)) {
      out.push({
        id: `script:${path}`,
        kind: "refusal",
        path,
        name: path,
        evidence: "check/ratchet script has a non-zero refusal path",
      });
    }
  }

  const ciText = tree[".github/workflows/ci.yml"];
  if (ciText) {
    for (const job of ciJobNames(ciText)) {
      out.push({
        id: `ci:${job}`,
        kind: "refusal",
        path: ".github/workflows/ci.yml",
        name: job,
        evidence: "ci.yml job can refuse the pull request",
      });
    }
  }

  pushIfContains(out, tree, "src/lib/drain.ts", "already-merged", {
    id: "state:dispatch-filter:already-merged",
    kind: "state",
    name: "already-merged dispatch filter",
    evidence: "dispatch eligibility can mark a task already credited",
  });
  pushIfContains(out, tree, "src/lib/drain.ts", "head-ref", {
    id: "state:credit-path:head-ref",
    kind: "state",
    name: "run-<taskId>-<epochMs> head-ref credit",
    evidence: "head branch credit can remove a task from dispatch",
  });
  pushIfContains(out, tree, "src/lib/drain.ts", "trailer", {
    id: "state:credit-path:trailer",
    kind: "state",
    name: "Remudero-Task trailer credit",
    evidence: "trailer credit can remove a task from dispatch",
  });
  pushIfContains(out, tree, "src/lib/correct.ts", "actual_pr_url", {
    id: "state:correction:actual-pr-url",
    kind: "state",
    name: "rmd correct actual_pr_url correction",
    evidence: "correction writes a replacement PR URL, not a false-credit reversal",
  });

  pushIfContains(out, tree, "src/lib/drain.ts", "verify-not-auto", {
    id: "task-stop:verify-not-auto",
    kind: "task-stop",
    name: "verify: human dispatch park",
    evidence: "dispatch eligibility parks non-auto tasks until release",
  });
  pushIfContains(out, tree, "src/lib/drain.ts", 't.status === "blocked"', {
    id: "task-stop:status-blocked",
    kind: "task-stop",
    name: "blocked task status dispatch park",
    evidence: "dispatch eligibility excludes blocked tasks",
  });
  pushIfContains(out, tree, "src/lib/drain.ts", "blocked_ci", {
    id: "task-stop:verdict:blocked_ci",
    kind: "task-stop",
    name: "blocked_ci non-halting redispatch path",
    evidence: "blocked_ci is continued rather than merged or closed",
  });
  if (tree["src/lib/daemon.ts"]?.includes("PER_TASK_FAILURE_RE") && tree["src/lib/daemon.ts"]?.includes("DAEMON_EXIT_BLOCKED")) {
    out.push({
      id: "task-stop:daemon-per-task-failure",
      kind: "task-stop",
      path: "src/lib/daemon.ts",
      name: "daemon per-task failure exit",
      evidence: "one task command failure can map the daemon to blocked",
    });
  }

  return uniqById(out);
}

export function censusGatePostures(
  surfaces: readonly GateSurface[],
  declarations: Readonly<Record<string, GatePostureDeclaration>> = GATE_POSTURE_DECLARATIONS,
): GatePostureCensus {
  const rows = surfaces.map((surface) => ({ ...surface, declaration: declarations[surface.id] }));
  const surfaceIds = new Set(surfaces.map((surface) => surface.id));
  return {
    rows,
    missingDeclarations: rows.filter((row) => row.declaration === undefined).map((row) => row.id).sort(),
    staleDeclarations: Object.keys(declarations).filter((id) => !surfaceIds.has(id)).sort(),
  };
}

export function renderGatePostureReport(census: GatePostureCensus): string {
  const lines = ["GATE POSTURE CENSUS"];
  for (const row of census.rows) {
    if (!row.declaration) {
      lines.push(`${row.id} | ${row.kind} | UNDECLARED | complies=unknown | ${row.path} | ${row.evidence}`);
      continue;
    }
    lines.push(
      `${row.id} | ${row.kind} | posture=${row.declaration.posture} | complies=${row.declaration.complies ? "yes" : "no"} | ` +
        `${row.path} | ${row.declaration.reason}`,
    );
  }
  if (census.missingDeclarations.length > 0) lines.push(`MISSING: ${census.missingDeclarations.join(", ")}`);
  if (census.staleDeclarations.length > 0) lines.push(`STALE: ${census.staleDeclarations.join(", ")}`);
  return lines.join("\n");
}

function walkFiles(root: string, dir: string, out: Record<string, string>): void {
  let entries;
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    const full = join(root, rel);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "coverage") continue;
      walkFiles(root, rel, out);
    } else if (entry.isFile()) {
      out[rel.split(sep).join("/")] = readFileSync(full, "utf8");
    }
  }
}

export function loadGatePostureTree(root: string): GatePostureTree {
  const out: Record<string, string> = {};
  for (const path of [
    "hooks",
    "scripts",
    ".github/workflows",
    "src/lib/drain.ts",
    "src/lib/daemon.ts",
    "src/lib/correct.ts",
  ]) {
    const full = join(root, path);
    try {
      const stats = statSync(full);
      if (stats.isDirectory()) walkFiles(root, path, out);
      if (stats.isFile()) out[relative(root, full).split(sep).join("/")] = readFileSync(full, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
  }
  return out;
}

const repair = (complies: boolean, reason: string): GatePostureDeclaration => ({ posture: "REPAIR", complies, reason });
const route = (complies: boolean, reason: string): GatePostureDeclaration => ({ posture: "ROUTE", complies, reason });
const close = (complies: boolean, reason: string): GatePostureDeclaration => ({ posture: "CLOSE", complies, reason });

export const GATE_POSTURE_DECLARATIONS: Readonly<Record<string, GatePostureDeclaration>> = {
  "hook:hooks/commit-msg": repair(true, "bad commit text has a computable rewrite"),
  "hook:hooks/deny-floor.sh": repair(false, "read cadence should be paced, not parked as a resting block"),
  "hook:hooks/pre-commit": repair(true, "local formatting/check failures name computable edits"),
  "hook:hooks/pre-push": repair(true, "tier admission and push checks have computable remedies"),

  "script:scripts/assertion-discrimination-check.mjs": repair(true, "assertion drift is repaired in tests or claims"),
  "script:scripts/baseline-monotonic-check.mjs": repair(true, "baseline regressions are computable ledger edits"),
  "script:scripts/claims-check.mjs": repair(true, "claim failures name the claim or proof to repair"),
  "script:scripts/coverage-session-blanking-check.mjs": repair(true, "workflow blanking has a mechanical workflow repair"),
  "script:scripts/learnings-assert-check.mjs": repair(true, "learning assertion drift is a computable source/data repair"),
  "script:scripts/mkdtemp-callsite-check.mjs": repair(true, "mkdtemp callsites either move to the helper or declare an allowance"),
  "script:scripts/no-hand-rolled-fetch-check.mjs": repair(true, "raw fetch callsites move to the transport seam"),
  "script:scripts/state-citation-check.mjs": repair(true, "state citations are repaired by anchoring or deleting stale citations"),
  "script:scripts/task-id-existence-check.mjs": repair(true, "task-id mismatches name the shard or id to repair"),
  "script:scripts/tracked-source-write-check.mjs": repair(true, "tracked source writes are moved behind reviewed writers"),
  "script:scripts/unwired-gate-check.mjs": repair(true, "unwired gates are registered or deliberately removed"),
  "script:scripts/claude-md-budget-ratchet.mjs": repair(false, "budget pressure is computable, but refusing can still strand rule knowledge"),
  "script:scripts/comment-load-ratchet.mjs": repair(true, "the ratchet prints the baseline or comment edit needed"),
  "script:scripts/console-parity-ratchet.mjs": repair(true, "console parity drift names the missing route or fixture"),
  "script:scripts/contract-coverage-ratchet.mjs": repair(true, "contract coverage drift is repaired with a test or baseline decrease"),
  "script:scripts/coverage-merge-ratchet.mjs": repair(true, "coverage merge failures name missing shard artifacts or bad inputs"),
  "script:scripts/coverage-ratchet.mjs": repair(true, "coverage failures are repaired by tests or measured baseline movement"),
  "script:scripts/cycle-ratchet.mjs": repair(true, "dependency cycles are removed or explicitly budgeted"),
  "script:scripts/learnings-budget-ratchet.mjs": repair(true, "learning-budget failures name the record to compress or split"),
  "script:scripts/mutation-ratchet.mjs": repair(true, "mutation regressions are repaired by behavior tests or reviewed baseline movement"),
  "script:scripts/source-size-ratchet.mjs": repair(true, "source-size output names the reviewed baseline outcome when recording is intended"),
  "script:scripts/workflow-guard-mutation-ratchet.mjs": repair(true, "workflow-guard mutation drift is repaired by a workflow test or baseline"),

  "ci:api-client-drift": repair(true, "generated client drift is repaired by regenerating the client"),
  "ci:assertion-discrimination": repair(true, "assertion failures name the behavioral assertion to repair"),
  "ci:baseline-monotonic": repair(true, "upward baselines must be justified or lowered"),
  "ci:ci": repair(true, "unit/type failures are computable implementation repairs"),
  "ci:ci-required": repair(true, "the required aggregator reflects repairable child checks"),
  "ci:claims": repair(true, "claim failures name the stale claim"),
  "ci:commitlint": repair(true, "the PR title is mechanically rewriteable"),
  "ci:comment-load-ratchet": repair(true, "comment-load prints the reviewed baseline line when growth is intended"),
  "ci:containment-probe": close(true, "containment is a harm boundary for sandbox and environment changes"),
  "ci:coverage-ratchet": repair(true, "coverage gaps are repaired by tests or reviewed coverage data"),
  "ci:coverage-ratchet-required": repair(true, "coverage aggregation reflects repairable child coverage checks"),
  "ci:dashboard": repair(true, "dashboard build/test failures have computable source repairs"),
  "ci:depcruise": repair(true, "dependency violations name the forbidden edge"),
  "ci:flake-retry-aggregate": repair(true, "retry aggregate failures name unstable tests or host clusters"),
  "ci:jscpd-gate": repair(true, "duplication findings name code to extract or justify"),
  "ci:leak-grep": close(true, "secret leakage is a genuine harm bar"),
  "ci:learnings-budget-ratchet": repair(true, "learning-budget pressure is repaired by compression or split records"),
  "ci:lint-plan": route(true, "plan semantics can require author judgement even when syntax is computable"),
  "ci:mutation-ratchet": repair(true, "mutation failures are repaired by behavior tests or reviewed baseline movement"),
  "ci:no-hand-rolled-fetch": repair(true, "raw network callsites move to the transport seam"),
  "ci:prompt-surface-gate": repair(true, "prompt surface drift names the prompt or baseline to repair"),
  "ci:source-size": repair(true, "source-size is a review signal; measurement failures are computable"),
  "ci:task-id-existence": repair(true, "task id drift names the duplicate or missing shard"),
  "ci:test-slow": repair(true, "slow-tier failures are ordinary computable test/source repairs"),

  "state:correction:actual-pr-url": route(false, "wrong-PR correction exists, but false credit with no true PR still needs judgement"),
  "state:credit-path:head-ref": route(false, "head-ref-only credit can silently mark work done and needs adjudication when false"),
  "state:credit-path:trailer": route(false, "trailer credit can over-credit unbuilt work and needs adjudication when false"),
  "state:dispatch-filter:already-merged": route(false, "the filter is correct for true credits but has no computable false-credit reversal"),

  "task-stop:daemon-per-task-failure": repair(false, "one task command failure can still become a blocked daemon outcome"),
  "task-stop:status-blocked": route(false, "blocked task status parks work until an operator or later task resolves it"),
  "task-stop:verdict:blocked_ci": repair(false, "blocked_ci has fix paths but measured redispatch can still become a resting spend loop"),
  "task-stop:verify-not-auto": route(true, "verify: human intentionally waits for judgement and `rmd approve` releases it"),
};

export function currentGatePostureReport(root: string): GatePostureCensus {
  return censusGatePostures(deriveGateSurfaces(loadGatePostureTree(root)));
}
