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
 * W1-T6125: binds also apply only at create, so W1-T6110's mount-plan reading drifts serve the same
 * way, under the same holds; an UNKNOWN reading (no plan, scratch off, no inspect) is never drift.
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
  imageShaContainerFor,
  isPrimaryDeployment,
  readMountPlanDrift,
  readResourcePolicyDrift,
  type DeployDeps,
  type MountPlanDrift,
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

export type ServeImageDrift = { expected: string; actual: string } | { kind: "unknown"; reason: string };

export type ServePolicyDeps = DeployDeps & {
  escalate?: (e: Escalation) => void;
  serveMountPlanDrift?: () => MountPlanDrift[] | undefined;
  serveImageDrift?: () => ServeImageDrift | undefined;
};

export interface ServePolicyInputs {
  drift: ResourcePolicyDrift[] | undefined;
  mountDrift?: MountPlanDrift[] | undefined;
  imageDrift?: ServeImageDrift;
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
  mountDrift?: MountPlanDrift[];
  imageDrift?: ServeImageDrift;
}

export function describeDrift(drift: ResourcePolicyDrift[]): string {
  return drift.map(({ field, expected, actual }) => `${field} expected=${expected} actual=${actual}`).join(", ");
}

export function describeMountDrift(drift: MountPlanDrift[]): string {
  return drift.map(({ target, expected, actual }) => `${target} expected=${expected} actual=${actual ?? "absent"}`).join(", ");
}

/** Each KNOWN drift, named; an unknown or empty reading contributes nothing. */
function driftDetails(drift: ResourcePolicyDrift[] | undefined, mountDrift: MountPlanDrift[] | undefined, imageDrift?: ServeImageDrift): string[] {
  return [
    ...(drift?.length ? [`serve resource policy drift (${describeDrift(drift)})`] : []),
    ...(mountDrift?.length ? [`serve mount plan drift (${describeMountDrift(mountDrift)})`] : []),
    ...(imageDrift && "expected" in imageDrift ? [`serve image drift (expected=${imageDrift.expected} actual=${imageDrift.actual})`] : []),
  ];
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
  const known = driftDetails(i.drift, i.mountDrift, i.imageDrift);
  if (known.length === 0 && i.imageDrift && "kind" in i.imageDrift) return { replace: false, reason: `serve image unreadable — unknown is never drift (${i.imageDrift.reason})` };
  if (known.length === 0 && i.drift === undefined) return { replace: false, reason: "serve resource policy unreadable — unknown is never drift" };
  if (known.length === 0) return { replace: false, reason: "serve is on its resource policy and mount plan, or the plan is unknown" };
  const details = known.join("; ");
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

export function servePolicyEscalation(drift: ResourcePolicyDrift[], error: string, mountDrift: MountPlanDrift[] = [], imageDrift?: ServeImageDrift): Escalation {
  return {
    class: "BLOCKED",
    taskId: "SERVE-POLICY",
    summary: "remudero-serve could not be replaced onto its resource policy, mounts or daemon image",
    detail: [
      `The watchdog tick found remudero-serve drift and its automatic`,
      `\`deploy/serve-container.sh --replace\` failed: ${error}`,
      ``,
      `- drift: ${describeDrift(drift)}`,
      ...(mountDrift.length ? [`- mount drift: ${describeMountDrift(mountDrift)}`] : []),
      ...(imageDrift && "expected" in imageDrift ? [`- image drift: expected=${imageDrift.expected} actual=${imageDrift.actual}`] : []),
      `- the tick retries after an hour (state/${SERVE_POLICY_FAILED_FILE} records the failure)`,
    ].join("\n"),
    options: [
      { label: "Replace serve by hand", detail: "Run ./deploy/serve-container.sh --replace on the host and read its refusal." },
      { label: "Revert the policy change", detail: "If the new limits are wrong, revert them in deploy/resource-policy.sh." },
    ],
    recommendation: "Replace serve by hand",
    headDedup: "independent",
    consequence: "Serve keeps running with the observed drift; the tick retries hourly.",
  };
}

/** One serve convergence pass. A no-op unless the primary instance wired the serve seams. `escalate`
 *  rides beside the deployer's seams because deployer.ts cannot import escalate.ts (a cycle). */
export function runServePolicyCycle(
  deps: ServePolicyDeps,
  opts: { dryRun?: boolean; imageDriftOnly?: boolean } = {}): ServePolicyOutcome {
  if (opts.imageDriftOnly !== true || !deps.servePolicyDrift || !deps.replaceServe) {
    return { replaced: false, reason: "serve policy is converged only by the primary instance's watchdog tick" };
  }
  const drift = deps.servePolicyDrift();
  const mountDrift = deps.serveMountPlanDrift?.();
  const imageDrift = deps.serveImageDrift?.();
  const nowMs = deps.now();
  const decision = decideServePolicyConvergence({
    drift,
    mountDrift,
    imageDrift,
    stopPresent: deps.stopPresent?.(),
    pausePresent: deps.pausePresent?.(),
    handoffInProgress: deps.serveHandoffInProgress?.(),
    healthy: deps.serveHealthy?.(),
    lastFailedAtMs: deps.servePolicyLastFailedAtMs?.(),
    nowMs,
    dryRun: opts.dryRun,
  });
  const rows = { drift: drift ?? [], ...(mountDrift ? { mountDrift } : {}), ...(imageDrift ? { imageDrift } : {}) };
  if (driftDetails(drift, mountDrift, imageDrift).length === 0) return { replaced: false, reason: decision.reason, drift, mountDrift, imageDrift };
  if (!decision.replace) {
    deps.log("deploy.serve_policy_held", { reason: decision.reason, ...rows });
    return { replaced: false, reason: decision.reason, drift, mountDrift, imageDrift };
  }
  deps.log("deploy.serve_policy_replace", { reason: decision.reason, ...rows });
  let error: string | undefined;
  try {
    deps.replaceServe();
    // Only a reading known BEFORE the replace is re-checked: an unknown one never caused it.
    const after = drift === undefined ? [] : deps.servePolicyDrift();
    const mountsAfter = mountDrift === undefined ? [] : deps.serveMountPlanDrift?.();
    const imageAfter = imageDrift && "expected" in imageDrift ? deps.serveImageDrift?.() : undefined;
    if (deps.serveHealthy?.() !== true) error = "serve is not running after the replace";
    else if (after === undefined || after.length > 0) error = `limits still off the policy after the replace (${after ? describeDrift(after) : "unreadable"})`;
    else if (mountsAfter === undefined || mountsAfter.length > 0) {
      error = `binds still off the scratch mount plan after the replace (${mountsAfter ? describeMountDrift(mountsAfter) : "unreadable"})`;
    }
    else if (imageAfter) {
      error = `image still off the daemon after the replace (${"kind" in imageAfter ? imageAfter.reason : `expected=${imageAfter.expected} actual=${imageAfter.actual}`})`;
    }
  } catch (err) {
    // the launcher's refusal is carried to the failure row, the back-off record and the escalation below
    error = err instanceof Error ? err.message : String(err);
  }
  if (error === undefined) {
    deps.clearServePolicyFailure?.();
    deps.log("deploy.serve_policy_replaced", rows);
    return { replaced: true, reason: decision.reason, drift, mountDrift, imageDrift };
  }
  deps.recordServePolicyFailure?.(error, nowMs);
  deps.log("deploy.serve_policy_failed", { ...rows, error });
  deps.escalate?.(servePolicyEscalation(drift ?? [], error, mountDrift, imageDrift));
  return { replaced: false, reason: `serve replace failed: ${error}`, drift, mountDrift, imageDrift };
}

/** The real serve seams, or none when this state root is not the registry's primary instance. */
export function realServePolicyDeps(
  o: Pick<RealDeployOpts, "installPath" | "stateRoot">,
  exec: (cmd: string, args: string[]) => string = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }),
  issuesFor: (owner: string, repo: string) => IssueGateway = ghIssueGateway,
): Partial<ServePolicyDeps> {
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
    // serve-container.sh plans its binds for the state root `replaceServe` hands it as RMD_STATE_DIR
    serveMountPlanDrift: () => readMountPlanDrift(exec, o.installPath, o.stateRoot, SERVE_POLICY_CONTAINER),
    serveImageDrift: () => {
      try {
        const actual = exec("docker", ["inspect", SERVE_POLICY_CONTAINER, "--format", "{{.Image}}"]).trim();
        const expected = exec("docker", ["inspect", imageShaContainerFor(registryText, o.stateRoot), "--format", "{{.Image}}"]).trim();
        if (![actual, expected].every(id => /^sha256:[0-9a-f]{64}$/.test(id))) {
          return { kind: "unknown", reason: "serve or daemon image id unreadable" };
        }
        return actual === expected ? undefined : { actual, expected };
      } catch (err) {
        return { kind: "unknown", reason: err instanceof Error ? err.message : String(err) };
      }
    },
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
