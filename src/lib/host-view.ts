/**
 * `host`: the console's /host page as one body (arch Phase 4 design §1.1 and §5, P4-T14, W1-T5053).
 *
 * The page read GET /v1/control/status, /v1/provider-routing, /v1/account-usage and /v1/self-measurement
 * on every render, and /v1/daemon-health ran `gh api rate_limit` synchronously on serve's loop. This view
 * carries each route's body, built by the same function the route answers with, plus the skills list and
 * the EXACT gauges (`now` keeps only bands). It is built in the read-model worker's view thread, re-sampled
 * at most once per {@link HOST_PROBE_INTERVAL_MS}; the rate limit and the self-measurement union are read
 * asynchronously there, so neither holds the thread, and each lands in the next sample.
 *
 * The view writes nothing. The credit-state edge the account file shows is ledgered by the slow lane's
 * credit-edge unit (read-model-slow-lane.ts, `recordCreditStateEdge`), once, whether or not anyone reads;
 * GET /v1/account-usage and this view only read it.
 *
 * `accountUsage` drops the route's `*AgeMs` fields: an age moves on every sample, and its `*AsOf` sibling
 * says the same thing as an absolute time.
 */
import { dirname } from "node:path";
import { systemClock, type Clock } from "./clock.js";
import { accountUsageBody, type AccountUsageDeps, type AccountUsageSnapshot } from "./account-usage.js";
import type { WorkerProviderId } from "./config.js";
import { readDiskFreeBytes } from "./daemon-health.js";
import { ghJsonAsync } from "./github-transport.js";
import { createLatestMeasurementReader, type LatestMeasurementRowsResult } from "./measurement-cadence.js";
import { controlStatusBody, type ControlStatusDeps, type FleetControlStatus } from "./panel-actions.js";
import { resolveProviderRoutingPolicy } from "./provider-routing-policy.js";
import { readProviderRoutingStatus, type ProviderRoutingStatus } from "./provider-routing-status.js";
import type { ReadModelInstanceState } from "./task-view.js";
import { loadSkillRegistry, skillsDir, type Skill } from "./skill.js";
import { readLedgerLines } from "./status.js";
import type { ViewDefinition, ViewSource } from "./views.js";

export const HOST_VIEW_NAME = "host";
export const HOST_VIEW_VERSION = 1;
/** The probe cadence (design §1.1: "probe every 60 s"); `host-probe:` is judged stale after three of them. */
export const HOST_PROBE_INTERVAL_MS = 60_000;
/** The home instance's probe source: its as-of is the instant the view read the host's files. */
const HOST_PROBE_SOURCE = "host-probe:core";
/** How many `measurement_cadence.ran` rows the self-measurement part carries: GET /v1/self-measurement's default. */
const SELF_MEASUREMENT_ROWS = 10;

/** Where the host's inputs live, all serializable: it crosses into the view thread as `workerData`. */
export interface HostViewConfig {
  /** Serve's fleet-control root: the flag files, `state/` and the provider-routing status. */
  controlRoot: string;
  /** Core's live ledger; its directory is the state dir the self-measurement union and statfs read. */
  ledgerPath: string;
  /** The checkout whose skills registry GET /v1/skills lists. */
  skillsRoot: string;
  accountFilePath?: string;
}

/** The host view's config from the slow lane's, which already names every input: absent without a credit-edge unit. */
export function hostViewConfig(slowLane: { inbox?: { root: string }; accountUsage?: { ledgerPath: string; root: string; accountFilePath?: string } } | undefined): HostViewConfig | undefined {
  const account = slowLane?.accountUsage;
  if (!account) return undefined;
  return { controlRoot: account.root, ledgerPath: account.ledgerPath, skillsRoot: slowLane.inbox?.root ?? account.root, ...(account.accountFilePath ? { accountFilePath: account.accountFilePath } : {}) };
}

export interface HostGauges {
  diskFreeBytes?: number;
  rateLimitRemaining?: number;
  /** Why a gauge is absent, per gauge. */
  reasons?: Record<string, string>;
}

export interface HostViewData {
  control: FleetControlStatus;
  accountUsage: AccountUsageSnapshot;
  providerRouting: ProviderRoutingStatus;
  skills: Skill[];
  selfMeasurement: LatestMeasurementRowsResult;
  gauges: HostGauges;
}

/** Each host route's own deps, so the view and the routes read through one object per part. */
export interface HostRouteReads {
  control: ControlStatusDeps;
  account: AccountUsageDeps;
  providerRouting: Pick<ControlStatusDeps, "now"> & { root: string; read?: typeof readProviderRoutingStatus };
  skillsRoot: string;
}

/** The route deps a config names, defaulted exactly as serve's routes default them. */
export function hostReadDeps(config: HostViewConfig): HostRouteReads {
  return {
    control: { root: config.controlRoot, ledgerPath: config.ledgerPath },
    account: { ledgerPath: config.ledgerPath, root: config.controlRoot, ...(config.accountFilePath ? { accountFilePath: config.accountFilePath } : {}) },
    providerRouting: { root: config.controlRoot },
    skillsRoot: config.skillsRoot,
  };
}

/** The committed provider policy a routing status names, as the policy resolver takes it. */
export function providerPolicyConfigFromStatus(status: ProviderRoutingStatus): { workerProviders: { enabled: WorkerProviderId[]; reservePercent: number } } | undefined {
  const committed = status.policy?.committed;
  if (!committed) return undefined;
  return { workerProviders: { enabled: [...committed.enabledProviders], reservePercent: committed.reservePercent } };
}

/** GET /v1/provider-routing's body: the daemon's last routing decision with the live policy overlaid. */
export function providerRoutingBody(deps: HostRouteReads["providerRouting"]): ProviderRoutingStatus {
  const status = (deps.read ?? readProviderRoutingStatus)(deps.root, { now: deps.now });
  const config = providerPolicyConfigFromStatus(status);
  const policy = config ? resolveProviderRoutingPolicy(deps.root, config, { now: deps.now }) : status.policy;
  // The status remains the daemon's last material routing decision. Overlay only the live policy
  // projection so a console write, expiry or clear shows before the next dispatch; no provider probe.
  return policy ? { ...status, policy } : status;
}

/** The account body without its `*AgeMs` fields, which move on every sample. */
export function hostAccountUsage(snapshot: AccountUsageSnapshot): AccountUsageSnapshot {
  return Object.fromEntries(Object.entries(snapshot).filter(([field]) => !field.endsWith("AgeMs"))) as unknown as AccountUsageSnapshot;
}

/** The parts read synchronously from files: one live-ledger read serves both the control and the account part. */
export function hostFileParts(deps: HostRouteReads): Pick<HostViewData, "control" | "accountUsage" | "providerRouting" | "skills"> {
  const lines = (deps.account.readLedger ?? readLedgerLines)(deps.account.ledgerPath);
  return {
    control: controlStatusBody(deps.control, lines),
    accountUsage: hostAccountUsage(accountUsageBody(deps.account, lines)),
    providerRouting: providerRoutingBody(deps.providerRouting),
    skills: loadSkillRegistry(skillsDir(deps.skillsRoot)),
  };
}

/** `gh api rate_limit`'s REST core `remaining`, read without blocking; `undefined` when it does not answer a number. */
export async function readGhRateLimitRemainingAsync(json: (args: string[]) => Promise<unknown> = ghJsonAsync): Promise<number | undefined> {
  const remaining = ((await json(["api", "rate_limit"])) as { resources?: { core?: { remaining?: unknown } } } | undefined)?.resources?.core?.remaining;
  return typeof remaining === "number" ? remaining : undefined;
}

export interface HostViewOptions {
  /** Absent, the view has no inputs and builds no body. */
  config?: HostViewConfig;
  /** The worker's `ledger:<i>` judge. */
  ledgerSource: (state: ReadModelInstanceState, now: number) => ViewSource;
  clock?: Clock;
  intervalMs?: number;
  /** Seams below; production reads the files, `statfs`, `gh api rate_limit` and the ledger union. */
  read?: Partial<HostRouteReads>;
  diskFree?: (path: string) => number | undefined;
  rateLimit?: () => Promise<number | undefined>;
  selfMeasurement?: (stateDir: string, n: number) => Promise<LatestMeasurementRowsResult>;
}

type HostBody = { key: string; data: HostViewData; sources: ViewSource[] };

/** The host view the read-model worker's view thread builds: one unkeyed body for core. */
export function createHostView(opts: HostViewOptions): {
  name: string;
  version: number;
  materialize(ctx: { now: number; instances: ReadonlyArray<{ state: ReadModelInstanceState }> }): HostBody[];
} {
  const clock = opts.clock ?? systemClock;
  const intervalMs = opts.intervalMs ?? HOST_PROBE_INTERVAL_MS;
  const config = opts.config;
  const read = config ? { ...hostReadDeps(config), ...opts.read } : undefined;
  const stateDir = config ? dirname(config.ledgerPath) : "";
  const rateLimit = opts.rateLimit ?? (() => readGhRateLimitRemainingAsync());
  const selfMeasurement = opts.selfMeasurement ?? createLatestMeasurementReader();
  const diskFree = opts.diskFree ?? readDiskFreeBytes;
  // The async readings, each held until its next answer lands; a landing makes the next pass re-compose.
  const held: { rateLimit?: number; rateLimitReason: string; measurement?: LatestMeasurementRowsResult } = { rateLimitReason: "gh api rate_limit has not answered yet" };
  const inFlight = { rateLimit: false, measurement: false };
  // The last probe: its file parts and statfs, re-composed without a re-read when an async reading lands.
  let sample: { parts: ReturnType<typeof hostFileParts>; diskFreeBytes?: number; sources: ViewSource[] } | undefined;
  let attemptedAt = Number.NEGATIVE_INFINITY;
  let last: HostBody | undefined;
  let landed = false;
  const refresh = (): void => {
    if (!inFlight.rateLimit) {
      inFlight.rateLimit = true;
      rateLimit().then((remaining) => {
        held.rateLimit = remaining;
        held.rateLimitReason = "gh api rate_limit did not answer a number";
      }, (error: unknown) => {
        held.rateLimit = undefined;
        held.rateLimitReason = `gh api rate_limit failed: ${String((error as Error)?.message ?? error)}`;
      }).finally(() => {
        inFlight.rateLimit = false;
        landed = true;
      });
    }
    if (!inFlight.measurement) {
      inFlight.measurement = true;
      selfMeasurement(stateDir, SELF_MEASUREMENT_ROWS).then((result) => {
        held.measurement = result;
      }, (error: unknown) => {
        held.measurement = { status: "unreadable", reason: `the measurement read failed: ${String((error as Error)?.message ?? error)}` };
      }).finally(() => {
        inFlight.measurement = false;
        landed = true;
      });
    }
  };
  return {
    name: HOST_VIEW_NAME,
    version: HOST_VIEW_VERSION,
    materialize: ({ now, instances }) => {
      const home = instances[0];
      if (!config || !read || !home) return [];
      // A probe whose file read threw is not retried before the next interval either.
      const due = now - attemptedAt >= intervalMs;
      if (!due && !(landed && sample)) return last ? [last] : [];
      landed = false;
      if (due) {
        attemptedAt = now;
        refresh();
        const diskFreeBytes = diskFree(stateDir);
        const instance = home.state.instance;
        const parts = hostFileParts(read);
        const usage = parts.accountUsage;
        sample = {
          parts,
          ...(diskFreeBytes !== undefined ? { diskFreeBytes } : {}),
          sources: [
            { name: `host-probe:${instance}`, asOf: clock.iso(), state: "fresh" },
            { name: `account:${instance}`, asOf: usage.usageAsOf ?? null, ...(usage.usageUnknownReason ? { state: "stale", reason: `account usage ${usage.usageUnknownReason}` } : { state: "fresh" }) },
            opts.ledgerSource(home.state, now),
          ],
        };
      }
      const current = sample!;
      const reasons: Record<string, string> = {};
      if (current.diskFreeBytes === undefined) reasons.diskFreeBytes = `statfs of ${stateDir} failed`;
      if (held.rateLimit === undefined) reasons.rateLimitRemaining = held.rateLimitReason;
      const gauges: HostGauges = {
        ...(current.diskFreeBytes !== undefined ? { diskFreeBytes: current.diskFreeBytes } : {}),
        ...(held.rateLimit !== undefined ? { rateLimitRemaining: held.rateLimit } : {}),
        ...(Object.keys(reasons).length > 0 ? { reasons } : {}),
      };
      const selfMeasurement = held.measurement ?? { status: "unreadable", reason: "the measurement union has not been read yet" };
      last = { key: "", data: { ...current.parts, selfMeasurement, gauges }, sources: current.sources };
      return [last];
    },
  };
}

/**
 * The legacy side serve pairs with the view: the same parts computed from the same route deps on the request.
 * The gauges and the self-measurement are the view's own readings while it has a body, as `now`'s legacy side
 * takes its probe gauges: two samples moments apart are not a diff, and serve must not re-read the archive union.
 */
export function hostLegacyView(deps: HostRouteReads, viewData: () => HostViewData | undefined): ViewDefinition<HostViewData> {
  return {
    name: HOST_VIEW_NAME,
    version: HOST_VIEW_VERSION,
    // The routing status is rewritten in place on every worker spawn and its freshness is judged against the
    // clock: the view reads it at its probe, legacy when serve renders, so the shadow pairs the two by its own times.
    shadowReadings: { providerRouting: { at: "observedAt", verdicts: { freshness: "freshUntil" }, viewReadAt: HOST_PROBE_SOURCE } },
    compute: () => {
      const sampled = viewData();
      const data: HostViewData = {
        ...hostFileParts(deps),
        selfMeasurement: sampled?.selfMeasurement ?? { status: "unreadable", reason: "the host view has not sampled the measurement union yet" },
        gauges: sampled?.gauges ?? { reasons: { diskFreeBytes: "the host view has not sampled yet", rateLimitRemaining: "the host view has not sampled yet" } },
      };
      return { data, sources: [{ name: "account:core", asOf: data.accountUsage.usageAsOf ?? null, state: data.accountUsage.usageUnknownReason ? "stale" : "fresh" }] };
    },
  };
}
