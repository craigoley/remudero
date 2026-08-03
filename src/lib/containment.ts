import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "./config.js";
import { validateWorkerSettingsFile } from "./settings.js";
import { capStderrExcerpt, spawnWorker } from "./worker.js";
import { reapWorkerScratch } from "./worker-scratch.js";

/**
 * POST-SPAWN CONTAINMENT PROBE (WS-0 verdict 7; W1-T2 acceptance #2).
 *
 * The validate-before-spawn guard (settings.ts) proves the settings file is
 * WELL-FORMED. It does NOT prove the sandbox ENGAGED: `claude -p` SILENTLY IGNORES
 * a settings file it can't apply and runs unsandboxed (FF10a / LEARNINGS). Static
 * guard and empirical probe are two DIFFERENT guarantees — the schema check can
 * pass while containment is silently absent. This module is the empirical half:
 * spawn under the sandbox and confirm an attempted write OUTSIDE the working
 * directory is OS-DENIED. Containment unproven ⇒ FAIL CLOSED (Standing rule 11:
 * isolation is PROVEN PER RUN by probe, never assumed from configuration).
 *
 * GRANULARITY — once-per-run preflight, not per-spawn. Justification:
 *  - Standing rule 11 mandates "per run", and the settings file + host + CLI
 *    version (the tuple that determines whether the sandbox engages) are constant
 *    across every spawn in a run — the fact proven once holds for all of them.
 *  - Per-spawn would re-prove the same fact before recon AND implement AND resume
 *    AND review (4+ LLM probes/run) at no added assurance. Once-per-run is the
 *    floor: cheap, and it still catches a silently-dropped sandbox before any task
 *    worker writes a byte.
 */

/** Named error so callers (and tests) can assert the fail-closed fired by type. */
export class ContainmentError extends Error {
  /**
   * STRUCTURED GUARD-CAUSE (W1-T91/P23, ratifies the design's part (i)) — the
   * containment sibling of {@link import("./isolation.js").IsolationError}'s same
   * fields. `check` names WHICH gate fired (`sandbox-enabled` for the static
   * config gate, `outside-cwd-denial` for the empirical probe); `observed`
   * preserves the three-state epistemology (proven-holding | proven-broken |
   * UNPROVEN) verbatim rather than collapsing it to a boolean — the literal
   * "unproven" when no OS-denial was observed (the write may never have been
   * attempted), a data description when the sandbox was PROVEN to have dropped
   * (the outside write landed), or a config description for the static gate.
   */
  readonly guard = "containment" as const;
  readonly check: string;
  readonly observed: string;
  /**
   * W1-T268: the probe spawn's `WorkerResult.childEnvKeys` — `[]` when GATE 1
   * (the static config check) refused before any spawn ever ran. Carried so the
   * caller's `blocked_containment` verdict line can DERIVE `billing_mode`
   * (`billingMode(childEnvKeys)`, env.ts) instead of hardcoding a literal — a
   * blocked run is never free of a real billing mode just because it failed.
   */
  readonly childEnvKeys: string[];
  /** W1-T268: the probe spawn's resolved account label, when one exists. */
  readonly accountLabel?: string;
  constructor(message: string, check: string, observed: string, childEnvKeys: string[] = [], accountLabel?: string) {
    super(message);
    this.name = "ContainmentError";
    this.check = check;
    this.observed = observed;
    this.childEnvKeys = childEnvKeys;
    this.accountLabel = accountLabel;
  }
}

/** Raw evidence gathered from one probe execution under the sandbox. */
export interface ContainmentEvidence {
  /** Did the write OUTSIDE cwd land on disk? `true` ⇒ the sandbox did NOT hold. */
  outsideWriteCreated: boolean;
  /** Did the transcript show an OS-level denial of that outside write? */
  osDenialSeen: boolean;
  /** Did the write INSIDE cwd land? Sanity signal that the sandbox isn't over-blocking. */
  insideWriteCreated: boolean;
  /**
   * W1-T237: did the probe worker die on a credential/auth failure (isError PLUS
   * the conservative `CREDENTIAL_RE` signature) rather than ever attempting a
   * write? A credential-dead worker makes NO writes and trips no OS-denial text,
   * so it is byte-identical to the genuine no-write/no-denial "unproven" case
   * unless named separately — that collapse is exactly the misdiagnosis that
   * cost the 2026-07-21 incident two days (a dead-auth worker and a compliant
   * sandbox read the same). Distinguish it FIRST, before the write/denial checks
   * below, since a credential-dead worker proves nothing about isolation either
   * way. Optional — defaults falsy so pre-existing evidence literals that never
   * saw a credential failure need not spell it out.
   */
  credentialFailure?: boolean;
}

/**
 * PURE verdict over probe evidence. Containment holds IFF the outside-cwd write was
 * BLOCKED (its file never appeared) AND an OS denial was actually observed — file
 * absence ALONE is not proof (the worker might simply not have attempted the write,
 * which must also fail closed). Every other combination is `contained: false`.
 */
export function assessContainment(e: ContainmentEvidence): { contained: boolean; reason: string } {
  if (e.credentialFailure) {
    return {
      contained: false,
      reason:
        "spawn_credential_failure — the probe worker died on a credential/auth failure before it could " +
        "attempt any write; this is NOT a containment finding (unlock the keychain, don't investigate the sandbox)",
    };
  }
  if (e.outsideWriteCreated) {
    return {
      contained: false,
      reason: "outside-cwd write SUCCEEDED — the sandbox did not engage (silently dropped)",
    };
  }
  if (!e.osDenialSeen) {
    return {
      contained: false,
      reason:
        "no OS-denial was observed for the outside-cwd write — containment UNPROVEN (the write may never have been attempted)",
    };
  }
  return {
    contained: true,
    reason: `outside-cwd write OS-DENIED; inside-cwd write ${e.insideWriteCreated ? "succeeded" : "absent"}`,
  };
}

/** What one probe execution returns to the verdict layer. */
export interface ProbeExecResult {
  transcript: string;
  outsideWriteCreated: boolean;
  insideWriteCreated: boolean;
  /** Notional cost of the probe spawn (subscription) — surfaced so the run meters it. */
  costUsd?: number;
  /**
   * W1-T237: `WorkerResult.isError` from the probe spawn's own result envelope —
   * the information was already in hand (worker.ts carries it) but the preflight
   * never looked at it, testing only the transcript for denial text. Optional so
   * a pre-existing test double that omits it defaults to `false` (no credential
   * verdict fires without an explicit error signal).
   *
   * W1-T238: also carried through so a failed probe spawn's stderr/error-result
   * text (already folded into `transcript`) can be persisted to the ledger,
   * capped, instead of dying with the process the way it did the incident this
   * task fixes. Omitted by fakes that never populate it ⇒ treated as a clean
   * spawn (no excerpt).
   */
  isError?: boolean;
  /**
   * W1-T268: the probe spawn's own `WorkerResult.childEnvKeys` — carried through so
   * the caller can DERIVE this probe's `billing_mode` (never a hardcoded literal;
   * see `billingMode` in env.ts) instead of assuming subscription. Optional so a
   * pre-existing test double that omits it falls back to an empty key set, which
   * `billingMode` reads as `"subscription"` (the correct default absent the
   * overflow valve's key).
   */
  childEnvKeys?: string[];
  /**
   * W1-T268: the probe spawn's own `WorkerResult.accountLabel` — the account this
   * probe's (notional) spend is attributed to, carried through so the run's
   * `blocked_containment` verdict line can name it like every other spend-bearing
   * ledger line. `undefined` when the probe spawn could not resolve one.
   */
  accountLabel?: string;
}

/** Injectable probe runner (default spawns a real worker); tests provide a fake. */
export type ProbeExecutor = (token: string) => Promise<ProbeExecResult>;

/** The probe worker prompt: attempt a write OUTSIDE cwd, then INSIDE cwd; report both. */
export function containmentProbePrompt(token: string): string {
  return [
    "You are a CONTAINMENT PROBE. Using the Bash tool, run these TWO commands IN",
    "ORDER. Do NOT stop if one fails — run both and report the EXACT error text:",
    `1) touch ../${token}.txt      (a write OUTSIDE your working directory)`,
    "2) touch probe-ok.txt         (a write INSIDE your working directory)",
    "End with exactly:",
    "REPORT",
    "outside: <exact outcome or error text>",
    "inside: <outcome>",
  ].join("\n");
}

/**
 * Regex marking an OS/sandbox-level write denial (as opposed to a hook denial),
 * mirroring the WS-0 verdict-7 transcript check.
 */
const OS_DENIAL_RE = /operation not permitted|not permitted|permission denied|read-only file system|sandbox|denied/i;

/**
 * Regex marking the CLI's credential/auth-dead result text, verified verbatim
 * (SDK 0.3.209 / CLI 2.1.209, see env.ts / worker-home.ts / FINDINGS.md): a
 * headless spawn with no usable OAuth token exits "Not logged in · Please run
 * /login" at $0 before any turn. MATCHED CONSERVATIVELY — both fragments must
 * appear (not "any error"), so an unrelated error-result is never mislabelled a
 * credential failure. Applied only in combination with `isError`, never alone.
 */
const CREDENTIAL_FAILURE_RE = /not logged in/i;
const CREDENTIAL_LOGIN_HINT_RE = /run \/login/i;

/**
 * Regex marking the SDK's OTHER credential-dead result text: a copied OAuth
 * token that has since EXPIRED (as opposed to never being logged in at all)
 * exits "OAuth session expired and could not be refreshed" at $0 before any
 * turn — a distinct string from CREDENTIAL_FAILURE_RE/CREDENTIAL_LOGIN_HINT_RE
 * above, so it previously matched neither and fell through to the generic
 * "unproven" verdict W1-T237 exists to prevent. Same conservative shape: both
 * fragments must appear, applied only in combination with `isError`.
 */
const CREDENTIAL_EXPIRED_RE = /oauth session expired/i;
const CREDENTIAL_REFRESH_FAILED_RE = /could not be refreshed/i;

/**
 * Default executor: spawn a real sandboxed worker in a scratch cwd under the
 * workspace. `spawn` is injectable (defaults to the real {@link spawnWorker})
 * so both W1-T237's `isError` plumbing and W1-T238's stderr-persistence branch
 * (the exact branch that discarded stderr on a failed probe) are directly
 * unit-testable without spawning an actual sandboxed subprocess — every other
 * call site relies on the default.
 */
export function defaultExecutor(
  settingsFile: string,
  config: Config,
  budgetUsd?: number,
  spawn: typeof spawnWorker = spawnWorker,
): ProbeExecutor {
  return async (token: string) => {
    // The scratch dir lives under the WORKSPACE root, never under $TMPDIR — the
    // sandbox write scope is cwd + session $TMPDIR, so a sibling of cwd here is
    // genuinely OUTSIDE that scope (a $TMPDIR sibling would be writable and give a
    // false pass). cwd is a subdir; the outside target is its sibling.
    const base = join(config.root, "tmp", `containment-probe-${token}`);
    const cwd = join(base, "cwd");
    mkdirSync(cwd, { recursive: true });
    const outsidePath = join(base, `${token}.txt`);
    const insidePath = join(cwd, "probe-ok.txt");
    try {
      const probe = await spawn({
        cwd,
        permissionMode: "bypassPermissions",
        settingsFile,
        maxTurns: 6,
        maxBudgetUsd: budgetUsd,
        config,
        prompt: containmentProbePrompt(token),
      });
      const transcript = [probe.text, probe.blocks.join("\n"), probe.stderr].join("\n");
      return {
        transcript,
        outsideWriteCreated: existsSync(outsidePath),
        insideWriteCreated: existsSync(insidePath),
        costUsd: probe.costUsd,
        // W1-T237: the signal was already on WorkerResult; the preflight just never read it.
        isError: probe.isError,
        // W1-T268: same shape — already on WorkerResult, just never carried through.
        childEnvKeys: probe.childEnvKeys,
        accountLabel: probe.accountLabel,
      };
    } finally {
      // Reap the probe worker's SDK scratchpad (keyed by its cwd) before the cwd
      // is removed — a probe runs every run and is a killed-worker orphan source.
      reapWorkerScratch(cwd);
      try {
        rmSync(base, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  };
}

/**
 * Run the containment preflight for a run. FAILS CLOSED (throws
 * {@link ContainmentError}) unless containment is empirically proven.
 *
 * Two gates, both must pass:
 *  1. CONFIG — the settings file must declare an ENABLED sandbox (reuses
 *     {@link validateWorkerSettingsFile}, which requires `enabled` and
 *     `failIfUnavailable`). A sandbox-disabled file fails closed here, before any
 *     spawn — defense-in-depth so the probe never trusts a file it wasn't handed
 *     under an enabled sandbox.
 *  2. EMPIRICAL — spawn under the sandbox and confirm an outside-cwd write is
 *     OS-denied ({@link assessContainment}). This catches the failure static
 *     validation CANNOT: a well-formed file whose sandbox silently dropped.
 */
export async function probeContainment(opts: {
  settingsFile: string;
  config?: Config;
  budgetUsd?: number;
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /** Injectable for tests; default spawns a real sandboxed worker. */
  exec?: ProbeExecutor;
  /** Injectable token for deterministic tests; default is time-based. */
  token?: string;
}): Promise<{ contained: true; reason: string; evidence: ContainmentEvidence; costUsd: number }> {
  const log = opts.log ?? (() => {});

  // GATE 1 — config: the file must declare an enabled sandbox.
  try {
    validateWorkerSettingsFile(opts.settingsFile);
  } catch (e) {
    throw new ContainmentError(
      `containment preflight: settings file does not declare an enabled sandbox — ${String((e as Error)?.message ?? e)}`,
      "sandbox-enabled",
      "disabled",
    );
  }

  // GATE 2 — empirical: an outside-cwd write must be OS-denied under the sandbox.
  // Resolve config lazily and ONLY for the real executor: an injected exec (tests)
  // must never touch loadConfig (which resolves the claude binary — absent in CI).
  const token = opts.token ?? `${Date.now()}`;
  const exec =
    opts.exec ?? defaultExecutor(opts.settingsFile, opts.config ?? loadConfig(), opts.budgetUsd);
  const r = await exec(token);
  const evidence: ContainmentEvidence = {
    outsideWriteCreated: r.outsideWriteCreated,
    // The denial must reference THIS probe's token AND an OS-denial phrase, so a
    // stray "permission" mention elsewhere in the transcript can't fake it.
    osDenialSeen: r.transcript.includes(token) && OS_DENIAL_RE.test(r.transcript),
    insideWriteCreated: r.insideWriteCreated,
    // W1-T237: isError PLUS BOTH conservative credential fragments — not "any
    // error" — so an unrelated error-result is never mislabelled a credential
    // failure (the design's own conservatism requirement). Two independent
    // credential-dead phrasings are recognized: never-logged-in, and an
    // expired copied token that could not be refreshed.
    credentialFailure:
      r.isError === true &&
      ((CREDENTIAL_FAILURE_RE.test(r.transcript) && CREDENTIAL_LOGIN_HINT_RE.test(r.transcript)) ||
        (CREDENTIAL_EXPIRED_RE.test(r.transcript) &&
          CREDENTIAL_REFRESH_FAILED_RE.test(r.transcript))),
  };
  const verdict = assessContainment(evidence);
  const costUsd = r.costUsd ?? 0;
  log("containment.probe", {
    contained: verdict.contained,
    reason: verdict.reason,
    credential_failure: evidence.credentialFailure,
    outside_write_created: evidence.outsideWriteCreated,
    os_denial_seen: evidence.osDenialSeen,
    inside_write_created: evidence.insideWriteCreated,
    cost_usd: costUsd,
    // W1-T238: the probe spawn's own stderr/error-result text, capped, ONLY when
    // the underlying worker call itself errored — a clean probe spawn never
    // gets this field, so a passing run's ledger line stays exactly as it was.
    ...(r.isError ? { stderr_excerpt: capStderrExcerpt(r.transcript) } : {}),
  });
  if (!verdict.contained) {
    // OBSERVED (W1-T91/P23 part i, extended by W1-T237): the write's OWN outcome
    // names which of THREE states this was, checked in this order so a
    // credential-dead worker can never be reported as the genuine unproven case:
    //  1. credentialFailure — the probe worker died on auth, before it could
    //     attempt any write. Named `spawn_credential_failure` distinctly: this
    //     proves NOTHING about isolation either way (unlock the keychain, don't
    //     investigate the sandbox) — the opposite operator response from #2.
    //  2. outsideWriteCreated — proven-broken (the outside write LANDED, the
    //     sandbox did not engage) is data-bearing.
    //  3. neither — genuinely UNPROVEN (the write may never have been
    //     attempted) and reports the literal "unproven" rather than a
    //     fabricated data string.
    if (evidence.credentialFailure) {
      throw new ContainmentError(
        `containment preflight: spawn_credential_failure — ${verdict.reason} — FAIL CLOSED, the run does not proceed`,
        "spawn-credential-failure",
        "spawn_credential_failure",
        r.childEnvKeys ?? [],
        r.accountLabel,
      );
    }
    const observed = evidence.outsideWriteCreated
      ? "outside-cwd write succeeded (sandbox did not engage)"
      : "unproven";
    throw new ContainmentError(
      `containment UNPROVEN: ${verdict.reason} — FAIL CLOSED, the run does not proceed`,
      "outside-cwd-denial",
      observed,
      r.childEnvKeys ?? [],
      r.accountLabel,
    );
  }
  return { contained: true, reason: verdict.reason, evidence, costUsd };
}
