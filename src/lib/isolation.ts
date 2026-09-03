import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "./config.js";
import { capStderrExcerpt, spawnWorker, type SpawnWorkerArgs, type WorkerResult } from "./worker.js";
import { reapWorkerScratch } from "./worker-scratch.js";

/**
 * ISOLATION PREFLIGHT PROBE (W1-T17 / Standing rule 11 / FIELD FINDING 11b).
 *
 * PR #8's shell isolation (CLAUDE_CODE_SHELL redirecting the Bash-tool snapshot
 * to an empty rc) works ONLY because THIS host's `~/.bashrc` happens to be
 * absent — an accident of the machine, not construction. A populated
 * `~/.bashrc` on some other host would silently isolate NOTHING (the config
 * "should" isolate, but that is a hypothesis, never a guarantee). Standing rule
 * 11: isolation is PROVEN PER RUN by probe, never assumed from configuration.
 *
 * This module is the empirical half: before any task worker runs, spawn a
 * READ-ONLY worker that counts the shell aliases/functions it inherited
 * (`alias | wc -l`, `declare -F | wc -l`). A worker with clean isolation
 * inherits NEITHER — any nonzero count means it picked up operator shell
 * state, so isolation is not holding on THIS run, THIS host. FAIL CLOSED
 * (Standing rule 11): a nonzero count aborts the run before any task work
 * begins, never a warning.
 *
 * GRANULARITY — once per run, mirroring containment.ts (W1-T2): the shell
 * config that determines contamination (CLAUDE_CODE_SHELL, ZDOTDIR, the host's
 * dotfiles) is constant across every spawn in a run, so the fact proven once
 * holds for all of them.
 *
 * READ-ONLY BY CONSTRUCTION, not just by prompt discipline: the probe spawn
 * restricts the model's tool set to `["Bash"]` ({@link isolationProbeSpawnArgs}),
 * so Write/Edit/NotebookEdit/MultiEdit are never even in the model's context —
 * a probe that is merely instructed to be read-only could still attempt a
 * write; one that never HAS a write tool cannot.
 *
 * CLAUDE-CODE'S OWN TOOL WRAPPERS ARE NOT OPERATOR STATE (CLI ≥ 2.1.211, verified
 * live this cycle). Every Claude Code Bash session injects a small, FIXED set of
 * shell FUNCTIONS into its snapshot that shadow `find`/`grep`/`rg` with Claude
 * Code's embedded `bfs`/`ugrep`/`ripgrep` binaries (the snapshot literally reads
 * `# Shadow find/grep with embedded bfs/ugrep`, `_cc_bin=$CLAUDE_CODE_EXECPATH`).
 * These are the SAME for every user on every host — they are the tool's own
 * plumbing, NOT operator shell customization — so counting them as "leakage" is a
 * FALSE POSITIVE that would block every run on a modern CLI. The probe therefore
 * counts only functions OUTSIDE {@link CLAUDE_CODE_TOOL_WRAPPERS}. This does NOT
 * weaken the invariant: an operator function of ANY OTHER name still trips the
 * gate, and an operator's own `find`/`grep`/`rg` function can never survive into
 * a worker anyway — Claude Code's snapshot `unalias`es and re-`function`s those
 * three names on top of whatever the shell had. Aliases are counted RAW (Claude
 * Code injects none). A wrapper name Claude Code adds in a FUTURE version is not
 * on this list, so it counts as operator state and fails CLOSED — the drift is
 * surfaced, never silently absorbed.
 */

/**
 * Claude Code's OWN Bash-tool / self-protection wrapper function names — excluded
 * from the isolation function count because they are the tool's plumbing, not
 * operator shell state (see file header). Kept deliberately SMALL and explicit:
 * a name not on this list is treated as operator leakage (fail closed). Each entry
 * is EXPLICIT and version-annotated — never pattern-absorbed — so the NEXT drift
 * still surfaces as a named block rather than being silently swallowed.
 *
 * SINGLE SOURCE OF TRUTH: the probe prompt's awk exclusion regex and the parser's
 * name filter both DERIVE from this const — adding a name here updates all three.
 */
export const CLAUDE_CODE_TOOL_WRAPPERS = [
  // find/grep/rg: the Bash-tool search wrappers, CLI >= 2.1.211.
  "find",
  "grep",
  "rg",
  // pkill: added CLI >= 2.1.214 (2026-07-18 auto-update; live fixture W3-T1a [pkill]).
  // Per the module doc, additions are EXPLICIT and version-annotated — never
  // pattern-absorbed — so the next drift also surfaces.
  "pkill",
] as const;

/** Named error so callers (and tests) can assert the fail-closed fired by type. */
export class IsolationError extends Error {
  /**
   * STRUCTURED GUARD-CAUSE (W1-T91/P23, ratifies the design's part (i)): the guard
   * class, the specific probe check that fired, and what was OBSERVED — carried
   * alongside the prose `message` so a reader (the retro's read-side classifier,
   * chiefly) never has to parse prose to know a block was a GUARD FIRING CORRECTLY,
   * not a task defect. `guard`/`check` are fixed literals (isolation has exactly
   * one probe today); `observed` preserves the preflight's three-state epistemology
   * (proven-holding | proven-broken | UNPROVEN) verbatim — the measured counts when
   * they exist ("0 aliases, 2 functions"), or the literal "unproven" when the report
   * itself could not be parsed. Never collapsed to a boolean.
   */
  readonly guard = "isolation" as const;
  readonly check = "inherited-functions" as const;
  readonly observed: string;
  /**
   * W1-T268: the probe spawn's `WorkerResult.childEnvKeys` — so the caller's
   * `blocked_isolation` verdict line can DERIVE `billing_mode`
   * (`billingMode(childEnvKeys)`, env.ts) instead of hardcoding a literal — a
   * blocked run is never free of a real billing mode just because it failed.
   */
  readonly childEnvKeys: string[];
  /** W1-T268: the probe spawn's resolved account label, when one exists. */
  readonly accountLabel?: string;
  constructor(message: string, observed: string, childEnvKeys: string[] = [], accountLabel?: string) {
    super(message);
    this.name = "IsolationError";
    this.observed = observed;
    this.childEnvKeys = childEnvKeys;
    this.accountLabel = accountLabel;
  }
}

/** Raw evidence gathered from one probe execution under the worker shell. */
export interface IsolationEvidence {
  /** `alias | wc -l` as reported by the probe worker (NaN if unparseable). */
  aliasCount: number;
  /** `declare -F | wc -l` as reported by the probe worker (NaN if unparseable). */
  functionCount: number;
  /**
   * The NAMES of the inherited aliases (space-joined) when the probe reported
   * them; omitted when the report carried no `alias_names:` line (an OLD-prompt
   * worker) or listed none. OBSERVABILITY ONLY — never consulted by the verdict.
   */
  aliasNames?: string;
  /**
   * The NAMES of the inherited functions (space-joined, CLAUDE_CODE_TOOL_WRAPPERS
   * excluded to match the count); omitted when unreported or none. Observability
   * only — the fail-closed decision is still purely the counts.
   */
  functionNames?: string;
}

/**
 * PURE verdict over probe evidence. Isolation holds IFF BOTH counts are
 * exactly zero. A count that could not be parsed out of the transcript is
 * NaN, which fails every comparison below — an unparseable report is treated
 * as UNPROVEN, not as a pass (absence of a bad number is not proof of a good
 * one; the same "unproven ⇒ fail closed" posture as containment.ts).
 */
export function assessIsolation(e: IsolationEvidence): { isolated: boolean; reason: string } {
  if (!Number.isFinite(e.aliasCount) || !Number.isFinite(e.functionCount)) {
    return {
      isolated: false,
      reason: "the probe's alias/function counts could not be parsed — isolation UNPROVEN",
    };
  }
  if (e.aliasCount > 0 || e.functionCount > 0) {
    // Observability (the W1-T91(i) direction, NOT completing that task): NAME the
    // inherited state so one line replaces a diagnostics session. The `[names]`
    // suffix appears ONLY when the probe reported names; absent ⇒ the reason is
    // byte-identical to the count-only version a worker on the old prompt produces.
    const named = (names?: string) => (names ? ` [${names}]` : "");
    return {
      isolated: false,
      reason:
        `worker inherited ${e.aliasCount} alias(es)${named(e.aliasNames)} and ${e.functionCount} function(s)${named(e.functionNames)} from operator ` +
        "shell state — isolation is NOT holding on this host/run",
    };
  }
  return {
    isolated: true,
    reason: `worker reports 0 aliases and 0 functions inherited (alias=${e.aliasCount}, functions=${e.functionCount})`,
  };
}

/**
 * W1-T2755 — the reason a FAILED isolation verdict reports, chosen from the signal that
 * actually produced the failure.
 *
 * THE DEFECT THIS CLOSES. {@link assessIsolation} sees only {@link IsolationEvidence} — two
 * counts. It cannot see whether the probe SPAWN failed, so a probe that never ran (a CLI
 * refusing to start, a transport failure, a spawn error) yields `NaN` counts and gets the
 * "counts could not be parsed" reason, which then travels into BOTH the
 * `isolation_preflight_failed` ledger row and the thrown {@link IsolationError} message. A
 * reader following that verdict investigates the report PARSER; the real cause is sitting in
 * `isError`/`transcript`, already carried into this function and used only for the row's
 * `stderr_excerpt`. MEASURED COST: a full day of investigation aimed at the isolation prompt
 * and the parser when the actual cause was the Codex CLI refusing a non-git-repo cwd (fixed
 * separately as W1-T2754). Same shape as the #981 ledger defect CLAUDE.md records — a line
 * must carry the reason from the decision that produced its outcome.
 *
 * THE VERDICT IS UNTOUCHED. This chooses a STRING. `assessIsolation` still decides
 * `isolated`, the caller still throws, and an unproven probe still fails closed. Nothing here
 * can turn a failure into a pass.
 *
 * THE THREE CASES, in the order they are distinguished:
 *  1. PROVEN BROKEN — counts parsed and at least one is nonzero. `assessIsolation`'s reason
 *     already names the observed leakage exactly; it is returned unchanged. A spawn that
 *     errored but still somehow produced parseable nonzero counts is a real leak either way.
 *  2. SPAWN FAILED — counts unparseable AND `isError`. The probe did not produce a report to
 *     parse; report the spawn's own text.
 *  3. GENUINELY UNPARSEABLE — counts unparseable, no error, but the probe DID return output.
 *     This is the case the parse-failure message exists for, and it keeps it verbatim.
 *  4. AMBIGUOUS — counts unparseable, no error signal, and no output either. Neither signal is
 *     present, so neither explanation is earned; say exactly that rather than blame the parser.
 */
export function isolationFailureReason(
  evidence: IsolationEvidence,
  verdict: { isolated: boolean; reason: string },
  probe: { isError?: boolean; transcript?: string },
): string {
  const countsParsed = Number.isFinite(evidence.aliasCount) && Number.isFinite(evidence.functionCount);
  if (countsParsed) return verdict.reason; // (1) proven broken — already specific
  const transcript = probe.transcript ?? "";
  if (probe.isError) {
    // (2) the spawn itself failed — name THAT, capped the same way the ledger row caps it.
    const excerpt = capStderrExcerpt(transcript.trim());
    return (
      "the probe spawn itself FAILED, so no report was produced to parse — isolation UNPROVEN" +
      (excerpt ? `; probe error: ${excerpt}` : "")
    );
  }
  if (transcript.trim() !== "") return verdict.reason; // (3) real parse failure — keep the message it exists for
  // (4) no counts, no error, no output.
  return "the probe returned no output and reported no error, so neither a parse failure nor a spawn failure is established — isolation UNPROVEN";
}

/** What one probe execution returns to the verdict layer. */
export interface ProbeExecResult {
  transcript: string;
  aliasCount: number;
  functionCount: number;
  /** Inherited alias names (space-joined) when the probe reported them; omitted otherwise. */
  aliasNames?: string;
  /** Inherited function names (space-joined, wrappers excluded) when reported; omitted otherwise. */
  functionNames?: string;
  /** Notional cost of the probe spawn (subscription) — surfaced so the run meters it. */
  costUsd?: number;
  /**
   * W1-T238: the underlying probe spawn's own `WorkerResult.isError` — carried
   * through so a failed probe spawn's stderr/error-result text (already folded
   * into `transcript`) can be persisted to the ledger, capped, instead of dying
   * with the process. Omitted by fakes that never populate it ⇒ treated as a
   * clean spawn (no excerpt).
   */
  isError?: boolean;
  /**
   * W1-T268: the probe spawn's own `WorkerResult.childEnvKeys` — carried through so
   * the caller can DERIVE this probe's `billing_mode` instead of assuming
   * subscription. Optional so a pre-existing test double that omits it falls back
   * to an empty key set, which `billingMode` reads as `"subscription"`.
   */
  childEnvKeys?: string[];
  /**
   * W1-T268: the probe spawn's own `WorkerResult.accountLabel` — the account this
   * probe's (notional) spend is attributed to. `undefined` when unresolved.
   */
  accountLabel?: string;
}

/** Injectable probe runner (default spawns a real worker); tests provide a fake. */
export type ProbeExecutor = () => Promise<ProbeExecResult>;

/** The probe worker prompt: report inherited alias/function counts, read-only.
 * The function count EXCLUDES Claude Code's own {@link CLAUDE_CODE_TOOL_WRAPPERS}
 * (find/grep/rg/pkill) — those are tool plumbing, not operator state (see file
 * header). The awk filter is generated from the const, so it tracks additions.
 * `awk` is used for the filter because it is NOT one of the wrapped commands. */
export function isolationProbePrompt(): string {
  const wrappers = CLAUDE_CODE_TOOL_WRAPPERS.join("|");
  return [
    "You are an ISOLATION PREFLIGHT PROBE. READ-ONLY: use ONLY the Bash tool to run",
    "these commands, IN ORDER, and report the EXACT results. Do NOT create,",
    "modify, or delete any file — you have no write tool available for a reason.",
    "1) alias | wc -l        (count of shell aliases this worker inherited)",
    `2) declare -F | awk '$NF !~ /^(${wrappers})$/ {c++} END {print c+0}'`,
    `   (count of shell functions this worker inherited, EXCLUDING Claude Code's`,
    `    OWN tool / self-protection wrappers named in the awk filter above`,
    `    (find/grep/rg/pkill) — those are injected into every Claude Code Bash`,
    `    session and are NOT operator shell state)`,
    `3) alias | awk '{sub(/^alias /, ""); sub(/=.*/, ""); printf "%s ", $0}'`,
    "   (the NAMES of those aliases, space-separated — empty output means none)",
    `4) declare -F | awk '$NF !~ /^(${wrappers})$/ {printf "%s ", $NF}'`,
    `   (the NAMES of those functions, the SAME wrapper exclusion as command 2`,
    "    — empty output means none)",
    "End with exactly:",
    "REPORT",
    "aliases: <exact number from command 1>",
    "functions: <exact number from command 2>",
    "alias_names: <exact names from command 3, or - if command 3 printed nothing>",
    "function_names: <exact names from command 4, or - if command 4 printed nothing>",
  ].join("\n");
}

/** Matches the probe's `aliases: N` / `functions: N` report lines, in order. */
const REPORT_RE = /aliases:\s*(\d+)[\s\S]*?functions:\s*(\d+)/i;
/** Optional name lines (added alongside the counts) — matched TOLERANTLY: a worker
 * on the OLD prompt emits neither, and parsing is unchanged when they are absent. */
const ALIAS_NAMES_RE = /alias_names:\s*(.+)/i;
const FUNCTION_NAMES_RE = /function_names:\s*(.+)/i;

/** Normalize a reported names line to a space-joined display string, or `undefined`
 * when the line was absent, a literal `-`, or (for functions) left with only wrappers.
 * `excludeWrappers` re-applies the CLAUDE_CODE_TOOL_WRAPPERS filter in code so the
 * names honor the SAME exclusion as the count regardless of what the worker emitted. */
function normalizeNames(raw: string | undefined, excludeWrappers: boolean): string | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "-") return undefined;
  let names = trimmed.split(/\s+/).filter((n) => n && n !== "-");
  if (excludeWrappers) {
    const wrappers = new Set<string>(CLAUDE_CODE_TOOL_WRAPPERS);
    names = names.filter((n) => !wrappers.has(n));
  }
  return names.length ? names.join(" ") : undefined;
}

/**
 * Parse the probe transcript into raw counts (and, when present, the inherited
 * NAMES); `null` if the report never appeared. The name fields are added to the
 * result ONLY when the probe reported them, so an old-prompt report parses to the
 * exact same `{ aliasCount, functionCount }` shape as before.
 */
export function parseIsolationReport(
  transcript: string,
): { aliasCount: number; functionCount: number; aliasNames?: string; functionNames?: string } | null {
  const m = REPORT_RE.exec(transcript);
  if (!m) return null;
  const aliasNames = normalizeNames(ALIAS_NAMES_RE.exec(transcript)?.[1], false);
  const functionNames = normalizeNames(FUNCTION_NAMES_RE.exec(transcript)?.[1], true);
  const out: { aliasCount: number; functionCount: number; aliasNames?: string; functionNames?: string } = {
    aliasCount: Number(m[1]),
    functionCount: Number(m[2]),
  };
  if (aliasNames) out.aliasNames = aliasNames;
  if (functionNames) out.functionNames = functionNames;
  return out;
}

/**
 * PURE builder for the probe worker's spawn args — extracted so the
 * read-only-by-construction guarantee (`tools: ["Bash"]`, no Write/Edit/
 * NotebookEdit/MultiEdit ever in context) is unit-testable without spawning a
 * real worker.
 */
export function isolationProbeSpawnArgs(opts: {
  cwd: string;
  settingsFile: string;
  budgetUsd?: number;
}): SpawnWorkerArgs {
  return {
    cwd: opts.cwd,
    permissionMode: "bypassPermissions",
    settingsFile: opts.settingsFile,
    // Structural read-only enforcement (belt-and-suspenders over the prompt):
    // the model has NO write tool at all, so it cannot use one even if asked.
    tools: ["Bash"],
    maxTurns: 4, // two read-only commands + the report; bounded tight.
    maxBudgetUsd: opts.budgetUsd,
    prompt: isolationProbePrompt(),
  };
}

/**
 * Default executor: spawn a real worker in a scratch cwd under the workspace.
 * `spawn` is injectable (defaults to the real {@link spawnWorker}) SOLELY so a unit
 * test can drive the `isError` propagation below without paying for a real SDK
 * spawn (W1-T238: this is the exact branch that discarded stderr on a failed probe
 * — it must stay under direct coverage, not only via the `exec` fake).
 */
export function defaultExecutor(
  settingsFile: string,
  config: Config,
  budgetUsd?: number,
  spawn: (args: SpawnWorkerArgs) => Promise<WorkerResult> = spawnWorker,
): ProbeExecutor {
  return async () => {
    const cwd = join(config.root, "tmp", `isolation-probe-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    try {
      const probe = await spawn({
        ...isolationProbeSpawnArgs({ cwd, settingsFile, budgetUsd }),
        config,
      });
      const transcript = [probe.text, probe.blocks.join("\n"), probe.stderr].join("\n");
      const parsed = parseIsolationReport(transcript);
      return {
        transcript,
        aliasCount: parsed?.aliasCount ?? NaN,
        functionCount: parsed?.functionCount ?? NaN,
        aliasNames: parsed?.aliasNames,
        functionNames: parsed?.functionNames,
        costUsd: probe.costUsd,
        isError: probe.isError,
        childEnvKeys: probe.childEnvKeys,
        accountLabel: probe.accountLabel,
      };
    } finally {
      // Reap the probe worker's SDK scratchpad (keyed by its cwd) before removal.
      reapWorkerScratch(cwd);
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  };
}

/**
 * Run the isolation preflight for a run. FAILS CLOSED (throws
 * {@link IsolationError}) unless zero inherited aliases/functions is
 * empirically proven — before any task worker (recon/implement) runs.
 */
export async function probeIsolation(opts: {
  settingsFile: string;
  config?: Config;
  budgetUsd?: number;
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /** Injectable for tests; default spawns a real worker. */
  exec?: ProbeExecutor;
}): Promise<{ isolated: true; reason: string; evidence: IsolationEvidence; costUsd: number }> {
  const log = opts.log ?? (() => {});
  const exec = opts.exec ?? defaultExecutor(opts.settingsFile, opts.config ?? loadConfig(), opts.budgetUsd);

  const r = await exec();
  const evidence: IsolationEvidence = { aliasCount: r.aliasCount, functionCount: r.functionCount };
  // Names are observability-only; carry them only when the probe reported them.
  if (r.aliasNames) evidence.aliasNames = r.aliasNames;
  if (r.functionNames) evidence.functionNames = r.functionNames;
  const verdict = assessIsolation(evidence);
  const costUsd = r.costUsd ?? 0;
  // W1-T2755: pick the reason from the signal that actually produced this outcome, BEFORE the
  // first ledger row is written. Hoisted above `isolation.probe` on purpose: that row is
  // written on EVERY probe, so it is the one a reader scanning probe history sees, and leaving
  // it saying "counts could not be parsed" on a spawn failure would recreate this task's own
  // defect on the forensic surface it did its damage on. TOTAL and SAFE to call
  // unconditionally: `isolationFailureReason` returns `verdict.reason` untouched whenever the
  // counts parsed, which covers every isolated (0/0) and proven-broken (nonzero) outcome — only
  // the unparseable-counts paths can differ, and those are exactly the misattributed ones.
  const failureReason = isolationFailureReason(evidence, verdict, r);
  log("isolation.probe", {
    isolated: verdict.isolated,
    reason: failureReason,
    alias_count: evidence.aliasCount,
    function_count: evidence.functionCount,
    alias_names: evidence.aliasNames ?? null,
    function_names: evidence.functionNames ?? null,
    cost_usd: costUsd,
    // W1-T238: the probe spawn's own stderr/error-result text, capped, ONLY when
    // the underlying worker call itself errored — a clean probe spawn never
    // gets this field, so a passing run's ledger line stays exactly as it was.
    ...(r.isError ? { stderr_excerpt: capStderrExcerpt(r.transcript) } : {}),
  });
  if (!verdict.isolated) {
    // Named error carrying the OBSERVED count (W1-T17 acceptance #1) AND, when the
    // probe reported them, the OBSERVED names — logged as its own ledger event,
    // distinct from the run-level `verdict` line the caller (run-task.ts) appends
    // when it converts this throw into a terminal run outcome.
    log("isolation_preflight_failed", {
      alias_count: evidence.aliasCount,
      function_count: evidence.functionCount,
      alias_names: evidence.aliasNames ?? null,
      function_names: evidence.functionNames ?? null,
      reason: failureReason,
      // W1-T1112: this row is the run-terminating VERDICT — the one a reader follows
      // when the run dies — so it must carry the spawn's own error text itself, not
      // just point at the sibling `isolation.probe` row written the same millisecond.
      // SAME condition as that row's `stderr_excerpt` (W1-T238): present only when the
      // underlying worker call itself errored, so a proven-broken (nonzero count) or
      // unproven (unparseable count) verdict on a CLEAN spawn still carries no excerpt.
      ...(r.isError ? { stderr_excerpt: capStderrExcerpt(r.transcript) } : {}),
    });
    // OBSERVED (W1-T91/P23 part i): the actual measured counts when both parsed
    // cleanly (a proven-broken state — nonzero leakage), or the literal "unproven"
    // when either count was unparseable (NaN) — the SAME unproven state
    // assessIsolation already fails closed on, now named explicitly for readers
    // that never see the prose `reason`.
    const observed =
      Number.isFinite(evidence.aliasCount) && Number.isFinite(evidence.functionCount)
        ? `${evidence.aliasCount} aliases, ${evidence.functionCount} functions`
        : "unproven";
    throw new IsolationError(
      `isolation_preflight_failed: ${failureReason} — FAIL CLOSED, the run does not proceed`,
      observed,
      r.childEnvKeys ?? [],
      r.accountLabel,
    );
  }
  return { isolated: true, reason: verdict.reason, evidence, costUsd };
}
