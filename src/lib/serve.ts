/**
 * lib/serve.ts — `rmd serve`'s assembler: the FRONT DOOR (W1-T139, MASTER-PLAN §7/§7B).
 *
 * board.ts's own header named exactly this gap: "Real `rmd serve` CLI wiring (registering
 * these routes on a live createService(...) instance, with a real ghGateway) is a later
 * task's concern" — panel-actions.ts and panel-graph.ts's headers say the same. That later
 * task is this one. This module wires ZERO new business logic — it is a thin layer over the
 * FOUR already-proven modules (service.ts's mechanism, board.ts's read side, panel-actions.ts's
 * write side, panel-graph.ts's graph) plus one new thing this task actually owns: a minimal
 * HTML shell at `GET /` and the tiny bit of CLI glue (port resolution, token persistence) a
 * launchable command needs. Every route below is REUSED verbatim from its own module's
 * exported builder — never reimplemented (task design note).
 *
 * TWO ROOTS, ONE `PanelActionDeps` SHAPE (verified from source, not assumed): panel-actions.ts's
 * six routes all take a `PanelActionDeps` with a single `root` field, but that field backs TWO
 * genuinely different filesystem locations elsewhere in this codebase:
 *   - `requestPause`/`requestStop`/`resumeFleet` (fleet-control.ts) read/write
 *     `<root>/state/{STOP,PAUSE}` — and MUST agree with what `rmd daemon`/`rmd
 *     drain` check (`stopDetail(config.root)` etc., run-task.ts's daemonCommand) or a panel
 *     STOP would write a flag file the real daemon never looks at.
 *   - `appendQuestionAnswer` (worker.ts, only `buildAnswerQuestionRoute` calls it) writes
 *     `<root>/plan/questions.ndjson` — and MUST agree with where `appendQuestion` (the QUESTION
 *     side of the SAME contract, run-task.ts) writes, which is `repoRoot` (the git tree), not
 *     `config.root` — else "THE ANSWER FLOWS TO THE ARCHITECT" (panel-actions.ts's own header)
 *     would silently land in a file nothing reads.
 * `config.root` and `repoRoot` are NOT the same directory by default (config.root defaults to
 * `~/Remudero`, a workspace; repoRoot is the git checkout serve runs from) — one shared `root`
 * cannot satisfy both correctly. Since every `build*Route` function takes its own independent
 * `PanelActionDeps`, {@link buildServeRoutes} passes TWO differently-rooted instances: a
 * `fleetControlRoot`-rooted one for pause/resume/stop/quiet-hours/approve-manual, and a
 * `questionsRoot`-rooted one for answer-question alone — both share the SAME `ledgerPath`
 * (every module's `panel.*`/`daemon.*` ledger lines always live under config.root, unambiguous
 * everywhere else in this codebase).
 */

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { createConnection } from "node:net";
import { promises as fsPromises } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { createOrReadExclusive } from "./fs-race-safe.js";
import {
  assertWriteTiersComplete,
  createConfirmNonceStore,
  createService,
  makeConfirmNonceRoute,
  type ConfirmNonceStore,
  type Method,
  type Route,
  type Scope,
  cloudflareAccessIdentityProvider,
  createCloudflareAccessKeyCache,
  createOperatorJwksCache,
  ingestTokenProvider,
  operatorJwksUrl,
  operatorSessionIdentityProvider,
  type IdentityProvider,
  type OperatorIdentityConfig,
  type ServiceOptions,
  type ServiceTokens,
  type SseRoute,
  type WriteTier,
} from "./service.js";
import {
  buildIncidentEventsRoute,
  INCIDENT_INGEST_ROUTE_METHOD,
  INCIDENT_INGEST_ROUTE_PATH,
} from "./incident-events.js";
import { buildIncidentsRoute, type IncidentsRouteInput } from "./incident-lifecycle.js";
import {
  ciIncidentEventLedgerLine,
  createCiIncidentState,
  readCiIncidentJobLog,
  recordCheckRunOutcome,
  DEFAULT_CI_INCIDENT_MAIN_BRANCH,
  type CiIncidentState,
} from "./ci-incidents.js";
import { loadEscalationLinkSecret, type EscalationOption, type EscalationOptionRoute } from "./escalate.js";
import { classifyAskRecordItem } from "./ask-classification.js";
import { buildRecentRoute, buildStatusRoute, buildStatusStream, DEFAULT_POLL_MS, type BoardDeps } from "./board.js";
import { buildBatchedGithub, type GhFailureReason, type GitHub } from "./status.js";
import { buildInstanceGatewayRoutes, CORE_INSTANCE, watchInstanceLiveness, type InstanceGatewayOptions } from "./instance-gateway.js";
import { buildOperatorAgentAnswer, buildOperatorAgentAnswerRoute, readInboxAnswerEvidence } from "./operator-agent-answer.js";
import {
  buildAnswerQuestionRoute,
  buildApproveManualRoute,
  buildControlStatusRoute,
  buildDrainFeedbackRoute,
  buildDrainNowRoute,
  buildEscalationLinkAnswerRoute,
  buildEscalationLinkConfirmRoute,
  buildEscalationMarkHandledRoute,
  buildEscalationReplyRoute,
  buildKickRoute,
  buildMergeHoldRoute,
  buildPauseRoute,
  buildPrActionRoute,
  buildQuietHoursRoute,
  buildResumeRoute,
  buildStopRoute,
  bearerTokenId,
  jsonAction,
  sendJson,
  type ControlStatusDeps,
  type IssueCloser,
  type PanelActionDeps,
} from "./panel-actions.js";
import { buildPanelGraphRoutes, inboxThreadStorePath, ratifyCliGateway, type PanelGraphDeps } from "./panel-graph.js";
import { buildPanelSkillsRoutes } from "./panel-skills.js";
import { buildPanelSkillRunRoutes } from "./panel-skill-run.js";
import { buildRepoDashboardRoute } from "./repo-dashboard-route.js";
import { buildTaskCardRoute } from "./task-card.js";
import { buildAddOperatorNoteRoute, buildListOperatorNotesRoute } from "./operator-notes.js";
import { buildOperatorAgentRoutes, createOperatorAgentMemorySource, type OperatorAgentMemorySource } from "./operator-agent.js";
import { buildContextControlsRoutes } from "./context-controls.js";
import { createLastSeenStore, lastSeenPath, type LastSeenStore } from "./last-seen.js";
import {
  buildDaemonHealthRoute,
  createEventLoopLagMonitor,
  type DaemonHealthDeps,
  type EventLoopLag,
  type GatewayCheckoutState,
} from "./daemon-health.js";
import {
  evaluateIncidentInvariants,
  eventLoopLagLedgerLine,
  invariantFindingLedgerLine,
  type IncidentInvariantRow,
} from "./incident-invariants.js";
import { checkServiceFreshness } from "./self-sync.js";
import { changedPathsSince, serveRestartRelevant, type ChangedPathsRead, type ChangedPathsReader } from "./serve-restart-relevance.js";
import { buildAccountUsageRoute, type AccountUsageDeps } from "./account-usage.js";
import { readProviderRoutingStatus, type ProviderRoutingStatus } from "./provider-routing-status.js";
import {
  ProviderRoutingPolicyError,
  clearProviderRoutingPolicyOverride,
  resolveProviderRoutingPolicy,
  writeProviderRoutingPolicyOverride,
  type ProviderRoutingPolicyOverrideInput,
} from "./provider-routing-policy.js";
import { appendLedger } from "./ledger.js";
import {
  buildAnalyticsRoute,
  coldAnalyticsSnapshot,
  createAnalyticsSnapshotCache,
  type AnalyticsSnapshot,
  type AnalyticsSnapshotCacheDeps,
} from "./analytics-route.js";
import type { LiveAnalyticsMetrics } from "./analytics-live-metrics.js";
import { createLiveAnalyticsSnapshotCache, type LiveAnalyticsSnapshotCacheOptions } from "./live-analytics-snapshot-cache.js";
import { inboxDigestsPath } from "./digest.js";
import { readLedgerLines } from "./status.js";
import { buildReplay, resolveReplayLedgerLines, type ReplayLedgerRead } from "./ledger-replay.js";
import { latestMeasurementRows, type LatestMeasurementRowsResult } from "./measurement-cadence.js";
import type { LedgerUnionResult } from "./ledger-grep.js";
import type { BoardRow, BoardSnapshot } from "./board.js";
import {
  startInstallationTokenRefresh,
  TOKEN_REFRESHED_STEP,
  TOKEN_REFRESH_FAILED_STEP,
  type RefreshOptions,
} from "./github-app.js";
import {
  createGitHubEventWakeHandler,
  createPersistentDeliveryDedupStore,
  createWakeCounters,
  githubDeliveryDedupPath,
  startWakeSummaryFlush,
  sweepWakeMarkerPath,
  wakeSummaryRow,
  type CheckRunCompletedInfo,
  type GithubEventWakeSemanticMode,
  type WakeCounters,
} from "./github-event-wake.js";
import { DEFAULT_GITHUB_EVENT_WAKE_DEDUP_CAPACITY } from "./policy.js";
import { loadConfig, type WorkerProviderId } from "./config.js";
import type { Config, ModelApproval } from "./config-schema.js";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { createConsoleSnapshotStore } from "./console-snapshot-store.js";
import {
  createConsoleSnapshotCache,
  createConsoleWriteGeneration,
  invalidateSnapshotsOnWrite,
  prewarmReadRoutes,
  RouteResponseBuffer,
  sendStaleJson,
  type ConsoleResponseStaleness,
  type ConsoleSnapshotCacheOptions,
} from "./console-snapshot-cache.js";
import { operatorIdentityFromFile, type OperatorIdentityFileIo } from "./operator-identity-file.js";
import {
  DEFAULT_HOST_INSTANCE_REGISTRY_PATH,
  InstanceRegistryError,
  parseInstanceNames,
  parseInstanceRegistry,
  projectRegistry,
  registryDrift,
  type InstanceRegistry,
  type RegistryDrift,
} from "./instance-registry.js";
import { daemonInstanceRegistryPath } from "./deployer.js";
import { onboardingReadiness, type OnboardingReadinessGateway, type OnboardingRegistryRead } from "./onboarding-readiness.js";
import {
  buildProviderAuthRoutes,
  ProviderAuthSessionStore,
  readProviderAuthProfiles,
  startProviderAuthSession,
  type ProviderAuthProfile,
} from "./provider-auth-sessions.js";

/**
 * One escalation option's RENDER-READY affordance (W1-T2273) — what a console UI needs to draw
 * either a button (route + payload + the tier that gates it) or the "operator only, no button"
 * marker, for ONE {@link EscalationOption}.
 *
 * Resolved PURELY off `option.kind` (escalate.ts) — `option.label`/`option.detail` ride along
 * on the result UNCHANGED (note (xiv): the prose survives on every option, including the ones
 * that are operator-only) but are never CONSULTED to decide `executable`. This is note (iii)'s
 * "renderer stays dumb": the vocabulary an option's shape is drawn from lives in exactly ONE
 * place — the `kind` escalate.ts's emitter already validated via `validateEscalationOptionKind`
 * — never re-derived here by matching words in the prose against a route, which would put the
 * same vocabulary in two places and let them drift (the two-enumerator defect this repo has
 * already paid for elsewhere). An option with no `kind` (every producer this task did not
 * touch — run-task.ts, triage.ts — none is in this task's own file scope) resolves exactly like
 * one explicitly marked `operator-only`: today's behavior, unchanged.
 */
export type EscalationOptionAffordance =
  | {
      readonly executable: true;
      readonly route: EscalationOptionRoute;
      readonly tier: WriteTier;
      readonly payload: Readonly<Record<string, unknown>>;
      readonly label: string;
      readonly detail: string;
    }
  | { readonly executable: false; readonly label: string; readonly detail: string };

/** See {@link EscalationOptionAffordance}. */
export function resolveEscalationOptionAffordance(option: EscalationOption): EscalationOptionAffordance {
  const kind = option.kind;
  if (kind !== undefined && kind.type === "executable") {
    return {
      executable: true,
      route: kind.route,
      tier: kind.tier,
      payload: kind.payload ?? {},
      label: option.label,
      detail: option.detail,
    };
  }
  return { executable: false, label: option.label, detail: option.detail };
}

/** Default `rmd serve` port. */
export const DEFAULT_SERVE_PORT = 4317;

export interface ServeDeps {
  consoleSnapshots?: { dir: string; prewarmPaths?: readonly string[] };
  /** Injectable ONLY so a unit test can pin the captured sha; real callers omit it and get
   *  {@link resolveConsoleSha}, resolved once at server start. */
  consoleSha?: string;
  /**
   * W1-T996 — the Cloudflare Access team domain and AUD tag. Defaulted from `loadConfig()` inside
   * {@link buildServeServer} rather than threaded from `serveCommand`, so the ONE production call
   * site stays this module's own and no caller changes. Injectable so a test states them without
   * a config file on disk.
   *
   * ⚠ BOTH OR NEITHER — see {@link accessIdentityProviders}. Absent either, no provider is
   * composed at all, and `createService`'s built-in order is byte-identical to before.
   */
  accessTeamDomain?: string;
  accessAudience?: string;
  /**
   * W1-T4244 — the console operator's Clerk session identity (`serve.operatorIdentity`). Defaulted
   * from `loadConfig()` inside {@link buildServeServer} exactly like the Access values above;
   * injectable so a test states it without a config file. Absent: no operator provider, and
   * every request is authorised exactly as before this task.
   */
  operatorIdentity?: OperatorIdentityConfig;
  /** The key-set fetch and clock the operator provider uses — injectable so a test is hermetic. */
  operatorIdentityIo?: { fetchImpl?: typeof fetch; clock?: Clock };
  /** W1-T2562: re-resolve the CURRENT on-disk sha for the shell's staleness chip. Defaults to
   *  {@link resolveConsoleSha} — the same primitive {@link gateStaleCodeExit} compares against. */
  resolveCurrentSha?: () => string;
  board: BoardDeps;
  /** Read-only projection of the host's model approvals; no other config field crosses the status wire. */
  modelApprovals?: readonly ModelApproval[];
  /**
   * `plan/feedback/` + `plan/tasks.yaml` root and GitHub trace gateway (panel-graph.ts).
   * Deliberately `Omit<..., "inboxRoot">` — {@link buildServeRoutes} supplies `inboxRoot`
   * itself (= `fleetControlRoot`, config.root) the SAME way it already splits `fleetControlRoot`
   * vs `questionsRoot` for panel-actions.ts, so a `ServeDeps` caller names each root exactly
   * once, never a duplicate that could drift from `fleetControlRoot`.
   *
   * `ratify` is likewise OPTIONAL here (W1-T193): {@link buildServeRoutes} defaults it to a REAL
   * {@link ratifyCliGateway} rooted at `panelGraph.root` + `<fleetControlRoot>/state/logs` when
   * the caller doesn't supply one — the same "the assembler wires the real gateway, a test
   * injects a fake" split `inboxRoot` above already follows, so `rmd serve`'s own CLI wiring
   * (run-task.ts's `serveCommand`) never has to construct this gateway itself, and a test can
   * still inject a fake by supplying `ratify` explicitly.
   */
  panelGraph: Omit<PanelGraphDeps, "inboxRoot" | "ratify"> & { ratify?: PanelGraphDeps["ratify"] };
  /** `<root>/state/ledger.ndjson` — SAME path board.ts tails and every panel route ledgers into. */
  ledgerPath: string;
  /** `gh issue close` gateway shared by every panel-actions write route that needs it. */
  issues: IssueCloser;
  /** Fleet-control flag-file root — MUST equal the `config.root` `rmd daemon`/`rmd drain` check (see module header). */
  fleetControlRoot: string;
  /** `plan/questions.ndjson` root — MUST equal the `repoRoot` `appendQuestion` writes into (see module header). */
  questionsRoot: string;
  tokens: ServiceTokens;
  /** Board SSE poll pace; defaults to board.ts's own `DEFAULT_POLL_MS` (250ms, the W3-T2 2s acceptance bar). */
  pollMs?: number;
  /**
   * W1-T154: how often {@link prewarmBoardGithub}'s background timer re-warms `board.github`.
   * Defaults to {@link DEFAULT_BOARD_PREWARM_MS} (matches `buildBatchedGithub`'s own default TTL
   * in status.ts, so the background refresh lands right as the gateway's cache would otherwise
   * go stale). Only meaningful for a gateway implementing {@link GitHub.warm}; a no-op otherwise.
   */
  boardGithubRefreshMs?: number;
  /**
   * W1-T183: per-phase elapsed-time ANOMALY thresholds (ms), keyed by {@link Phase} (plus a
   * `default` fallback for a phase not listed) — DATA, not a constant baked into the row
   * template, so an operator (or a test) can tune "how long is too long" without a source
   * change. Defaults to {@link DEFAULT_PHASE_ELAPSED_THRESHOLDS_MS} when omitted. Embedded
   * verbatim into the shell's own script (see {@link renderShellHtml}) — the anomaly check
   * itself runs client-side, over the SAME `elapsedMs`/`phase` fields NOW rows already render
   * (W1-T155), never a new server-side derivation.
   */
  phaseElapsedThresholdsMs?: Record<string, number>;
  /** Forwarded to `createService` — one ledger line per auth decision/SSE lifecycle/handler error. */
  log?: ServiceOptions["log"];
  /**
   * W1-T163: the per-token "since you last checked" marker store (lib/last-seen.ts), shared with
   * `rmd digest`'s own marker-aware send (lib/digest.ts's `sendMarkerAwareDigest`) so a pushed
   * digest and the console's pulled recap read/advance the SAME per-token state — "push and pull
   * tell one story." OPTIONAL here the same way `panelGraph.ratify` is (see that field's own
   * doc): {@link buildServeRoutes} defaults it to a REAL store rooted at `<fleetControlRoot>/
   * state/last-seen.json` when the caller doesn't supply one, so `rmd serve`'s CLI wiring never
   * has to construct it itself, and a test can still inject a fake by supplying it explicitly.
   */
  lastSeen?: LastSeenStore;
  /**
   * W1-T159: the GLANCE layer's daemon-health widget deps (disk-free path + injectable
   * statfs/gh-exec/clock — see daemon-health.ts's own doc for each field's real source).
   * OPTIONAL and defaults to `diskPath: fleetControlRoot` with the real `fs.statfsSync`/real
   * `gh api rate_limit` when the caller doesn't supply one — the SAME "the assembler wires the
   * real gateway, a test injects a fake" split every other optional ServeDeps field already
   * follows (see `panelGraph.ratify`/`lastSeen`'s own docs, above).
   */
  daemonHealth?: Omit<DaemonHealthDeps, "ledgerPath" | "diskPath"> & { diskPath?: string };
  /** W1-T4229: defaults to {@link assessGatewayCheckout} over {@link serveRepoDir}. */
  gatewayCheckout?: () => Promise<GatewayCheckoutAssessment>;
  staleExitSeams?: Pick<StaleCodeExitDeps, "scheduleRecheck" | "exit">;
  /**
   * W1-T288: GET /v1/control/status's daemon-liveness verdict deps (injectable ledger reader /
   * clock / liveness bound — see panel-actions.ts's `ControlStatusDeps` for each field's real
   * source). OPTIONAL and defaults to the real `readLedgerLines`/`Date.now`/
   * `DEFAULT_LIVENESS_BOUND_MS` when the caller doesn't supply one, the SAME "the assembler
   * wires the real thing, a test injects a fake" split `daemonHealth` above already follows.
   */
  controlStatus?: Omit<ControlStatusDeps, "root" | "ledgerPath">;
  /**
   * The ACCOUNT strip's deps (see account-usage.ts's header). OPTIONAL and defaults to the real
   * `~/.claude.json` + `Date.now`, exactly like `daemonHealth` above — the assembler wires the
   * real reader, a test injects a captured one. The `ledgerPath` half is always the console's own,
   * never a caller's, so the governor posture can never come from a different ledger than the
   * rest of the page.
   */
  accountUsage?: Omit<AccountUsageDeps, "ledgerPath">;
  /**
   * Read-only provider-routing projection. The real reader is rooted at `fleetControlRoot`;
   * tests may inject a clock/reader without giving the console any provider credentials.
   */
  providerRouting?: {
    now?: () => number;
    read?: (root: string, deps?: { now?: () => number }) => ProviderRoutingStatus;
  };
  /** Server-owned provider browser-auth profiles and session store. Credential homes remain on the
   * daemon; the browser receives only provider-auth-v1 projections. */
  providerAuth?: {
    profiles?: readonly ProviderAuthProfile[];
    store?: ProviderAuthSessionStore;
    env?: NodeJS.ProcessEnv;
  };
  /**
   * W1-T3352: process-owned analytics refresh deps. OPTIONAL and defaults to the real streaming
   * rotation-union reducer. The state directory and telemetry sink are always the console's own;
   * callers can inject the reader/clock/timers but cannot point this cache at a second state root.
   */
  analytics?: Omit<AnalyticsSnapshotCacheDeps, "stateDir" | "log">;
  /** Process-owned filesystem snapshots for the live analytics fields; never request-time readers. */
  liveAnalytics?: Omit<LiveAnalyticsSnapshotCacheOptions, "root">;
  /** Already-captured process-owned live signals for `/v1/analytics`; never a request-time reader. */
  liveMetrics?: () => LiveAnalyticsMetrics;
  /**
   * W1-T371: additive tailnet-identity auth — forwarded verbatim to `createService`'s
   * `identity` option (see service.ts's {@link IdentityAuth} for the two gates it enforces).
   * OPTIONAL and omitted by default: an install that never sets `config.serve.identityCapability`
   * (see serveCommand, run-task.ts) gets identity never consulted at all — byte-for-byte the
   * pre-W1-T371 token-only behavior, so a Tailscale failure (or simply never opting in) degrades
   * to the token rather than locking the operator out.
   */
  identity?: ServiceOptions["identity"];
  /**
   * W1-T500: the {@link ConfirmNonceStore} both `POST /v1/confirm` (mounted by
   * {@link buildServeRoutes}) and `createService`'s own dispatch (`enforceWriteTiers`'s HIGH-tier
   * check) must consult -- the SAME instance, or a route issuing into one store and a dispatch
   * consuming from another would refuse every nonce it just issued. {@link buildServeServer}
   * resolves this ONCE (a fresh {@link createConfirmNonceStore} when omitted) and threads that one
   * instance to both. OPTIONAL here the same way `lastSeen` above is: a test can inject its own to
   * assert on a known nonce; `rmd serve`'s own CLI wiring never has to construct one itself.
   */
  confirmNonces?: ConfirmNonceStore;
  /**
   * W1-T945: `GET /v1/peek`'s read root + liveness predicate. `root` defaults to
   * `fleetControlRoot` (config.root) — the SAME root W1-T942's tail writer resolves
   * `state/runs/<runId>.tail` against (`buildWorkerStateSensor`, run-task.ts), never a second
   * root. `isLive` defaults to a predicate that never claims LIVE, so a caller that omits it (a
   * bare test) gets an honest FINISHED rather than a fabricated liveness signal. Real wiring
   * (`serveCommand`, run-task.ts) always supplies `isLive` as a closure over the REAL
   * `liveInflightRuns` — the SAME pid-checked read every other liveness decision in this
   * codebase uses (design note ii), never a second definition of "in flight" declared here.
   */
  peek?: { root?: string; isLive?: (runId: string) => boolean };
  /**
   * W1-T2578: `GET /v1/replay`'s ledger-corpus read. `stateDir` defaults to
   * `dirname(deps.ledgerPath)` — the SAME derivation `replayCommand`'s own CLI wiring uses
   * (run-task.ts: `dirname(ledgerPathFor(loadConfig()))`), never a second root. Both fields are
   * injectable so a test drives the resolved-lines and refused (`ok: false`) paths without a
   * real state dir — the same seam `ReplayRouteDeps` (below) and `peek` (above) both use.
   */
  replay?: { stateDir?: string; resolveReplayLedgerLines?: (stateDir: string) => ReplayLedgerRead };
  /**
   * W1-T2660: `GET /v1/self-measurement`'s ledger-corpus read. `stateDir` defaults to
   * `dirname(deps.ledgerPath)` — the SAME derivation `replay` (above) already uses, never a
   * second root. `n` bounds how many of the newest `measurement_cadence.ran` rows the reader
   * ({@link latestMeasurementRows}, measurement-cadence.ts) returns; the panel needs at least
   * two per verb (latest + previous), so the default reads a handful more than
   * `plan/policy.yaml`'s own `measurementCadence.maxPerDay: 4` rather than exactly two. Both
   * fields are injectable so a test drives the "unreadable" (`ok: false`) union path without a
   * real state dir — the same seam `replay`/`peek` above both use.
   */
  selfMeasurement?: { stateDir?: string; n?: number; ledgerUnion?: (stateDir: string, pattern: RegExp) => LedgerUnionResult };
  /**
   * W1-T4387: `GET /v1/incidents`'s inputs. `stateDir` defaults to `dirname(deps.ledgerPath)` —
   * the SAME derivation `replay`/`selfMeasurement` above already use, never a second root.
   * `readStore` is injectable so a test drives the "unreadable" (`ok: false`) path without a real
   * state dir — the same seam those two fields already use.
   */
  incidents?: Omit<IncidentsRouteInput, "stateDir"> & { stateDir?: string };
  /** W1-T4227: `GET /v1/registry`'s inputs; the repo path defaults via `daemonInstanceRegistryPath`. */
  registry?: {
    /** The repo-tracked `.remudero/daemon-instances.yaml` — the one registry. */
    repoRegistryPath?: string;
    /** The fleet host's copy; defaults to {@link DEFAULT_HOST_INSTANCE_REGISTRY_PATH}. */
    hostRegistryPath?: string;
    clock?: Clock;
    /** Async on purpose: a console read route never blocks the event loop (W1-T3192's census). */
    readText?: (path: string) => Promise<string>;
  };
  /** W1-T4264: `GET /v1/onboarding/readiness`'s inputs; `gateway` defaults to the real GitHub reads. */
  onboardingReadiness?: {
    gateway?: OnboardingReadinessGateway;
    repoRegistryPath?: string;
    readText?: (path: string) => Promise<string>;
  };
  instances?: InstanceGatewayOptions;
  /**
   * W1-T2269: the console's OWN installation-token refresh loop — the SAME mechanism
   * `run-task.ts`'s `serveCommand` already arms for the daemon (`github-app.ts`'s
   * `startInstallationTokenRefresh`), run here instead in the CONSOLE's own process against the
   * console's own environment. It talks directly to GitHub's token-exchange endpoint and NEVER
   * calls the daemon — design (ii) refuses any renewal path that would couple the console's
   * `--restart=unless-stopped` lifetime to the daemon's. Gated on config presence exactly like
   * the daemon's own call: a console with no `GH_APP_ID`/`GH_APP_INSTALLATION_ID`/
   * `GH_APP_PRIVATE_KEY_PATH` in its environment (the console's default today — see
   * `deploy/serve-container.sh`) is byte-identical to before this task, zero timers, zero ledger
   * lines. OPTIONAL and defaults to the real `startInstallationTokenRefresh` against real
   * `process.env`; a test injects a fake `start` (and/or a throwaway `env`) so it never mints a
   * real token or opens a real timer.
   */
  githubAppRefresh?: {
    start?: typeof startInstallationTokenRefresh;
    env?: NodeJS.ProcessEnv;
  };
  /**
   * W1-T2568: `POST /v1/hooks/github`'s config — the signed GitHub-event wake (see
   * `lib/github-event-wake.ts`'s module header for the full design). OPTIONAL and SHIPS DARK
   * (design vii) when omitted, or whenever `secret` resolves to `undefined` — the route still
   * mounts (so a probe gets a named `webhook_not_configured` refusal rather than a 404 that
   * reads like a routing typo) but writes no marker and accepts nothing. `secret` is normally
   * resolved by `serveCommand` (run-task.ts) from an operator-mounted file
   * (`RMD_GITHUB_WEBHOOK_SECRET_FILE`, see `resolveGithubWebhookSecretFilePath`/
   * `readGithubWebhookSecret`) — this field never reads the file itself, so a test can inject a
   * literal secret without touching disk. `repository` has no default here (deliberately — the
   * assembler, never this library, decides what "this daemon's own repo" means); `serveCommand`
   * always supplies `${self.owner}/${self.repo}`, the SAME `resolveOwnerRepo()` result the rest
   * of that command already uses. `dedupCapacity` defaults to
   * `DEFAULT_GITHUB_EVENT_WAKE_DEDUP_CAPACITY` (policy.ts) when omitted — `serveCommand` reads
   * the real `plan/policy.yaml` row so the console never carries a second, drifting copy of that
   * bound.
   */
  githubEventWake?: {
    secret?: string;
    repository: string;
    dedupCapacity?: number;
    semanticCheckMode?: GithubEventWakeSemanticMode;
    aggregateCheckNames?: readonly string[];
    counters?: WakeCounters;
  };
  /** W1-T4391: CI-flake producer seams; each defaults to the real job-log read, "main" and the system clock. */
  ciIncidents?: {
    fetchJobLog?: (repository: string, jobId: number) => string | Promise<string>;
    mainBranch?: string;
    clock?: Clock;
  };
  incidentInvariants?: {
    intervalMs?: number;
    readLedger?: (path: string) => ReadonlyArray<IncidentInvariantRow>;
    writeLedger?: typeof appendLedger;
    eventLoopLag?: () => EventLoopLag | undefined;
    clock?: Clock;
    setInterval?: typeof setInterval;
    clearInterval?: typeof clearInterval;
  };
}

/**
 * What the console currently knows about its own GitHub credential's renewability — never the
 * credential itself (design iii: no secret reaches a log line, a ledger row, or disk, and that
 * includes this state, which carries only a reason string github-app.ts itself already ledgers).
 */
export interface GithubCredentialState {
  /** Whether this process armed its own in-process refresh loop. `false` means the console's
   *  `GH_TOKEN`, whatever value it holds, is fixed for this process's entire life — no App
   *  config was present to renew it from (claim: "a credential that cannot be replaced is
   *  reported by the console rather than presented as a working board"). */
  armed: boolean;
  /** The reason string of the most recent FAILED refresh attempt, cleared the next time a
   *  refresh succeeds. Absent when `armed` is false (no attempt was ever made) or no attempt has
   *  failed yet. Only ever a fixed reason string — see {@link GithubCredentialState}'s own doc. */
  lastFailureReason?: string;
}

export interface ConsoleInboxDigestEntry {
  ts: string;
  text: string;
}

export interface ConsoleInboxDigests {
  entries: ConsoleInboxDigestEntry[];
  omitted: number;
  reason?: string;
}

/** PRIMARY CONTROL: the mailbox's daily-digest render window. */
export const CONSOLE_INBOX_DIGEST_LIMIT = 10;
function emptyConsoleInboxDigests(): ConsoleInboxDigests {
  return { entries: [], omitted: 0 };
}

function isConsoleInboxDigestEntry(value: unknown): value is ConsoleInboxDigestEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.ts === "string" && typeof entry.text === "string";
}

export function readConsoleInboxDigests(root: string, limit: number = CONSOLE_INBOX_DIGEST_LIMIT): ConsoleInboxDigests {
  if (limit <= 0) return emptyConsoleInboxDigests();
  try {
    if (!existsSync(inboxDigestsPath(root))) return emptyConsoleInboxDigests();
    const raw = JSON.parse(readFileSync(inboxDigestsPath(root), "utf8")) as unknown;
    if (!Array.isArray(raw)) return emptyConsoleInboxDigests();
    const valid = raw.filter(isConsoleInboxDigestEntry);
    const entries = valid.slice(Math.max(0, valid.length - limit));
    return { entries, omitted: Math.max(0, valid.length - entries.length) };
  } catch (error) {
    return { entries: [], omitted: 0, reason: String((error as Error)?.message ?? error) };
  }
}

export function buildInboxDigestsRoute(deps: { root: string; limit?: number; read?: (root: string, limit?: number) => ConsoleInboxDigests }): Route {
  return {
    method: "GET",
    path: "/v1/inbox/digests",
    scope: "read",
    handler: async (_req, res) => {
      if (deps.read) {
        sendJson(res, 200, deps.read(deps.root, deps.limit));
        return;
      }
      sendJson(res, 200, await readConsoleInboxDigestsAsync(deps.root, deps.limit));
    },
  };
}

async function readConsoleInboxDigestsAsync(root: string, limit: number = CONSOLE_INBOX_DIGEST_LIMIT): Promise<ConsoleInboxDigests> {
  if (limit <= 0) return emptyConsoleInboxDigests();
  try {
    const raw = JSON.parse(await fsPromises.readFile(inboxDigestsPath(root), "utf8")) as unknown;
    if (!Array.isArray(raw)) return emptyConsoleInboxDigests();
    const valid = raw.filter(isConsoleInboxDigestEntry);
    const entries = valid.slice(Math.max(0, valid.length - limit));
    return { entries, omitted: Math.max(0, valid.length - entries.length) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return emptyConsoleInboxDigests();
    return { entries: [], omitted: 0, reason: String((error as Error)?.message ?? error) };
  }
}

export interface ConsoleBlockingRequestPathViolation {
  route: string;
  symbol: string;
}

export const CONSOLE_READ_ROUTE_BUDGET_MS = 750;
export const CONSOLE_BLOCKING_REQUEST_PATH_BASELINE = 0;
export const CONSOLE_STATUS_FULL_TASK_THRESHOLD = 500; // PRIMARY CONTROL
export const CONSOLE_STATUS_RENDERED_TASK_LIMIT = 120; // BACKSTOP
export const CONSOLE_STATUS_RESPONSE_SIZE_RATCHET_BYTES = 96_000;
const CONSOLE_CACHED_READ_PATHS = new Set(["/v1/status", "/v1/recent", "/v1/inbox", "/v1/daemon-health", "/v1/repos"]);
const BLOCKING_REQUEST_PATH_SYMBOLS = [
  "readFileSync",
  "writeFileSync",
  "existsSync",
  "readdirSync",
  "execFileSync",
  "statSync",
  "openSync",
  "mkdirSync",
] as const;

export interface ConsoleStatusTaskProjection {
  complete: boolean;
  total: number;
  returned: number;
  omitted: number;
  limit: number;
  reason: string;
}

export interface ConsoleModelApproval {
  model: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt?: string;
  expired: boolean;
}

function projectModelApprovals(
  approvals: readonly ModelApproval[] | undefined,
  nowMs = systemClock.now(),
): ConsoleModelApproval[] {
  return (approvals ?? []).map((approval) => ({
    model: approval.model,
    approvedBy: approval.approvedBy,
    approvedAt: approval.approvedAt,
    ...(approval.expiresAt ? { expiresAt: approval.expiresAt } : {}),
    expired: approval.expiresAt !== undefined && Date.parse(approval.expiresAt) <= nowMs,
  }));
}

/** W1-T3394: `row.needsHuman` is one of the classifier's four source shapes — a needs-human
 *  escalation (escalate.ts, W1-T8/T77's BLOCKED-AMBIGUOUS disposition) — so routed through {@link
 *  classifyAskRecordItem} rather than read as a bare boolean here, even though today's only
 *  consumer (this initial-board cut) still just wants "does this need attention now". Byte-
 *  identical to the prior `row.needsHuman === true` check: `resolved` is the negation of the same
 *  flag, and the classifier's `escalation` arm is exactly `resolved ? RECORD : ASK`. This is the
 *  classifier's production call site (W1-T3395/W1-T3396 will consult it for the full NEEDS ME
 *  split; this task only needs it reachable from src, not from its own tests alone). */
function taskRendersOnInitialBoard(row: BoardRow): boolean {
  const escalationIsAsk = classifyAskRecordItem({ kind: "escalation", resolved: row.needsHuman !== true }) === "ASK";
  return row.phase !== undefined || escalationIsAsk || row.verifyHumanPending === true;
}

export function projectConsoleStatusResponse(
  body: unknown,
  modelApprovals?: readonly ModelApproval[],
  nowMs = systemClock.now(),
): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const source = body as BoardSnapshot & Record<string, unknown>;
  if (!Array.isArray(source.tasks)) return body;
  const total = source.counts && typeof source.counts === "object" && typeof (source.counts as { total?: unknown }).total === "number"
    ? (source.counts as { total: number }).total
    : source.tasks.length;
  const wholePlanFits = source.tasks.length <= CONSOLE_STATUS_FULL_TASK_THRESHOLD;
  const rendered = wholePlanFits ? source.tasks : source.tasks.filter(taskRendersOnInitialBoard).slice(0, CONSOLE_STATUS_RENDERED_TASK_LIMIT);
  const omitted = Math.max(0, total - rendered.length);
  const taskProjection: ConsoleStatusTaskProjection = {
    complete: omitted === 0,
    total,
    returned: rendered.length,
    omitted,
    limit: wholePlanFits ? CONSOLE_STATUS_FULL_TASK_THRESHOLD : CONSOLE_STATUS_RENDERED_TASK_LIMIT,
    reason: omitted === 0 ? "complete" : "bounded-to-initial-board-rows",
  };
  return { ...source, modelApprovals: projectModelApprovals(modelApprovals, nowMs), tasks: rendered, taskProjection };
}

function fallbackStatusSnapshot(deps: BoardDeps, nowMs: number, staleness: ConsoleResponseStaleness): BoardSnapshot & { staleness: ConsoleResponseStaleness } {
  // W1-T3925: `staleness.reason` only carries a value once `route.handler` has actually thrown
  // (see `refresh`'s `catch` below). Its absence here means the live read is simply still
  // running past budget — cold cache or an event-loop-blocked read, never observed to have
  // failed — so labelling it "transport" would fabricate a cause nobody saw (design note iv).
  const unavailableReason: GhFailureReason = staleness.reason ? "transport" : "not_yet_collected";
  const tasks: BoardRow[] = deps.plan.tasks.map((task) => ({
    taskId: task.id,
    title: task.title,
    risk: task.risk,
    status: "queued",
    merged: false,
    source: "throttled",
    indeterminate: true,
    unavailableReason,
  }));
  return {
    generated_at: fixedClock(nowMs).iso(),
    github_unreachable: true,
    counts: {
      total: tasks.length,
      running: 0,
      merged: 0,
      queued: tasks.length,
      blocked: tasks.filter((t) => t.needsHuman === true || t.status === "blocked").length,
      merged_known: false,
    },
    spend: { mergedToday: 0, channel: "fleet", spendTodayUsd: 0, spendWeekUsd: 0, sessionSpendUsd: null },
    tasks,
    blockedPrs: [],
    mergeHeld: [],
    prQueue: {
      complete: false,
      rows: [],
      unavailableReason: "console read cache has not produced a live status snapshot yet",
    },
    staleness,
  };
}

function fallbackBodyForCachedRead(path: string, deps: ServeDeps, staleness: ConsoleResponseStaleness): unknown {
  const nowMs = systemClock.now();
  const modelApprovals = deps.modelApprovals ?? [];
  switch (path) {
    case "/v1/status":
      return projectConsoleStatusResponse(fallbackStatusSnapshot(deps.board, nowMs, staleness), modelApprovals, nowMs);
    case "/v1/recent":
      return { entries: [], staleness };
    case "/v1/inbox":
      return { ready: [], drafting: [], notReady: [], staleness };
    case "/v1/daemon-health":
      return { pollIntervalMs: deps.daemonHealth?.defaultPollIntervalMs ?? DEFAULT_POLL_MS, staleness };
    default:
      return { staleness };
  }
}

export function projectConsoleStatusRoute(route: Route, modelApprovals?: readonly ModelApproval[]): Route {
  if (route.method !== "GET" || route.path !== "/v1/status") return route;
  return {
    ...route,
    handler: async (req, res, ctx) => {
      const buffer = new RouteResponseBuffer();
      await route.handler(req, buffer as unknown as import("node:http").ServerResponse, ctx);
      const buffered = buffer.buffered(systemClock.now());
      const contentType = buffered.headers["content-type"] ?? "";
      if (!/application\/json/i.test(contentType)) {
        res.writeHead(buffered.status, buffered.headers);
        res.end(buffered.body);
        return;
      }
      res.writeHead(buffered.status, buffered.headers);
      res.end(JSON.stringify(projectConsoleStatusResponse(JSON.parse(buffered.body), modelApprovals, buffered.generatedAtMs)));
    },
  };
}

export function consoleBlockingRequestPathViolations(routes: readonly Route[]): ConsoleBlockingRequestPathViolation[] {
  const violations: ConsoleBlockingRequestPathViolation[] = [];
  for (const route of routes) {
    if (route.method !== "GET" || route.scope !== "read") continue;
    if (route.selfAuthenticated) continue;
    const source = route.handler.toString();
    for (const symbol of BLOCKING_REQUEST_PATH_SYMBOLS) {
      if (new RegExp(`\\b${symbol}\\b`).test(source)) violations.push({ route: `${route.method} ${route.path}`, symbol });
    }
  }
  return violations;
}

export function boundConsoleReadRoute(
  route: Route,
  deps: ServeDeps,
  budgetMs: number = CONSOLE_READ_ROUTE_BUDGET_MS,
  options: Omit<ConsoleSnapshotCacheOptions, "budgetMs" | "fallbackBody"> = {},
): Route {
  if (route.method !== "GET" || route.scope !== "read" || !CONSOLE_CACHED_READ_PATHS.has(route.path)) return route;
  const fallbackBody = (staleness: ConsoleResponseStaleness) => fallbackBodyForCachedRead(route.path, deps, staleness);
  return { ...route, handler: createConsoleSnapshotCache(route, { ...options, budgetMs, fallbackBody }).handler };
}

export function boundConsoleReadRoutes(routes: readonly Route[], deps: ServeDeps, budgetMs: number = CONSOLE_READ_ROUTE_BUDGET_MS): Route[] {
  const generation = createConsoleWriteGeneration();
  const snapshots = deps.consoleSnapshots;
  const store = snapshots && createConsoleSnapshotStore({ dir: snapshots.dir, codeRev: deps.consoleSha ?? CONSOLE_SHA_UNKNOWN, log: deps.log });
  if (snapshots?.prewarmPaths) void prewarmReadRoutes(routes, snapshots.prewarmPaths, deps.log);
  return routes.map((route) => invalidateSnapshotsOnWrite(boundConsoleReadRoute(route, deps, budgetMs, { generation, store }), generation));
}

/**
 * Wrap a ledger `log` so every `github_app.token_refresh_failed` / `github_app.token_refreshed`
 * line it observes ALSO updates `state` IN PLACE — a live object {@link buildShellRoute}'s
 * handler (below) reads FRESH on every request, the same "read the state, don't cache a
 * snapshot" discipline that route's idle-reasons panel already follows (impl-FC). Every line is
 * forwarded to `log` completely UNCHANGED — this only ever OBSERVES what github-app.ts already
 * ledgers, never a second, divergent copy of its reasoning.
 */
function trackGithubCredentialState(
  log: RefreshOptions["log"] | undefined,
): { state: GithubCredentialState; log: (step: string, extra?: Record<string, unknown>) => void } {
  const state: GithubCredentialState = { armed: false };
  return {
    state,
    log: (step, extra) => {
      if (step === TOKEN_REFRESH_FAILED_STEP) {
        const reason = extra?.reason;
        state.lastFailureReason = typeof reason === "string" ? reason : "refresh failed";
      } else if (step === TOKEN_REFRESHED_STEP) {
        state.lastFailureReason = undefined;
      }
      log?.(step, extra);
    },
  };
}

/** Matches {@link buildBatchedGithub}'s own default `ttlMs` (status.ts) — kept as one named
 *  constant here rather than a bare literal so the two stay visibly the same number. */
export const DEFAULT_BOARD_PREWARM_MS = 15_000;

/**
 * W1-T999 — the serve board gateway's poll TTL, DERIVED FROM THE SWEEP DISTRIBUTION rather than
 * matching {@link buildBatchedGithub}'s bare 15s default the way {@link DEFAULT_BOARD_PREWARM_MS}
 * does. THE INCIDENT: `serveCommand` (run-task.ts) built its board gateway at that bare 15s
 * default against an always-on console, re-asking roughly ten times per sweep pass for an answer
 * that could not have changed between asks — 423 of 423 board fetches in the incident log failed,
 * retrying into the very secondary rate limit that outage held open for two hours.
 *
 * THE NUMBER. Re-measured at filing: the sweep's median pass is 2.6 minutes (156_000 ms) and its
 * p90 is 17 minutes. 150_000 ms sits AT (just under) the median — the board is never more than one
 * sweep behind while re-asking roughly once per sweep instead of ten times, and staying well under
 * the p90 keeps the board from reading as dead through the long tail. A round number was
 * deliberately NOT chosen; this is the median rounded down to keep the "never worse than one
 * sweep late" property exact rather than approximate.
 *
 * `serveCommand` threads this into BOTH `buildBatchedGithub`'s `ttlMs` and this module's own
 * `ServeDeps.boardGithubRefreshMs` (see {@link buildServeServer}), so the gateway's cache staleness
 * bound and the background prewarm cadence that re-warms it stay the SAME number rather than
 * drifting apart the way two independent literals would.
 */
export const DEFAULT_BOARD_POLL_TTL_MS = 150_000;

/**
 * W1-T183 default anomaly thresholds — how long a phase normally takes before a still-running
 * row is worth a second look. NOT a liveness verdict (W1-T179 owns "is this actually running");
 * purely a visual "this one is taking unusually long" flag. Keyed by status.ts's {@link Phase}
 * union, plus `default` for any value not listed (defensive — Phase is a closed set today, but
 * the client-side check is written against an arbitrary string key, never a hard-coded switch).
 */
export const DEFAULT_PHASE_ELAPSED_THRESHOLDS_MS: Record<string, number> = {
  recon: 15 * 60 * 1000,
  implement: 90 * 60 * 1000,
  review: 30 * 60 * 1000,
  "fix-rung": 45 * 60 * 1000,
  default: 60 * 60 * 1000,
};

/**
 * PRE-WARM (W1-T154, revised by the connected-client gate): schedule `github.warm()` (if it has
 * one — status.ts's `buildBatchedGithub` does) on a background tick, then every `refreshMs`.
 * `.unref()`'d so this never keeps a short-lived process (a test, a one-shot script) alive;
 * {@link buildServeServer} wires the returned `stop` function to the server's own `close` event
 * so the timer doesn't outlive it.
 *
 * THE FIRST WARM IS SCHEDULED FOR EVERY CALLER, WITH NO OPT-OUT (W1-T3192). `github.warm()`
 * resolves to a BLOCKING `gh pr list`, and this helper's ONLY production caller is
 * {@link gatePrewarmOnClients}, which invokes it from the 0 -> 1 viewer edge — an SSE request's
 * own handler. A synchronous warm there does not merely delay the connection that triggered it:
 * it holds the event loop for the whole round-trip to GitHub, so every concurrent request pays
 * too. That is the request-path block this task exists to remove, which is why the immediacy is
 * not a per-caller choice. `setTimeout(warm, 0)` keeps the warm immediate in background terms —
 * it lands well before the interval's first tick, so nothing goes colder than it was — while
 * handing the stream-open path straight back to the event loop. `stop()` cancels it, so a server
 * that closes before the warm fires never issues the fetch at all.
 */
export function prewarmBoardGithub(
  github: GitHub,
  refreshMs: number = DEFAULT_BOARD_PREWARM_MS,
  opts: { immediate?: boolean } = {},
): () => void {
  const warm = (): void => {
    try {
      github.warm?.();
    } catch {
      // The gateway records its own failure state; prewarming must never break stream open.
    }
  };
  // `immediate` DEFAULTS TRUE, so every existing caller is unchanged byte for byte.
  //
  // THE READ PATH PASSES FALSE, and the reason is measured. `warm()` is a blocking `gh pr list`;
  // on the SSE path it runs once per connection, but a read happens on every poll, so an immediate
  // warm there lands inside the very request that triggered it. Turning it on for reads without
  // this took test/serve.test.ts's 183-task first-paint from under its 2,000ms budget to 8,693ms —
  // the exact hazard W1-T3192 already scheduled this timeout to avoid, reintroduced on a hotter
  // path. The reader that starts the walk still pays its own cold read, exactly as today; every
  // poll after it finds the gateway warm.
  const first = opts.immediate === false ? undefined : setTimeout(warm, 0);
  first?.unref?.();
  const timer = setInterval(warm, refreshMs);
  timer.unref?.();
  return () => {
    if (first !== undefined) clearTimeout(first);
    clearInterval(timer);
  };
}

/**
 * GATE {@link prewarmBoardGithub} ON A CONNECTED CLIENT — the fix for the zero-viewer burn.
 *
 * WHAT WENT WRONG. W1-T154 wired the pre-warm timer UNCONDITIONALLY at `buildServeServer`, and
 * its own doc argued that was the point: "the gateway never goes cold again waiting on a request
 * to trigger its own refetch", client-independent by design. The cost of that design was never
 * bounded. `warm()` resolves to a `gh pr list --state all --limit 1000` — a GraphQL call — so a
 * `serve` process with NOBODY WATCHING still billed one every 15s, forever.
 *
 * MEASURED, 2026-07-28: a serve process left running unwatched for ~5.6 days issued 60 GraphQL
 * pr-list calls in the 17:26:08Z–17:46Z window against the daemon's 16 — 78.9% of ALL GraphQL
 * traffic on the account. At 4/min = 240/hr that projects to ~3,100 points/hour against a
 * 5,000/hour budget, roughly 62% of the entire allowance, spent rendering a board no human had
 * open. That exhaustion blinded the sweep for 22 consecutive minutes and delayed a PR review by
 * ~13 minutes.
 *
 * WHY THIS SEAM. `rmd serve` ALREADY has an exact notion of "a client is connected", and it is
 * not a heuristic: service.ts calls {@link SseRoute.subscribe} once per SSE connection and
 * invokes the unsubscribe it returns from that request's own `close` event. Refcounting those
 * two edges is therefore the connection count, not a proxy for it — no new tracking layer, no
 * heartbeat, no socket bookkeeping of our own.
 *
 * THE CONTRACT, precisely:
 *   - zero clients            -> no timer, and `warm()` is never called at all
 *   - 0 -> 1 clients          -> warm ONCE on the next tick (never on the subscriber's own
 *                                stack — see {@link prewarmBoardGithub}), then every `refreshMs`
 *   - 1 -> 2 clients          -> nothing changes; ONE timer serves every viewer
 *   - last client disconnects -> `clearInterval`, no dangling handle
 *   - reconnect after idle    -> warms again on the next tick, exactly like the first connect
 *
 * DELIBERATE BEHAVIOUR CHANGE, stated rather than hidden: the BOOT-time warm is gone. A
 * `GET /v1/status` that arrives before any SSE client has connected now pays its own fetch on
 * the request path, which is what W1-T154 originally set out to avoid. That is a first-request
 * latency cost, never a correctness one — `buildBatchedGithub` fetches lazily on demand and
 * `warm()` only forces that same `index()` early. Paying it on the rare
 * request-before-any-viewer is the entire point: the alternative is paying it 5,760 times a day
 * for nobody.
 */
export function gatePrewarmOnClients(
  route: SseRoute,
  github: GitHub,
  refreshMs: number = DEFAULT_BOARD_PREWARM_MS,
  deps: { clock?: Clock; setInterval?: typeof setInterval; clearInterval?: typeof clearInterval } = {},
): { route: SseRoute; stop: () => void; noteRead: () => void } {
  let clients = 0;
  let stopPrewarm: (() => void) | undefined;
  const clock = deps.clock ?? systemClock;
  const setTimer = deps.setInterval ?? setInterval;
  const clearTimer = deps.clearInterval ?? clearInterval;
  let lastRead: number | undefined;
  let idleCheck: ReturnType<typeof setInterval> | undefined;

  const stop = (): void => {
    stopPrewarm?.();
    stopPrewarm = undefined;
    if (idleCheck !== undefined) {
      clearTimer(idleCheck);
      idleCheck = undefined;
    }
  };

  const start = (immediate: boolean): void => {
    if (stopPrewarm === undefined) stopPrewarm = prewarmBoardGithub(github, refreshMs, { immediate });
  };

  /**
   * A POLLING READER IS A VIEWER. The product console reads `GET /v1/status` on a timer and never
   * opens the SSE stream, so `clients` was 0 forever and the warm walk never started — every
   * request paid the cold GitHub walk synchronously on the main thread. MEASURED 2026-09-16 on the
   * live daemon, 39 minutes after boot, so this is not a cold-start effect:
   *
   *     /v1/status         66-80s
   *     /v1/inbox          64-100s (one timed out)
   *     /v1/daemon-health  64.5s   <- 296 bytes, queued behind the above
   *
   * This is the SAME blind spot W1-T3610 fixed for the recycle gate, which also counted only
   * subscribers and also concluded nobody was watching while an operator sat reading.
   *
   * NOT A WEAKENING OF W1-T154's GATE. Its purpose is that an UNWATCHED daemon must not burn
   * GitHub quota on a timer for nobody, and that still holds exactly: no subscriber and no recent
   * read means no prewarm. A reader is simply not "nobody".
   */
  const noteRead = (): void => {
    lastRead = clock.now();
    start(false);
    if (idleCheck !== undefined) return;
    // THE IDLE BOUND IS DERIVED, NOT INVENTED: if nobody has read within one refresh cycle, the
    // next refresh would be for nobody, which is precisely what the gate exists to prevent. Tying
    // it to `refreshMs` means there is no second number to keep in step with the first.
    idleCheck = setTimer(() => {
      if (clients > 0) return;
      if (lastRead !== undefined && clock.now() - lastRead <= refreshMs) return;
      stop();
    }, refreshMs);
    idleCheck.unref?.();
  };

  return {
    stop,
    noteRead,
    route: {
      ...route,
      subscribe: (send) => {
        const unsubscribe = route.subscribe(send);
        clients += 1;
        // 0 -> 1 ONLY. A second viewer must not start a second timer (which would double the
        // very call rate this exists to bound) and must not re-warm off-cadence. `start` is
        // idempotent, so a subscriber arriving while a reader already warmed it changes nothing.
        if (clients === 1) start(true);
        let released = false;
        return () => {
          // service.ts invokes this exactly once per connection, but a defensive latch keeps a
          // double-release from underflowing the count — a negative count would never reach 0
          // again and would strand the timer running with zero viewers, which is the bug.
          if (released) return;
          released = true;
          unsubscribe();
          clients -= 1;
          // A READER MAY STILL BE WATCHING. Stopping on the last subscriber alone would undo the
          // warm walk under a polling console that never subscribed in the first place.
          if (clients === 0 && (lastRead === undefined || clock.now() - lastRead > refreshMs)) stop();
        };
      },
    },
  };
}

/** The checkout this process's code was loaded from — `src/lib/serve.ts` walks up three levels. */
export function serveRepoDir(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}
/** What {@link resolveConsoleSha} reports when the sha genuinely cannot be resolved. */
export const CONSOLE_SHA_UNKNOWN = "unknown";
/**
 * The sha of the CODE THIS CONSOLE PROCESS LOADED — resolved ONCE, from the directory the running
 * module was loaded from (`import.meta.url`), never from cwd and NEVER re-read per request.
 *
 * WHY THAT MATTERS MORE THAN IT LOOKS. `rmd serve` loads its code once via tsx and the deploy
 * supervisor's console restart sits behind a short-circuit a manual checkout pull consumes, so the
 * console can serve days-old code against a current checkout — observed running 3f6a1d1 while the
 * checkout was a0d96a9, and serving 2026-07-29 code through every merge for two days. A version
 * re-read from the checkout at request time would ALWAYS match the checkout and therefore always
 * look current: it would rebuild the very bug this exists to detect. Captured at start, it cannot.
 *
 * This mirrors the daemon's `bootHeadSha` (PR #1054, src/run-task.ts) exactly in intent — the
 * loaded module's own directory — adjusted for depth: that call site is `src/run-task.ts` and
 * walks up two levels; this file is `src/lib/serve.ts` and therefore walks up three.
 *
 * NEVER FATAL. Every failure mode (no git, no repo, detached, git absent from PATH) returns
 * {@link CONSOLE_SHA_UNKNOWN}. The console is the operator's live diagnostic surface; a console
 * that will not start is strictly worse than one that cannot name its own sha.
 */
export function resolveConsoleSha(
  exec: (dir: string) => string = (dir) =>
    execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).toString(),
): string {
  try {
    const sha = exec(serveRepoDir()).trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : CONSOLE_SHA_UNKNOWN;
  } catch {
    return CONSOLE_SHA_UNKNOWN;
  }
}
/**
 * W1-T2229: `bootSha` (captured once, {@link resolveConsoleSha}) vs `currentSha` (the SAME
 * primitive called again, fresh, at the moment this runs) — the whole trigger design (i) asks
 * for: a comparison, never a timer. {@link CONSOLE_SHA_UNKNOWN} on EITHER side means "can't
 * tell", and an unresolved sha is never read as evidence of drift — a transient git failure (no
 * git on PATH, detached HEAD, an unreadable repo) degrades to "assume fresh", never to an exit
 * decided on a guess. Design (vi)'s pin — "a console whose boot sha still matches the tree never
 * exits" — holds for the degenerate case where both sides independently failed to resolve, too:
 * `unknown === unknown` is EQUAL, not stale.
 */
export function isConsoleCodeStale(bootSha: string, currentSha: string): boolean {
  if (bootSha === CONSOLE_SHA_UNKNOWN || currentSha === CONSOLE_SHA_UNKNOWN) return false;
  return bootSha !== currentSha;
}
/**
 * How far behind the running code is, as a count of commits — the "how much" half of change
 * pressure, against {@link consoleRecyclePatienceMs}'s "how long".
 *
 * NEVER FATAL, and never a network read: the on-disk checkout is already advanced by the daemon's
 * own sync, so this is a local `rev-list`. Every failure mode returns `undefined`, which
 * {@link consoleRecyclePatienceMs} reads as "no pressure evidence" and therefore as maximum
 * patience — an unreadable backlog must never become a reason to interrupt an operator.
 */
export function resolveCommitsBehind(
  bootSha: string,
  exec: (dir: string, range: string) => string = (dir, range) =>
    execFileSync("git", ["-C", dir, "rev-list", "--count", range], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).toString(),
): number | undefined {
  if (bootSha === CONSOLE_SHA_UNKNOWN) return undefined;
  try {
    const moduleDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    const n = Number(exec(moduleDir, `${bootSha}..HEAD`).trim());
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  } catch (error) {
    // Best-effort only, per this function's own contract above: a missing git, a detached
    // worktree, or a boot sha the checkout has since lost (rebase, shallow clone) all read as "no
    // evidence" to consoleRecyclePatienceMs, never as a caller-visible failure. Recorded so a
    // persistently unreadable backlog is diagnosable instead of silently maximal patience forever.
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`resolveCommitsBehind: ${reason}`);
    return undefined;
  }
}

/** The patience a console with NOBODY watching would need. It has none: a free moment is free. */
export const RECYCLE_PATIENCE_FREE_MS = 0;

/** The patience at one commit behind — the longest this gate will ever make a merged fix wait
 *  while somebody is watching. Not a threshold: {@link consoleRecyclePatienceMs} divides it, so
 *  every backlog size gets its own budget and none of them is a cliff. */
export const RECYCLE_PATIENCE_BASE_MS = 60 * 60_000;

// Why: the 3h25m of stale service the edge-only trigger actually produced —
// docs/forensics/serve.md#change-pressure-as-a-shrinking-budget
/**
 * CHANGE PRESSURE, AS A SHRINKING BUDGET RATHER THAN A THRESHOLD.
 *
 * W1-T2229 built this gate to exit at "a moment that costs nothing" — zero SSE subscribers and
 * zero in-flight writes — and explicitly never on a schedule. That is right whenever such a
 * moment arrives, and on a watched console it does not arrive: a tab left open never produces
 * the zero-client edge, and between edges nothing re-asks the question at all.
 *
 * So patience is a function of the backlog instead: zero with nobody watching, and otherwise
 * {@link RECYCLE_PATIENCE_BASE_MS} DIVIDED by the backlog — an hour at one commit behind, ~70s
 * at fifty. No cliff anywhere on that curve and no reading of "too stale", only a budget that
 * shrinks as the reason to recycle grows. Self-healing: a recycle resets the backlog to zero.
 *
 * WHAT PRESSURE NEVER BUYS: an in-flight write. That stays absolute in
 * {@link gateStaleCodeExit} — this module drains nothing, so exiting mid-write drops the request
 * and orphans whatever it spawned. Pressure decides whether to interrupt a READER, and the cost
 * of being wrong there is a reconnect the shell's last-snapshot cache repaints through.
 *
 * An `undefined` commitsBehind is "no evidence", and no evidence must not read as pressure —
 * it yields {@link Number.POSITIVE_INFINITY}, i.e. wait for a genuinely free moment.
 */
/**
 * HOW MUCH ATTENTION A READ IS STILL WORTH, decaying by half every minute.
 *
 * The recycle gate asked "is anyone SUBSCRIBED", counting SSE clients on
 * /v1/status/stream. That was the right question when the only console was the shell this
 * daemon serves itself. It is the wrong question now: the product console is a separate Next.js
 * application that POLLS /v1/status over HTTP every 3s and never opens a stream, so an operator
 * reading it is invisible to the gate, patience reads as zero, and the daemon recycles out from
 * under him.
 *
 * MEASURED 2026-09-15: the boot window after a recycle is 86.5s, during which cloudflared logs
 * "connection refused" and then "connection reset by peer" against remudero-serve:4317 and the
 * console reports every surface unavailable. The operator hit exactly that.
 *
 * A HALF-LIFE RATHER THAN A WINDOW, because a window is a cliff and this is a question of
 * degree: a surface polled seconds ago is being watched, one last read ten minutes ago is not,
 * and there is no instant in between where the answer flips. No reads at all is exactly zero,
 * which keeps an unwatched daemon recycling as freely as it does today.
 */
export const READ_ATTENTION_HALF_LIFE_MS = 60_000;

export function readAttention(msSinceLastRead: number | undefined): number {
  if (msSinceLastRead === undefined || !Number.isFinite(msSinceLastRead) || msSinceLastRead < 0) return 0;
  return Math.pow(0.5, msSinceLastRead / READ_ATTENTION_HALF_LIFE_MS);
}

export function consoleRecyclePatienceMs(
  clients: number,
  commitsBehind: number | undefined,
  msSinceLastRead?: number,
): number {
  // ATTENTION, not subscription: an SSE client counts as one watcher, and a recent read counts
  // as a fraction of one that decays. Both zero is the genuinely free moment.
  const attention = clients + readAttention(msSinceLastRead);
  if (attention <= 0) return RECYCLE_PATIENCE_FREE_MS;
  if (commitsBehind === undefined || commitsBehind <= 0) return Number.POSITIVE_INFINITY;
  return (RECYCLE_PATIENCE_BASE_MS * attention) / commitsBehind;
}

/** How often the gate re-asks the question while somebody is watching. Slow on purpose: this is
 *  the ONE thing W1-T2229 refused, and the refusal's reason was cost — a `git rev-parse` per
 *  check. At this cadence that is one cheap local command a minute, and only while the process is
 *  up, against the 3h25m of stale service the edge-only trigger actually produced. */
export const RECYCLE_RECHECK_MS = 60_000;

/** W1-T4229 BACKSTOP: a hung fetch must not hold the checkout read open past the next re-check. */
export const GATEWAY_FETCH_TIMEOUT_MS = 60_000;

/** One read of the gateway's own checkout, and whether it warrants the freshness restart. */
export interface GatewayCheckoutAssessment {
  state: GatewayCheckoutState;
  /** Behind AND clean: the entrypoint fast-forwards only a clean tree on boot. */
  restartDue: boolean;
}

/** {@link assessGatewayCheckout}'s seams; every git call is injectable so a test stays hermetic. */
export interface GatewayCheckoutDeps {
  repoDir: string;
  env?: Record<string, string | undefined>;
  git?: (args: string[]) => string;
  /** The network half, run OFF the event loop. Defaults to an async `git fetch --quiet origin`. */
  fetch?: () => Promise<void>;
  clock?: Clock;
}

function defaultGatewayFetch(repoDir: string): () => Promise<void> {
  return () =>
    new Promise((resolve, reject) => {
      execFile("git", ["-C", repoDir, "fetch", "--quiet", "origin"], { timeout: GATEWAY_FETCH_TIMEOUT_MS }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
}

/** `status --porcelain` lines to paths. Read raw: the status column can start with a space. */
function porcelainPaths(raw: string | undefined): string[] {
  return (raw ?? "")
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

/** W1-T4229 — {@link checkServiceFreshness}'s read with an async fetch and NO material-path filter
 *  (managed-repos.json, behind the measured `[]`, is "immaterial"); unreadable is "unknown", never 0. */
export async function assessGatewayCheckout(deps: GatewayCheckoutDeps): Promise<GatewayCheckoutAssessment> {
  const env = deps.env ?? process.env;
  const git = deps.git ?? ((args: string[]) => execFileSync("git", ["-C", deps.repoDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const clock = deps.clock ?? systemClock;
  const readOrUnknown = <T>(read: () => T): T | "unknown" => {
    try {
      return read();
    } catch {
      // Unreadable reads "unknown", never a healthy default; the caller shows it.
      return "unknown";
    }
  };
  const localState = (detail: string): GatewayCheckoutState => ({
    head: readOrUnknown(() => git(["rev-parse", "HEAD"]).trim()),
    behindBy: "unknown",
    dirty: readOrUnknown(() => git(["status", "--porcelain", "-uno"]).trim().length > 0),
    checkedAt: clock.iso(),
    detail,
  });
  const refuse = (): string => {
    throw new Error("guard probe");
  };
  if (checkServiceFreshness(deps.repoDir, env, { git: refuse }).status === "guarded") {
    return { state: localState("guarded environment: freshness is not assessed here"), restartDue: false };
  }
  let fetchError: string | undefined;
  try {
    await (deps.fetch ?? defaultGatewayFetch(deps.repoDir))();
  } catch (err) {
    // Carried into the read below, which reports `degraded` rather than trusting a stale ref.
    fetchError = err instanceof Error ? err.message : String(err);
  }
  const seen = new Map<string, string>();
  const svc = checkServiceFreshness(deps.repoDir, env, {
    git: (args) => {
      if (args[0] === "fetch") {
        if (fetchError !== undefined) throw new Error(fetchError);
        return "";
      }
      const out = git(args);
      seen.set(args.join(" "), out);
      return out;
    },
  });
  if (svc.status !== "assessed") {
    return { state: localState(svc.status === "degraded" ? svc.reason : "guarded"), restartDue: false };
  }
  const dirtyPaths = porcelainPaths(seen.get("status --porcelain -uno"));
  const behindBy: number | "unknown" =
    svc.behind === null
      ? 0
      : readOrUnknown(() => {
          const n = Number(git(["rev-list", "--count", "HEAD..origin/main"]).trim());
          if (!Number.isInteger(n) || n < 0) throw new Error(`unparseable rev-list count: ${n}`);
          return n;
        });
  const state: GatewayCheckoutState = {
    head: (seen.get("rev-parse HEAD") ?? "unknown").trim() || "unknown",
    behindBy,
    dirty: svc.dirty,
    ...(svc.dirty ? { dirtyPaths } : {}),
    checkedAt: clock.iso(),
  };
  // NEVER DIRTY: the entrypoint refuses to sync it, so the restart would loop on the same sha.
  return { state, restartDue: !svc.dirty && svc.behind !== null && behindBy !== 0 && serveRestartRelevant(svc.behind.changedPaths) };
}

/** W1-T4229 BACKSTOP: fires only on a connection that never ends by itself (SSE, a hung client). */
export const SERVE_RESTART_DRAIN_BOUND_MS = 10_000;

export type DrainableServer = Pick<Server, "close" | "closeIdleConnections" | "closeAllConnections">;

/** Node never closes a socket that goes idle AFTER close(); unswept, a restart waited ~4 s. */
const DRAIN_IDLE_SWEEP_MS = 50;

/** Let in-flight requests finish; resolves at the last close or the bound, and never rejects. */
export function drainServer(
  server: DrainableServer,
  boundMs: number = SERVE_RESTART_DRAIN_BOUND_MS,
  schedule: (run: () => void, ms: number) => () => void = (run, ms) => {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      cancel();
      clearInterval(sweep);
      resolve();
    };
    const cancel = schedule(() => {
      server.closeAllConnections();
      finish();
    }, boundMs);
    const sweep = setInterval(() => server.closeIdleConnections(), DRAIN_IDLE_SWEEP_MS);
    sweep.unref?.();
    server.close(() => finish());
    server.closeIdleConnections();
  });
}

/** {@link gateStaleCodeExit}'s constructor deps — every side effect injectable, same discipline
 *  {@link gatePrewarmOnClients} already follows for this module's other refcount gate. */
export interface StaleCodeExitDeps {
  /** The sha captured at boot — {@link ServeDeps.consoleSha} ?? {@link resolveConsoleSha}(),
   *  resolved ONCE by the caller and handed in, never re-resolved by this gate. */
  bootSha: string;
  /** Re-resolve the CURRENT on-disk sha, fresh, uncached — defaults to {@link resolveConsoleSha}
   *  itself (the identical primitive, called again). Injectable so a test never shells to git. */
  resolveCurrentSha?: () => string;
  /** Ends the process — defaults to `process.exit`. Injectable so a test observes the call
   *  instead of the test runner actually dying under it. */
  exit?: (code: number) => void;
  /** The backlog behind {@link bootSha} — defaults to {@link resolveCommitsBehind}. */
  resolveCommitsBehind?: (bootSha: string) => number | undefined;
  /** The clock patience is measured against — src/lib/clock.ts's port, never a bare
   *  millis-function field: clock-signature-census ratchets that legacy signature per file, and
   *  this port is what it ratchets toward. Defaults to {@link systemClock}. */
  clock?: Clock;
  /** Starts the slow re-check while somebody is watching, and returns its stop function.
   *  Injectable so a suite steps the cadence by hand rather than waiting on a real interval. */
  scheduleRecheck?: (run: () => void, ms: number) => () => void;
  /** When a read-scoped request was last served, so a POLLING console counts as watched — see
   *  {@link readAttention}. Absent means no read has been observed and the gate behaves exactly
   *  as it did before this seam existed. */
  lastReadAt?: () => number | undefined;
  /** One ledger line naming the decision, mirroring {@link ServiceOptions.log}. */
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /** Synchronous cleanup immediately before the process exit. The analytics cache supplies its
   * stop hook here because `process.exit` does not emit the HTTP server's `close` event. */
  beforeExit?: () => void;
  /** W1-T4229: {@link assessGatewayCheckout}, run at each re-check. */
  assessCheckout?: () => Promise<GatewayCheckoutAssessment>;
  /** W1-T4229: {@link drainServer}; absent, the exit is immediate as before. */
  drain?: () => Promise<void>;
  changedPathsSince?: ChangedPathsReader;
}
/** What {@link gateStaleCodeExit} hands back — a wrapper for the console's ONE SSE route and a
 *  wrapper for each HIGH-tier write route, both feeding the SAME internal decision. */
export interface StaleCodeExitGate {
  /** Wrap the console's SSE route so every open/close edge is refcounted against this gate too —
   *  a SECOND, independent tap on the identical subscribe/unsubscribe edges
   *  {@link gatePrewarmOnClients} already refcounts (rationale (4)), never a new tracking layer. */
  wrapSse(route: SseRoute): SseRoute;
  /** Wrap a HIGH-tier write route so its full request lifetime — call-in to the response actually
   *  finishing or the connection closing — counts as in-flight. */
  wrapWrite(route: Route): Route;
  checkout(): GatewayCheckoutState | undefined;
  /** What the cadence runs; resolves once its checkout read has landed and been acted on. */
  recheck(): Promise<void>;
  stop(): void;
}
/**
 * W1-T2229 design: the console notices its OWN code is stale and ends its own process — at a
 * moment that costs nothing, never on a schedule. `RestartPolicy: unless-stopped` (rationale (2),
 * unchanged by this task) restarts on a CLEAN exit, so `exit(0)` here is what turns "a merged fix
 * reaches this console" from "a human restarts it" into "the next time nobody is watching and
 * nothing is writing, it restarts itself."
 *
 * THE DECISION POINT FIRES ONLY AT THE TWO EDGES THAT CAN NEWLY SATISFY BOTH CONDITIONS — an SSE
 * client disconnecting, or a HIGH-tier write finishing — NEVER on an interval (design (i)).
 * Between those edges nothing calls {@link isConsoleCodeStale} at all: an idle console with a
 * viewer still attached, or one mid-write, is never even asked the question, so the sha is
 * re-resolved (a `git rev-parse`, not free) only at the instant an exit is actually a candidate.
 *
 * THE TWO CONDITIONS ARE AND-ED (design (iii)), and this gate is why: zero SSE subscribers with a
 * write still in flight must not exit mid-write (rationale (6): this module drains nothing, so an
 * exit today would drop the request and orphan a spawn already handed off), and zero in-flight
 * writes with a viewer still watching must not exit out from under an operator for no reason
 * (rationale (5): a quiet stream is not an idle process, but neither is a watched one).
 *
 * NOT COVERED, NAMED RATHER THAN GLOSSED (design (iv)): a detached spawn (`ratify.approve`) that
 * outlives the HTTP request which triggered it reads zero on {@link wrapWrite}'s counter the
 * moment that request returns, even while the spawned work continues outside it. Whether the exit
 * must also wait on such a handoff is the one genuinely open question design (iv) names and this
 * shard does not settle — this gate covers exactly the in-flight HTTP request, nothing broader.
 */
/**
 * Records that a read-scoped route was served, for {@link readAttention}.
 *
 * READ SCOPE ONLY, AND DELIBERATELY NOT EVERY ROUTE. A webhook delivery is not an operator
 * watching — `/v1/hooks/github` carried 1341 of the 1423 requests reaching the tunnel on
 * 2026-09-15 — so counting it would report constant attention and the gate would never recycle.
 * What the gate needs to know is whether a HUMAN surface is being read.
 */
export function stampReadWith(route: Route, stamp: () => void): Route {
  if (route.scope !== "read") return route;
  return {
    ...route,
    handler: (req, res, ctx) => {
      stamp();
      return route.handler(req, res, ctx);
    },
  };
}

export function gateStaleCodeExit(deps: StaleCodeExitDeps): StaleCodeExitGate {
  const resolveCurrentSha = deps.resolveCurrentSha ?? resolveConsoleSha;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? (() => {});
  const commitsBehindOf = deps.resolveCommitsBehind ?? resolveCommitsBehind;
  const clock = deps.clock ?? systemClock;
  const scheduleRecheck =
    deps.scheduleRecheck ??
    ((run, ms) => {
      const timer = setInterval(run, ms);
      timer.unref?.();
      return () => clearInterval(timer);
    });
  let clients = 0;
  let inFlightWrites = 0;
  /** When the code FIRST read stale, so patience is measured from the change landing rather than
   *  from whenever a re-check happened to notice it. Cleared if it somehow reads fresh again. */
  let staleSince: number | undefined;
  let checkout: GatewayCheckoutAssessment | undefined;
  let exiting = false;
  let dirtyReported: string | undefined;
  const readChangedPaths = deps.changedPathsSince ?? ((boot, target) => changedPathsSince(boot, target, serveRepoDir()));
  const relevance = new Map<string, boolean | "pending">();
  const settleRelevance = (currentSha: string, read: ChangedPathsRead): void => {
    const relevant = serveRestartRelevant(read.diffUnreadable === undefined ? read.changedPaths : undefined);
    relevance.set(currentSha, relevant);
    if (!relevant) log("serve.stale_code_not_loaded", { bootSha: deps.bootSha, currentSha, changedPaths: read.changedPaths });
    else if (read.diffUnreadable !== undefined) log("serve.restart_diff_unreadable", { bootSha: deps.bootSha, currentSha, reason: read.diffUnreadable });
  };
  const movedRelevantly = (currentSha: string): boolean => {
    const known = relevance.get(currentSha);
    if (known !== undefined) return known === true;
    relevance.set(currentSha, "pending");
    const read = readChangedPaths(deps.bootSha, currentSha);
    if (!(read instanceof Promise)) {
      settleRelevance(currentSha, read);
      return relevance.get(currentSha) === true;
    }
    read.then(
      (landed) => settleRelevance(currentSha, landed),
      (err: unknown) => settleRelevance(currentSha, { diffUnreadable: err instanceof Error ? err.message : String(err) }),
    ).then(maybeExit);
    return false;
  };

  const maybeExit = (): void => {
    if (exiting) return;
    // NEVER NEGOTIABLE: an exit mid-write drops the request, and a drain's bound could cut one.
    if (inFlightWrites !== 0) return;
    const currentSha = resolveCurrentSha();
    const codeStale = isConsoleCodeStale(deps.bootSha, currentSha) && movedRelevantly(currentSha);
    const checkoutBehind = checkout?.restartDue === true;
    if (!codeStale && !checkoutBehind) {
      staleSince = undefined;
      return;
    }
    staleSince ??= clock.now();
    const localBehind = codeStale ? commitsBehindOf(deps.bootSha) : undefined;
    const originBehind = checkoutBehind && typeof checkout?.state.behindBy === "number" ? checkout.state.behindBy : undefined;
    const commitsBehind = localBehind === undefined && originBehind === undefined ? undefined : (localBehind ?? 0) + (originBehind ?? 0);
    const lastRead = deps.lastReadAt?.();
    const msSinceLastRead = lastRead === undefined ? undefined : Math.max(0, clock.now() - lastRead);
    const patienceMs = consoleRecyclePatienceMs(clients, commitsBehind, msSinceLastRead);
    const staleForMs = clock.now() - staleSince;
    // Somebody is watching and the backlog has not yet earned the interruption. The re-check
    // below keeps asking, and the backlog grows on its own — which is what turns a watched
    // console from "never" into "soon enough" without ever reading a threshold.
    if (staleForMs < patienceMs) return;
    log("serve.stale_code_exit", {
      bootSha: deps.bootSha,
      currentSha,
      clients,
      inFlightWrites,
      commitsBehind,
      staleForMs,
      patienceMs,
      msSinceLastRead,
      ...(checkoutBehind ? { reason: "checkout_behind", checkout: checkout?.state } : {}),
    });
    exiting = true;
    stopRecheck();
    // exit(0): unless-stopped restarts it and entrypoint.sh's sync_tree fast-forwards the clone.
    const finish = (): void => {
      deps.beforeExit?.();
      exit(0);
    };
    if (!deps.drain) return finish();
    deps.drain().then(finish, (err: unknown) => {
      // A failed drain still ends in the restart it was preparing; the reason is kept.
      log("serve.drain_failed", { reason: err instanceof Error ? err.message : String(err) });
      finish();
    });
  };
  const noteCheckout = (next: GatewayCheckoutAssessment): void => {
    checkout = next;
    const { state } = next;
    if (state.dirty !== true || typeof state.behindBy !== "number" || state.behindBy === 0) return;
    // NEVER OVERWRITTEN; reported once per distinct head and path set, not once a minute.
    const key = `${state.head} ${(state.dirtyPaths ?? []).join(",")}`;
    if (key === dirtyReported) return;
    dirtyReported = key;
    log("serve.gateway_checkout_dirty", { head: state.head, behindBy: state.behindBy, dirtyPaths: state.dirtyPaths });
  };
  let assessing: Promise<void> | undefined;
  const recheck = (): Promise<void> => {
    if (deps.assessCheckout && !assessing && !exiting) {
      assessing = deps.assessCheckout().then(noteCheckout, (err: unknown) => {
        log("serve.gateway_checkout_unreadable", { reason: err instanceof Error ? err.message : String(err) });
      }).finally(() => {
        assessing = undefined;
      });
    }
    maybeExit();
    return assessing ? assessing.then(maybeExit) : Promise.resolve();
  };
  // STARTED HERE, NOT FROM INSIDE AN EDGE. Starting it lazily from `maybeExit` would reproduce
  // the exact defect this fixes: a console with a tab left open fires no edge at all, so the
  // re-check that is supposed to notice that would itself never be scheduled.
  let stopped = false;
  const stopTimer = scheduleRecheck(() => void recheck(), RECYCLE_RECHECK_MS);
  const stopRecheck = (): void => {
    if (stopped) return;
    stopped = true;
    stopTimer();
  };
  return {
    checkout: () => checkout?.state,
    recheck,
    stop: stopRecheck,
    wrapSse(route) {
      return {
        ...route,
        subscribe: (send) => {
          const unsubscribe = route.subscribe(send);
          clients += 1;
          let released = false;
          return () => {
            // Same defensive latch gatePrewarmOnClients's own release carries — a double-release
            // from service.ts must not underflow the count past whatever remains connected.
            if (released) return;
            released = true;
            unsubscribe();
            clients -= 1;
            maybeExit();
          };
        },
      };
    },
    wrapWrite(route) {
      return {
        ...route,
        handler: (req, res, ctx) => {
          inFlightWrites += 1;
          let released = false;
          const release = (): void => {
            if (released) return;
            released = true;
            inFlightWrites -= 1;
            maybeExit();
          };
          // "finish" (the response flushed) and "close" (the connection dropped before it did,
          // e.g. a client abort) both mean the request is DONE from this gate's point of view —
          // covering both means a handler that throws before writing anything is still covered:
          // createService's own dispatch catches that throw and sends a 500, which still fires
          // "finish". A handler that never responds at all leaves the count at 1 forever, which
          // is the safe direction — this gate never exits while it cannot prove the write ended.
          res.once("finish", release);
          res.once("close", release);
          return route.handler(req, res, ctx);
        },
      };
    },
  };
}
/** The console the operator uses. This surface serves `/v1/*` only (W1-T4563). */
export const CANONICAL_CONSOLE_URL = "https://app.remudero.com";

/**
 * `GET /` — W1-T4563. The daemon's in-process console is retired: app.remudero.com is the console
 * (DECISIONS 2026-09-16, and the operator's 2026-09-26 instruction to remove the localhost one).
 * What remains at `/` is a plain statement of what this surface is, so a person who lands here is
 * sent to the console and a script learns the API root -- never an HTML page to maintain again.
 */
function buildGatewayIndexRoute(): Route {
  return {
    method: "GET",
    path: "/",
    scope: "read",
    handler: (_req, res) => {
      sendJson(res, 200, { service: "remudero control gateway", console: CANONICAL_CONSOLE_URL, api: "/v1", version: "/v1/version" });
    },
  };
}

/**
 * `GET /v1/version` — read-scoped, and the value is the one captured at server start (a closure
 * over `sha`, not a fresh resolution). READ scope deliberately: a commit sha is not a secret, and
 * requiring the WRITE token would make the operator's staleness check need his most privileged
 * credential. The payload carries the sha and nothing else — no token, no path, no config.
 *
 * W1-T2269 deliberately does NOT extend this payload with the credential-renewability state
 * (see {@link GithubCredentialState}): an existing test (test/serve.test.ts, "the served payload
 * carries the sha and NO credential-shaped key") asserts this endpoint's keys and values stay
 * clear of anything token/secret/bearer/auth/password/credential-shaped, as a standing security
 * invariant on this specific surface — a `githubCredential` key, or a `lastFailureReason` value
 * that happened to contain the word "token" (github-app.ts's own reason strings do), would trip
 * it. That state is reported on the SHELL instead (see {@link renderGithubCredentialHtml} and
 * the "github credential" glance chip {@link buildShellRoute} renders), which is also the more
 * literal reading of the acceptance claim: "reported by the console ... rather than presented as
 * a working board" names the BOARD, not a JSON API response.
 */
export function buildVersionRoute(sha: string): Route {
  return {
    method: "GET",
    path: "/v1/version",
    scope: "read",
    handler: (_req, res) => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ sha }));
    },
  };
}
/** W1-T4227 — `GET /v1/registry`'s inputs. Both paths and the reader are injectable for tests. */
/** How the host copy compared: `unreadable`/`malformed` are notes, never a failed response. */
export type HostRegistryState = "in_sync" | "drifted" | "unreadable" | "malformed";

/**
 * W1-T4227 — `GET /v1/registry`: the fleet as projects → repos → instances, from the ONE registry
 * (`.remudero/daemon-instances.yaml`) through {@link parseInstanceRegistry}. The body is built by
 * {@link projectRegistry} from names and repos only — never a path, state dir, credential dir,
 * image or token, even though the registry rows carry the first four. `source` names WHICH
 * registry answered (`"repo"`), not where it lives on disk.
 *
 * DRIFT: when the host copy is readable and declares a different instance set, the body carries
 * `drift: { hostOnly, repoOnly }`. A host copy that cannot be read (every dev machine, the console
 * container) or parsed is a `hostRegistry` NOTE and no `drift` field — never an error, because the
 * repo registry answered and the host copy is only the thing being checked against it.
 */
export type RegistryRouteInput = NonNullable<ServeDeps["registry"]> & { repoRegistryPath: string };

export function buildRegistryRoute(deps: RegistryRouteInput): Route {
  const readText = deps.readText ?? ((path: string) => fsPromises.readFile(path, "utf8"));
  const clock = deps.clock ?? systemClock;
  const hostPath = deps.hostRegistryPath ?? DEFAULT_HOST_INSTANCE_REGISTRY_PATH;
  return {
    method: "GET",
    path: "/v1/registry",
    scope: "read",
    handler: async (_req, res) => {
      let registry: InstanceRegistry;
      try {
        registry = parseInstanceRegistry(await readText(deps.repoRegistryPath));
      } catch (error) {
        // Path-free refusal: fs errors embed the absolute path, so echo only the parser's code.
        const code = error instanceof InstanceRegistryError ? error.code : "unreadable";
        sendJson(res, 503, { error: "registry_unavailable", reason: code });
        return;
      }
      const repoNames = registry.instances.filter((i) => i.live).map((i) => i.name);
      let hostRegistry: HostRegistryState;
      let drift: RegistryDrift | undefined;
      let hostText: string | undefined;
      try {
        hostText = await readText(hostPath);
      } catch {
        // An absent/unreadable host copy is the normal case off the fleet host; it is a note.
        hostText = undefined;
      }
      if (hostText === undefined) {
        hostRegistry = "unreadable";
      } else {
        try {
          drift = registryDrift(repoNames, parseInstanceNames(hostText));
          hostRegistry = drift ? "drifted" : "in_sync";
        } catch {
          // A host copy outside the shell grammar cannot be compared; say so rather than guess.
          hostRegistry = "malformed";
        }
      }
      sendJson(res, 200, {
        ...projectRegistry(registry),
        source: "repo",
        generatedAt: clock.iso(),
        hostRegistry,
        ...(drift ? { drift } : {}),
      });
    },
  };
}
/** `owner/name` — the grammar {@link parseInstanceRegistry} requires, so both sides compare as-is. */
const ONBOARDING_READINESS_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type OnboardingReadinessRouteInput = NonNullable<ServeDeps["onboardingReadiness"]> & { repoRegistryPath: string };

/**
 * W1-T4264 — `GET /v1/onboarding/readiness?repo=<owner/name>`: the eight checks of
 * `onboarding-readiness.ts`, header-only auth like every other `/v1/*` data route.
 * `already-onboarded` reads the SAME registry `GET /v1/registry` answers from; an unreadable one
 * makes that ONE check `unknown` (path-free code, as buildRegistryRoute) — never a 503, never a pass.
 */
export function buildOnboardingReadinessRoute(deps: OnboardingReadinessRouteInput): Route {
  const readText = deps.readText ?? ((path: string) => fsPromises.readFile(path, "utf8"));
  return {
    method: "GET",
    path: "/v1/onboarding/readiness",
    scope: "read",
    handler: async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const repoParam = url.searchParams.get("repo");
      if (!repoParam || !ONBOARDING_READINESS_REPO.test(repoParam)) {
        sendJson(res, 400, { error: "invalid_request", detail: "?repo=<owner/name> is required" });
        return;
      }
      const [owner, name] = repoParam.split("/");
      let registry: OnboardingRegistryRead;
      try {
        const parsed = parseInstanceRegistry(await readText(deps.repoRegistryPath));
        registry = { repos: parsed.instances.filter((i) => i.live).map((i) => i.repo) };
      } catch (error) {
        registry = { unreadable: error instanceof InstanceRegistryError ? error.code : "unreadable" };
      }
      sendJson(res, 200, onboardingReadiness(owner, name, registry, deps.gateway));
    },
  };
}
/**
 * `GET /` — the shell above, read-scoped like every other route on this surface, but ALSO
 * accepting the token via `?token=` (allowQueryToken). A browser NAVIGATION to `/?token=<read>`
 * cannot set an `Authorization` header, so without this the shell would 401 and never load — the
 * page's OWN follow-up `/v1/*` fetches then carry the header (those routes stay header-only). This
 * closes the W1-T139 bootstrap paradox: the auth spec was satisfied against header-sending fetch
 * clients and unreachable by the one client that matters, the browser opening the URL.
 */
/**
 * W1-T996 — COMPOSE THE ACCESS PROVIDER, OR DELIBERATELY COMPOSE NOTHING.
 *
 * `cloudflareAccessIdentityProvider` and `createCloudflareAccessKeyCache` shipped in W1-T531,
 * fully unit-tested, and MEASURED 2026-09-04 they scored **0 src invocations each** against
 * controls of 2 and 2 for `tailscaleIdentityProvider` and `bearerTokenProvider` — the two
 * providers that ARE wired. So every console request already carried a verified identity the
 * server discarded. This is the wiring, not a second implementation: `src/lib/service.ts` is
 * deliberately NOT in this task's scope, and a builder editing it is rebuilding W1-T531.
 *
 * ⚠ ABSENT CONFIG MEANS NO PROVIDER, NEVER A PERMISSIVE ONE. Composing with an empty audience
 * would verify nothing and grant on ANY assertion — strictly worse than leaving it unwired. Both
 * values are per-install operator config, so their absence is the normal case for every install
 * that does not front the console with Access, and it must cost those installs nothing.
 *
 * ⚠ THE REFRESH IS STARTED HERE AND NEVER AWAITED ON THE REQUEST PATH. `scheduleRefresh()` is
 * fire-and-forget and reentrancy-guarded by the cache itself; `grant` reads whatever `keys()`
 * currently holds. A cache miss therefore DENIES THIS REQUEST and lets the next refresh fix the
 * next one — the design's own falsifier, and the reason this returns providers rather than a
 * promise.
 *
 * Returns `[]` rather than `undefined` so the call site spreads it unconditionally: with no
 * Access config the `providers` array is empty and `createService`'s built-in order — tailnet
 * identity, then bearer token — is byte-identical to before this task.
 */
/** W1-T996 — the two Access values off `loadConfig()`, tolerantly. A console that cannot read its
 *  config still serves; it simply composes no Access provider, which is the same outcome as an
 *  install that never configured one. Never a throw on the boot path for an optional credential. */
function accessConfig(): { accessTeamDomain?: string; accessAudience?: string } {
  try {
    const config = loadConfig();
    return { accessTeamDomain: config.accessTeamDomain, accessAudience: config.accessAudience };
  } catch {
    // Deliberate: an unreadable config is indistinguishable here from an unconfigured one, and
    // both must mean "no Access provider" rather than a failed boot.
    return {};
  }
}

/** W1-T4244 — `serve.operatorIdentity` off `loadConfig()`, tolerantly, {@link accessConfig}'s
 *  precedent: an unreadable config composes no operator provider rather than failing the boot. */
export function operatorIdentityConfig(
  read: () => Pick<Config, "serve"> = loadConfig,
  file: OperatorIdentityFileIo = {},
): OperatorIdentityConfig | undefined {
  let configured: OperatorIdentityConfig | undefined;
  try {
    configured = read().serve?.operatorIdentity;
  } catch {
    // Deliberate: an unreadable config and an unconfigured one both mean "no operator provider".
    configured = undefined;
  }
  return configured ?? operatorIdentityFromFile(file);
}

/**
 * W1-T4244 — COMPOSE THE OPERATOR-SESSION PROVIDER, OR NOTHING. Absent config, or one with no
 * issuer / no allowed origin / no operator, composes NO provider: a verifier with an empty
 * allowlist grants nobody, and saying so at boot beats an operator discovering it as a 403. The
 * key set is fetched lazily, on the first request that carries a session, never at boot.
 */
export function operatorSessionProvider(
  config: OperatorIdentityConfig | undefined,
  io: { fetchImpl?: typeof fetch; clock?: Clock; log?: (step: string, extra?: Record<string, unknown>) => void } = {},
): IdentityProvider | undefined {
  if (!config) return undefined;
  const issuer = config.issuer?.trim();
  if (!issuer || !(config.allowedOrigins?.length > 0) || !(config.operatorUserIds?.length > 0)) {
    io.log?.("serve.operator_identity_incomplete", {
      issuer: Boolean(issuer),
      allowed_origins: config.allowedOrigins?.length ?? 0,
      operator_user_ids: config.operatorUserIds?.length ?? 0,
    });
    return undefined;
  }
  const keys = createOperatorJwksCache({ jwksUrl: operatorJwksUrl({ ...config, issuer }), fetchImpl: io.fetchImpl, clock: io.clock, log: io.log });
  return operatorSessionIdentityProvider({ ...config, issuer, keys, clock: io.clock, log: io.log });
}

export function accessIdentityProviders(opts: {
  teamDomain?: string;
  audience?: string;
  log?: (step: string, extra?: Record<string, unknown>) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  makeKeyCache?: typeof createCloudflareAccessKeyCache;
}): IdentityProvider[] {
  const teamDomain = opts.teamDomain?.trim();
  const audience = opts.audience?.trim();
  if (!teamDomain || !audience) return [];
  const keys = (opts.makeKeyCache ?? createCloudflareAccessKeyCache)(teamDomain, opts.fetchImpl ?? fetch, opts.log);
  // Off the request path, by construction: started once here, re-armed by the cache's own
  // `scheduleRefresh` on a miss. Never awaited, so a slow certs endpoint cannot hold a request.
  // Optional on the interface (a timer-refreshed cache may leave it a no-op), so it is called only
  // when present rather than asserted — the default `createCloudflareAccessKeyCache` supplies it.
  keys.scheduleRefresh?.();
  return [cloudflareAccessIdentityProvider({ teamDomain, audience, keys, now: opts.now, log: opts.log })];
}

/**
 * W1-T945: the run-id SHAPE `readWorkerTail` (run-task.ts) validates BEFORE building a path —
 * duplicated here rather than imported, because serve.ts is a lib module and run-task.ts is the
 * CLI entrypoint that imports FROM lib/*, never the reverse (this file's own module header); the
 * one property design note (vi) needs on BOTH sides of that boundary is declared once per side
 * rather than smuggling a lib->entrypoint cycle into a security-relevant check. Accepts exactly
 * the id shapes run-task.ts actually mints (`${taskId}-${Date.now()}`, `RETRO-<ms>`,
 * `review-PR<n>-<ms>`, `SERVE-<ms>`, …) — letters, digits, `-`, `_` only, so no id can contain a
 * `/` or a `.` and therefore cannot escape `state/runs/`.
 */
const PEEK_RUN_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/;
function isValidPeekRunId(id: string): boolean {
  return PEEK_RUN_ID_SHAPE.test(id);
}
/** Mirrors run-task.ts's `WORKER_TAIL_MAX_LINES`/`WORKER_TAIL_MAX_BYTES` (duplicated for the
 *  same lib/entrypoint-direction reason as {@link PEEK_RUN_ID_SHAPE}, above) — the response is
 *  capped in BOTH dimensions regardless of what `?lines=` asks for (design note v). */
const PEEK_MAX_LINES = 500;
const PEEK_MAX_BYTES = 64 * 1024;
const PEEK_DEFAULT_LINES = 50;

/** Read-scoped console projection of the daemon's last provider-routing decision. */
export function buildProviderRoutingRoute(deps: {
  root: string;
  now?: () => number;
  read?: (root: string, deps?: { now?: () => number }) => ProviderRoutingStatus;
}): Route {
  return {
    method: "GET",
    path: "/v1/provider-routing",
    scope: "read",
    handler: (_req, res) => {
      const read = deps.read ?? readProviderRoutingStatus;
      const status = read(deps.root, { now: deps.now });
      const config = providerPolicyConfigFromStatus(status);
      const policy = config ? resolveProviderRoutingPolicy(deps.root, config, { now: deps.now }) : status.policy;
      // The status remains the daemon's last material routing decision. Overlay only the live
      // policy projection so a successful console write, expiry, or clear stays visible before
      // the next dispatch refreshes capacities/selection; Serve still performs no provider probe.
      sendJson(res, 200, policy ? { ...status, policy } : status);
    },
  };
}

interface ProviderRoutingPolicyRouteDeps {
  root: string;
  ledgerPath: string;
  now?: () => number;
  readStatus?: typeof readProviderRoutingStatus;
  writeOverride?: typeof writeProviderRoutingPolicyOverride;
  clearOverride?: typeof clearProviderRoutingPolicyOverride;
}

function validateProviderRoutingPolicyBody(body: unknown): { error: string } | { value: ProviderRoutingPolicyOverrideInput } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "body must be a JSON object" };
  }
  // The store is the one schema authority. Keep the unknown object wrapped so a hostile `error`
  // key cannot be mistaken for jsonAction's own validation-error envelope.
  return { value: body as ProviderRoutingPolicyOverrideInput };
}

function providerPolicyConfigFromStatus(status: ProviderRoutingStatus): { workerProviders: { enabled: WorkerProviderId[]; reservePercent: number } } | undefined {
  const committed = status.policy?.committed;
  if (!committed) return undefined;
  return {
    workerProviders: {
      enabled: [...committed.enabledProviders],
      reservePercent: committed.reservePercent,
    },
  };
}

function providerPolicyAuditProjection(policy: ReturnType<typeof resolveProviderRoutingPolicy>): Record<string, unknown> {
  return {
    provenance: policy.provenance,
    enabled_providers: policy.enabledProviders,
    routable_providers: policy.routableProviders,
    preference: policy.preference,
    reserve_percent: policy.reservePercent,
    parks: policy.parks,
    codex_model_preference: policy.codexModelPreference ?? null,
    expires_at: policy.overrideExpiresAt ?? null,
    ...(policy.fallback ? { fallback: policy.fallback.reason } : {}),
  };
}

function appendProviderPolicyAudit(
  deps: ProviderRoutingPolicyRouteDeps,
  req: import("node:http").IncomingMessage,
  before: ReturnType<typeof resolveProviderRoutingPolicy>,
  after: ReturnType<typeof resolveProviderRoutingPolicy>,
): void {
  appendLedger(deps.ledgerPath, {
    run_id: `PROVIDER-POLICY-${(deps.now ?? Date.now)()}`,
    task_id: "SERVE",
    step: "console.provider_routing_policy_written",
    who: bearerTokenId(req),
    from: before.provenance,
    to: after.provenance,
    from_policy: providerPolicyAuditProjection(before),
    to_policy: providerPolicyAuditProjection(after),
    expires_at: after.overrideExpiresAt ?? null,
    effective: "next dispatch",
  });
}

function providerPolicyContext(
  deps: ProviderRoutingPolicyRouteDeps,
): { status: ProviderRoutingStatus; config: { workerProviders: { enabled: WorkerProviderId[]; reservePercent: number } } } | undefined {
  const status = (deps.readStatus ?? readProviderRoutingStatus)(deps.root, { now: deps.now });
  const config = providerPolicyConfigFromStatus(status);
  return config ? { status, config } : undefined;
}

/** Set one bounded live provider-policy override. The daemon consumes it on its next dispatch. */
export function buildSetProviderRoutingPolicyRoute(deps: ProviderRoutingPolicyRouteDeps): Route {
  return {
    method: "POST",
    path: "/v1/policy/provider-routing",
    scope: "write",
    tier: "high",
    handler: jsonAction(validateProviderRoutingPolicyBody, ({ value }, req, res) => {
      const context = providerPolicyContext(deps);
      if (!context) {
        sendJson(res, 409, {
          error: "provider_policy_unavailable",
          detail: "the daemon has not published a committed provider-policy projection; no override was written",
        });
        return;
      }
      const now = deps.now ?? Date.now;
      const before = resolveProviderRoutingPolicy(deps.root, context.config, { now });
      if (value.codexModelPreference) {
        const codex = context.status.providers?.find((provider) => provider.provider === "codex");
        const decision = codex?.modelDecision;
        if (context.status.freshness !== "fresh" || !decision) {
          sendJson(res, 409, {
            error: "codex_model_inventory_stale",
            detail: "a fresh daemon-written Codex model inventory is required; no override was written",
          });
          return;
        }
        const option = decision.options.find((candidate) => candidate.id === value.codexModelPreference?.model);
        if (
          decision.requestedCapability !== value.codexModelPreference.capability ||
          decision.requestedEffort !== value.codexModelPreference.effort ||
          !option ||
          !option.mapped ||
          !option.eligible
        ) {
          sendJson(res, 400, {
            error: "codex_model_not_eligible",
            detail: "the requested model is not a fresh mapped eligible option; no override was written",
          });
          return;
        }
      }
      try {
        (deps.writeOverride ?? writeProviderRoutingPolicyOverride)(deps.root, value, {
          config: context.config,
          writerFingerprint: bearerTokenId(req),
          now,
        });
      } catch (error) {
        if (error instanceof ProviderRoutingPolicyError) {
          sendJson(res, 400, { error: "invalid_request", detail: error.message });
          return;
        }
        throw error;
      }
      const after = resolveProviderRoutingPolicy(deps.root, context.config, { now });
      appendProviderPolicyAudit(deps, req, before, after);
      sendJson(res, 200, { ok: true, effective: "next dispatch", policy: after });
    }),
  };
}

/** Clear the live override and return to the committed host policy on the next dispatch. */
export function buildClearProviderRoutingPolicyRoute(deps: ProviderRoutingPolicyRouteDeps): Route {
  return {
    method: "POST",
    path: "/v1/policy/provider-routing/clear",
    scope: "write",
    tier: "high",
    handler: jsonAction(
      (body) =>
        typeof body === "object" && body !== null && !Array.isArray(body) && Object.keys(body).length === 0
          ? { value: true }
          : { error: "body must be an empty JSON object" },
      (_input, req, res) => {
        const context = providerPolicyContext(deps);
        if (!context) {
          sendJson(res, 409, {
            error: "provider_policy_unavailable",
            detail: "the daemon has not published a committed provider-policy projection; no override was cleared",
          });
          return;
        }
        const now = deps.now ?? Date.now;
        const before = resolveProviderRoutingPolicy(deps.root, context.config, { now });
        (deps.clearOverride ?? clearProviderRoutingPolicyOverride)(deps.root);
        const after = resolveProviderRoutingPolicy(deps.root, context.config, { now });
        appendProviderPolicyAudit(deps, req, before, after);
        sendJson(res, 200, { ok: true, effective: "next dispatch", policy: after });
      },
    ),
  };
}

/**
 * `GET /v1/peek?runId=<id>[&lines=<n>]` — read-scoped, W1-T945: the console's read-only tail
 * reader, the FIRST HTTP route in this codebase to serve raw worker output (design note vi).
 * Inherits this surface's EXISTING auth/nonce/localhost-binding wholesale — mounted in
 * {@link buildServeRoutes} exactly like every other route, no new listener, no new auth path
 * (design note v). The run id is validated against {@link isValidPeekRunId} BEFORE any path is
 * built — an invalid shape 400s and never reaches a `readFileSync` call at all. A validly-shaped
 * but unknown/absent tail 200s with a NAMED `reason` (design note iv) — never a silent empty
 * body, matching `readWorkerTail`'s own honest-emptiness contract (run-task.ts). `deps.isLive` is
 * INJECTED, never a second liveness definition here: the real wiring (`serveCommand`) passes a
 * closure over the SAME `liveInflightRuns` read every other liveness decision in this codebase
 * uses (design note ii). No parameter this handler reads writes to, signals, resumes or kills
 * anything (design note i) — `lines` only bounds how much of the read-only file comes back, and
 * both `runId`/`lines` are the ONLY two query params this handler ever consults.
 */
export function buildPeekRoute(deps: { root: string; isLive: (runId: string) => boolean }): Route {
  return {
    method: "GET",
    path: "/v1/peek",
    scope: "read",
    handler: async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const runId = url.searchParams.get("runId");
      if (!runId || !runId.trim()) {
        sendJson(res, 400, { error: "invalid_request", detail: "?runId=<run-id> is required" });
        return;
      }
      if (!isValidPeekRunId(runId)) {
        sendJson(res, 400, { error: "invalid_request", detail: `'${runId}' is not a valid run id` });
        return;
      }
      const live = deps.isLive(runId);
      const linesRaw = url.searchParams.get("lines");
      const requested = linesRaw === null ? PEEK_DEFAULT_LINES : Number(linesRaw);
      const maxLines = Number.isInteger(requested) && requested > 0 ? Math.min(requested, PEEK_MAX_LINES) : PEEK_DEFAULT_LINES;
      const tailPath = join(deps.root, "state", "runs", `${runId}.tail`);
      let raw: string;
      try {
        raw = await fsPromises.readFile(tailPath, "utf8");
      } catch {
        // Missing or unreadable tails share the existing not-found response for this read-only peek.
        sendJson(res, 200, { runId, live, found: false, lines: [], reason: `no tail recorded for ${runId}` });
        return;
      }
      const split = raw.split("\n");
      if (split.length > 0 && split[split.length - 1] === "") split.pop();
      let lines = split.length > maxLines ? split.slice(split.length - maxLines) : split;
      while (lines.length > 0 && Buffer.byteLength(lines.join("\n"), "utf8") > PEEK_MAX_BYTES) {
        lines = lines.slice(1);
      }
      sendJson(res, 200, { runId, live, found: true, lines });
    },
  };
}
/**
 * `GET /v1/replay?since=<iso>&until=<iso>[&task=<id>][&step=<prefix>]` — W1-T2578's incident
 * TIMELINE panel: the console's read surface over `rmd replay` (src/lib/ledger-replay.ts,
 * W1-T2296). ONE PANEL, ONE ROUTE, ZERO NEW READERS (design i): this handler reads the SAME
 * archive∪live union `buildReplay` already resolves through ({@link resolveReplayLedgerLines} —
 * `resolveLedgerUnion`, ledger-grep.ts) and calls {@link buildReplay} itself for the narration; it
 * never re-filters, re-orders or re-derives a row field on its own — the panel formats the verb's
 * output and never re-derives the story (design iv, the same formatter-over-computation
 * relationship `scopeAdvisorySection` (review.ts) holds to its own advisory).
 *
 * `since`/`until` are REQUIRED — the same usage `replayCommand` (run-task.ts) enforces before it
 * will narrate anything; `task`/`step` narrow exactly as `--task`/`--step` do on the CLI.
 * `scope: "read"`, header-only auth like every other `/v1/*` data route — NEVER `allowQueryToken`
 * ({@link Route.allowQueryToken}'s own doc: that flag is reserved for the static HTML shell alone,
 * an API/data route stays header-only or a pasted URL leaks the bearer via `Referer` and logs).
 *
 * A PARTIAL CORPUS REFUSES, NEVER A SHORTER STORY (design iv): when
 * {@link resolveReplayLedgerLines} reports `ok: false` (an unread rotation, or zero archives under
 * `stateDir`), this renders that SAME refusal text — never a narration built from whatever
 * fraction of the corpus was readable.
 */
function escapeReplayHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
/**
 * The panel body, as a server-rendered HTML fragment the console embeds (GET /v1/replay's
 * response). Server-side on purpose: the fragment is escaped here, once, so no caller has to.
 *
 * FORMATS, NEVER RE-DERIVES (design iv): `narration` is {@link buildReplay}'s own return value,
 * read here as an OPAQUE string. This splits it only on the "\n" convention `buildReplay`'s own
 * doc declares — one summary line, then zero or more row lines — and escapes each line UNCHANGED
 * into a list item; it never re-parses a row's `ts`/`run_id`/`task_id`/`step`/`outcome`/`reason`
 * fields, which stay exactly as `buildReplay`'s own `renderRow` wrote them. DETERMINISM SURVIVES
 * THE RENDER (design ii): every row's `ts` rides through byte-for-byte — no relative-time
 * rendering, no client clock — so a screenshot of this panel and a `rmd replay` paste of the same
 * window agree on every line, and identical `narration` in always renders identical HTML out.
 */
export function renderReplayPanelHtml(narration: string): string {
  const [summary, ...rows] = narration.split("\n");
  const items = rows.map((row) => `<li class="replay-row">${escapeReplayHtml(row)}</li>`).join("");
  return (
    '<div class="replay-panel" data-replay="ok">' +
    `<p class="replay-summary">${escapeReplayHtml(summary)}</p>` +
    `<ol class="replay-rows">${items}</ol>` +
    "</div>"
  );
}
/**
 * Design (iv): "a partial corpus renders the verb's own refusal text, never a shorter story" —
 * `reason` is {@link ReplayLedgerRead}'s own `ok: false` text, the SAME string `rmd replay` prints
 * to stderr (`replayCommand`, run-task.ts), formatted here and never softened or summarized.
 */
export function renderReplayRefusalHtml(reason: string): string {
  return (
    '<div class="replay-panel replay-refused" data-replay="refused">' +
    `<p class="replay-refusal">rmd replay: ${escapeReplayHtml(reason)}</p>` +
    "</div>"
  );
}
export interface ReplayRouteDeps {
  /** The ledger STATE DIR {@link resolveReplayLedgerLines} reads the archive∪live union under —
   *  the SAME directory `rmd replay`'s own CLI wiring resolves, never a second derivation. */
  stateDir: string;
  /** Injectable so a test drives the resolved-lines and refused (`ok: false`) paths without a
   *  real state dir — same seam `replayCommand`'s own `opts.resolveReplayLedgerLines` uses. */
  resolveReplayLedgerLines?: (stateDir: string) => ReplayLedgerRead;
}
export function buildReplayRoute(deps: ReplayRouteDeps): Route {
  return {
    method: "GET",
    path: "/v1/replay",
    scope: "read",
    handler: (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const since = url.searchParams.get("since");
      const until = url.searchParams.get("until");
      if (!since || !until) {
        sendJson(res, 400, { error: "invalid_request", detail: "?since=<iso> and ?until=<iso> are required" });
        return;
      }
      const taskId = url.searchParams.get("task") ?? undefined;
      const stepPrefix = url.searchParams.get("step") ?? undefined;
      const resolve = deps.resolveReplayLedgerLines ?? resolveReplayLedgerLines;
      const resolved = resolve(deps.stateDir);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (!resolved.ok) {
        res.end(renderReplayRefusalHtml(resolved.reason));
        return;
      }
      res.end(renderReplayPanelHtml(buildReplay(resolved.lines, { since, until, taskId, stepPrefix })));
    },
  };
}

/** {@link buildSelfMeasurementRoute}'s deps — see the `ServeDeps.selfMeasurement` field this
 *  route's production wiring reads from for what each one defaults to. */
export interface SelfMeasurementRouteDeps {
  stateDir: string;
  n?: number;
  ledgerUnion?: (stateDir: string, pattern: RegExp) => LedgerUnionResult;
}

/**
 * W1-T2660: `GET /v1/self-measurement` — the console's ONE read of `measurement_cadence.ran`
 * rows (rule-efficacy, verdict-calibration, autonomy-rate, adoption, proof-debt, the verb
 * census), via {@link latestMeasurementRows} (measurement-cadence.ts) — the reader that INVERTS
 * that module's own writer (design (i)) rather than re-describing the row shape here. Returns
 * `latestMeasurementRows`'s own result verbatim as JSON: `{status: "ok", rows: [...]}` or
 * `{status: "unreadable", reason}` — the client-side `renderSelfMeasurement` (renderShellHtml's
 * script) renders the `unreadable` case AS unreadable, and renders each metric's
 * `delta_vs_previous` beside the latest value through the generic figure row, never as a
 * quietly-empty panel (the W1-T119 distinction this reader's own doc states).
 */
export function buildSelfMeasurementRoute(deps: SelfMeasurementRouteDeps): Route {
  return {
    method: "GET",
    path: "/v1/self-measurement",
    scope: "read",
    handler: (_req, res) => {
      const result: LatestMeasurementRowsResult = latestMeasurementRows(deps.stateDir, deps.n ?? 10, deps.ledgerUnion);
      sendJson(res, 200, result);
    },
  };
}
/**
 * W1-T493 design (i): the completeness ratchet for SCOPE, `writeRoutesMissingTier`-shaped
 * (service.ts, W1-T404) but over `scope` rather than `tier`. `scope` is REQUIRED on both `Route`
 * and `SseRoute` (service.ts), so a TypeScript-checked route literal can never appear here — an
 * unclassified route fails to COMPILE, the strongest ratchet there is (see
 * test/route-scope-matrix.test.ts's own compile-time proof of that). This is the runtime
 * backstop for the one thing the compiler cannot see: an entry assembled through a widened or
 * cast array (an `as Route`, a spread from an untyped source) that slips an invalid `scope` past
 * it. Empty ⇒ every entry in `entries` declares one of the two real `Scope` values — proving the
 * FIELD is present, never that enforcement matches it; test/route-scope-matrix.test.ts is the
 * suite that separately drives the REAL assembled table (this function's real caller,
 * {@link buildServeRoutes}, plus the one mounted SSE stream) through `createService` itself.
 */
export function routesMissingScopeClassification(
  entries: readonly { method?: Method; path: string; scope: Scope }[],
): string[] {
  return entries
    .filter((r) => r.scope !== "read" && r.scope !== "write")
    .map((r) => (r.method ? `${r.method} ${r.path}` : `GET ${r.path} (sse)`));
}
/**
 * design (iii-a)'s shape, copied: run {@link routesMissingScopeClassification} and FAIL THE
 * CALLER (throw) rather than merely reporting. Extracted here, callable directly, so its throw
 * branch is unit-testable without needing the real assembled table (which never triggers it,
 * `scope` being required on the type) to somehow go missing a classification.
 */
export function assertRoutesScopeComplete(entries: readonly { method?: Method; path: string; scope: Scope }[]): void {
  const missing = routesMissingScopeClassification(entries);
  if (missing.length > 0) {
    throw new Error(`route(s) with no declared Scope: ${missing.join(", ")}`);
  }
}
interface ServeRoutesAssembly {
  routes: Route[];
  /** The first GitHub App token mint. Absent when App refresh is not configured. */
  githubAppReady?: Promise<void>;
}

/** Internal route assembly that keeps the first-mint readiness signal beside the routes it protects. */
function assembleServeRoutes(
  deps: ServeDeps,
  currentAnalyticsSnapshot: () => AnalyticsSnapshot = coldAnalyticsSnapshot,
  operatorAgentMemory?: OperatorAgentMemorySource,
): ServeRoutesAssembly {
  const modelApprovals = deps.modelApprovals ?? [];
  // CAPTURED ONCE, HERE. buildServeRoutes runs exactly once per `rmd serve` process, so this is
  // server start; both the shell span and GET /v1/version close over this one value and neither
  // ever re-resolves it. See resolveConsoleSha for why re-reading per request would be worse
  // than not reporting at all.
  const consoleSha = deps.consoleSha ?? resolveConsoleSha();
  // W1-T2269: armed ONCE, here, alongside consoleSha above — buildServeRoutes runs exactly once
  // per process (this function's own doc, immediately above). Gated on config presence inside
  // startInstallationTokenRefresh itself: a console with no GH_APP_* names in its environment
  // (the default — see deploy/serve-container.sh) gets `armed: false` and nothing else changes,
  // byte-identical to before this task. Talks directly to GitHub, never to the daemon (design ii,
  // ServeDeps.githubAppRefresh's own doc) — so this never makes the console's boot depend on the
  // daemon being reachable (claim: "the console starts and serves when the daemon is absent").
  const githubCredential = trackGithubCredentialState(deps.log);
  const startGithubAppRefresh = deps.githubAppRefresh?.start ?? startInstallationTokenRefresh;
  const githubAppRefresh = startGithubAppRefresh({
    log: githubCredential.log,
    env: deps.githubAppRefresh?.env,
  });
  githubCredential.state.armed = githubAppRefresh.armed;
  // W1-T4088: the thread store is wired in production at last — the SAME file the inbox thread
  // routes and the daemon's responder use — so an escalation reply is accepted, not refused.
  const fleetControlDeps: PanelActionDeps = {
    root: deps.fleetControlRoot,
    ledgerPath: deps.ledgerPath,
    issues: deps.issues,
    threadStorePath: inboxThreadStorePath(deps.fleetControlRoot),
  };
  const questionDeps: PanelActionDeps = { root: deps.questionsRoot, ledgerPath: deps.ledgerPath, issues: deps.issues };
  // W1-T288: the SAME fleetControlDeps root/ledgerPath, plus the (optional, injectable)
  // liveness-verdict deps -- never a second root, never a second ledger read primitive.
  const controlStatusDeps: ControlStatusDeps = { ...fleetControlDeps, ...deps.controlStatus };
  // panel-graph's GET /v1/inbox needs config.root (inbox-proposals.json/inbox-drafts.json live
  // under state/, same as fleet-control's own flags) -- `fleetControlRoot` IS config.root
  // (module header), so it is the same root, never a THIRD independently-resolved path.
  // W1-T193: `ratify` defaults to a REAL ratifyCliGateway (see ServeDeps.panelGraph's own doc)
  // when the caller doesn't inject one -- rmd serve's own CLI wiring relies on this default;
  // a test supplies `ratify` explicitly to inject a fake instead.
  const panelGraphDeps = {
    ...deps.panelGraph,
    inboxRoot: deps.fleetControlRoot,
    ratify: deps.panelGraph.ratify ?? ratifyCliGateway(deps.panelGraph.root, join(deps.fleetControlRoot, "state", "logs")),
  };
  const lastSeen = deps.lastSeen ?? createLastSeenStore(lastSeenPath(deps.fleetControlRoot));
  // W1-T500: SAME instance `createService`'s dispatch consults (see ServeDeps.confirmNonces's own
  // doc for why that has to be true) -- {@link buildServeServer} resolves this once and threads it
  // through `deps.confirmNonces`, so a direct `buildServeRoutes` caller (a test) that omits it still
  // gets a route that issues real nonces, just not ones any dispatch is wired to consume.
  const confirmNonces = deps.confirmNonces ?? createConfirmNonceStore();
  const daemonHealthDeps: DaemonHealthDeps = {
    ledgerPath: deps.ledgerPath,
    diskPath: deps.daemonHealth?.diskPath ?? deps.fleetControlRoot,
    statfs: deps.daemonHealth?.statfs,
    exec: deps.daemonHealth?.exec,
    now: deps.daemonHealth?.now,
    defaultPollIntervalMs: deps.daemonHealth?.defaultPollIntervalMs,
    gatewayCheckout: deps.daemonHealth?.gatewayCheckout,
  };
  // W1-T333: `root` defaults to the SAME fleetControlRoot every other console write surface
  // already resolves `state/` against (daemonHealthDeps.diskPath above follows the identical
  // "assembler wires the real root, a test injects its own" split).
  //
  // W1-T997: `accountFilePath` is likewise RESOLVED here rather than left undefined — see
  // {@link resolveAccountFilePath}'s own doc for the precedence and for why an install that sets
  // neither an explicit override nor RMD_ACCOUNT_FILE_PATH renders byte-identical to before this
  // task (the console still reads `readAccountUsageFile`'s own `homedir()` default).
  const accountUsageDeps: AccountUsageDeps = {
    ...deps.accountUsage,
    ledgerPath: deps.ledgerPath,
    root: deps.accountUsage?.root ?? deps.fleetControlRoot,
    accountFilePath: resolveAccountFilePath(deps.accountUsage?.accountFilePath),
  };
  const providerAuthStore = deps.providerAuth?.store ?? new ProviderAuthSessionStore({
    profiles: deps.providerAuth?.profiles ?? readProviderAuthProfiles(deps.providerAuth?.env),
  });
  // Personal context governance is mounted with the existing operator-agent routes. Its context
  // inventory is metadata-only; raw private content is consumed through the ledger-backed
  // preflight reader, never serialized by the browser-facing console route.
  const operatorAgentRoutes = buildOperatorAgentRoutes({
    ledgerPath: deps.ledgerPath,
    ...(operatorAgentMemory ? { memory: operatorAgentMemory } : {}),
  });
  // W1-T3893: the operator self-service surface (inventory/forget/revoke/export) over the SAME
  // ledger-backed context-governance engine above — same ledgerPath, so a self-service forget and
  // a governance delete are the identical durable receipt, never a second memory store. Raw
  // private content never crosses these routes either: inventory strips it structurally and
  // export returns only a bounded, secret-scrubbed preview (see context-controls.ts's header).
  const contextControlsRoutes = buildContextControlsRoutes({ ledgerPath: deps.ledgerPath });
  // One history per `rmd serve` process, never a module singleton; a throw logs `github.wake.check_run_callback_failed`.
  let ciIncidentState: CiIncidentState = createCiIncidentState();
  const onCheckRunCompleted = async (info: CheckRunCompletedInfo): Promise<void> => {
    if (info.conclusion !== "failure" && info.conclusion !== "success") return;
    const log =
      info.conclusion === "failure"
        ? await readCiIncidentJobLog(deps.githubEventWake?.repository ?? "", info.id, deps.ciIncidents?.fetchJobLog, deps.log)
        : undefined;
    const outcome = recordCheckRunOutcome(ciIncidentState, {
      sha: info.sha,
      branch: info.branch ?? "",
      name: info.name,
      conclusion: info.conclusion,
      log,
      mainBranch: deps.ciIncidents?.mainBranch ?? DEFAULT_CI_INCIDENT_MAIN_BRANCH,
    });
    ciIncidentState = outcome.state;
    const nowMs = (deps.ciIncidents?.clock ?? systemClock).now();
    for (const event of outcome.events) appendLedger(deps.ledgerPath, ciIncidentEventLedgerLine(event, nowMs));
  };
  const rawRoutes = [
    projectConsoleStatusRoute(buildStatusRoute(deps.board, lastSeen), modelApprovals),
    buildRepoDashboardRoute({ root: deps.questionsRoot, ledgerPath: deps.ledgerPath, planPath: deps.panelGraph.planPath }),
    buildRecentRoute(deps.board),
    buildInboxDigestsRoute({ root: deps.fleetControlRoot }),
    buildDaemonHealthRoute(daemonHealthDeps),
    buildAccountUsageRoute(accountUsageDeps),
    ...buildProviderAuthRoutes(providerAuthStore, undefined, (input) => startProviderAuthSession(providerAuthStore, input)),
    buildProviderRoutingRoute({ root: deps.fleetControlRoot, ...deps.providerRouting }),
    buildSetProviderRoutingPolicyRoute({
      root: deps.fleetControlRoot,
      ledgerPath: deps.ledgerPath,
      now: deps.providerRouting?.now,
    }),
    buildClearProviderRoutingPolicyRoute({
      root: deps.fleetControlRoot,
      ledgerPath: deps.ledgerPath,
      now: deps.providerRouting?.now,
    }),
    buildControlStatusRoute(controlStatusDeps),
    buildPauseRoute(fleetControlDeps),
    buildResumeRoute(fleetControlDeps),
    buildStopRoute(fleetControlDeps),
    buildQuietHoursRoute(fleetControlDeps),
    buildAnswerQuestionRoute(questionDeps),
    buildApproveManualRoute(fleetControlDeps),
    buildEscalationMarkHandledRoute(fleetControlDeps),
    // W1-T2496: the prose-reply route — MOUNTED so it never joins the "declared but unreachable"
    // class this module's own history has three prior instances of (see the buildDrainFeedbackRoute
    // note below). W1-T4088 gave `fleetControlDeps` its `threadStorePath`, so a reply to an
    // escalation that has a thread is accepted; one with no thread is still refused, never filed
    // unattached.
    buildEscalationReplyRoute(fleetControlDeps),
    // W1-T2696: the ping's own answer links. MOUNTED for the reason the note above states — a
    // declared-but-unreachable route is this module's recurring defect. Both are
    // selfAuthenticated: the operator's phone carries no bearer token, so the link's signature is
    // the authority and each handler verifies it before anything acts. The GET is side-effect-free
    // because iMessage previews a URL it sends, which would otherwise burn every link unclicked.
    ...escalationLinkRoutes(fleetControlDeps, deps.fleetControlRoot),
    // W1-T164: operator guidance notes — console-editable, provenance-stamped, task-scoped.
    // Rooted at `questionsRoot` (repoRoot) — the SAME durable, gitignored `plan/` store
    // worker.ts's question channel already reads/writes (see operator-notes.ts's module doc).
    buildAddOperatorNoteRoute({ root: deps.questionsRoot, ledgerPath: deps.ledgerPath }),
    buildListOperatorNotesRoute({ root: deps.questionsRoot }),
    // Console UP NEXT write-actions (fb-1784988460437-9daa9b): Run a queued task, Drain now.
    buildKickRoute(fleetControlDeps),
    buildDrainNowRoute(fleetControlDeps),
    buildPrActionRoute(fleetControlDeps),
    // W1-T2719: existing durable refusal, exposed without any merge/lifecycle primitive.
    buildMergeHoldRoute(fleetControlDeps),
    // recon-ER: the post-drain rundown's one-tap verdict (W1-T141). Declared, aggregated into
    // buildPanelActionRoutes, and covered by six tests that stand up a REAL server and get real
    // 200s from it -- but never mounted here, so POST /v1/drain/feedback 404'd on every running
    // console since W1-T141 landed. That is why `operator_feedback` occurs ZERO times across the
    // ledger's 663-file union: not the unbuilt learning limb downstream (W1-T87/T88), which is
    // real but cannot be the binding constraint -- nothing upstream of it could ever fire.
    //
    // Third instance of one class: GET /v1/skills (W1-T284), POST /v1/skills/run (impl-EQ), this.
    // `assertDeclaredRoutesAreMounted` (test/route-registration.test.ts) is the check that ends it.
    //
    // `fleetControlDeps` and not a new root: the handler's only dep is `ledgerPath`
    // (ledgerPanelAction, panel-actions.ts:134), which is identical across both PanelActionDeps
    // instances built above -- so this route reads no root at all and cannot be misrooted.
    buildDrainFeedbackRoute(fleetControlDeps),
    // Operator-agent proposals, settings, and experiment-v1 observations all share the daemon
    // ledger. The experiment routes are mounted through this same production assembly so the
    // console cannot approve a change without a durable baseline and rollback path.
    ...operatorAgentRoutes,
    buildOperatorAgentAnswerRoute(() => ({
      repository: deps.githubEventWake?.repository,
      instance: deps.instances?.coreInstance ?? CORE_INSTANCE,
      snapshot: currentAnalyticsSnapshot(),
      inbox: readInboxAnswerEvidence(inboxThreadStorePath(deps.fleetControlRoot)),
    }), (input) => buildOperatorAgentAnswer(input)),
    ...contextControlsRoutes,
    ...buildPanelGraphRoutes(panelGraphDeps, () => deps.board.plan),
    // W1-T284: the skills-panel button SET, read-scoped -- was built (lib/panel-skills.ts,
    // W3-T8) but never wired into the real route table, so GET /v1/skills 404'd on every
    // running console. `questionsRoot` IS repoRoot (see that field's own doc, above) and
    // `.remudero/skills/` lives under repo root (lib/skill.ts's `skillsDir`), so it is the
    // same root buildAddOperatorNoteRoute already uses, never a new one.
    ...buildPanelSkillsRoutes({ root: deps.questionsRoot }),
    // impl-EQ: the WRITE half of the same panel, and the same defect W1-T284 fixed for the read
    // half one module earlier — `buildPanelSkillRunRoutes` (lib/panel-skill-run.ts, W3-T8 round 3)
    // had no caller anywhere in src/, so POST /v1/skills/run 404'd on every running console while
    // twelve tests exercised a route the server never mounted.
    //
    // IT DOES NOT SPAWN. Exactly one skill+mode is wired, `{ skill: "plan", mode: "clarify" }` (the
    // Refine button); every other combination is refused with a 400 that names what is unwired. The
    // wired path is a synchronous filesystem+ledger op — load the plan, lint the task, ground it
    // against the "plan" skill's own registry-declared `grounding_sources`, capture a `grilling`
    // feedback entry, ledger `panel.skill_invoked`. No worker, no spend.
    //
    // `panelGraphDeps` is passed WHOLE and deliberately: this module needs the same `root`,
    // `planPath`, `ledgerPath` and `feedbackLand` that POST /v1/feedback/decision already uses, and
    // production sets `panelGraph.root` and `questionsRoot` to the SAME `repoRoot` (run-task.ts) —
    // so the skills registry and the feedback write resolve under one root, and the grill lands on
    // the bot branch instead of dirtying the daemon's checkout.
    ...buildPanelSkillRunRoutes(panelGraphDeps),
    buildTaskCardRoute(deps.board),
    // W1-T3352: synchronous read of process-owned state. The server assembly owns refresh and
    // cancellation; this route receives no ledger path or reader capability.
    buildAnalyticsRoute({ currentSnapshot: currentAnalyticsSnapshot, currentLiveMetrics: deps.liveMetrics, mountsRoot: deps.questionsRoot }),
    // W1-T4563: `/` no longer serves a console -- app.remudero.com is the console (DECISIONS
    // 2026-09-16 and 2026-09-26). It says what this surface is and where to go instead.
    buildGatewayIndexRoute(),
    buildVersionRoute(consoleSha),
    // W1-T4227: the fleet's one registry, read-only — see buildRegistryRoute's own doc.
    buildRegistryRoute({
      ...deps.registry,
      repoRegistryPath: deps.registry?.repoRegistryPath ?? daemonInstanceRegistryPath(deps.questionsRoot),
    }),
    // W1-T4264: defaults to the SAME registry path buildRegistryRoute (above) resolves.
    buildOnboardingReadinessRoute({
      ...deps.onboardingReadiness,
      repoRegistryPath: deps.onboardingReadiness?.repoRegistryPath ?? deps.registry?.repoRegistryPath ?? daemonInstanceRegistryPath(deps.questionsRoot),
    }),
    // W1-T945: read-only run-tail reader — root defaults to fleetControlRoot (= config.root, the
    // same root the tail writer resolves state/runs/<runId>.tail against); isLive defaults to
    // "never live" so a caller that omits it (a bare test) never fabricates liveness.
    buildPeekRoute({ root: deps.peek?.root ?? deps.fleetControlRoot, isLive: deps.peek?.isLive ?? (() => false) }),
    // W1-T2578: the incident timeline panel over `rmd replay` (ledger-replay.ts). `stateDir`
    // defaults to `dirname(deps.ledgerPath)` -- the SAME derivation `replayCommand`'s own CLI
    // wiring uses (run-task.ts), never a second root.
    buildReplayRoute({
      stateDir: deps.replay?.stateDir ?? dirname(deps.ledgerPath),
      resolveReplayLedgerLines: deps.replay?.resolveReplayLedgerLines,
    }),
    // W1-T2660: the self-measurement panel over `measurement_cadence.ran` rows. `stateDir`
    // defaults to `dirname(deps.ledgerPath)` -- the SAME derivation `replay` immediately above
    // uses, never a second root.
    buildSelfMeasurementRoute({
      stateDir: deps.selfMeasurement?.stateDir ?? dirname(deps.ledgerPath),
      n: deps.selfMeasurement?.n,
      ledgerUnion: deps.selfMeasurement?.ledgerUnion,
    }),
    // W1-T500: the nonce-issuance route design (iv)'s second factor needs to exist AT ALL -- built
    // (service.ts, W1-T404) and exported, but mounted nowhere until now, which is why every
    // HIGH-tier write was one flag flip away from a `confirm_nonce_required` with no way to
    // satisfy it. `scope: "write"` (its own declared shape) means `assertWriteTiersComplete` below
    // requires a `tier` too -- makeConfirmNonceRoute deliberately declares none of its own
    // (service.ts's own doc: "requesting a nonce for an action grants nothing by itself"), so this
    // is the one route mounted here rather than reused verbatim -- LOW, the same bookkeeping-grade
    // consequence buildAuthScopeRoute above already claims for the least consequential thing a
    // write token can do.
    { ...makeConfirmNonceRoute(confirmNonces), tier: "low" as const },
    // W1-T2568: the signed GitHub-event wake — see github-event-wake.ts's module header. Ships
    // dark (design vii) whenever `deps.githubEventWake` is omitted or carries no `secret`: the
    // route mounts either way, so a probe gets a named `webhook_not_configured` 503 rather than
    // a 404 that reads like a routing typo, but writes nothing. `markerPath` is ALWAYS rooted at
    // `fleetControlRoot` — the SAME shared state directory `wireSweepWakeToDaemon` (run-task.ts's
    // `daemonCommand`) watches, never a second, independently-resolved root.
    createGitHubEventWakeHandler({
      secret: deps.githubEventWake?.secret,
      repository: deps.githubEventWake?.repository ?? "",
      markerPath: sweepWakeMarkerPath(deps.fleetControlRoot),
      dedup: createPersistentDeliveryDedupStore(
        githubDeliveryDedupPath(deps.fleetControlRoot),
        deps.githubEventWake?.dedupCapacity ?? DEFAULT_GITHUB_EVENT_WAKE_DEDUP_CAPACITY,
      ),
      semanticCheckMode: deps.githubEventWake?.semanticCheckMode,
      aggregateCheckNames: deps.githubEventWake?.aggregateCheckNames,
      counters: deps.githubEventWake?.counters,
      log: deps.log,
      onCheckRunCompleted,
    }),
    buildIncidentEventsRoute({ ledgerPath: deps.ledgerPath }),
    // W1-T4387: the fix-verification lifecycle's own read surface, beside the ingest route above.
    // `stateDir` defaults to `dirname(deps.ledgerPath)` -- the SAME derivation `replay` and
    // `selfMeasurement` already use, never a second root.
    buildIncidentsRoute({
      stateDir: deps.incidents?.stateDir ?? dirname(deps.ledgerPath),
      clock: deps.incidents?.clock,
      readStore: deps.incidents?.readStore,
    }),
  ];
  const routes = boundConsoleReadRoutes(rawRoutes, deps);
  routes.push(
    ...buildInstanceGatewayRoutes(routes, {
      registryPath: daemonInstanceRegistryPath(deps.questionsRoot),
      github: (repo) => buildBatchedGithub(repo.split("/")[0], repo.split("/")[1], { ttlMs: DEFAULT_BOARD_POLL_TTL_MS, log: deps.log }),
      issues: deps.issues,
      controlStatus: deps.controlStatus,
      log: deps.log,
      bound: (reads, board) => boundConsoleReadRoutes(reads.map((r) => projectConsoleStatusRoute(r, modelApprovals)), { ...deps, board, consoleSnapshots: undefined }),
      ...deps.instances,
    }),
  );
  // W1-T404 design (iii): `ci-parity:drift`-shaped completeness, run inside the PRODUCT function
  // (this one), not merely a test — a write-scoped route added here with no declared tier fails
  // the build rather than defaulting quietly. See `assertWriteTiersComplete`'s own doc.
  assertWriteTiersComplete(routes);
  // W1-T493 design (i): the same shape, over `scope`. Never fires today (`scope` is required on
  // the `Route` type, so an unclassified literal cannot compile) — kept here anyway, beside its
  // tier sibling, as the runtime backstop for whatever the compiler cannot see. See
  // `assertRoutesScopeComplete`'s own doc.
  assertRoutesScopeComplete(routes);
  return { routes, githubAppReady: githubAppRefresh.ready };
}

/** Every REST route `rmd serve` registers — board, panel actions, panel graph, and the shell. */
/**
 * W1-T2696's two answer routes.
 *
 * The signing secret is resolved LAZILY — assembling routes must touch no disk, and
 * `loadEscalationLinkSecret` creates the secret on first read.
 * TRAP: resolving it here instead makes standing up a server write a file, which
 * test/console-write-entry.test.ts refuses ("obtaining the grant touches no disk at all").
 *
 * Both routes are always mounted, so a link can only be refused by a route that could have
 * verified it, never 404 by one silently left out.
 */
function escalationLinkRoutes(panelDeps: PanelActionDeps, configRoot: string): Route[] {
  const linkDeps = { root: configRoot, secret: () => loadEscalationLinkSecret(configRoot), now: () => Date.now() };
  return [buildEscalationLinkConfirmRoute(panelDeps, linkDeps), buildEscalationLinkAnswerRoute(panelDeps, linkDeps)];
}

export function buildServeRoutes(deps: ServeDeps): Route[] {
  return assembleServeRoutes(deps).routes;
}

interface ServeServerAssembly {
  server: Server;
  githubAppReady?: Promise<void>;
}

export const INCIDENT_INVARIANTS_INTERVAL_MS = 60_000;

export function startIncidentInvariantsMonitor(
  ledgerPath: string,
  deps: NonNullable<ServeDeps["incidentInvariants"]> & { log?: ServiceOptions["log"] } = {},
): () => void {
  const readLedger = deps.readLedger ?? readLedgerLines;
  const writeLedger = deps.writeLedger ?? appendLedger;
  const eventLoopLag = deps.eventLoopLag ?? createEventLoopLagMonitor();
  const clock = deps.clock ?? systemClock;
  const setTimer = deps.setInterval ?? setInterval;
  const clearTimer = deps.clearInterval ?? clearInterval;
  const intervalMs = deps.intervalMs ?? INCIDENT_INVARIANTS_INTERVAL_MS;

  const tick = (): void => {
    const nowMs = clock.now();
    try {
      const lag = eventLoopLag();
      if (lag) writeLedger(ledgerPath, eventLoopLagLedgerLine(lag, nowMs));
    } catch (e) {
      deps.log?.("serve.incident_invariants.loop_lag_failed", { reason: String((e as Error)?.message ?? e) });
    }
    try {
      const rows = readLedger(ledgerPath);
      for (const finding of evaluateIncidentInvariants(rows, nowMs)) {
        writeLedger(ledgerPath, invariantFindingLedgerLine(finding, nowMs));
      }
    } catch (e) {
      deps.log?.("serve.incident_invariants.evaluate_failed", { reason: String((e as Error)?.message ?? e) });
    }
  };

  const timer = setTimer(tick, intervalMs);
  timer.unref?.();
  return () => clearTimer(timer);
}

/**
 * Build (but do not `.listen()`) the full `rmd serve` HTTP server — one call, every route wired.
 * `deps.board.github`'s background TTL refresh (W1-T154) runs ONLY while at least one console is
 * connected — see {@link gatePrewarmOnClients} for the zero-viewer burn that gate exists to stop.
 * It is also stopped unconditionally when the returned server `close`s, so a server torn down
 * with a viewer still attached leaves no timer behind.
 */
function assembleServeServer(deps: ServeDeps): ServeServerAssembly {
  const prewarm = gatePrewarmOnClients(
    buildStatusStream(deps.board, deps.pollMs ?? DEFAULT_POLL_MS),
    deps.board.github,
    deps.boardGithubRefreshMs ?? DEFAULT_BOARD_PREWARM_MS,
  );
  // W1-T500: resolved ONCE, here, and threaded to BOTH `buildServeRoutes` (the mounted
  // `POST /v1/confirm` route's issuing store, via `deps.confirmNonces` below) and `createService`
  // (the `enforceWriteTiers` HIGH-tier dispatch check's consuming store) -- the one shared
  // instance ServeDeps.confirmNonces's own doc requires; resolving it independently in each place
  // (each defaulting on its own) would issue nonces into a store the dispatch never consults.
  const confirmNonces = deps.confirmNonces ?? createConfirmNonceStore();
  const analyticsCache = createAnalyticsSnapshotCache({
    ...deps.analytics,
    stateDir: dirname(deps.ledgerPath),
    log: deps.log,
  });
  const operatorAgentMemory = createOperatorAgentMemorySource(() => analyticsCache.current().operatorAgentMemory);
  const liveAnalyticsCache = createLiveAnalyticsSnapshotCache({
    ...deps.liveAnalytics,
    root: deps.fleetControlRoot,
  });
  // W1-T2229: resolved ONCE, here, and threaded through to `buildServeRoutes` below (explicitly,
  // via the spread) so `GET /v1/version` and the shell's "console build" chip report the EXACT
  // sha {@link gateStaleCodeExit} is comparing against — never a second independent resolution
  // that could drift from the one the exit decision uses.
  const consoleSha = deps.consoleSha ?? resolveConsoleSha();
  // WHEN A READER WAS LAST SERVED — the signal that makes a POLLING console visible to the
  // recycle gate. The product console never opens an SSE stream, so subscriber count alone
  // reported nobody watching and the daemon recycled out from under an operator mid-read. See
  // {@link readAttention}.
  let lastReadAt: number | undefined;
  let drainTarget: Server | undefined;
  const wakeCounters = createWakeCounters();
  const stopWakeSummary = startWakeSummaryFlush({
    counters: wakeCounters,
    clock: systemClock,
    write: (window) => deps.log?.("github.wake.summary", { ...wakeSummaryRow(wakeCounters, window) }),
  });
  const staleExit = gateStaleCodeExit({
    bootSha: consoleSha,
    log: deps.log,
    beforeExit: () => {
      analyticsCache.stop();
      liveAnalyticsCache.stop();
      stopWakeSummary();
    },
    lastReadAt: () => lastReadAt,
    assessCheckout: deps.gatewayCheckout ?? (() => assessGatewayCheckout({ repoDir: serveRepoDir() })),
    drain: () => (drainTarget ? drainServer(drainTarget) : Promise.resolve()),
    ...deps.staleExitSeams,
  });
  // THE CLOCK PORT, never the legacy signature. clock-signature-census ratchets that shape per
  // file and this line pushed src/lib/serve.ts from 2 to 3; `systemClock` is the target the
  // census names, and it is the SAME default `gateStaleCodeExit` reads patience against above, so
  // the stamp and the decision that consumes it cannot disagree about what time it is.
  // ONE STAMP, TWO CONSUMERS: the recycle gate's patience (W1-T3610) and the prewarm gate above.
  // Both were blind to a polling console in exactly the same way, so both read the same signal
  // rather than growing a second notion of "someone is watching".
  const stampRead = (route: Route): Route =>
    stampReadWith(route, () => {
      lastReadAt = systemClock.now();
      prewarm.noteRead();
    });
  const routeAssembly = assembleServeRoutes(
    {
      ...deps,
      consoleSha,
      confirmNonces,
      githubEventWake: deps.githubEventWake && { ...deps.githubEventWake, counters: wakeCounters },
      liveMetrics: deps.liveMetrics ?? liveAnalyticsCache.current,
      // W1-T4229: /v1/daemon-health reports the SAME reading the restart decision acts on.
      daemonHealth: { ...deps.daemonHealth, gatewayCheckout: deps.daemonHealth?.gatewayCheckout ?? staleExit.checkout },
    },
    analyticsCache.current,
    operatorAgentMemory,
  );
  const routes = routeAssembly.routes.map((route) =>
    // rationale (7): HIGH-tier IS the write-consequence set this task must respect — the same
    // five paths (`/v1/manual/approve`, `/v1/drain/kick`, `/v1/drain/run`, `/v1/inbox/approve`,
    // `/v1/skills/run`) `HIGH_TIER_WRITE_PATHS` names client-side, read here off the route table's
    // own declared `tier` (already asserted complete, above in `buildServeRoutes`) rather than a
    // second hard-coded path list that could drift from it.
    route.tier === "high" ? staleExit.wrapWrite(route) : stampRead(route),
  );
  const ingestToken = deps.tokens.ingest ?? process.env[INGEST_TOKEN_ENV] ?? readIngestTokenFile(process.env[INGEST_TOKEN_FILE_ENV], deps.log);
  const server = createService({
    tokens: deps.tokens,
    identity: deps.identity,
    // W1-T996: APPENDED through the seam, never by reordering `createService`'s built-in array (the
    // W1-T371 token-first contract). Access is empty unless BOTH config values are present; W1-T4383's
    // ingest grantor is absent unless an ingest token is, and reaches only the incident route.
    providers: accessIdentityProviders({
      teamDomain: deps.accessTeamDomain ?? accessConfig().accessTeamDomain,
      audience: deps.accessAudience ?? accessConfig().accessAudience,
      log: deps.log,
    }).concat(
      ingestToken ? [ingestTokenProvider({ token: ingestToken, method: INCIDENT_INGEST_ROUTE_METHOD, path: INCIDENT_INGEST_ROUTE_PATH })] : [],
    ),
    // W1-T4244: the signed-in operator, consulted BEFORE the bearer token the console also sends.
    operatorSession: operatorSessionProvider(deps.operatorIdentity ?? operatorIdentityConfig(loadConfig, { log: deps.log }), { ...deps.operatorIdentityIo, log: deps.log }),
    routes,
    sse: [staleExit.wrapSse(prewarm.route)],
    log: deps.log,
    confirmNonces,
    // W1-T404 design (iii), turned on LAST (design iii, this task): a no-op until now for want of
    // the two other pieces this task adds -- the issuing route (buildServeRoutes, above) and the
    // console's own client round trip (postJson, above). Both now real: a HIGH-tier write from a
    // credential whose granted tier reaches HIGH (tailnet identity, unraised, still "high") is
    // refused without a nonce and satisfied with one; the bearer write token stays PINNED at "low"
    // (W1-T404's own ruling, not raised here) and so never reaches a MIDDLE or HIGH route at all,
    // nonce or not -- see ServiceOptions.enforceWriteTiers's own doc and bearerTokenProvider's.
    // W1-T4244: the operator's own verified session (above) is how the console reaches MIDDLE,
    // and HIGH after a recent step-up; the bearer token is still pinned at LOW.
    enforceWriteTiers: true,
  });
  drainTarget = server;
  server.on("close", staleExit.stop);
  server.on("close", prewarm.stop);
  server.on("close", stopWakeSummary);
  server.once("listening", analyticsCache.start);
  server.on("close", analyticsCache.stop);
  server.once("listening", liveAnalyticsCache.start);
  server.on("close", liveAnalyticsCache.stop);
  server.on("close", watchInstanceLiveness({ registryPath: daemonInstanceRegistryPath(deps.questionsRoot), ledgerPath: deps.ledgerPath, log: deps.log, ...deps.instances }));
  const stopIncidentInvariants = startIncidentInvariantsMonitor(deps.ledgerPath, {
    ...deps.incidentInvariants,
    log: deps.log,
  });
  server.on("close", stopIncidentInvariants);
  return { server, githubAppReady: routeAssembly.githubAppReady };
}

export function buildServeServer(deps: ServeDeps): Server {
  return assembleServeServer(deps).server;
}

/**
 * Production boot boundary: wait for the first GitHub App mint to settle before any caller can
 * bind the server. `ready` never rejects and is absent when App refresh is unconfigured, so this
 * preserves Serve's fail-open posture while removing the empty-token startup race.
 */
export async function buildReadyServeServer(deps: ServeDeps): Promise<Server> {
  const assembly = assembleServeServer(deps);
  if (assembly.githubAppReady) await assembly.githubAppReady;
  return assembly.server;
}
// ── CLI glue: port + token resolution (kept here, not run-task.ts, so both are unit-testable
// as pure/near-pure functions rather than only exercisable through the live CLI) ────────────
/**
 * `--port <n>` if present, else `configPort` (the `serve.port` field an install may pin —
 * W1-T152, so the launchd unit and a hand-run `rmd serve` agree on ONE port without the
 * operator retyping a flag), else {@link DEFAULT_SERVE_PORT}. BOTH sources are validated as an
 * integer 1-65535 — a garbage config value must fail as loudly as a garbage flag, not silently
 * fall through to the default and bind a port nobody's bookmark points at. Throws (never
 * returns an invalid port) so the CLI can fail loud before any bind attempt.
 */
export function resolveServePort(rest: string[], configPort?: number): number {
  const idx = rest.indexOf("--port");
  const raw = idx >= 0 ? rest[idx + 1] : configPort;
  if (raw === undefined) return DEFAULT_SERVE_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    const source = idx >= 0 ? "--port" : "config serve.port";
    throw new Error(`${source} must be an integer 1-65535, got ${JSON.stringify(raw)}`);
  }
  return n;
}
/** Loopback. The default bind: reachable from this machine and from nothing else. UNCHANGED by
 *  this task — see {@link resolveServeHosts}'s own doc for why the default stays exactly this,
 *  containerized or not: "exposure must be typed, never inherited" (R-4) applies here too. */
export const DEFAULT_SERVE_HOST = "127.0.0.1";
/**
 * W1-T915: the one wildcard spelling {@link assertBindableHost} will accept — and ONLY when the
 * caller also names {@link CONTAINER_NETWORK_ENV} — because it is the one that matches the actual
 * defect. `remudero-serve` runs in a container with no published port: `DEFAULT_SERVE_HOST`
 * (loopback) answers neither Docker's `-p` NAT nor a sibling container (the Cloudflare Tunnel
 * client the 2026-08-14 DECISIONS.md ruling puts on this same box), because both reach a
 * container over ITS interface inside the container's own network namespace, never over its
 * loopback. `0.0.0.0` there is the address that namespace needs to gain.
 *
 * This is deliberately NOT what {@link WILDCARD_HOSTS}'s existing refusal is about. That refusal
 * guards a BARE HOST, where "every interface" means every network the host's own NIC joins — home
 * wifi, a coffee-shop LAN, whatever's plugged in, with a bearer token as the only thing standing
 * between a stranger on that LAN and a write route. Inside a container, "every interface" is
 * bounded by Docker's own network isolation to that container's namespace; nothing here publishes
 * a port to the host's other networks or to the public internet on its own — that stays an
 * operator act (`docker run -p`, or co-locating the tunnel client). So the container's namespace
 * gains an address; nothing wider does, and never silently: see {@link CONTAINER_NETWORK_ENV}.
 */
export const CONTAINER_ALL_INTERFACES_HOST = "0.0.0.0";
/**
 * The env var that must be set to exactly {@link CONTAINER_NETWORK_VALUE} before
 * {@link assertBindableHost} will accept {@link CONTAINER_ALL_INTERFACES_HOST} as a `--host`/
 * `RMD_SERVE_HOST` value — same shape as {@link TRUSTED_PROXY_TAILSCALE}'s single accepted value,
 * refused for anything else (an unset var, a typo, `"1"`, `"true"`) rather than treated as a
 * loose boolean. Deliberately a SEPARATE knob from the host value itself, not folded into it:
 * typing `--host 0.0.0.0` alone must keep failing exactly as loudly as before (the existing
 * `resolveServeHost`/`resolveServeHosts` wildcard tests assert this, unchanged by this task), so
 * a template copy-paste or a fat-fingered address can never silently open every interface on a
 * bare host. Only a caller who names BOTH "I mean 0.0.0.0" (the host value) AND "I am declaring a
 * container's own network namespace, not a host's" (this var) gets through — exposure stays
 * something someone typed, it just now takes two independent things typed together instead of
 * being permanently unreachable no matter how deliberately they were typed.
 */
export const CONTAINER_NETWORK_ENV = "RMD_SERVE_NETWORK";
export const INGEST_TOKEN_ENV = "RMD_SERVE_INGEST_TOKEN";
export const INGEST_TOKEN_FILE_ENV = "RMD_SERVE_INGEST_TOKEN_FILE";

export function readIngestTokenFile(path: string | undefined, log?: ServeDeps["log"]): string | undefined {
  if (!path) return undefined;
  let token: string;
  try {
    token = readFileSync(path, "utf8").trim();
  } catch (err) {
    log?.("serve.ingest_token_refused", { file: path, reason: `unreadable: ${(err as NodeJS.ErrnoException).code ?? String(err)}` });
    return undefined;
  }
  if (token) return token;
  log?.("serve.ingest_token_refused", { file: path, reason: "empty" });
  return undefined;
}

/** The only value {@link CONTAINER_NETWORK_ENV} accepts. See that constant's own doc. */
export const CONTAINER_NETWORK_VALUE = "container";

/**
 * Wildcard binds, refused by name — UNLESS `host` is exactly {@link CONTAINER_ALL_INTERFACES_HOST}
 * and `allowContainerWildcard` says the caller declared {@link CONTAINER_NETWORK_ENV}. Plain
 * `server.listen(port)` with no host defaults to `::`, which accepts from EVERY interface — which
 * is what `rmd serve` actually did while printing "listening on http://localhost:4317". On a bare
 * host anyone on any network that host is attached to could reach the console, and the only thing
 * between them and fleet-control write actions was a bearer token the same command printed to a
 * world-readable log. `::`, `*` and `""` stay refused unconditionally: only `0.0.0.0`, and only
 * with the explicit container declaration, is the one case this task carves out — see
 * {@link CONTAINER_ALL_INTERFACES_HOST}'s doc for why that specific pairing is safe.
 */
export const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "*", ""]);

function assertBindableHost(host: string, raw: string, allowContainerWildcard: boolean): void {
  if (allowContainerWildcard && host === CONTAINER_ALL_INTERFACES_HOST) return;
  if (WILDCARD_HOSTS.has(host)) {
    throw new Error(
      `--host ${JSON.stringify(raw)} binds EVERY interface. Name the interface(s) you mean ` +
        `(e.g. ${DEFAULT_SERVE_HOST} for local only, or "${DEFAULT_SERVE_HOST},<tailnet-ip>" ` +
        `to keep the console reachable locally AND from the phone) — or, inside a container with ` +
        `no published port, set ${CONTAINER_NETWORK_ENV}=${CONTAINER_NETWORK_VALUE} alongside ` +
        `${JSON.stringify(CONTAINER_ALL_INTERFACES_HOST)} to declare that "every interface" means ` +
        `only this container's own network namespace (W1-T915).`,
    );
  }
  if (host.startsWith("--")) {
    throw new Error(`--host expects an address, got the flag ${JSON.stringify(raw)}`);
  }
}

/** Default TCP liveness probe for the serve port: connect, then immediately destroy. Never sends a
 *  byte, so it cannot appear in the gateway's request log as a spurious unauthenticated hit. Moved
 *  here from the retired `rmd console-url` module (W1-T4563); `rmd up` and `rmd down` call it. */
export function defaultIsListening(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    const done = (alive: boolean) => {
      sock.destroy();
      resolve(alive);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/**
 * Resolve the interface `rmd serve` binds to: `--host <addr>`, else `RMD_SERVE_HOST`, else
 * `configHost` (config.json's `serve.host` — W1-T152, so a launchd unit and a hand-run serve
 * agree without the operator retyping the address), else loopback. A wildcard is REFUSED rather
 * than silently accepted — exposure must be a thing someone typed, naming the interface they
 * meant — with exactly one carve-out (W1-T915): `0.0.0.0` is accepted when
 * `env[CONTAINER_NETWORK_ENV] === CONTAINER_NETWORK_VALUE`, because inside a container that value
 * names the container's own network namespace, not "every network this host is attached to". The
 * DEFAULT (`raw === undefined`, nobody named anything) is UNCHANGED — still always loopback,
 * containerized or not: R-4 ("exposure must be typed, never inherited") applies to the carve-out
 * exactly as it applies to every other interface this function resolves. `remudero-serve` closes
 * the measured defect by SETTING `RMD_SERVE_HOST=0.0.0.0` and `RMD_SERVE_NETWORK=container` in
 * its own launch config — an operator/deploy act, same as every other `RMD_SERVE_HOST` value —
 * not by this function inventing a default nobody typed.
 *
 * Remote access is expressed by naming the interface, not by opening all of them. This fleet is
 * reached from the operator's phone over Tailscale, so the tailnet address is the correct value
 * here (`RMD_SERVE_HOST=100.x.y.z`) — that keeps the console on an authenticated, encrypted
 * overlay instead of on every coffee-shop LAN the laptop joins.
 */
export function resolveServeHosts(rest: string[], env: NodeJS.ProcessEnv = process.env, configHost?: string): string[] {
  const idx = rest.indexOf("--host");
  const raw = idx >= 0 ? rest[idx + 1] : (env.RMD_SERVE_HOST ?? configHost);
  if (raw === undefined) return [DEFAULT_SERVE_HOST];
  const hosts = raw
    .split(",")
    .map((h) => h.trim())
    .filter((h, i, all) => all.indexOf(h) === i);
  // An all-empty value (",", "  ") must not silently collapse to "listen nowhere" — that would
  // read as a working server that answers no one. Fall through to the wildcard check below,
  // which names the empty string, so the operator gets a message rather than a silent no-op.
  if (hosts.length === 0) hosts.push("");
  const allowContainerWildcard = env[CONTAINER_NETWORK_ENV] === CONTAINER_NETWORK_VALUE;
  for (const host of hosts) assertBindableHost(host, raw, allowContainerWildcard);
  return hosts;
}

/**
 * SINGLE-HOST CONVENIENCE, retained because most callers want one address. Returns the FIRST
 * resolved host — never an UNDECLARED wildcard, since {@link resolveServeHosts} has already
 * refused those; it CAN return {@link CONTAINER_ALL_INTERFACES_HOST} when the caller explicitly
 * declared {@link CONTAINER_NETWORK_ENV} (W1-T915), the one wildcard spelling that is no longer
 * unconditionally refused.
 */
export function resolveServeHost(rest: string[], env: NodeJS.ProcessEnv = process.env): string {
  return resolveServeHosts(rest, env)[0] as string;
}

/**
 * W1-T997: the env var an operator sets to point `GET /v1/account-usage` at a readable copy of
 * `~/.claude.json` — see {@link resolveAccountFilePath}'s own doc for why this exists at all.
 */
export const ACCOUNT_FILE_PATH_ENV = "RMD_ACCOUNT_FILE_PATH";

/**
 * W1-T997: resolve the path `GET /v1/account-usage` reads for the console's usage panel.
 *
 * THE DEFECT THIS CLOSES. `readAccountUsageFile` (account-usage.ts) defaults to
 * `join(homedir(), ".claude.json")`, and `AccountUsageDeps.accountFilePath` already exists to
 * override that default — but nothing upstream of {@link buildServeRoutes} ever supplied a
 * value, so every request resolved under the SERVE process's own home, which is where
 * `remudero-serve`'s container mounts `~/.claude/` (a directory) but not the sibling
 * `~/.claude.json` FILE that sits beside it outside every mount. The panel therefore always read
 * `unreadable`, even though the identical file exists, fresh, in `remudero-daemon`.
 *
 * SAME PRECEDENCE SHAPE {@link resolveServeHosts} already uses for `--host` — explicit override
 * first, then an env var, then the default — minus the CLI-flag and config-file tiers: argv
 * parsing and `config.json` reading both live in run-task.ts's `serveCommand`, which this task
 * (W1-T997) deliberately does not touch (raised to `risk: high` specifically so the reader and
 * this wiring stay one shard rather than splitting a supplier from nothing to supply). An
 * explicit caller override (`ServeDeps.accountUsage.accountFilePath` — the SAME "an assembler
 * wires the real thing, a test injects a fake" seam every other optional field on that type
 * already follows) stands in for the flag tier; {@link ACCOUNT_FILE_PATH_ENV} stands in for the
 * config tier: an operator sets it directly in the deployment environment, entirely outside this
 * file and the CLI parser. Neither set ⇒ `undefined`,
 * which is exactly what flowed through before this task — `readAccountUsageFile`'s OWN default
 * parameter resolves it, so an install that sets neither renders BYTE-IDENTICAL to today.
 *
 * CONTAINMENT (design note iv): this only ever WIDENS what the route may READ, never what it may
 * write — `readAccountUsageFile` opens the path with `readFileSync` and projects a handful of
 * scalar fields out of it (see that function's own doc); nothing here grants the console write
 * access to the operator's Claude Code state or serializes any key beyond the ones already
 * named there.
 */
export function resolveAccountFilePath(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return explicit ?? env[ACCOUNT_FILE_PATH_ENV];
}

/**
 * The only `serve.trustedProxy` value {@link resolveServeIdentity} accepts today: the operator
 * declaring that Tailscale Serve (see service.ts's `IdentityAuth` doc) is the process
 * terminating on the trusted loopback address. Any other declared value names a proxy this
 * codebase cannot verify strips identity headers the way Serve does, so it is refused rather
 * than silently trusted (W1-T398).
 */
export const TRUSTED_PROXY_TAILSCALE = "tailscale";

/**
 * W1-T371/W1-T398: resolve the additive tailnet-identity option, or `undefined` when the
 * operator hasn't opted in. `identityCapability` (config.json's `serve.identityCapability`) is
 * the ONLY source for the capability name — no `--flag`/env override, unlike port/host: the ACL
 * app-capability name is an install-level constant chosen once against the operator's own
 * Tailscale policy, not something a single invocation varies. Undefined input (the default,
 * unconfigured install) returns `undefined` REGARDLESS of `trustedProxy` — identity is never
 * consulted, byte-for-byte the pre-W1-T371 behavior, and the off-by-default path gains no new
 * required field.
 *
 * `trustedLocalAddress` is always {@link DEFAULT_SERVE_HOST} (loopback) — matching Tailscale's
 * own documented guidance that a backend trusting Serve's identity headers should listen ONLY
 * on localhost ("it's best practice to only have the service listen on localhost... [otherwise]
 * any user that can call your service directly... could trivially provide their own values for
 * these HTTP headers", https://tailscale.com/kb/1312/serve). This is independent of whatever
 * `rmd serve` itself binds via `RMD_SERVE_HOST`/`resolveServeHosts` — those are this Node
 * process's own direct-connection interfaces, not `tailscale serve`'s proxy target, which is
 * operator-machine deployment config (com.remudero.serve.plist) outside this repo.
 *
 * W1-T398: enabling `identityCapability` used to inherit that loopback-trust assumption
 * silently — nothing recorded WHICH proxy the operator meant to be listening there, so pointing
 * any OTHER reverse proxy (nginx, Caddy, a cloud load balancer's local target) at the same
 * address turns gate 1 (service.ts's interface check) into a no-op while gate 2's header check
 * loses the only thing that made it safe (Serve stripping client-supplied headers). Whether the
 * process on that address really is Serve is NOT OBSERVABLE from inside this one — shelling a
 * `tailscale` binary would prove a daemon is running, never that it's the listener in question
 * — so this cannot VERIFY the topology, only require the operator to STATE it:
 *   - `trustedProxy` absent while `identityCapability` is set: REFUSED at startup. A config that
 *     never declares which proxy it trusts no longer silently inherits one.
 *   - `trustedProxy === "tailscale"` ({@link TRUSTED_PROXY_TAILSCALE}): the declared, supported
 *     case — resolves exactly as it did before W1-T398.
 *   - any other `trustedProxy` value: a named opt-out, REFUSED for now, naming what would have
 *     to be true (a header-stripping guarantee equivalent to Serve's) for it to be safe.
 * An install that never sets `identityCapability` never reaches any of this: this function
 * still returns `undefined` for it without ever inspecting `trustedProxy`.
 */
export function resolveServeIdentity(
  identityCapability: string | undefined,
  trustedProxy: string | undefined,
): ServiceOptions["identity"] {
  if (!identityCapability) return undefined;
  if (!trustedProxy) {
    throw new Error(
      `config serve.identityCapability is set ("${identityCapability}") but serve.trustedProxy is ` +
        `not. Tailnet-identity auth trusts whichever process is terminating on the loopback address ` +
        `gate 1 checks against, and nothing declares which one this install means. Add ` +
        `"trustedProxy": "${TRUSTED_PROXY_TAILSCALE}" next to identityCapability in config.json if ` +
        `Tailscale Serve is that process (the supported, documented case).`,
    );
  }
  if (trustedProxy !== TRUSTED_PROXY_TAILSCALE) {
    throw new Error(
      `config serve.trustedProxy ${JSON.stringify(trustedProxy)} is not a supported value. Only ` +
        `"${TRUSTED_PROXY_TAILSCALE}" is accepted today — gate 2 (service.ts's capability check) is ` +
        `only as sound as its assumption that the process on the trusted loopback address strips ` +
        `client-supplied identity headers the way Tailscale Serve does, and nothing in this codebase ` +
        `can verify that of a different proxy. Front this with Tailscale Serve, or unset ` +
        `identityCapability and rely on the bearer token instead.`,
    );
  }
  return { trustedLocalAddress: DEFAULT_SERVE_HOST, capability: identityCapability };
}

// ── SERVICE LIFECYCLE (W1-T152) ───────────────────────────────────────────────────────────
//
// What changes when the console stops being a foreground process someone babysits and becomes
// a launchd job that is expected to survive kills, reboots and the operator being 3000 miles
// away. Each helper below is one incident, kept PURE-ish (injected clock / injected git / plain
// paths) so it is provable without a live service:
//
//   listenWithReapWait  — the kill→relaunch EADDRINUSE race that produced a silent outage
//   ensureLogFileMode   — R-5, a bearer token found in a world-readable serve.log
//   offMainNotice       — a console serving branch code lies to the operator (W1-T255 posture:
//                         it SAYS SO, LOUDLY, and keeps serving — a service never exit-1s on
//                         tree state, which is what crash-looped the daemon after #707)

/** How many times {@link listenWithReapWait} retries a bind that loses the port race, and how
 *  long it waits between tries — 20 × 500ms = a 10s reap window, comfortably inside launchd's
 *  60s ThrottleInterval, so a genuinely stuck port still surfaces as a real error rather than
 *  being papered over forever. */
export const DEFAULT_BIND_ATTEMPTS = 20;
export const DEFAULT_BIND_RETRY_MS = 500;

/**
 * Bind, WAITING OUT a port the previous process has not released yet.
 *
 * THE INCIDENT: `kill $(lsof -ti :4317)` followed immediately by a relaunch raced — the new
 * process hit EADDRINUSE, died into an unread log, the OLD process kept serving stale code,
 * and when it finally exited the console was down with nothing listening. Every layer of that
 * was silent. Under launchd the same race is REAL and more likely, not less: `kickstart -k`
 * SIGKILLs and relaunches immediately, and a relaunch that dies on EADDRINUSE burns a
 * ThrottleInterval before anyone finds out.
 *
 * So an in-use port is treated as a TRANSIENT condition to wait out (the old owner is being
 * reaped), not a fatal one — but only for a bounded window, and only for EADDRINUSE: any other
 * listen error (EACCES on a privileged port, EADDRNOTAVAIL for a tailnet address that isn't up
 * yet) is rethrown immediately, because retrying those just delays a real diagnosis. `onRetry`
 * is how the caller makes the wait AUDIBLE — the silence is what made the original outage
 * expensive.
 */
export async function listenWithReapWait(
  listen: () => Promise<void>,
  opts: {
    attempts?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (attempt: number, err: NodeJS.ErrnoException) => void;
  } = {},
): Promise<void> {
  const attempts = opts.attempts ?? DEFAULT_BIND_ATTEMPTS;
  const delayMs = opts.delayMs ?? DEFAULT_BIND_RETRY_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      await listen();
      return;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "EADDRINUSE" || attempt >= attempts) throw err;
      opts.onRetry?.(attempt, err);
      await sleep(delayMs);
    }
  }
}

/**
 * Force mode 0600 on the console's log files, creating them if absent (R-5, standing rule 24).
 *
 * launchd creates `StandardOutPath`/`StandardErrorPath` at its own umask — 0644 — and serve's
 * startup banner prints the READ bearer token, so the default is a token in a world-readable
 * file that outlives the process. That already happened once and cost a token rotation. Both
 * the `--write` install path and serve's own boot call this: pre-creating at 0600 wins the
 * common case (launchd appends to the existing file, keeping the mode), and the boot-time call
 * repairs a file launchd got to first.
 *
 * BEST-EFFORT BY CONSTRUCTION: a chmod failure returns the path in `failed` and NEVER throws —
 * a service that refuses to start because it could not tighten a log file has turned a hygiene
 * problem into an outage (the W1-T255 posture, applied to file state instead of tree state).
 */
export function ensureLogFileMode(paths: string[], mode: number = 0o600): { secured: string[]; failed: string[] } {
  const secured: string[] = [];
  const failed: string[] = [];
  for (const p of paths) {
    try {
      mkdirSync(dirname(p), { recursive: true });
      closeSync(openSync(p, "a", mode));
      chmodSync(p, mode); // FORCE — `openSync` only applies `mode` when it CREATES the file.
      const actual = statSync(p).mode & 0o777;
      if (actual === mode) secured.push(p);
      else failed.push(p);
    } catch {
      failed.push(p);
    }
  }
  return { secured, failed };
}

/** The branch a console is allowed to serve without comment. */
export const SERVE_EXPECTED_BRANCH = "main";

/**
 * The LOUD non-fatal notice a console prints when its checkout is not on `main` — or `null`
 * when it is (and when the branch can't be read at all, which is not evidence of anything).
 *
 * THE INCIDENT: `rmd serve` launched off a feature branch keeps serving that branch's code
 * after the checkout returns to main, because tsx loads the module graph once. Three
 * stale-code incidents in one day traced to it, and the operator had no way to tell from the
 * board that he was looking at un-shipped code.
 *
 * WHY A NOTICE AND NOT A REFUSAL. W1-T152 originally specified "REFUSES to bind when not on
 * main, exit non-zero". W1-T255 (#726) then established the opposite for services, the hard
 * way: the daemon's dirty-tree refusal exit-1'd on every launchd restart and took the whole
 * automation down for hours. A KeepAlive'd unit turns ANY startup refusal into a crash-loop,
 * and a crash-looping console is strictly worse than a console that is honest about which
 * branch it serves — the operator reattaching from a phone needs a surface that answers.
 * So: assess, say so in the log every boot, and serve. (Amended in plan/tasks.yaml with this
 * citation rather than implemented against the older wording.)
 */
export function offMainNotice(branch: string | null): string | null {
  if (branch === null || branch === SERVE_EXPECTED_BRANCH) return null;
  return (
    `### rmd serve — WARNING: this checkout is on branch '${branch}', not '${SERVE_EXPECTED_BRANCH}'. ` +
    `The console is serving code that is NOT what the fleet ships, and tsx loads the module graph ` +
    `ONCE — returning the checkout to '${SERVE_EXPECTED_BRANCH}' will NOT change what this process ` +
    `serves. Restart it (launchctl kickstart -k gui/$UID/com.remudero.serve) from ` +
    `'${SERVE_EXPECTED_BRANCH}'. Serving anyway: a service never refuses to start over tree state (W1-T255).`
  );
}

/** The checkout's current branch, or `null` when it can't be read (detached HEAD, no git, a
 *  worktree mid-operation) — `null` is "don't know", never "off main", so {@link offMainNotice}
 *  stays silent rather than crying wolf. `git` is injectable for tests. */
export function currentBranch(repoDir: string, git?: (args: string[]) => string): string | null {
  const run = git ?? ((args: string[]) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" }));
  try {
    const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    return branch === "" || branch === "HEAD" ? null : branch;
  } catch {
    return null;
  }
}

/** Where `rmd serve`'s generated bearer tokens persist across restarts (config.root, like every other `<root>/state/*` control file). */
export function serviceTokensPath(configRoot: string): string {
  return join(configRoot, "state", "service-tokens.json");
}

/**
 * Load `rmd serve`'s bearer tokens, generating + persisting them on first run. A bearer token
 * must stay STABLE across daemon restarts (a client — apps/dashboard's `?token=` param, a
 * saved curl command — would otherwise silently break every relaunch), so this is create-once,
 * read-thereafter, using the SAME exclusive-create discipline config.ts's `loadConfig` already
 * established for its own first-run file (`openSync(p, "wx")` folds the existence check and
 * the create into one atomic syscall — no TOCTOU window for a second `rmd serve` racing this
 * one's first launch to clobber the other's tokens).
 *
 * ROTATION (previously undocumented, which made it effectively absent — R-31). Because this is
 * create-once/read-thereafter, rotation is: stop `rmd serve`, delete the file, start it again.
 * The next start mints a fresh pair at 0600.
 *
 *     lsof -ti :4317 | xargs kill
 *     rm ~/Remudero/state/service-tokens.json
 *     rmd serve            # prints the new console URL
 *
 * Rotate whenever a token has been exposed — and note that MERELY RUNNING `rmd serve` used to
 * expose both, because it printed them to stdout, which under the operator's launch is
 * redirected to a world-readable `serve.log`. Any token that reached a log, a terminal
 * transcript, or a chat window is compromised and must be rotated, not merely un-shared.
 *
 * CodeQL js/file-system-race, round 4 (alert #61): the `wx` attempt and the EEXIST fallback
 * read both go through the shared `createOrReadExclusive` helper (fs-race-safe.ts) — the same
 * one config.ts's `loadConfig` uses — rather than a fourth open-coded copy of this exact
 * create-or-read shape.
 */
export function resolveServiceTokens(configRoot: string): ServiceTokens {
  const p = serviceTokensPath(configRoot);
  mkdirSync(dirname(p), { recursive: true });
  const result = createOrReadExclusive(p, 0o600);
  if (result.created) {
    try {
      const created: ServiceTokens = { read: randomBytes(32).toString("hex"), write: randomBytes(32).toString("hex") };
      writeSync(result.fd, JSON.stringify(created, null, 2) + "\n");
      return created;
    } finally {
      closeSync(result.fd);
    }
  }
  return JSON.parse(result.raw) as ServiceTokens;
}

/** `existsSync` re-export point kept trivial — used only by test fixtures wanting to assert the tokens file's persistence without importing node:fs directly for that one check. */
export function serviceTokensFileExists(configRoot: string): boolean {
  return existsSync(serviceTokensPath(configRoot));
}
