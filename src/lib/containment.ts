import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "./config.js";
import { validateWorkerSettingsFile } from "./settings.js";
import { spawnWorker } from "./worker.js";

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
  constructor(message: string) {
    super(message);
    this.name = "ContainmentError";
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
}

/**
 * PURE verdict over probe evidence. Containment holds IFF the outside-cwd write was
 * BLOCKED (its file never appeared) AND an OS denial was actually observed — file
 * absence ALONE is not proof (the worker might simply not have attempted the write,
 * which must also fail closed). Every other combination is `contained: false`.
 */
export function assessContainment(e: ContainmentEvidence): { contained: boolean; reason: string } {
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

/** Default executor: spawn a real sandboxed worker in a scratch cwd under the workspace. */
function defaultExecutor(settingsFile: string, config: Config, budgetUsd?: number): ProbeExecutor {
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
      const probe = await spawnWorker({
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
      };
    } finally {
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
  };
  const verdict = assessContainment(evidence);
  const costUsd = r.costUsd ?? 0;
  log("containment.probe", {
    contained: verdict.contained,
    reason: verdict.reason,
    outside_write_created: evidence.outsideWriteCreated,
    os_denial_seen: evidence.osDenialSeen,
    inside_write_created: evidence.insideWriteCreated,
    cost_usd: costUsd,
  });
  if (!verdict.contained) {
    throw new ContainmentError(
      `containment UNPROVEN: ${verdict.reason} — FAIL CLOSED, the run does not proceed`,
    );
  }
  return { contained: true, reason: verdict.reason, evidence, costUsd };
}
