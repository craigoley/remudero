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
 * W1-T8311: those holds never read the HOST. The launcher stops and removes the old console, so the
 * automatic replace passes it the host memory budget's thresholds and the launcher re-checks fresh
 * host pressure before its first destructive step. Its named refusal (a returned ServeReplaceHold) is a
 * HOLD: the old container stays, and no failure, back-off or escalation is recorded.
 * W1-T9487: W1-T9094 stopped the build daemon recycling for serve-only image inputs, so the daemon's
 * image stopped being serve's measure: serve is judged against the newest PUBLISHED image for its own
 * inputs, read from its `/etc/rmd-build-sha`; only when that cannot be read does the daemon's decide.
 * W1-T9509: the handoff hold read the live ledger.ndjson alone, so a rotation (17:00:22Z on 2026-10-14) left
 * it no handoff row and the next tick replaced serve; it now reads the live file and the newest rotations.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fixedClock } from "./clock.js";
import {
  IMAGE_BUILD_SHA_PATH,
  IMAGE_RECYCLE_FAILURE_BACKOFF_MS,
  bakedPathCommitsBehind,
  daemonInstanceRegistryPath,
  deployLedgerPath,
  githubSlugOf,
  imageShaContainerFor,
  isPrimaryDeployment,
  instanceForStateRoot,
  readMountPlanDrift,
  playwrightCoreVersionCommitsBehind,
  readResourcePolicyDrift,
  workerSdkCommitsBehind,
  type DeployDeps,
  type MountPlanDrift,
  type RealDeployOpts,
  type ResourcePolicyDrift,
} from "./deployer.js";
import { ghIssueGateway, tryEscalate, type Escalation, type IssueGateway } from "./escalate.js";
import { isPaused } from "./fleet-control.js";
import { writeAtomic } from "./fs-race-safe.js";
import { loadHostMemoryBudgetPolicy, type HostMemoryBudgetPolicy } from "./host-memory-shadow.js";
import { ledgerLivePath, readLedgerUnionRawLinesSync, realLedgerFs, type LedgerGrepFsDeps } from "./ledger-union.js";
import { createSelectedRegistryObserver, observeSelectedRegistrySync, selectedRegistryObserverInContext } from "./selected-registry-consumers.js";

export const SERVE_POLICY_CONTAINER = "remudero-serve";
export const SERVE_POLICY_FAILED_FILE = "SERVE_POLICY_FAILED";

/** Supervisor rows that open a handoff, and rows after which none is in flight. W1-T9504: a deferral (W1-T8311's
 *  `deferUpgrade`) forks no standby, holds no lock and keeps the active generation, so nothing is mid-swap after it;
 *  counting it open held the replace for as long as a handoff that never fits kept deferring (2026-10-14). */
const HANDOFF_OPEN_STEPS = ["serve.handoff_requested", "serve.handoff_shed"];
const HANDOFF_CLOSED_STEPS = [
  "serve.handoff_deferred",
  "serve.handoff_done",
  "serve.handoff_aborted",
  "serve.handoff_skipped",
  "serve.handoff_failed",
  "serve.handoff_legacy_exit",
  "serve.supervisor_start",
  "serve.supervisor_ready",
];

/** deploy/serve-container.sh's exit when fresh host pressure refuses the replace; nothing was changed. */
export const SERVE_REPLACE_HELD_EXIT = 75;

/** The environment that makes the launcher admit the replace on fresh host pressure, from the budget's existing values. */
export function serveReplaceAdmissionEnv(policy: HostMemoryBudgetPolicy): string[] {
  return [
    "RMD_SERVE_REPLACE_ADMISSION=required",
    `RMD_SERVE_ADMIT_HOST_RESERVE_MIB=${policy.hostReserveMib}`,
    `RMD_SERVE_ADMIT_SWAPIN_MAX=${policy.swapInPagesPerSecMax}`,
    `RMD_SERVE_ADMIT_PSI_SOME_AVG10_MAX=${policy.psiSomeAvg10Max}`,
    `RMD_SERVE_ADMIT_PSI_FULL_AVG10_MAX=${policy.psiFullAvg10Max}`,
    // the measured serve cold-start peak: what the new console needs once the old one is stopped
    `RMD_SERVE_ADMIT_CANDIDATE_MIB=${policy.serveColdStartReserveMib}`,
  ];
}

/** `basis: "serve-inputs"` (W1-T9487): expected is the newest image-input commit, actual serve's build
 *  sha. Without it, both are image ids and expected is the daemon's (W1-T6245). */
export type ServeImageDrift = { expected: string; actual: string; basis?: "serve-inputs" } | { kind: "unknown"; reason: string };

/** W1-T9487 — serve's build sha and how many of its own image-input commits origin/main has beyond it. */
export interface ServeImageInputs {
  buildSha: string;
  behind: number;
}

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

/** W1-T9509 — how far before the NEWEST rotation's cut the handoff hold still opens rotations. The newest one is
 *  always read, so a handoff opened before any one rotation stays visible; rotations ran every ~1.5-2 h on
 *  2026-10-14, so this is one or two files, and a size-forced burst of rotations is bounded by 2 h of writes. */
export const SERVE_HANDOFF_ROTATION_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Each row in `lines` in ts order; a row with no readable ts keeps the place of the row before it. */
function inTsOrder(lines: readonly string[]): string[] {
  let at = Number.NEGATIVE_INFINITY;
  const keyed = lines.map((line) => {
    const ts = Date.parse(String((JSON.parse(line) as { ts?: unknown }).ts));
    if (!Number.isNaN(ts)) at = ts;
    return { line, at };
  });
  return keyed.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).map((r) => r.line);
}

/**
 * Whether a serve handoff is open, read from the handoff rows of the live ledger and the rotations cut within
 * {@link SERVE_HANDOFF_ROTATION_WINDOW_MS} of the newest (at least the newest), in ts order. An unread rotation, an
 * absent or unreadable live file, or a read that throws is unknown — undefined, which holds the replace.
 */
export function serveHandoffInProgressFromLedger(stateDir: string, fsDeps: LedgerGrepFsDeps = realLedgerFs): boolean | undefined {
  const livePath = ledgerLivePath(stateDir);
  let liveRead = false;
  const tracked: LedgerGrepFsDeps = {
    ...fsDeps,
    readFileSync: (path) => {
      const buf = fsDeps.readFileSync(path);
      if (path === livePath) liveRead = true;
      return buf;
    },
  };
  try {
    const union = readLedgerUnionRawLinesSync(stateDir, {
      step: [...HANDOFF_OPEN_STEPS, ...HANDOFF_CLOSED_STEPS],
      rotationWindowMs: SERVE_HANDOFF_ROTATION_WINDOW_MS,
      minRotations: 1,
      refuseIncomplete: true,
    }, tracked);
    // the union skips an unreadable live file silently; here it is unknown, as it was before the union
    if (!union.ok || !liveRead) return undefined;
    return serveHandoffOpen(inTsOrder(union.rawLines).join("\n"));
  } catch {
    return undefined; // a read that throws leaves the handoff state unknown, which holds the replace
  }
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

/**
 * W1-T9487 — serve's image reading. Serve on every image input of its own is converged, whatever the
 * daemon runs. Behind them, it drifts only once an image containing the newest input is published
 * (the deploy cycle's own `imagePublished`); before that it waits for the build, which is never drift.
 * An unreadable build sha leaves today's daemon comparison deciding.
 */
function readServeImage(deps: Parameters<typeof runServePolicyCycle>[0]): ServeImageDrift | undefined {
  const inputs = deps.serveImageInputs?.();
  if (inputs === undefined) return deps.serveImageDrift?.();
  if (inputs.behind === 0) return undefined;
  const newest = deps.newestBakedSha?.();
  const published = newest === undefined ? undefined : deps.imagePublished?.(newest);
  if (newest !== undefined && published === true) return { expected: newest, actual: inputs.buildSha, basis: "serve-inputs" };
  const image = newest === undefined
    ? "the newest image input is unknown"
    : `an image containing ${newest.slice(0, 9)} is ${published === false ? "not published yet" : "of unknown publication"}`;
  return { kind: "unknown", reason: `serve is ${inputs.behind} image-input commit(s) behind origin/main, but ${image} — waiting for the build` };
}

/** One serve convergence pass. A no-op unless the primary instance wired the serve seams. `escalate`
 *  rides beside the deployer's seams because deployer.ts cannot import escalate.ts (a cycle). */
export function runServePolicyCycle(
  deps: DeployDeps & {
    escalate?: (e: Escalation) => void;
    serveMountPlanDrift?: () => MountPlanDrift[] | undefined;
    serveImageDrift?: () => ServeImageDrift | undefined;
    serveImageInputs?: () => ServeImageInputs | undefined;
  },
  opts: { dryRun?: boolean; imageDriftOnly?: boolean } = {}): ServePolicyOutcome {
  if (opts.imageDriftOnly !== true || !deps.servePolicyDrift || !deps.replaceServe) {
    return { replaced: false, reason: "serve policy is converged only by the primary instance's watchdog tick" };
  }
  const drift = deps.servePolicyDrift();
  const mountDrift = deps.serveMountPlanDrift?.();
  const imageDrift = readServeImage(deps);
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
    const held = deps.replaceServe();
    if (held) {
      // W1-T8311: an admission refusal changed nothing; the next tick asks again with a fresh reading
      const reason = `${decision.reason}, but fresh host pressure refused it (${held.held}: ${held.detail}) — the old console was kept`;
      deps.log("deploy.serve_policy_held", { reason, hold: held.held, ...rows });
      return { replaced: false, reason, drift, mountDrift, imageDrift };
    }
    // Only a reading known BEFORE the replace is re-checked: an unknown one never caused it.
    const after = drift === undefined ? [] : deps.servePolicyDrift();
    const mountsAfter = mountDrift === undefined ? [] : deps.serveMountPlanDrift?.();
    const imageAfter = imageDrift && "expected" in imageDrift ? readServeImage(deps) : undefined;
    if (deps.serveHealthy?.() !== true) error = "serve is not running after the replace";
    else if (after === undefined || after.length > 0) error = `limits still off the policy after the replace (${after ? describeDrift(after) : "unreadable"})`;
    else if (mountsAfter === undefined || mountsAfter.length > 0) {
      error = `binds still off the scratch mount plan after the replace (${mountsAfter ? describeMountDrift(mountsAfter) : "unreadable"})`;
    }
    else if (imageAfter) {
      const measure = imageDrift && "basis" in imageDrift ? "behind its newest published input" : "off the daemon";
      error = `image still ${measure} after the replace (${"kind" in imageAfter ? imageAfter.reason : `expected=${imageAfter.expected} actual=${imageAfter.actual}`})`;
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
  o: Pick<RealDeployOpts, "installPath" | "stateRoot" | "selectedRegistryObservation">,
  exec: (cmd: string, args: string[]) => string = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }),
  issuesFor: (owner: string, repo: string) => IssueGateway = ghIssueGateway,
  budget: () => HostMemoryBudgetPolicy = () => loadHostMemoryBudgetPolicy(),
): Partial<Parameters<typeof runServePolicyCycle>[0]> {
  o = { ...o };
  const observer = o.selectedRegistryObservation === undefined ? selectedRegistryObserverInContext()
    : createSelectedRegistryObserver(o.selectedRegistryObservation);
  let registryText: string;
  try {
    registryText = readFileSync(daemonInstanceRegistryPath(o.installPath), "utf8");
  } catch {
    return {}; // no registry, no primary to name — serve is left to the operator, as before
  }
  if (isPrimaryDeployment(registryText, o.stateRoot) !== true) return {};
  const instanceName = instanceForStateRoot(registryText, o.stateRoot);
  const ledgerPath = deployLedgerPath(o.stateRoot);
  const failedPath = join(o.stateRoot, "state", SERVE_POLICY_FAILED_FILE);
  const git = (args: readonly string[]): string => exec("git", ["-C", o.installPath, ...args]);
  return {
    servePolicyDrift: () => readResourcePolicyDrift(exec, o.installPath, "serve", SERVE_POLICY_CONTAINER, o.stateRoot),
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
    serveImageInputs: () => {
      let buildSha: string;
      try {
        buildSha = exec("docker", ["exec", SERVE_POLICY_CONTAINER, "cat", IMAGE_BUILD_SHA_PATH]).trim();
      } catch {
        return undefined; // serve down or no docker — the daemon comparison decides, as before
      }
      if (!/^[0-9a-f]{40}$/i.test(buildSha)) return undefined; // built without RMD_BUILD_SHA reads "unknown"
      // serve executes every baked input, and the deploy cycle's lockfile image inputs too
      const baked = bakedPathCommitsBehind(buildSha, git, "serve");
      if (baked === undefined) return undefined;
      return { buildSha, behind: baked + (playwrightCoreVersionCommitsBehind(buildSha, git) ?? 0) + (workerSdkCommitsBehind(buildSha, git) ?? 0) };
    },
    pausePresent: () => isPaused(o.stateRoot),
    serveHandoffInProgress: () => serveHandoffInProgressFromLedger(dirname(ledgerPath)),
    serveHealthy: () => {
      try {
        return exec("docker", ["inspect", SERVE_POLICY_CONTAINER, "--format", "{{.State.Running}} {{.State.Restarting}}"]).trim() === "true false";
      } catch {
        return undefined; // no such container or no docker — not observed healthy
      }
    },
    replaceServe: () => observeSelectedRegistrySync(observer, "serve-policy-replace", {
      instanceName, stateRoot: o.stateRoot, containerName: SERVE_POLICY_CONTAINER, namespace: "host",
    }, () => {
      let admission: string[];
      try {
        admission = serveReplaceAdmissionEnv(budget());
      } catch (err) {
        // no thresholds, no launch: a named hold, never an unguarded replace
        return { held: "policy_unread", detail: err instanceof Error ? err.message : String(err) };
      }
      try {
        exec("env", [`RMD_STATE_DIR=${o.stateRoot}`, ...admission, "bash", join(o.installPath, "deploy", "serve-container.sh"), "--replace"]);
      } catch (err) {
        const status = (err as { status?: unknown }).status;
        if (status !== SERVE_REPLACE_HELD_EXIT) throw err;
        const stderr = String((err as { stderr?: unknown }).stderr ?? "");
        const held = /HELD \(([a-z_]+)\) — (.*)/.exec(stderr);
        return { held: held?.[1] ?? "held", detail: held?.[2] ?? (err instanceof Error ? err.message : String(err)) };
      }
      return undefined;
    }),
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
          return githubSlugOf(git(["remote", "get-url", "origin"]).trim());
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
