import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { systemClock, type Clock } from "./clock.js";
import { githubSlugOf, REFUSAL_ESCALATE_AT, REFUSAL_PERSISTING_AT } from "./deployer.js";
import { escalate, ghIssueGateway, type Escalation, type EscalationOption, type IssueGateway } from "./escalate.js";
import { GH_APP_ID_ENV, GH_APP_INSTALLATION_ID_ENV, GH_APP_PRIVATE_KEY_PATH_ENV, signAppJwt } from "./github-app.js";
import { ghExec } from "./github-transport.js";
import {
  deliveredEscalationUrl,
  recordHostDeliveredEscalation,
  spoolEscalation,
  withdrawSpooledEscalation,
  type SpoolMeta,
} from "./host-escalation-spool.js";
import { isTestRunner } from "./live-write-guard.js";
import { hostWorktreeGit } from "./worktree-git.js";
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
 * 2026-10-15 (W1-T9625) -- A DOWN-DAEMON ALERT THAT ONLY THE DAEMON CAN DELIVER REACHES NO ONE. The
 * launcher named CRASH LOOP at 08:43:51 and raised this every tick with `issueUrl ""` for 1 h 46 m:
 * the spool's only reader was the daemon whose death it reported, and #11965 was opened by the daemon
 * that had just recovered. So a crash-loop escalation raised while the instance's container is NOT
 * RUNNING is posted by the host itself, through the same `escalate` (title dedup, labels) the drain
 * uses, authenticated by the host's own credential: a fleet App installation token minted from the
 * configured key, else GH_TOKEN. Its spool entry is then recorded delivered, so the daemon never
 * posts a second issue. Any failure (no credential, no docker answer, GitHub refused) leaves the
 * spool exactly as before, with the reason on the entry. Every other condition stays spool-only.
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
  /** W1-T9625: present on a crash-loop escalation the host could have posted itself. */
  direct?: DirectPostOutcome;
  directError?: string;
}

export interface LauncherAlertMeta {
  host: string;
  clock: Clock;
  /** W1-T9625: the host's own delivery while the daemon is down. Absent, every alert is spool-only. */
  direct?: HostDirectDelivery;
}

/** W1-T9625: whether an instance's container is running, as docker reports it. */
export type ContainerRunState = "running" | "down" | "unknown";

export interface HostDirectDelivery {
  containerState(instance: string): ContainerRunState;
  /** Opens (or dedups onto) the issue; returns its url, or throws naming why it could not. */
  post(e: Escalation): string;
}

/** W1-T9625: the outcome of the host's own attempt, for the verdict line the journal keeps. */
export type DirectPostOutcome = "posted" | "failed" | "daemon-running" | "not-attempted";

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
  let direct: { outcome: DirectPostOutcome; error?: string } | undefined;
  if (state.count >= spec.escalateAt) {
    tier = "escalated";
    const escalation = launcherAlertEscalation(state);
    direct = postWhileDaemonDown(stateDir, input, escalation, meta);
    const url = direct.outcome === "posted"
      ? deliveredEscalationUrl(stateDir, escalation)
      : spoolEscalation(stateDir, escalation, { ...spoolMeta(meta), ...(direct.error ? { directError: direct.error } : {}) });
    if (url) state.issueUrl = url;
    if (!state.escalatedAt) {
      state.escalatedAt = now;
      ledger(stateDir, taskId, LAUNCHER_ALERT_STEPS.escalated, { instance: input.instance, condition: input.condition, count: state.count, first_at: state.firstAt, message });
    }
  }
  writeState(path, state);
  return {
    instance: input.instance, condition: input.condition, tier, count: state.count, issueUrl: state.issueUrl ?? "",
    ...(direct && direct.outcome !== "not-attempted" ? { direct: direct.outcome, ...(direct.error ? { directError: direct.error } : {}) } : {}),
  };
}

/** The line the issue carries so a reader knows who posted it, and why not the daemon. */
function hostProvenance(instance: string, host: string): string {
  return (
    `\n\n---\nPosted by the host watchdog (\`rmd host-alert\`) on ${host} while ${instance} was not running: the daemon ` +
    "that drains the escalation spool is the one that is down, so it could not post this itself."
  );
}

/**
 * W1-T9625: post a crash-loop escalation from the host, only while the instance's container is not
 * running and no issue has been delivered for it yet. Never throws: a failure is returned as text
 * for the spool entry's directError, and the daemon still posts the entry once it is back.
 */
function postWhileDaemonDown(
  stateDir: string,
  input: { instance: string; condition: LauncherAlertCondition },
  e: Escalation,
  meta: LauncherAlertMeta,
): { outcome: DirectPostOutcome; error?: string } {
  if (input.condition !== "crash-loop" || !meta.direct || deliveredEscalationUrl(stateDir, e)) return { outcome: "not-attempted" };
  try {
    if (meta.direct.containerState(input.instance) !== "down") return { outcome: "daemon-running" };
    const url = meta.direct.post({ ...e, detail: e.detail + hostProvenance(input.instance, meta.host) });
    if (!url) throw new Error("escalate opened no issue (its dedup read was unreadable, or it refused)");
    // The delivered record keys on the escalation's OWN detail, the one every later tick re-raises.
    recordHostDeliveredEscalation(stateDir, e, url, spoolMeta(meta));
    return { outcome: "posted" };
  } catch (err) {
    return { outcome: "failed", error: oneLine(String((err as Error)?.message ?? err)).slice(0, 300) };
  }
}

/** bound kind: physical -- a docker inspect that has not answered in this long has no answer to give. */
const DOCKER_INSPECT_TIMEOUT_MS = 15_000;
/** bound kind: physical -- the App token exchange, inside the launcher's own 120 s host-alert bound. */
const TOKEN_EXCHANGE_TIMEOUT_MS = 30_000;

type SpawnSyncFn = (file: string, args: string[], opts: { encoding: "utf8"; timeout: number; input?: string }) => SpawnSyncReturns<string>;
const realSpawnSync: SpawnSyncFn = (file, args, opts) => spawnSync(file, args, opts);

/** `docker inspect` of the instance's container: running, down (stopped, or no such container), or
 *  unknown when docker itself did not answer -- which is never read as down. */
export function dockerContainerState(instance: string, run: SpawnSyncFn = realSpawnSync): ContainerRunState {
  const r = run("docker", ["inspect", "--format", "{{.State.Running}}", instance], { encoding: "utf8", timeout: DOCKER_INSPECT_TIMEOUT_MS });
  if (r.error) return "unknown"; // no docker binary, or it hung past the bound
  const out = (r.stdout ?? "").trim();
  if (r.status === 0) return out === "true" ? "running" : out === "false" ? "down" : "unknown";
  return /no such (object|container)/i.test(r.stderr ?? "") ? "down" : "unknown";
}

/** The child that exchanges the App JWT for an installation token. Read from stdin, so neither the
 *  JWT nor the token is ever on an argv; the token comes back on stdout only. */
const TOKEN_EXCHANGE_SCRIPT = `
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const { url, jwt, timeoutMs } = JSON.parse(raw);
const res = await fetch(url, {
  method: "POST",
  headers: { Authorization: "Bearer " + jwt, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  signal: AbortSignal.timeout(timeoutMs),
});
const body = await res.json().catch((err) => ({ error: String(err) }));
if (!res.ok || typeof body.token !== "string") {
  process.stderr.write("installation token exchange answered HTTP " + res.status);
  process.exit(1);
}
process.stdout.write(JSON.stringify({ token: body.token }));
`;

/** The token seams' production values; a test overrides any of them. */
const realTokenSeams = {
  env: process.env as NodeJS.ProcessEnv,
  readKey: (path: string): string => readFileSync(path, "utf8"),
  spawn: realSpawnSync,
  clock: systemClock as Clock,
  /** The exchange endpoint for an installation id; GitHub's, outside tests. */
  exchangeUrl: (id: string): string => `https://api.github.com/app/installations/${encodeURIComponent(id)}/access_tokens`,
};

/**
 * The host's own GitHub credential: a fleet App installation token minted from GH_APP_ID,
 * GH_APP_INSTALLATION_ID and the key at GH_APP_PRIVATE_KEY_PATH when all three are set, else
 * GH_TOKEN. Throws naming what is missing or what failed; never logs either secret.
 */
export function hostGithubToken(seams: Partial<typeof realTokenSeams> = {}): string {
  const d = { ...realTokenSeams, ...seams };
  const appId = d.env[GH_APP_ID_ENV];
  const installationId = d.env[GH_APP_INSTALLATION_ID_ENV];
  const keyPath = d.env[GH_APP_PRIVATE_KEY_PATH_ENV];
  if (appId && installationId && keyPath) {
    let jwt: string;
    try {
      jwt = signAppJwt(appId, d.readKey(keyPath), () => d.clock.now());
    } catch (err) {
      throw new Error(`the App key at ${keyPath} could not sign a JWT: ${(err as Error).message}`);
    }
    const input = JSON.stringify({ url: d.exchangeUrl(installationId), jwt, timeoutMs: TOKEN_EXCHANGE_TIMEOUT_MS });
    const r = d.spawn(process.execPath, ["--input-type=module", "-e", TOKEN_EXCHANGE_SCRIPT], { encoding: "utf8", timeout: TOKEN_EXCHANGE_TIMEOUT_MS + 5_000, input });
    if (r.status === 0) {
      try {
        return (JSON.parse(r.stdout) as { token: string }).token;
      } catch (err) {
        throw new Error(`the installation token exchange printed no token (${(err as Error).message})`);
      }
    }
    const why = r.error ? r.error.message : (r.stderr ?? "").trim().split("\n").pop() || `exit ${r.status}`;
    if (!d.env.GH_TOKEN) throw new Error(`the App installation token exchange failed (${why}) and no GH_TOKEN is set`);
    return d.env.GH_TOKEN;
  }
  if (d.env.GH_TOKEN) return d.env.GH_TOKEN;
  throw new Error(`no host credential: set ${GH_APP_ID_ENV}, ${GH_APP_INSTALLATION_ID_ENV} and ${GH_APP_PRIVATE_KEY_PATH_ENV}, or GH_TOKEN, in host-alert's environment`);
}

/** `owner/repo` of the checkout `rmd host-alert` runs from (the launcher cds into the daemon tree),
 *  read through the hardened host git leaf. */
export function hostAlertRepo(
  originUrl: () => string = () => hostWorktreeGit(process.cwd(), ["remote", "get-url", "origin"], { timeout: DOCKER_INSPECT_TIMEOUT_MS }),
): { owner: string; repo: string } {
  let url: string;
  try {
    url = originUrl();
  } catch (err) {
    throw new Error(`the checkout host-alert runs from has no readable origin: ${(err as Error).message}`);
  }
  const slug = githubSlugOf(url);
  if (!slug) throw new Error("the checkout host-alert runs from has no github.com origin");
  const [owner, repo] = slug.split("/");
  return { owner, repo };
}

/** The production delivery: docker for the down check, the host credential, the needs-human
 *  transport, whose `create` is the gated write (escalate.ts's ghIssueGateway, in AUTHORITY_TABLE).
 *  Refused under the test runner before the credential, git or the gateway's dedup READ run. */
export function realHostDirectDelivery(stateDir: string): HostDirectDelivery {
  return {
    containerState: (instance) => dockerContainerState(instance),
    post: (e) => {
      if (isTestRunner()) throw new Error(`refused under the test runner: the host posting ${e.taskId} would reach the live repo`);
      return postAsHost(stateDir, e);
    },
  };
}

/** One escalation through `escalate` as the host: its dedup searches the open needs-human issues
 *  for the same task id and title first, so an issue the daemon already opened takes this as a
 *  comment instead of a duplicate. Returns the issue url (`""` when escalate opened none). */
export function postAsHost(
  stateDir: string,
  e: Escalation,
  seams: {
    token?: () => string;
    repo?: () => { owner: string; repo: string };
    /** The needs-human transport for owner/repo, its `gh` children carrying `env` (the host token). */
    issues?: (owner: string, repo: string, env: NodeJS.ProcessEnv) => IssueGateway;
  } = {},
): string {
  const token = (seams.token ?? hostGithubToken)();
  const { owner, repo } = (seams.repo ?? hostAlertRepo)();
  const env = { ...process.env, GH_TOKEN: token };
  const issues = (seams.issues ?? ((o: string, r: string, childEnv: NodeJS.ProcessEnv) =>
    ghIssueGateway(o, r, { exec: (args) => ghExec(args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: childEnv }) })))(owner, repo, env);
  return escalate(e, { issues, ledgerPath: join(stateDir, LEDGER_FILENAME), runId: e.runId ?? e.taskId });
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
    : raiseLauncherAlert(stateRoot, { instance, condition, message: message ?? "" }, {
        ...meta,
        // A suite driving the verb must never probe this machine's docker or post: it injects one.
        direct: meta.direct ?? (isTestRunner() ? undefined : realHostDirectDelivery(stateRoot)),
      });
}
