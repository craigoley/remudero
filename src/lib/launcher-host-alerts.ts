import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Clock } from "./clock.js";
import { REFUSAL_ESCALATE_AT, REFUSAL_PERSISTING_AT } from "./deployer.js";
import type { Escalation, EscalationOption } from "./escalate.js";
import { spoolEscalation, withdrawSpooledEscalation, type SpoolMeta } from "./host-escalation-spool.js";
import { appendLedger } from "./ledger.js";
import { LEDGER_FILENAME } from "./ledger-path.js";

/**
 * 2026-10-11 -- THE HOST WATCHDOG'S OWN ALARMS WENT TO THE JOURNAL. The launcher rendered by
 * deploy/install-host-units.sh names a crash loop in `state/DAEMON_CRASH_LOOP` ("this needs a
 * human") and refuses to converge or refresh on a checkout that is not on main, has diverged, or
 * cannot fetch, and on a deploy-run that reported a problem. Nothing read any of it: the marker had
 * no reader and every refusal was one stderr line per tick. The host has no GitHub credential, so
 * these now ride the escalation spool (host-escalation-spool.ts) and the daemon posts them.
 *
 * TIERED BY PERSISTENCE, ON THE DEPLOYER'S OWN SCALE. A refusal is counted per consecutive observed
 * tick until the launcher sees that step succeed: at REFUSAL_PERSISTING_AT it is ledgered as
 * persisting, at REFUSAL_ESCALATE_AT it is spooled -- the tiers W1-T6062 gave a recycle that keeps
 * refusing. A single transient never pages, and a success in between restarts the count. The crash
 * loop is spooled at once: the launcher only names one after its own tiering (CRASH_LOOP_RUN recent
 * contiguous revivals, or the progress watchdog's hold-revive verdict).
 *
 * EVERY ALERT CLEARS ON RECOVERY. The launcher clears a condition when it next sees the step
 * succeed; a still-spooled escalation is withdrawn and one the daemon already opened gets a spooled
 * close, through the same withdrawSpooledEscalation `rmd deploy-run` uses.
 */
export const LAUNCHER_ALERT_DIRNAME = "launcher-alerts";

export const LAUNCHER_ALERT_STEPS = {
  persisting: "launcher_alert.persisting",
  escalated: "launcher_alert.escalated",
  cleared: "launcher_alert.cleared",
} as const;

export type LauncherAlertCondition =
  | "crash-loop"
  | "units-not-on-main"
  | "units-diverged"
  | "deploy-code-fetch-failed"
  | "deploy-code-diverged"
  | "deploy-run-problem";

interface ConditionSpec {
  persistingAt: number;
  escalateAt: number;
  /** The stable issue title: escalate dedups on it, so it carries no count or time. */
  summary: (instance: string) => string;
  /** What succeeding again looks like, for the close. */
  recovered: string;
  remedy: string;
}

const REFUSAL_TIERS = { persistingAt: REFUSAL_PERSISTING_AT, escalateAt: REFUSAL_ESCALATE_AT };

const SPECS: Record<LauncherAlertCondition, ConditionSpec> = {
  "crash-loop": {
    persistingAt: 1,
    escalateAt: 1,
    summary: (i) => `daemon ${i} is crash-looping on the host`,
    recovered: "the daemon running with no crash loop left in the revival log",
    remedy:
      "read the revival log and the failed boots `rmd progress-watchdog` names, then fix the input; a held revive " +
      "resumes when origin/main or the image changes (or remove state/watchdog-hold-revive)",
  },
  "units-not-on-main": {
    ...REFUSAL_TIERS,
    summary: (i) => `host units for ${i} are not converging: the install checkout is not on main`,
    recovered: "the install checkout back on branch main",
    remedy: "put <state>/daemon-install back on branch main; the next watchdog tick converges the units",
  },
  "units-diverged": {
    ...REFUSAL_TIERS,
    summary: (i) => `host units for ${i} are not converging: the install checkout diverged from origin/main`,
    recovered: "the install checkout fast-forwarding to origin/main",
    remedy: "reconcile <state>/daemon-install with origin/main (it holds commits main does not); the next tick fast-forwards it",
  },
  "deploy-code-fetch-failed": {
    ...REFUSAL_TIERS,
    summary: (i) => `deploy code for ${i} cannot refresh: fetching origin/main fails`,
    recovered: "the daemon checkout fetching origin/main",
    remedy: "check that the host reaches origin from <state>/remudero (network, remote url, its credential)",
  },
  "deploy-code-diverged": {
    ...REFUSAL_TIERS,
    summary: (i) => `deploy code for ${i} cannot refresh: the daemon checkout diverged from origin/main`,
    recovered: "the daemon checkout descending from origin/main again",
    remedy: "reconcile <state>/remudero with origin/main (its HEAD is not an ancestor of main); the next idle tick fast-forwards it",
  },
  "deploy-run-problem": {
    ...REFUSAL_TIERS,
    summary: (i) => `the host watchdog's deploy-run for ${i} keeps reporting a problem`,
    recovered: "`rmd deploy-run --image-drift-only` exiting cleanly",
    remedy: "read the deploy-run output in the watchdog's journal (rmd-fleet-watchdog.service) and fix what it names",
  },
};

export const LAUNCHER_ALERT_CONDITIONS = Object.keys(SPECS) as LauncherAlertCondition[];

export function isLauncherAlertCondition(value: string | undefined): value is LauncherAlertCondition {
  return value !== undefined && Object.hasOwn(SPECS, value);
}

/** One condition's run of consecutive observations, kept until the launcher sees it recover. */
export interface LauncherAlertState {
  v: 1;
  instance: string;
  condition: LauncherAlertCondition;
  count: number;
  firstAt: string;
  lastAt: string;
  firstMessage: string;
  lastMessage: string;
  escalatedAt?: string;
  issueUrl?: string;
}

export interface LauncherAlertVerdict {
  instance: string;
  condition: LauncherAlertCondition;
  tier: "observed" | "persisting" | "escalated" | "cleared" | "none";
  count: number;
  issueUrl: string;
}

export interface LauncherAlertMeta {
  host: string;
  clock: Clock;
}

const MESSAGE_CHARS = 600;

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-");
}

export function launcherAlertPath(stateDir: string, instance: string, condition: LauncherAlertCondition): string {
  return join(stateDir, LAUNCHER_ALERT_DIRNAME, `${safeName(instance)}.${condition}.json`);
}

/** The dedup identity of one instance's condition: the task id and the title. */
export function launcherAlertIdentity(instance: string, condition: LauncherAlertCondition): Pick<Escalation, "taskId" | "summary"> {
  return { taskId: `HOST-WATCHDOG-${instance}-${condition}`, summary: SPECS[condition].summary(instance) };
}

function oneLine(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, MESSAGE_CHARS) || "(the launcher gave no message)";
}

function readState(path: string): LauncherAlertState | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LauncherAlertState;
  } catch {
    return undefined; // absent: no run of this condition is open
  }
}

function writeState(path: string, state: LauncherAlertState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`);
  renameSync(tmp, path);
}

function ledger(stateDir: string, taskId: string, step: string, extra: Record<string, unknown>): void {
  appendLedger(join(stateDir, LEDGER_FILENAME), { run_id: "HOST-WATCHDOG", task_id: taskId, step, ...extra });
}

function spoolMeta(meta: LauncherAlertMeta): SpoolMeta {
  return { source: "host-watchdog", host: meta.host, clock: meta.clock };
}

/** The escalation for an open run. Its detail is fixed per episode (first sighting and message),
 *  so a run re-observed every tick is spooled as one entry and, once delivered, not posted again. */
export function launcherAlertEscalation(state: LauncherAlertState): Escalation {
  const spec = SPECS[state.condition];
  const options: EscalationOption[] = [
    { label: "fix it on the host", detail: spec.remedy },
    { label: "leave it to the watchdog", detail: "the launcher retries this on every tick and closes this issue itself once the step succeeds" },
  ];
  const seen = state.condition === "crash-loop"
    ? `The host watchdog named a crash loop for ${state.instance} at ${state.firstAt}: ${state.firstMessage}`
    : `The host watchdog for ${state.instance} has refused this on consecutive ticks since ${state.firstAt} ` +
      `(${spec.escalateAt} or more in a row, with no success between). First refusal: ${state.firstMessage}`;
  return {
    class: "BLOCKED",
    ...launcherAlertIdentity(state.instance, state.condition),
    runId: `HOST-WATCHDOG-${state.instance}`,
    detail:
      `${seen}\n\nUntil now the launcher (deploy/install-host-units.sh) logged this only to the host journal. ` +
      `This issue closes itself once the watchdog sees ${spec.recovered}.`,
    options,
    recommendation: "fix it on the host",
    consequence: state.condition === "crash-loop"
      ? "the daemon keeps dying and reviving (or stays held down), so the fleet builds nothing"
      : "the host keeps running what it had; merged changes to its units or deploy code do not reach it",
  };
}

/**
 * Record ONE observation of a condition on the host. Counts it, ledgers it once it persists, and
 * spools the escalation once it has persisted long enough. Returns the issue url once the daemon
 * has delivered it (`""` until then).
 */
export function raiseLauncherAlert(
  stateDir: string,
  input: { instance: string; condition: LauncherAlertCondition; message: string },
  meta: LauncherAlertMeta,
): LauncherAlertVerdict {
  const spec = SPECS[input.condition];
  const path = launcherAlertPath(stateDir, input.instance, input.condition);
  const prior = readState(path);
  const now = meta.clock.iso();
  const message = oneLine(input.message);
  const state: LauncherAlertState = prior
    ? { ...prior, count: prior.count + 1, lastAt: now, lastMessage: message }
    : { v: 1, instance: input.instance, condition: input.condition, count: 1, firstAt: now, lastAt: now, firstMessage: message, lastMessage: message };
  const { taskId } = launcherAlertIdentity(input.instance, input.condition);
  let tier: LauncherAlertVerdict["tier"] = state.count >= spec.persistingAt ? "persisting" : "observed";
  if (state.count === spec.persistingAt && spec.persistingAt < spec.escalateAt) {
    ledger(stateDir, taskId, LAUNCHER_ALERT_STEPS.persisting, { instance: input.instance, condition: input.condition, count: state.count, first_at: state.firstAt, message });
  }
  if (state.count >= spec.escalateAt) {
    tier = "escalated";
    const url = spoolEscalation(stateDir, launcherAlertEscalation(state), spoolMeta(meta));
    if (url) state.issueUrl = url;
    if (!state.escalatedAt) {
      state.escalatedAt = now;
      ledger(stateDir, taskId, LAUNCHER_ALERT_STEPS.escalated, { instance: input.instance, condition: input.condition, count: state.count, first_at: state.firstAt, message });
    }
  }
  writeState(path, state);
  return { instance: input.instance, condition: input.condition, tier, count: state.count, issueUrl: state.issueUrl ?? "" };
}

/** The launcher saw the step succeed: end the run, and withdraw or close what it escalated. */
export function clearLauncherAlert(
  stateDir: string,
  input: { instance: string; condition: LauncherAlertCondition },
  meta: LauncherAlertMeta,
): LauncherAlertVerdict {
  const path = launcherAlertPath(stateDir, input.instance, input.condition);
  const prior = readState(path);
  if (!prior) return { instance: input.instance, condition: input.condition, tier: "none", count: 0, issueUrl: "" };
  const identity = launcherAlertIdentity(input.instance, input.condition);
  const now = meta.clock.iso();
  if (prior.escalatedAt) {
    const closing =
      `The host watchdog saw ${SPECS[input.condition].recovered} at ${now}, after ${prior.count} observation(s) ` +
      `since ${prior.firstAt} -- closing.`;
    withdrawSpooledEscalation(stateDir, identity, closing, spoolMeta(meta));
  }
  rmSync(path, { force: true });
  ledger(stateDir, identity.taskId, LAUNCHER_ALERT_STEPS.cleared, {
    instance: input.instance, condition: input.condition, count: prior.count, first_at: prior.firstAt, escalated: Boolean(prior.escalatedAt),
  });
  return { instance: input.instance, condition: input.condition, tier: "cleared", count: prior.count, issueUrl: prior.issueUrl ?? "" };
}

/** `rmd host-alert`'s body, argv already split: the launcher's one entry into this module. */
export function hostAlertCommandResult(
  args: { stateRoot?: string; instance?: string; condition?: string; message?: string; clear: boolean },
  meta: LauncherAlertMeta,
): LauncherAlertVerdict | string {
  const { stateRoot, instance, condition, message, clear } = args;
  if (!stateRoot || !instance || !isLauncherAlertCondition(condition) || clear === (message !== undefined)) {
    return `rmd host-alert: --state-root, --instance, --condition (${LAUNCHER_ALERT_CONDITIONS.join("|")}) and exactly one of --raise <message> or --clear are required`;
  }
  return clear
    ? clearLauncherAlert(stateRoot, { instance, condition }, meta)
    : raiseLauncherAlert(stateRoot, { instance, condition, message: message ?? "" }, meta);
}
