/**
 * Serve's resource-policy convergence — the W1-T4267 drift check for the build daemons, extended to
 * `remudero-serve`. Docker applies `--memory`/`--cpu-shares`/`--memory-reservation` only when a
 * container is CREATED, so on 2026-10-02 #8569 raised serve's limit 5120 → 7680 MiB and its
 * reservation 3072 → 5120 MiB, and serve kept the old ones until an operator ran
 * `./deploy/serve-container.sh --replace` by hand. The core watchdog tick (`rmd deploy-run
 * --image-drift-only`) now asks the same question for serve and converges through that launcher.
 *
 * Serve is the operator's console, so the replace is held by: STOP or PAUSE (set or unknown), an
 * hour's back-off after a failed replace, a supervisor handoff that has not finished (it is mid-swap
 * between generations), and a serve that is not healthy now. After a replace the live limits and
 * the container are read again; a failure records the back-off and opens a needs-human issue.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fixedClock } from "./clock.js";
import {
  IMAGE_RECYCLE_FAILURE_BACKOFF_MS,
  daemonInstanceRegistryPath,
  deployLedgerPath,
  githubSlugOf,
  isPrimaryDeployment,
  readResourcePolicyDrift,
  type DeployDeps,
  type RealDeployOpts,
  type ResourcePolicyDrift,
} from "./deployer.js";
import { ghIssueGateway, tryEscalate, type Escalation, type IssueGateway } from "./escalate.js";
import { isPaused } from "./fleet-control.js";
import { writeAtomic } from "./fs-race-safe.js";

export const SERVE_POLICY_CONTAINER = "remudero-serve";
export const SERVE_POLICY_FAILED_FILE = "SERVE_POLICY_FAILED";

/** Supervisor rows that open a handoff, and rows after which none is in flight. */
const HANDOFF_OPEN_STEPS = ["serve.handoff_requested", "serve.handoff_deferred", "serve.handoff_shed"];
const HANDOFF_CLOSED_STEPS = [
  "serve.handoff_done",
  "serve.handoff_aborted",
  "serve.handoff_skipped",
  "serve.handoff_failed",
  "serve.handoff_legacy_exit",
  "serve.supervisor_start",
  "serve.supervisor_ready",
];

export interface ServePolicyInputs {
  drift: ResourcePolicyDrift[] | undefined;
  stopPresent: boolean | undefined;
  pausePresent: boolean | undefined;
  handoffInProgress: boolean | undefined;
  healthy: boolean | undefined;
  lastFailedAtMs: number | undefined;
  nowMs: number;
  dryRun?: boolean;
}

export interface ServePolicyOutcome {
  replaced: boolean;
  reason: string;
  drift?: ResourcePolicyDrift[];
}

export function describeDrift(drift: ResourcePolicyDrift[]): string {
  return drift.map(({ field, expected, actual }) => `${field} expected=${expected} actual=${actual}`).join(", ");
}

/** Whether the newest handoff row in `ledgerText` opened one that no later row closed. */
export function serveHandoffOpen(ledgerText: string): boolean {
  let open = false;
  for (const line of ledgerText.split("\n")) {
    const step = /"step":"(serve\.[a-z_]+)"/.exec(line)?.[1];
    if (step === undefined) continue;
    if (HANDOFF_OPEN_STEPS.includes(step)) open = true;
    else if (HANDOFF_CLOSED_STEPS.includes(step)) open = false;
  }
  return open;
}

export function decideServePolicyConvergence(i: ServePolicyInputs): { replace: boolean; reason: string } {
  if (i.drift === undefined) return { replace: false, reason: "serve resource policy unreadable — unknown is never drift" };
  if (i.drift.length === 0) return { replace: false, reason: "serve is on its resource policy" };
  const details = `serve resource policy drift (${describeDrift(i.drift)})`;
  if (i.stopPresent !== false) return { replace: false, reason: `${details}, but STOP is set or unknown — no automatic replace` };
  if (i.pausePresent !== false) return { replace: false, reason: `${details}, but PAUSE is set or unknown — no automatic replace` };
  if (i.lastFailedAtMs !== undefined && i.nowMs - i.lastFailedAtMs < IMAGE_RECYCLE_FAILURE_BACKOFF_MS) {
    return { replace: false, reason: `${details}; a serve replace failed under an hour ago — backing off` };
  }
  if (i.handoffInProgress !== false) {
    return { replace: false, reason: `${details}, but a serve handoff is in progress or unreadable — waiting for it to finish` };
  }
  if (i.healthy !== true) return { replace: false, reason: `${details}, but serve is not healthy now — a replace waits for a healthy serve` };
  if (i.dryRun === true) return { replace: false, reason: `${details}; dry run — not replacing` };
  return { replace: true, reason: `automatic serve replace: ${details}` };
}

export function servePolicyEscalation(drift: ResourcePolicyDrift[], error: string): Escalation {
  return {
    class: "BLOCKED",
    taskId: "SERVE-POLICY",
    summary: "remudero-serve could not be replaced onto its resource policy",
    detail: [
      `The watchdog tick found remudero-serve's live limits off deploy/resource-policy.sh and its automatic`,
      `\`deploy/serve-container.sh --replace\` failed: ${error}`,
      ``,
      `- drift: ${describeDrift(drift)}`,
      `- the tick retries after an hour (state/${SERVE_POLICY_FAILED_FILE} records the failure)`,
    ].join("\n"),
    options: [
      { label: "Replace serve by hand", detail: "Run ./deploy/serve-container.sh --replace on the host and read its refusal." },
      { label: "Revert the policy change", detail: "If the new limits are wrong, revert them in deploy/resource-policy.sh." },
    ],
    recommendation: "Replace serve by hand",
    headDedup: "independent",
    consequence: "Serve keeps running on its old limits; the tick retries hourly.",
  };
}

/** One serve convergence pass. A no-op unless the primary instance wired the serve seams. `escalate`
 *  rides beside the deployer's seams because deployer.ts cannot import escalate.ts (a cycle). */
export function runServePolicyCycle(deps: DeployDeps & { escalate?: (e: Escalation) => void }, opts: { dryRun?: boolean; imageDriftOnly?: boolean } = {}): ServePolicyOutcome {
  if (opts.imageDriftOnly !== true || !deps.servePolicyDrift || !deps.replaceServe) {
    return { replaced: false, reason: "serve policy is converged only by the primary instance's watchdog tick" };
  }
  const drift = deps.servePolicyDrift();
  const nowMs = deps.now();
  const decision = decideServePolicyConvergence({
    drift,
    stopPresent: deps.stopPresent?.(),
    pausePresent: deps.pausePresent?.(),
    handoffInProgress: deps.serveHandoffInProgress?.(),
    healthy: deps.serveHealthy?.(),
    lastFailedAtMs: deps.servePolicyLastFailedAtMs?.(),
    nowMs,
    dryRun: opts.dryRun,
  });
  if (drift === undefined || drift.length === 0) return { replaced: false, reason: decision.reason, drift };
  if (!decision.replace) {
    deps.log("deploy.serve_policy_held", { reason: decision.reason, drift });
    return { replaced: false, reason: decision.reason, drift };
  }
  deps.log("deploy.serve_policy_replace", { reason: decision.reason, drift });
  let error: string | undefined;
  try {
    deps.replaceServe();
    const after = deps.servePolicyDrift();
    if (deps.serveHealthy?.() !== true) error = "serve is not running after the replace";
    else if (after === undefined || after.length > 0) error = `limits still off the policy after the replace (${after ? describeDrift(after) : "unreadable"})`;
  } catch (err) {
    // the launcher's refusal is carried to the failure row, the back-off record and the escalation below
    error = err instanceof Error ? err.message : String(err);
  }
  if (error === undefined) {
    deps.clearServePolicyFailure?.();
    deps.log("deploy.serve_policy_replaced", { drift });
    return { replaced: true, reason: decision.reason, drift };
  }
  deps.recordServePolicyFailure?.(error, nowMs);
  deps.log("deploy.serve_policy_failed", { drift, error });
  deps.escalate?.(servePolicyEscalation(drift, error));
  return { replaced: false, reason: `serve replace failed: ${error}`, drift };
}

/** The real serve seams, or none when this state root is not the registry's primary instance. */
export function realServePolicyDeps(
  o: Pick<RealDeployOpts, "installPath" | "stateRoot">,
  exec: (cmd: string, args: string[]) => string = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }),
  issuesFor: (owner: string, repo: string) => IssueGateway = ghIssueGateway,
): Partial<DeployDeps> & { escalate?: (e: Escalation) => void } {
  let registryText: string;
  try {
    registryText = readFileSync(daemonInstanceRegistryPath(o.installPath), "utf8");
  } catch {
    return {}; // no registry, no primary to name — serve is left to the operator, as before
  }
  if (isPrimaryDeployment(registryText, o.stateRoot) !== true) return {};
  const ledgerPath = deployLedgerPath(o.stateRoot);
  const failedPath = join(o.stateRoot, "state", SERVE_POLICY_FAILED_FILE);
  return {
    servePolicyDrift: () => readResourcePolicyDrift(exec, o.installPath, "serve", SERVE_POLICY_CONTAINER),
    pausePresent: () => isPaused(o.stateRoot),
    serveHandoffInProgress: () => {
      try {
        return serveHandoffOpen(readFileSync(ledgerPath, "utf8"));
      } catch {
        return undefined; // unreadable ledger — the handoff state is unknown, which holds the replace
      }
    },
    serveHealthy: () => {
      try {
        return exec("docker", ["inspect", SERVE_POLICY_CONTAINER, "--format", "{{.State.Running}} {{.State.Restarting}}"]).trim() === "true false";
      } catch {
        return undefined; // no such container or no docker — not observed healthy
      }
    },
    replaceServe: () => {
      exec("env", [`RMD_STATE_DIR=${o.stateRoot}`, "bash", join(o.installPath, "deploy", "serve-container.sh"), "--replace"]);
    },
    servePolicyLastFailedAtMs: () => {
      try {
        const at = Date.parse((JSON.parse(readFileSync(failedPath, "utf8")) as { at?: string }).at ?? "");
        return Number.isFinite(at) ? at : undefined;
      } catch {
        return undefined; // no failure recorded (or unreadable) — no back-off applies
      }
    },
    recordServePolicyFailure: (message, atMs) => {
      writeAtomic(failedPath, JSON.stringify({ message, at: fixedClock(atMs).iso() }, null, 2));
    },
    clearServePolicyFailure: () => {
      try {
        unlinkSync(failedPath);
      } catch {
        /* already gone — nothing recorded to retract */
      }
    },
    escalate: (e) => {
      const slug = (() => {
        try {
          return githubSlugOf(exec("git", ["-C", o.installPath, "remote", "get-url", "origin"]).trim());
        } catch {
          return undefined; // no origin — the failure row and back-off file still record it
        }
      })();
      if (!slug) return;
      const [owner, repo] = slug.split("/");
      void tryEscalate(e, { issues: issuesFor(owner!, repo!), ledgerPath, runId: "DEPLOY-SERVE-POLICY" });
    },
  };
}
