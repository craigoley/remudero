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

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeSync } from "node:fs";
import { promises as fsPromises } from "node:fs";
import { execFileSync } from "node:child_process";
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
  type IdentityProvider,
  type ServiceOptions,
  type ServiceTokens,
  type SseRoute,
  type WriteTier,
} from "./service.js";
import { loadEscalationLinkSecret, type EscalationOption, type EscalationOptionRoute } from "./escalate.js";
import { buildRecentRoute, buildStatusRoute, buildStatusStream, DEFAULT_POLL_MS, type BoardDeps } from "./board.js";
import type { GitHub } from "./status.js";
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
import { buildPanelGraphRoutes, ratifyCliGateway, type PanelGraphDeps } from "./panel-graph.js";
import { buildPanelSkillsRoutes } from "./panel-skills.js";
import { buildPanelSkillRunRoutes } from "./panel-skill-run.js";
import { buildTaskCardRoute } from "./task-card.js";
import { buildAddOperatorNoteRoute, buildListOperatorNotesRoute } from "./operator-notes.js";
import { createLastSeenStore, lastSeenPath, type LastSeenStore } from "./last-seen.js";
import { buildDaemonHealthRoute, type DaemonHealthDeps } from "./daemon-health.js";
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
import { buildAnalyticsRoute, type AnalyticsRouteDeps } from "./analytics-route.js";
import { renderConsoleShellScript } from "./console-shell-script.js";
import { consoleShellClientSource } from "./console-shell-client.js";
import { inboxDigestsPath } from "./digest.js";
import { readIdleReasons, renderIdleReasonsHtml } from "./idle-reasons-panel.js";
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
  githubDeliveryDedupPath,
  sweepWakeMarkerPath,
  type GithubEventWakeSemanticMode,
} from "./github-event-wake.js";
import { DEFAULT_GITHUB_EVENT_WAKE_DEDUP_CAPACITY } from "./policy.js";
import { loadConfig, type WorkerProviderId } from "./config.js";
import { fixedClock, systemClock } from "./clock.js";

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

/** Default `rmd serve` port — matches apps/dashboard/src/main.ts's own `?daemon=` default (`http://localhost:4317`), so the shipped dashboard points at a served daemon out of the box. */
export const DEFAULT_SERVE_PORT = 4317;

export interface ServeDeps {
  /** W1-T3176 — the built console's directory. OMITTED means this daemon serves the string shell
   *  only: no mount is installed, no build is looked for, and nothing is reported. Set, it is
   *  verified at startup and the result is both logged and printed in the banner. */
  consoleBuildRoot?: string;
  /** Injected filesystem for that check, so the decision is provable without a real build. */
  consoleBuildIo?: ConsoleBuildIo;
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
  /** W1-T2562: re-resolve the CURRENT on-disk sha for the shell's staleness chip. Defaults to
   *  {@link resolveConsoleSha} — the same primitive {@link gateStaleCodeExit} compares against. */
  resolveCurrentSha?: () => string;
  board: BoardDeps;
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
  /**
   * W1-T477: `GET /v1/analytics`'s deps (see analytics-route.ts's header). OPTIONAL and defaults
   * to a real rotation-union read against the real filesystem, the same "the assembler wires the
   * real thing, a test injects a fake" split every other optional field here already follows. The
   * `ledgerPath` half is always the console's own — see {@link accountUsage}'s doc immediately
   * above for why that is never a caller-supplied override.
   */
  analytics?: Omit<AnalyticsRouteDeps, "ledgerPath">;
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

export interface ConsoleResponseStaleness {
  stale: boolean;
  ageMs: number | null;
  generatedAt: string | null;
  refreshing: boolean;
  budgetMs: number;
  reason?: string;
}

export interface ConsoleBlockingRequestPathViolation {
  route: string;
  symbol: string;
}

export const CONSOLE_READ_ROUTE_BUDGET_MS = 750;
export const CONSOLE_BLOCKING_REQUEST_PATH_BASELINE = 0;
const CONSOLE_STALENESS_FIELD = "staleness";
const CONSOLE_CACHED_READ_PATHS = new Set(["/v1/status", "/v1/recent", "/v1/inbox", "/v1/daemon-health"]);
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

function responseStaleness(nowMs: number, generatedAtMs: number | undefined, refreshing: boolean, budgetMs: number, reason?: string): ConsoleResponseStaleness {
  return {
    stale: generatedAtMs === undefined || nowMs - generatedAtMs > budgetMs,
    ageMs: generatedAtMs === undefined ? null : Math.max(0, nowMs - generatedAtMs),
    generatedAt: generatedAtMs === undefined ? null : fixedClock(generatedAtMs).iso(),
    refreshing,
    budgetMs,
    ...(reason ? { reason } : {}),
  };
}

function withJsonStaleness(body: unknown, staleness: ConsoleResponseStaleness): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return JSON.stringify({ ...(body as Record<string, unknown>), [CONSOLE_STALENESS_FIELD]: staleness });
  }
  return JSON.stringify({ value: body, [CONSOLE_STALENESS_FIELD]: staleness });
}

function sendStaleJson(res: import("node:http").ServerResponse, status: number, body: unknown, staleness: ConsoleResponseStaleness): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-rmd-cache-state": staleness.stale ? "stale" : "fresh",
    "x-rmd-cache-age-ms": staleness.ageMs === null ? "unknown" : String(staleness.ageMs),
  });
  res.end(withJsonStaleness(body, staleness));
}

function fallbackStatusSnapshot(deps: BoardDeps, nowMs: number, staleness: ConsoleResponseStaleness): BoardSnapshot & { staleness: ConsoleResponseStaleness } {
  const tasks: BoardRow[] = deps.plan.tasks.map((task) => ({
    taskId: task.id,
    title: task.title,
    risk: task.risk,
    status: "queued",
    merged: false,
    source: "throttled",
    indeterminate: true,
    unavailableReason: "transport",
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
  switch (path) {
    case "/v1/status":
      return fallbackStatusSnapshot(deps.board, nowMs, staleness);
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

interface BufferedRouteResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  generatedAtMs: number;
}

class RouteResponseBuffer {
  statusCode = 200;
  headersSent = false;
  private headers: Record<string, string> = {};
  private chunks: string[] = [];

  writeHead(status: number, headers?: import("node:http").OutgoingHttpHeaders): this {
    this.statusCode = status;
    this.headersSent = true;
    for (const [key, value] of Object.entries(headers ?? {})) {
      if (value === undefined) continue;
      this.headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
    }
    return this;
  }

  setHeader(name: string, value: number | string | readonly string[]): this {
    this.headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
    return this;
  }

  end(chunk?: unknown): this {
    if (chunk !== undefined) this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    this.headersSent = true;
    return this;
  }

  write(chunk: unknown): boolean {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return true;
  }

  buffered(generatedAtMs: number): BufferedRouteResponse {
    return { status: this.statusCode, headers: { ...this.headers }, body: this.chunks.join(""), generatedAtMs };
  }
}

function writeBufferedResponse(res: import("node:http").ServerResponse, cached: BufferedRouteResponse, staleness: ConsoleResponseStaleness): void {
  const headers: Record<string, string> = {
    ...cached.headers,
    "x-rmd-cache-state": staleness.stale ? "stale" : "fresh",
    "x-rmd-cache-age-ms": staleness.ageMs === null ? "unknown" : String(staleness.ageMs),
  };
  const contentType = headers["content-type"] ?? "";
  let body = cached.body;
  if (/application\/json/i.test(contentType)) {
    try {
      body = withJsonStaleness(JSON.parse(cached.body), staleness);
    } catch {
      // Malformed cached JSON keeps its original body; the cache headers still carry staleness.
      body = cached.body;
    }
  }
  res.writeHead(cached.status, headers);
  res.end(body);
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

export function boundConsoleReadRoute(route: Route, deps: ServeDeps, budgetMs: number = CONSOLE_READ_ROUTE_BUDGET_MS): Route {
  if (route.method !== "GET" || route.scope !== "read" || !CONSOLE_CACHED_READ_PATHS.has(route.path)) return route;
  let cached: BufferedRouteResponse | undefined;
  let refreshing = false;
  let refreshPromise: Promise<void> | undefined;
  let lastError: string | undefined;

  const refresh = (req: import("node:http").IncomingMessage): Promise<void> => {
    if (refreshPromise) return refreshPromise;
    refreshing = true;
    const startedAt = systemClock.now();
    const buffer = new RouteResponseBuffer();
    refreshPromise = (async () => {
      try {
        await route.handler(req, buffer as unknown as import("node:http").ServerResponse, { params: {} });
        cached = buffer.buffered(startedAt);
        lastError = undefined;
      } catch (error) {
        const reason = String((error as Error)?.message ?? error);
        lastError = reason;
      } finally {
        refreshing = false;
        refreshPromise = undefined;
      }
    })();
    return refreshPromise;
  };

  return {
    ...route,
    handler: async (req, res) => {
      const refreshDone = refresh(req);
      const outcome = await Promise.race([
        refreshDone.then(() => "ready" as const),
        new Promise<"budget">((resolve) => setTimeout(() => resolve("budget"), budgetMs)),
      ]);
      if (outcome === "ready" && cached) {
        writeBufferedResponse(res, cached, responseStaleness(systemClock.now(), cached.generatedAtMs, refreshing, budgetMs, lastError));
        return;
      }
      // Reaching this branch means the live refresh missed its response budget. Even a cache entry
      // generated exactly one budget window ago is therefore a stale fallback for this response;
      // deriving only from age made the boundary millisecond nondeterministically report `fresh`.
      const staleness = {
        ...responseStaleness(systemClock.now(), cached?.generatedAtMs, refreshing, budgetMs, lastError),
        stale: true,
      };
      if (cached) {
        writeBufferedResponse(res, cached, staleness);
        return;
      }
      sendStaleJson(res, 200, fallbackBodyForCachedRead(route.path, deps, staleness), staleness);
    },
  };
}

export function boundConsoleReadRoutes(routes: readonly Route[], deps: ServeDeps, budgetMs: number = CONSOLE_READ_ROUTE_BUDGET_MS): Route[] {
  return routes.map((route) => boundConsoleReadRoute(route, deps, budgetMs));
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
): () => void {
  const warm = (): void => {
    try {
      github.warm?.();
    } catch {
      // The gateway records its own failure state; prewarming must never break stream open.
    }
  };
  const first = setTimeout(warm, 0);
  first.unref?.();
  const timer = setInterval(warm, refreshMs);
  timer.unref?.();
  return () => {
    clearTimeout(first);
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
): { route: SseRoute; stop: () => void } {
  let clients = 0;
  let stopPrewarm: (() => void) | undefined;

  const stop = (): void => {
    stopPrewarm?.();
    stopPrewarm = undefined;
  };

  return {
    stop,
    route: {
      ...route,
      subscribe: (send) => {
        const unsubscribe = route.subscribe(send);
        clients += 1;
        // 0 -> 1 ONLY. A second viewer must not start a second timer (which would double the
        // very call rate this exists to bound) and must not re-warm off-cadence.
        if (clients === 1) stopPrewarm = prewarmBoardGithub(github, refreshMs);
        let released = false;
        return () => {
          // service.ts invokes this exactly once per connection, but a defensive latch keeps a
          // double-release from underflowing the count — a negative count would never reach 0
          // again and would strand the timer running with zero viewers, which is the bug.
          if (released) return;
          released = true;
          unsubscribe();
          clients -= 1;
          if (clients === 0) stop();
        };
      },
    },
  };
}

/**
 * The operator-console HTML shell (W1-T153: "replace the flat file-order table with
 * operator-priority sections + a real design system"). NOT apps/dashboard's full SPA — that
 * page's own header already documents why it stays a separate, later-wired artifact ("Wiring
 * the daemon to actually SERVE this directory as static files... is explicit follow-on work").
 *
 * INFORMATION ARCHITECTURE, top to bottom — file order appears NOWHERE (task design note):
 *   1. NOW        — in-flight runs (a live `phase` + elapsed), from GET /v1/status.
 *   2. NEEDS ME    — needs-human escalations (StatusProjection.needsHuman) + the feedback
 *      inbox's actionable entries (grilling/proposed, GET /v1/feedback) + W1-T110's READY
 *      ratification proposals (GET /v1/inbox) — one-line ask + action affordance each.
 *   3. UP NEXT     — the drain head, first ~5 of GET /v1/drain/preview (W1-T140), in
 *      plannedSequence order.
 *   4. RECENT      — last ~10 merges/blocks with PR links, GET /v1/recent (board.ts, reusing
 *      W1-T141's `merged`/`blocked` outcome vocabulary — see board.ts's header for why this
 *      route exists instead of querying a live DrainSummary).
 *   5. everything else, COLLAPSED behind grouped counts (queued: N, merged: N, other: N) with
 *      an expand + filter/search over the remaining GET /v1/status tasks.
 * Fleet control (Pause/Resume/STOP/quiet-hours) and an auxiliary "more tools" panel (submit
 * feedback, plan→task→PR graph) follow below the five sections.
 *
 * W1-T336: the priority order above is now expressed by WHICH TAB a section renders under
 * (Decisions/Now/Plan/Feed), not by its position on one continuous scroll — NEEDS ME is
 * Decisions' whole content; NOW/UP NEXT/Fleet control sit together under Now; RECENT/everything-
 * else/the "more tools" panel sit together under Feed. See SECTION_TAB_OWNER (this shell's own
 * script) for the exact table, and each section's own \`data-owner-tab\` attribute in the
 * template for the concrete rendering of it — DOCUMENT ORDER stays exactly as listed above
 * (test/serve.test.ts's own structural check polices it), ownership is expressed purely by that
 * attribute, never by moving a section into a per-tab container.
 *
 * SCOPE NOTE (W1-T110/W1-T111 split): a READY inbox proposal's "action" is the exact `rmd
 * approve`/`rmd reframe` command text, not a button — `approveProposal`/`reframeProposal`
 * (lib/inbox.ts) need a real git/gh `RatifyGateway`, and wiring that as a WRITE route is its
 * own concern (a ratification write surface), not this task's one concern (shell IA/design).
 * See GET /v1/inbox's own doc comment (panel-graph.ts).
 *
 * DESIGN SYSTEM: dark theme (default, no light/auto toggle in v0 — "applied by default"
 * satisfies the acceptance bar without prefers-color-scheme's extra state to keep distinct-
 * and-consistent across), five distinct CSS-custom-property status color tokens reused
 * EVERYWHERE a state appears (never an inline color — see `.status-dot`/`.status-label`),
 * monospace task ids, phone-first responsive (a single fluid column, no fixed-width table —
 * the v0 shell's `<table>` was exactly what produced horizontal scroll at 390px). Every
 * interactive control is a real `<button>`/`<input>`/`<label>` (never a clickable `<div>`),
 * kept for the Lighthouse/axe a11y bar (test/serve.shell-ux.test.ts).
 *
 * FLEET-CONTROL READ-BACK (task design note): the shell reads GET /v1/control/status
 * (panel-actions.ts, this task's own new route — no route exposed the tri-state before) and
 * renders the ACTIVE mode's control visibly active/disabled — never identical button states
 * across paused/running/stopped ("should I try clicking start?"). STOP requires an explicit
 * second click ("Confirm STOP") before it POSTs — never a single click.
 *
 * Uses bearer auth exactly like every other route on this surface (there is no unauthenticated
 * route in service.ts's model — `GET /` is `scope: "read"` like everything else; the reader
 * must already carry a token, same `?token=` query-param convention apps/dashboard's own
 * `main.ts` uses).
 *
 * W1-T154 ADDENDUM (first-paint perf, separable from the above IA/design work): the initial
 * markup below ships a SKELETON (see `skeletonRows`) in every row-list, never a bare "loading…"
 * text block. The page's own script then paints, in order: (1) a last-snapshot cache from
 * localStorage if one exists, stamped STALE via `#stale-badge`/`top-status`'s `data-stale`
 * attribute, swapped for live data the instant it arrives; (2) `GET /v1/status` ALONE, painting
 * NOW + the `#summary` line immediately — never gated behind the other five endpoints
 * (progressive load); (3) those other five, completing the picture. See `refreshAll`'s own
 * comment for the full sequencing.
 */
/**
 * W1-T154: the initial-paint placeholder for a row list with no data yet — a REAL skeleton (a
 * distinct, visually-pulsing "content is coming" marker), never the bare "loading…" text a
 * screen-reader-silent, visually-empty-looking block the acceptance bar's falsifier names
 * ("never a blank 'loading…' block"). `aria-hidden` because the page's `#top-status` (aria-live)
 * is the one accessible loading announcement — these rows are a purely visual placeholder.
 */
function skeletonRows(n: number): string {
  return Array.from({ length: n }, () => '<li class="row skeleton" aria-hidden="true"><span class="skeleton-bar"></span></li>').join("");
}

export function renderShellHtml(
  phaseElapsedThresholdsMs: Record<string, number> = DEFAULT_PHASE_ELAPSED_THRESHOLDS_MS,
  consoleSha: string = CONSOLE_SHA_UNKNOWN,
  // impl-FC: the WHY-IDLE panel, rendered SERVER-SIDE by buildShellRoute and spliced in as a static
  // fragment. Appended last and defaulted to "" so every existing caller and test is unaffected,
  // and so the client script below is untouched -- byte-identical to main, deliberately.
  idleReasonsHtml: string = "",
  // W1-T2269: the "github credential" glance chip's inner HTML, rendered SERVER-SIDE by
  // buildShellRoute (renderGithubCredentialHtml) — same "static span, no client-script risk"
  // discipline the "console build" chip beside it already follows. Appended last and defaulted
  // so every existing caller/test is unaffected.
  githubCredentialHtml: string = renderGithubCredentialHtml({ armed: false }),
  // W1-T2562: the "loaded code" glance chip's inner HTML, rendered SERVER-SIDE by buildShellRoute
  // from a sha re-resolved per request. Appended last and defaulted — same discipline as the two
  // chips above — so every existing caller and test is unaffected and the client script is
  // byte-identical to main.
  consoleCodeHtml: string = `<span class="console-code-current">current</span>`,
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Remudero — the operator console</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<style>
  :root {
    color-scheme: dark;
    --bg: #0b0e14;
    --bg-elevated: #12161f;
    --bg-card: #171c27;
    --border: #262c3a;
    --text: #e6e9ef;
    --text-dim: #a7b0c2;
    --text-faint: #8b93a8;
    --accent: #5b9dff;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --status-running: #4db8ff;
    --status-blocked: #ff6b6b;
    --status-needs-human: #ffb84d;
    --status-merged: #4ade80;
    --status-queued: #a3acc2;
    --radius: 10px;
    --gap: 12px;
  }
  * { box-sizing: border-box; }
  html, body { max-width: 100vw; overflow-x: hidden; }
  body {
    margin: 0; padding: var(--gap) var(--gap) 3rem;
    background: var(--bg); color: var(--text);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    line-height: 1.4;
  }
  /* W1-T183: tightened section/heading chrome (1.5rem->1rem gap, 1rem->0.75rem vertical
     section padding, 0.5rem->0.35rem heading margin) -- every priority section above "everything
     else" (NOW/NEEDS ME/UP NEXT/RECENT) is frequently EMPTY on a quiet fleet, so their own chrome
     -- not row height -- was the dominant cost keeping a first screen under 15 rows. */
  main { max-width: 56rem; margin: 0 auto; display: flex; flex-direction: column; gap: 0.6rem; }
  h1 { font-size: 1.25rem; margin: 0.5rem 0; }
  h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-dim); margin: 0 0 0.25rem; }
  a { color: var(--accent); min-height: 24px; display: inline-flex; align-items: center; }
  code, .mono { font-family: var(--font-mono); }
  #top-status { color: var(--text-dim); font-size: 0.875rem; margin: 0; }
  /* W1-T183 round 2: the >=15-rows-above-the-fold bar was passing the SYNTHETIC (1-char-title)
     fixture but only barely clearing 15 against the REAL, realistic-title 218-task plan (measured
     exactly 15 -- a margin thin enough that a different browser's font metrics could tip it under).
     Section/toolbar chrome -- not row height -- was still the dominant remaining cost once "everything
     else" itself was visible, so this round tightens that chrome further for real headroom, not a
     razor's edge. */
  section.panel-section {
    background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 0.5rem 0.75rem;
  }
  .row-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.25rem; }
  /* W1-T183 DENSITY + IA v2: one line per task by default -- id · status · phase · elapsed ·
     spend · PR/issue link -- truncated with an ellipsis rather than wrapping to a second line,
     so a first screen reads the fleet at a glance instead of scrolling card-shaped rows to find
     anything (the 2026-07-20 console v2 fixture this task falsifies). A row carrying a real
     inline FORM (NEEDS ME's approve/answer/accept-reject affordances) opts back into wrapping
     below -- an <input> cannot usefully truncate onto one line. */
  .row {
    display: flex; flex-wrap: nowrap; align-items: center; gap: 0.5rem;
    background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 6px;
    min-height: 24px; padding: 0.22rem 0.5rem; overflow: hidden;
  }
  .row > * { flex-shrink: 0; }
  .row:has(form), .row:has(.btn-row), .row:has(.drain-feedback) { flex-wrap: wrap; overflow: visible; align-items: baseline; }
  .row .task-id { font-family: var(--font-mono); font-weight: 600; }
  .row .detail {
    color: var(--text-dim); font-size: 0.875rem; flex: 1 1 auto; min-width: 0; flex-shrink: 1;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .row:has(form) .detail, .row:has(.btn-row) .detail, .row:has(.drain-feedback) .detail {
    flex-basis: 100%; white-space: normal; overflow: visible; text-overflow: clip;
  }
  /* W1-T435: the RECENT feed's one-tap operator verdict + steering note -- wraps onto its own
     full-width line below the detail text (the SAME "flex-basis: 100%" treatment a form/btn-row
     already gets above), so it never forces the row into horizontal overflow at a narrow viewport. */
  .drain-feedback { flex-basis: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; margin-top: 0.15rem; }
  .drain-feedback-note {
    flex: 1 1 160px; min-width: 120px; max-width: 100%; font: inherit; font-size: 0.8rem;
    resize: vertical; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px;
    padding: 0.15rem 0.35rem;
  }
  /* ANOMALY FLAG (W1-T183): a per-phase elapsed threshold exceeded -- never carried by colour
     alone, always paired with the "⚠ long-running" text+glyph marker (nowRowHtml/tickElapsed). */
  .row.anomaly { border-color: var(--status-needs-human); background: rgba(255, 184, 77, 0.1); }
  .anomaly-flag { color: var(--status-needs-human); font-weight: 700; }
  .status-dot { display: inline-block; width: 0.6em; height: 0.6em; border-radius: 50%; margin-right: 0.15em; }
  .status-label { font-size: 0.8rem; font-weight: 600; background: none; }
  /* the DOT is a filled swatch (background); the LABEL is text colored to match (never a
     filled background behind it — same-color text-on-background is an invisible-text bug). */
  .status-dot.status-running { background: var(--status-running); }
  .status-dot.status-blocked { background: var(--status-blocked); }
  .status-dot.status-needs-human { background: var(--status-needs-human); }
  .status-dot.status-merged { background: var(--status-merged); }
  .status-dot.status-queued { background: var(--status-queued); }
  .status-label.status-running { color: var(--status-running); }
  .status-label.status-blocked { color: var(--status-blocked); }
  .status-label.status-needs-human { color: var(--status-needs-human); }
  .status-label.status-merged { color: var(--status-merged); }
  .status-label.status-queued { color: var(--status-queued); }
  /* W1-T914: the review three-state dot/label, mirroring .status-dot/.status-label's own
     swatch-then-matching-text convention rather than a new pattern. Reuses the SAME status
     color variables (never new ones) — success=merged-green, failure=blocked-red,
     pending=running-blue, unreadable=needs-human-amber (an outage is attention-worthy, same as
     a stopped task); "none" (absent) gets the neutral queued-grey, never green or blue. */
  .review-dot { display: inline-block; width: 0.5em; height: 0.5em; border-radius: 50%; margin: 0 0.15em; }
  .review-label { font-size: 0.75rem; font-weight: 600; background: none; }
  .review-dot.review-success { background: var(--status-merged); }
  .review-dot.review-failure { background: var(--status-blocked); }
  .review-dot.review-pending { background: var(--status-running); }
  .review-dot.review-none { background: var(--status-queued); }
  .review-dot.review-unreadable { background: var(--status-needs-human); }
  .review-label.review-success { color: var(--status-merged); }
  .review-label.review-failure { color: var(--status-blocked); }
  .review-label.review-pending { color: var(--status-running); }
  .review-label.review-none { color: var(--status-queued); }
  .review-label.review-unreadable { color: var(--status-needs-human); }
  .empty { color: var(--text-faint); font-size: 0.875rem; }
  /* W1-T154: first-paint skeleton — a pulsing placeholder bar, never a blank/empty block. */
  .row.skeleton { opacity: 0.7; }
  .skeleton-bar {
    display: inline-block; width: 100%; height: 0.9rem; border-radius: 4px;
    background: linear-gradient(90deg, var(--bg-elevated) 25%, var(--border) 37%, var(--bg-elevated) 63%);
    background-size: 400% 100%; animation: skeleton-pulse 1.4s ease infinite;
  }
  @keyframes skeleton-pulse { 0% { background-position: 100% 50%; } 100% { background-position: 0 50%; } }
  /* W1-T159 GLANCE LAYER: the pinned summary strip + daemon-health widget -- dense, phone-first,
     never a fixed-width table (the same v0 lesson W1-T153's own header already names). */
  .glance-strip, .daemon-health {
    display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; margin: 0.4rem 0; padding: 0.5rem 0.65rem;
    background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius);
  }
  .glance-counts { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; }
  .glance-item { display: inline-flex; align-items: baseline; gap: 0.3em; font-size: 0.85rem; }
  .glance-label { color: var(--text-faint); }
  .glance-value { font-family: var(--font-mono); color: var(--text); font-weight: 600; }
  /* The ACCOUNT strip's scope note — deliberately quiet and full-width-wrapping: it is a caveat
     ("whole account, not just the fleet"), not a metric, and must never read as one more number. */
  .glance-scope { flex-basis: 100%; }
  .glance-scope .glance-label { font-size: 0.75rem; font-style: italic; }
  .glance-anomaly {
    margin: 0.4rem 0 0; padding: 0.3rem 0.6rem; border-radius: 6px; font-size: 0.85rem; font-weight: 600;
    background: rgba(255, 107, 107, 0.14); color: var(--status-blocked); border: 1px solid var(--status-blocked);
  }
  /* W1-T336: the four-tab console bar -- pinned directly under the glance strip (the header
     block, above), a plain role="tablist" of role="tab" buttons that is now AUTHORITATIVE: every
     one of the nine \`[data-owner-tab]\` sections below is hidden by the script's own
     applyActiveTab whenever its owner isn't the active tab (see SECTION_TAB_OWNER).
     SIZING, REVISED -- W1-T183's lesson is KEPT, its application here is corrected. The rule
     above this one used to read \`font-size: 0.65rem; line-height: 1; padding: 0 0.35rem;
     border: none\`, and its comment said it was "Sized like FIND's own .sort-header buttons".
     IT WAS NOT: .facet-btn/.sort-header are \`font-size: 0.8rem; padding: 0.2rem 0.5rem\` and
     inherit the base \`button\` border, so the tab bar was substantially SMALLER than the idiom
     it named -- measured headlessly, a 10.41px-tall bar carrying the console's only navigation
     between its four views, under a 339.86px pinned header, at a font 76% of the .glance-item
     labels above it. W1-T183's point -- that TOOLBAR CHROME, not row height, decides how many
     rows clear the fold -- is real and is why this stays a compact toolbar idiom rather than
     becoming default button chrome (\`padding: 0.4rem 0.75rem\`). What that lesson never
     licensed is chrome so small it stops reading as a control: the fold discipline was applied
     to these four buttons and not to the 21 metric fields pinned above them, so the bar was
     compressed to save space the header then spent many times over. This adopts .sort-header's
     ACTUAL metrics and matches .glance-item's font size exactly, so the navigation is no longer
     smaller than the labels it navigates. MEASURED COST, headlessly, not estimated: the bar goes
     10.41px -> 27.41px, +17.00px of chrome ONCE for the whole page (the pinned header above it is
     unchanged at 339.86px, and no section moves tabs). */
  .console-tabs { display: flex; flex-wrap: wrap; gap: 0.25rem; margin: 0; }
  .tab-btn { font-size: 0.85rem; padding: 0.2rem 0.5rem; }
  .tab-btn[aria-selected="true"] { background: var(--accent); color: #04101f; border-color: var(--accent); }
  /* impl-DY: the header write-state badge. Colour is a SECONDARY cue only -- the text states the
     capability outright, so this reads correctly to a colour-blind operator and in a screenshot. */
  .write-state-badge {
    margin: 0.35rem 0 0; padding: 0.3rem 0.6rem; border-radius: 6px; font-size: 0.85rem; font-weight: 600;
    border: 1px solid transparent;
  }
  .write-state-badge[data-write-state="read-only"], .write-state-badge[data-write-state="rejected"] {
    background: rgba(255, 107, 107, 0.14); color: var(--status-blocked); border-color: var(--status-blocked);
  }
  .write-state-badge[data-write-state="write"] {
    background: rgba(87, 214, 140, 0.14); color: var(--status-merged); border-color: var(--status-merged);
  }
  .write-state-badge[data-write-state="unknown"] { opacity: 0.7; }
  /* W1-T346: the NEEDS ME ask-type badge -- an ACTION row (something to DO) reads distinctly
     from a QUESTION row (something to DECIDE); colour is a secondary cue only, the text itself
     ("Do"/"Decide") states the ask outright. */
  .ask-type-badge {
    display: inline-block; margin-right: 0.35em; padding: 0.05rem 0.4rem; border-radius: 999px;
    font-size: 0.75rem; font-weight: 700; border: 1px solid transparent; vertical-align: middle;
  }
  .ask-type-badge.ask-type-action {
    background: rgba(255, 184, 77, 0.16); color: var(--status-needs-human); border-color: var(--status-needs-human);
  }
  .ask-type-badge.ask-type-question {
    background: rgba(87, 214, 140, 0.14); color: var(--status-merged); border-color: var(--status-merged);
  }
  /* W1-T507: the human-verify-pending badge -- SAME pill shape as the ask-type badges above,
     a DISTINCT colour (the queued tone) so a verify:human row reads as its own kind rather
     than as an escalation (which keeps the amber ask-type-action/needs-human tone). */
  .ask-type-badge.ask-type-verify {
    background: rgba(163, 172, 194, 0.16); color: var(--status-queued); border-color: var(--status-queued);
  }
  /* W1-T1006: the blocked-PR badge -- SAME pill shape, the "blocked" tone (distinct from both
     the amber escalation/action tone and the queued verify tone) so a sweep-disposed PR reads
     as its own kind. */
  .ask-type-badge.ask-type-blocked-pr {
    background: rgba(255, 107, 107, 0.14); color: var(--status-blocked); border-color: var(--status-blocked);
  }
  .merge-hold-action { display: inline-flex; flex-wrap: wrap; gap: 0.35rem; align-items: center; margin-left: auto; }
  .merge-hold-action input { min-width: 15rem; }
  .merge-hold-current { margin: 0.45rem 0; }
  .pr-queue-toolbar { display: grid; grid-template-columns: repeat(3, minmax(9rem, 1fr)); gap: 0.5rem; margin: 0.35rem 0 0.55rem; }
  .pr-queue-toolbar label { margin: 0; }
  .pr-queue-toolbar select { width: 100%; margin-top: 0.15rem; }
  .pr-queue-row { display: block; width: 100%; padding: 0; border-left: 3px solid var(--status-queued); }
  .pr-queue-row.queue-actionable { border-left-color: var(--status-blocked); }
  .pr-queue-row.queue-active { border-left-color: var(--status-running); }
  .pr-queue-row.queue-ready-held { border-left-color: var(--status-merged); }
  .pr-queue-row summary { cursor: pointer; display: flex; align-items: center; gap: 0.45rem; padding: 0.35rem 0.55rem; overflow: hidden; }
  .pr-queue-row summary .detail { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pr-queue-transition { border-top: 1px solid var(--border); padding: 0.45rem 0.65rem; color: var(--text-dim); font-size: 0.82rem; display: grid; gap: 0.2rem; }
  .pr-queue-transition strong { color: var(--text); }
  @media (max-width: 620px) { .pr-queue-toolbar { grid-template-columns: 1fr; } }
  /* W1-T2497: THE MAILBOX -- inline, same <style> block (no stylesheet of its own). */ .mailbox-heading { font-size: 0.85rem; margin: 0.6rem 0 0.25rem; display: flex; align-items: center; gap: 0.4em; } .mailbox-unread-count:empty { display: none; } .mailbox-unread-count { display: inline-block; min-width: 1.2em; padding: 0 0.4em; border-radius: 999px; text-align: center; font-size: 0.75rem; font-weight: 700; background: var(--status-needs-human); color: #241a02; } .tab-btn .mailbox-unread-count { margin-left: 0.35rem; } .mailbox { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; } .mailbox-empty { font-size: 0.85rem; opacity: 0.7; margin: 0.25rem 0; } .mailbox-thread { list-style: none; border: 1px solid var(--border, #333); border-radius: 6px; padding: 0.4rem 0.6rem; } .mailbox-thread-unread { border-color: var(--status-needs-human); } .mailbox-thread-head { display: flex; align-items: center; gap: 0.4em; } .mailbox-unread-dot { width: 0.5em; height: 0.5em; border-radius: 999px; background: var(--status-needs-human); display: inline-block; } .mailbox-messages { list-style: none; margin: 0.3rem 0; padding: 0; display: flex; flex-direction: column; gap: 0.2rem; } .mailbox-message { font-size: 0.85rem; } .mailbox-sender { font-weight: 700; margin-right: 0.4em; } .mailbox-reply { display: flex; gap: 0.4em; margin-top: 0.3rem; }
  #stale-badge {
    display: inline-block; margin: 0.25rem 0 0; padding: 0.15rem 0.5rem; border-radius: 999px;
    font-size: 0.75rem; font-weight: 600; background: var(--status-needs-human); color: #241a02;
  }
  /* W1-T287: the author \`display\` above beats the UA sheet's own \`[hidden] { display: none }\`
     regardless of specificity, so markStale/clearStale flipping the \`hidden\` attribute
     (serve.ts ~1344-1350) changed nothing on screen -- the badge painted even while hidden.
     Same guard as .cmdk-overlay[hidden] below: hidden must win. */
  #stale-badge[hidden] { display: none; }
  /* W1-T156: TRUST — the console must never lie about its own liveness. ─────────────────── */
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
    clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
  }
  #trust-row { margin-top: 0.35rem; }
  .conn-badge {
    display: inline-flex; align-items: center; gap: 0.35em; padding: 0.15rem 0.55rem;
    border-radius: 999px; font-size: 0.75rem; font-weight: 600;
  }
  .conn-badge .dot { width: 0.5em; height: 0.5em; border-radius: 50%; background: currentColor; display: inline-block; }
  .conn-badge[data-state="connected"] { background: rgba(74, 222, 128, 0.15); color: var(--status-merged); }
  .conn-badge[data-state="connecting"] { background: rgba(163, 172, 194, 0.15); color: var(--text-dim); }
  .conn-badge[data-state="disconnected"] { background: rgba(255, 107, 107, 0.15); color: var(--status-blocked); }
  .conn-badge[data-state="connected"] .dot { animation: live-pulse 1.4s ease-in-out infinite; }
  @keyframes live-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  .gh-banner {
    background: rgba(255, 184, 77, 0.12); border: 1px solid var(--status-needs-human);
    color: var(--status-needs-human); padding: 0.5rem 0.75rem; border-radius: 8px; font-size: 0.85rem;
  }
  /* A FAILED WRITE, not a degraded read: red rather than the gh-banner's amber, so the two are
     never confused at a glance. Same box metrics, so it drops into the same header slot. */
  .write-error {
    background: rgba(255, 107, 107, 0.12); border-color: var(--status-blocked);
    color: var(--status-blocked); white-space: pre-line;
  }
  /* impl-EA: a SUCCEEDED write. Green for a completed action; the gh-banner amber is kept for one
     that was only REQUESTED - the fleet has not acted yet and may still refuse. Colour is a
     SECONDARY cue only; the text says which, so this reads correctly in a screenshot. */
  .write-ack { white-space: pre-line; }
  .write-ack[data-ack-kind="done"] {
    background: rgba(87, 214, 140, 0.12); border-color: var(--status-merged); color: var(--status-merged);
  }
  .live-indicator {
    width: 0.5em; height: 0.5em; border-radius: 50%; background: var(--status-running);
    display: inline-block; animation: live-pulse 1.2s ease-in-out infinite;
  }
  .live-badge-static {
    font-size: 0.75rem; font-weight: 700; letter-spacing: 0.03em; color: var(--status-running);
    border: 1px solid var(--status-running); border-radius: 4px; padding: 0 0.3em;
  }
  .row.flash { animation: row-flash 1.1s ease; }
  @keyframes row-flash { 0% { background: rgba(91, 157, 255, 0.35); } 100% { background: var(--bg-elevated); } }
  .row.flash-static { box-shadow: inset 3px 0 0 var(--accent); }
  @media (prefers-reduced-motion: reduce) {
    .conn-badge[data-state="connected"] .dot { animation: none; }
    .live-indicator { animation: none; }
    .row.flash { animation: none; background: var(--bg-elevated); }
    .skeleton-bar { animation: none; }
  }
  button {
    font: inherit; background: var(--bg-elevated); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; min-width: 24px; min-height: 24px; padding: 0.4rem 0.75rem; cursor: pointer;
  }
  button:hover { border-color: var(--accent); }
  button[aria-pressed="true"], button.active { background: var(--accent); color: #04101f; border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.danger { border-color: var(--status-blocked); color: var(--status-blocked); }
  button.danger.confirming { background: var(--status-blocked); color: #200404; }
  /* W1-T193: the proposal-card APPROVE button's arm-then-confirm state -- same visual language
     as STOP's own .confirming (an unmissable state change), a distinct (non-danger) accent since
     approving is not a destructive action the way STOP is. */
  button.proposal-approve-btn.confirming { background: var(--accent); color: #04101f; border-color: var(--accent); }
  /* W1-T2206: the Answer control's PENDING (preview in flight) and LAPSED (expired-arm) states.
     .pending rides on button:disabled's own dimming above, plus a wait cursor; .lapsed gets a
     distinct, non-armed accent so an expired arm is never visually mistaken for a fresh one. */
  .needs-me-answer-submit.pending { cursor: wait; }
  .needs-me-answer-submit.lapsed { border-color: var(--status-blocked); color: var(--status-blocked); }
  /* fb-…9daa9b: the UP NEXT write-actions (per-row Run + Drain now) — same arm-then-confirm
     visual language as APPROVE (a non-destructive accent), sized to sit inside a task row. */
  .up-next-run-btn { padding: 0.15rem 0.5rem; font-size: 0.8rem; margin-left: 0.4rem; flex: 0 0 auto; }
  .up-next-run-btn.confirming, #drain-now-btn.confirming { background: var(--accent); color: #04101f; border-color: var(--accent); }
  .up-next-actions { margin-bottom: 0.5rem; }
  #drain-now-btn { font-size: 0.85rem; padding: 0.25rem 0.6rem; }
  input, select, textarea { min-height: 24px; }
  input[type="text"], input[type="url"] {
    font: inherit; background: var(--bg); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 0.3rem 0.5rem; width: 100%; max-width: 24rem;
  }
  textarea {
    font: inherit; background: var(--bg); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 0.3rem 0.5rem; width: 100%; max-width: 28rem; resize: vertical;
  }
  label { display: block; min-height: 24px; font-size: 0.875rem; color: var(--text-dim); margin: 0.25rem 0; }
  /* W1-T183 round 2: this label reuses W1-T156's existing .sr-only class (defined above) -- still
     in the a11y tree (for=/aria-label parity), just not eating a whole line above the fold for a
     control whose placeholder already names it. */
  form.inline-action { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; flex-basis: 100%; }
  form.inline-action input, form.inline-action textarea { flex: 1 1 12rem; width: auto; }
  .btn-row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  /* W1-T193: a READY card's drafted-task list -- "render the draft's substance, not just its
     existence" (design). */
  .drafted-tasks { flex-basis: 100%; margin: 0.15rem 0 0.15rem 1.1rem; padding: 0; font-size: 0.875rem; color: var(--text-dim); }
  .drafted-tasks li { list-style: disc; }
  .counts { color: var(--text-dim); font-size: 0.9rem; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  /* W1-T157 FIND layer: faceted filters, sort headers, live counts ─────────────────────────── */
  .find-facets { display: flex; flex-wrap: wrap; gap: 0.5rem 0.75rem; margin: 0.3rem 0; }
  .facet-group { display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center; }
  .facet-group-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-faint); margin-right: 0.15rem; }
  .facet-btn, .sort-header { font-size: 0.8rem; padding: 0.2rem 0.5rem; }
  .facet-count { color: var(--text-faint); font-variant-numeric: tabular-nums; }
  button[aria-pressed="true"] .facet-count { color: inherit; }
  .find-sort { display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center; margin: 0.2rem 0; }
  #find-count { margin: 0.15rem 0; font-size: 0.8rem; }
  /* W1-T157 cmd+K command palette overlay ──────────────────────────────────────────────────── */
  .cmdk-overlay {
    position: fixed; inset: 0; z-index: 50; background: rgba(4, 7, 12, 0.6);
    display: flex; align-items: flex-start; justify-content: center; padding: 12vh 1rem 1rem;
  }
  .cmdk-overlay[hidden] { display: none; }
  #cmdk-dialog {
    background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius);
    width: min(92vw, 40rem); max-height: 70vh; display: flex; flex-direction: column;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55);
  }
  #cmdk-input { margin: 0.75rem; width: auto; max-width: none; }
  .cmdk-results { list-style: none; margin: 0; padding: 0 0.5rem 0.5rem; overflow-y: auto; }
  .cmdk-item {
    padding: 0.5rem 0.6rem; border-radius: 6px; cursor: pointer; font-size: 0.9rem;
    display: flex; align-items: center; gap: 0.5rem; overflow-wrap: anywhere;
  }
  .cmdk-item.active, .cmdk-item:hover { background: var(--bg-elevated); }
  .cmdk-kind { font-size: 0.75rem; font-weight: 700; letter-spacing: 0.03em; color: var(--text-faint); border: 1px solid var(--border); border-radius: 4px; padding: 0 0.3em; }
  .cmdk-empty { padding: 0.6rem; color: var(--text-faint); font-size: 0.875rem; }
  /* W1-T222: the INLINE DETAIL layer. Every task row is itself the expand trigger -- a right-
     edge chevron is the visible affordance (the row LOOKS expandable, not merely IS), flipping
     direction with the row detail button's own aria-expanded so the toggle state is legible without reading
     the card beneath it. */
  .row { cursor: pointer; }
  .row button, .row a, .row input, .row label, .row form { cursor: auto; }
  .row-chevron {
    margin-left: auto; min-width: 24px; min-height: 24px; padding: 0; font-size: 0.9rem; color: var(--text-faint);
    transition: transform 0.15s ease; display: inline-flex; align-items: center; justify-content: center;
  }
  .row-chevron[aria-expanded="true"] { transform: rotate(90deg); color: var(--accent); }
  @media (prefers-reduced-motion: reduce) {
    .row-chevron { transition: none; }
  }
  /* W1-T223: every section collapses, and the WHOLE HEADER is the trigger -- a real <button>
     wrapped in its own <h2> (the WAI-ARIA disclosure pattern), so it keeps native Enter/Space +
     click for free AND still reads as a heading for screen-reader heading navigation. Same
     click/keyboard/chevron-flip gesture as a row (W1-T222), so the console has ONE expand
     interaction rather than two that differ by region. The summary line stays visible in BOTH
     states -- collapsing a section must never also hide the one line that answers its question. */
  .panel-section > h2 { margin: 0 0 0.25rem; }
  .section-header {
    display: flex; align-items: center; gap: 0.5rem; width: 100%;
    background: none; border: none; padding: 0; margin: 0;
    font: inherit; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-dim);
    text-align: left; cursor: pointer;
  }
  .section-summary {
    font-size: 0.8rem; font-weight: 400; text-transform: none; letter-spacing: normal;
    color: var(--text-dim); flex: 1 1 auto; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
  .section-chevron {
    margin-left: auto; font-size: 0.9rem; color: var(--text-faint);
    transition: transform 0.15s ease; display: inline-block; flex-shrink: 0;
  }
  .section-header[aria-expanded="true"] .section-chevron { transform: rotate(90deg); color: var(--accent); }
  @media (prefers-reduced-motion: reduce) {
    .section-chevron { transition: none; }
  }
  /* NEEDS ME: an item arriving while the section is COLLAPSED must not be silently missed --
     collapsing must never become a way to miss the thing the console exists to surface, so the
     header itself carries emphasis until the operator actually expands it. */
  .section-header.section-emphasis {
    border: 1px solid var(--status-needs-human); border-radius: 6px; padding: 0.2rem 0.4rem;
    background: rgba(255, 184, 77, 0.12);
  }
  .section-header.section-emphasis .section-summary { color: var(--status-needs-human); font-weight: 600; }
  /* the card itself: a distinct sibling <li>, indented + accent-bordered so it visibly BELONGS
     to the row directly above it rather than reading as one more row in the same list. */
  .row-detail {
    cursor: auto; background: var(--bg-card); border: 1px solid var(--accent);
    border-radius: 6px; padding: 0.6rem 0.75rem 0.75rem; margin: -0.1rem 0 0 0.75rem;
  }
  .row-detail-title { font-weight: 700; margin: 0 0 0.35rem; }
  h3 { font-size: 0.9rem; margin: 0.75rem 0 0.35rem; color: var(--text-dim); }
  .row-detail ul { list-style: none; margin: 0; padding: 0; }
  .row-detail li { padding: 0.15rem 0; }
  .row-detail .card-journey-body ul ul { padding-left: 1.25rem; }
  .card-dep-link, .journey-task-link, .card-journey-toggle { font-size: 0.85rem; padding: 0.2rem 0.5rem; }
  .card-journey-body { margin-top: 0.35rem; }
  /* the failing/blocking step in a journey — the whole point of "walk backwards to the cause". */
  .journey-fail { color: var(--status-blocked); font-weight: 600; }
  /* W1-T2489: the journey's inline SVG graph -- drawn INSIDE the text fallback above, never in
     place of it. No stylesheet or script of its own (inline, same page, same <style> block). */
  .journey-graph { max-width: 100%; height: auto; display: block; margin: 0 0 0.5rem; color: var(--text-dim); }
  .journey-graph-fail rect { stroke: var(--status-blocked); }
  .journey-graph-fail text { fill: var(--status-blocked); }
  @media (min-width: 900px) {
    main { max-width: 64rem; }
  }
</style>
</head>
<body>
<main>
<header>
  <h1>Remudero — the operator console</h1>
  <!-- impl-DY: the WRITE-STATE badge. The write token lives in sessionStorage (W1-T202, XSS grounds), so
       it dies with every tab and every browser restart, and the only statement of that fact used to live in
       #write-token-status inside the Fleet-control section - the ELEVENTH section on the page, far below
       NEEDS ME. An operator clicking "Mark handled" never saw it and read a disabled button as a broken
       one, twice. This says the same thing where the click happens.
       It renders from hasWriteScope, which is the PROBE result (GET /v1/auth/scope with the held token),
       never "a token string is present" - a stale or wrong token reads REJECTED here, not green. -->
  <p id="write-state-badge" class="write-state-badge" role="status" aria-live="polite" data-write-state="unknown">checking write access…</p>
  <!-- W1-T159 GLANCE LAYER: a pinned summary strip -- running/needs-me/blocked/queued/
       merged-today/spend-today/spend-this-week, EVERY number traceable to a named ledger/API
       source (GET /v1/status's counts+spend, the same combined NEEDS ME set the section below
       renders from) -- plus an anomaly banner (a NOW row past its phase threshold, or a NEEDS ME
       item open over 24h) so the strip answers "is everything okay?", not only "how many". See
       renderGlanceStrip/updateGlanceAnomaly, below. -->
  <section id="glance" class="glance-strip" aria-label="At a glance">
    <div id="glance-counts" class="glance-counts">
      <span class="glance-item"><span class="glance-label">running</span><span class="glance-value" id="glance-running">…</span></span>
      <span class="glance-item"><span class="glance-label">needs me</span><span class="glance-value" id="glance-needs-me">…</span></span>
      <span class="glance-item"><span class="glance-label">blocked</span><span class="glance-value" id="glance-blocked">…</span></span>
      <span class="glance-item"><span class="glance-label">queued</span><span class="glance-value" id="glance-queued">…</span></span>
      <span class="glance-item"><span class="glance-label">merged today</span><span class="glance-value" id="glance-merged-today">…</span></span>
      <span class="glance-item"><span class="glance-label">spend today</span><span class="glance-value" id="glance-spend-today">…</span></span>
      <span class="glance-item"><span class="glance-label">spend this week</span><span class="glance-value" id="glance-spend-week">…</span></span>
    </div>
    <p id="glance-anomaly" class="glance-anomaly" role="status" aria-live="polite" hidden></p>
  </section>
  <!-- W1-T159: daemon-health widget -- last poll, a LIVE next-poll countdown, disk free, and
       GitHub core rate-limit remaining, each from its own named source (GET /v1/daemon-health;
       see daemon-health.ts's header). A placeholder value here would fail this task's own
       acceptance bar, so every value starts "…" (unknown) until the first real response lands,
       never a fabricated number. -->
  <section id="daemon-health" class="daemon-health" aria-label="Daemon health">
    <span class="glance-item"><span class="glance-label">last poll</span><span class="glance-value" id="dh-last-poll">…</span></span>
    <span class="glance-item"><span class="glance-label">next poll</span><span class="glance-value" id="dh-next-poll">…</span></span>
    <span class="glance-item"><span class="glance-label">disk free</span><span class="glance-value" id="dh-disk-free">…</span></span>
    <span class="glance-item"><span class="glance-label">rate limit</span><span class="glance-value" id="dh-rate-limit">…</span></span>
    ${idleReasonsHtml}
  </section>
  <!-- ACCOUNT strip: WHICH Anthropic account the fleet is spending, and how much of each usage
       window is gone (GET /v1/account-usage; see account-usage.ts's header for why usage comes
       from ~/.claude.json's cachedUsageUtilization and NOT from the daemon.headroom ledger line).
       Same box metrics and the same .glance-item idiom as the two strips above, so it drops into
       the header without a new layout. Every value starts "…" and renders "unknown" — never 0% —
       when its own source could not be read; "usage as of" is always shown, even when fresh,
       because a percentage nobody refreshes is worse than no percentage. -->
  <section id="account-usage" class="daemon-health" aria-label="Anthropic account usage">
    <span class="glance-item"><span class="glance-label">account</span><span class="glance-value" id="au-account">…</span></span>
    <span class="glance-item"><span class="glance-label">5h window</span><span class="glance-value" id="au-five-hour">…</span></span>
    <span class="glance-item"><span class="glance-label">7d window</span><span class="glance-value" id="au-seven-day">…</span></span>
    <span class="glance-item"><span class="glance-label">governor</span><span class="glance-value" id="au-governor">…</span></span>
    <!-- W1-T329: the two DISPATCH-DEFERRING governors (cost ceiling, WIP/queue ceiling). Sibling
         slots on the SAME strip as "governor" (the headroom governor's own posture) above --
         extending the existing surface rather than a new panel, per this task's own design note:
         "that is the surface that already answers 'may the fleet work'". -->
    <span class="glance-item"><span class="glance-label">cost governor</span><span class="glance-value" id="au-cost-governor">…</span></span>
    <span class="glance-item"><span class="glance-label">queue governor</span><span class="glance-value" id="au-queue-governor">…</span></span>
    <!-- W1-T333: the EFFECTIVE daily cost ceiling with its provenance (never the bare number --
         design note i), and the newest console write's who/when/from/to audit trail (the
         operator's stated audit requirement). Sibling slots on the SAME strip, same reason
         cost/queue governor above are: "that is the surface that already answers 'may the fleet
         work'". -->
    <span class="glance-item"><span class="glance-label">cost ceiling</span><span class="glance-value" id="au-cost-ceiling">…</span></span>
    <span class="glance-item"><span class="glance-label">ceiling override</span><span class="glance-value" id="au-cost-ceiling-audit">…</span></span>
    <span class="glance-item"><span class="glance-label">usage as of</span><span class="glance-value" id="au-as-of">…</span></span>
    <span class="glance-item glance-scope"><span class="glance-label" id="au-measures"></span></span>
  </section>
  <!-- Provider routing is a projection of the daemon's last durable decision. The console reads
       no provider credentials and runs no capacity probes; unknown/not-probed/stale remain
       explicit instead of being rendered as healthy or zero usage. -->
  <section id="provider-routing" class="daemon-health" aria-label="Provider routing">
    <span class="glance-item"><span class="glance-label">routing</span><span class="glance-value" id="pr-state">…</span></span>
    <span class="glance-item"><span class="glance-label">reserve</span><span class="glance-value" id="pr-reserve">…</span></span>
    <span class="glance-item"><span class="glance-label">selected</span><span class="glance-value" id="pr-selected">…</span></span>
    <span class="glance-item"><span class="glance-label">providers</span><span class="glance-value" id="pr-providers">…</span></span>
    <span class="glance-item"><span class="glance-label">Codex model broker</span><span class="glance-value" id="pr-codex-models">…</span></span>
    <span class="glance-item"><span class="glance-label">policy</span><span class="glance-value" id="pr-policy">…</span></span>
    <span class="glance-item"><span class="glance-label">preference bypass</span><span class="glance-value" id="pr-bypass">…</span></span>
    <span class="glance-item"><span class="glance-label">override expires</span><span class="glance-value" id="pr-expires">…</span></span>
    <span class="glance-item"><span class="glance-label">routing as of</span><span class="glance-value" id="pr-as-of">…</span></span>
  </section>
  <!-- W1-T2660: the fleet's own measurement_cadence.ran rows (rule-efficacy, verdict-
       calibration, autonomy-rate, adoption, proof-debt, the verb census), one row per verb,
       read via GET /v1/self-measurement (measurement-cadence.ts's latestMeasurementRows off the
       ledger UNION, never the live file alone -- see that function's own doc for why). Starts
       empty until the first fetch lands; renderSelfMeasurement (below) fills it, a refusal
       renders as a refusal, a verb with no row at all renders "never measured", and an
       unreadable ledger union renders the whole list as unreadable -- never a silent zero and
       never a quietly-empty panel. -->
  <section id="self-measurement" class="daemon-health" aria-label="Self-measurement">
    <h2>Self-measurement <span id="self-measurement-summary" class="section-summary"></span></h2>
    <ol id="self-measurement-list" class="row-list"></ol>
  </section>
  <!-- Rendered SERVER-SIDE from the sha captured at start: a static span, deliberately NOT a
       client-script field, so this carries no risk to the template literal below. -->
  <section id="console-version" class="daemon-health" aria-label="Console build">
    <span class="glance-item"><span class="glance-label">console build</span><span class="glance-value" id="console-sha">${consoleSha.slice(0, 12)}</span></span>
    <span class="glance-item"><span class="glance-label">github credential</span><span class="glance-value" id="github-credential">${githubCredentialHtml}</span></span>
    <span class="glance-item"><span class="glance-label">loaded code</span><span class="glance-value" id="console-code">${consoleCodeHtml}</span></span>
  </section>
  <p id="top-status" role="status" aria-live="polite">loading…</p>
  <p id="summary" class="counts" aria-live="polite"></p>
  <div class="btn-row" id="trust-row">
    <span id="connection-indicator" class="conn-badge" data-state="connecting" role="status" aria-live="polite">
      <span class="dot" aria-hidden="true"></span> connecting…
    </span>
    <span id="freshness" class="counts" aria-live="off"></span>
  </div>
  <span id="stale-badge" hidden>STALE — showing last known data</span>
  <div id="gh-unreachable-banner" class="gh-banner" hidden role="status" aria-live="polite"></div>
  <div id="write-error-banner" class="gh-banner write-error" hidden role="alert" aria-live="assertive"></div>
  <!-- impl-EA: a SUCCESSFUL write's acknowledgement. PR #1003 made a FAILED write visible; a
       successful one still produced no change the operator could see, because refreshAll re-reads a
       15s-TTL gateway and the row re-renders identically. He clicked Mark handled three more times
       on an action that had already worked. role=status (polite), not alert: success must not
       interrupt, and it is a SEPARATE element from the error banner - a green box and a red box in
       one element would make "did it work" a question of which paint landed last. -->
  <div id="write-ack-banner" class="gh-banner write-ack" hidden role="status" aria-live="polite" data-ack-kind=""></div>
  <!-- W1-T156: a single dedicated aria-live region for status-change announcements -- screen
       reader users get "task flipped" news without a sighted user's visual flash/highlight. -->
  <div id="aria-announcer" class="sr-only" role="status" aria-live="polite"></div>
</header>

<!-- W1-T336: THE TABS ARE NOW AUTHORITATIVE -- third and last shard split out of W1-T314.
     W1-T334 built this bar as a scaffold that governed nothing but its own (still-empty) Plan
     panel; W1-T335 gave every serve suite a shared reachSection helper that tolerates either
     shape. This shard is what makes the bar real: every one of the ten sections below carries
     a \`data-owner-tab\` naming which tab governs it, and the script's own applyActiveTab hides
     every section whose owner isn't the active tab -- never a second copy, never rebuilt, never
     re-fetched. SECTION_TAB_OWNER (this shell's own script, near SECTION_IDS) is the single
     table this markup is a rendering of.
     DOCUMENT ORDER IS DELIBERATELY PRESERVED around the existing task sections (NOW, NEEDS ME,
     ACCEPTED, UP NEXT, RECENT, rest, controls, more -- test/serve.test.ts's own structural check
     polices this order); MAILBOX is now a sibling before NEEDS ME. Ownership is
     expressed by the attribute below, never by re-parenting a section into a per-tab container,
     which is also why NOW and UP NEXT can sit on the SAME tab while NEEDS ME (a DIFFERENT tab)
     still renders between them in the markup.
     THE GLANCE STRIP -- the whole pinned header block closed just above (glance/daemon-health/
     account-usage/console-version, plus the write-state/connection/staleness status line) --
     stays OUTSIDE and ABOVE this bar, never inside a tab: it is the cross-tab "is anything on
     fire" answer, unmoved by this shard (design note "what does not move").
     A SECTION'S OWN visibility logic is UNTOUCHED: \`recap\`'s own \`hidden\` (set once, for
     "nothing to recap") is a SEPARATE concern from tab ownership -- see applyRecapVisibility,
     below, which combines the two without either ever overwriting the other. Every section
     below is the EXACT node W1-T156 already patches in place -- nothing here moves it, splits
     it, or wraps it in new DOM. -->
<div id="console-tabs" class="console-tabs" role="tablist" aria-label="Console view">
  <button type="button" class="tab-btn" id="tab-decisions" role="tab" data-tab="decisions" aria-selected="true">Decisions<span id="mailbox-unread-count" class="mailbox-unread-count" aria-label="unread mailbox threads"></span></button>
  <button type="button" class="tab-btn" id="tab-queue" role="tab" data-tab="queue" aria-selected="false">Queue</button>
  <button type="button" class="tab-btn" id="tab-now" role="tab" data-tab="now" aria-selected="false">Now</button>
  <button type="button" class="tab-btn" id="tab-plan" role="tab" data-tab="plan" aria-selected="false" aria-controls="tab-plan-panel">Plan</button>
  <button type="button" class="tab-btn" id="tab-feed" role="tab" data-tab="feed" aria-selected="false">Feed</button>
</div>
<!-- W1-T315: progress (done/in-flight/queued, GitHub-derived, never plan/tasks.yaml's own
     decorative status field) + the frontier (the next candidates in the SAME order the
     dispatcher would take them, each carrying a machine-derived reason). One fetch,
     GET /v1/plan/view -- see renderPlanView's own doc below for the full contract. -->
<section id="tab-plan-panel" class="panel-section" aria-label="Plan" hidden>
  <h2><span>Plan</span></h2>
  <section id="plan-progress" class="daemon-health" aria-label="Progress">
    <span class="glance-item"><span class="glance-label">done</span><span class="glance-value" id="plan-progress-done">…</span></span>
    <span class="glance-item"><span class="glance-label">in-flight</span><span class="glance-value" id="plan-progress-inflight">…</span></span>
    <span class="glance-item"><span class="glance-label">queued</span><span class="glance-value" id="plan-progress-queued">…</span></span>
    <span class="glance-item"><span class="glance-label">as of</span><span class="glance-value" id="plan-progress-asof">…</span></span>
  </section>
  <div id="plan-progress-unknown" class="gh-banner" hidden role="status" aria-live="polite"></div>
  <!-- W1-T376: per-section filed/merged COUNTS, joined off the SAME plan_refs the route already
       resolved -- rendered as a filed-versus-merged PAIR, deliberately never a percentage (a
       1-task section reading 100% the moment it merges would rank above a 74-task section still
       building out; see panel-graph.ts's computePlanSectionCounts doc for the full rationale). -->
  <h3>Sections <span id="plan-sections-summary" class="section-summary"></span></h3>
  <ol id="plan-sections-list" class="row-list"></ol>
  <h3>Frontier <span id="plan-frontier-summary" class="section-summary"></span></h3>
  <ol id="plan-frontier-list" class="row-list"></ol>
</section>

<section id="recap" class="panel-section" aria-label="Since you last checked" data-owner-tab="feed" hidden>
  <h2><span>Since you last checked</span></h2>
  <ul id="recap-list" class="row-list"></ul>
</section>

<section id="now" class="panel-section" aria-label="Now" data-owner-tab="now">
  <h2><button type="button" class="section-header" id="now-toggle" aria-expanded="true" aria-controls="now-body">
    <span>Now</span><span class="section-summary" id="now-summary">…</span><span class="section-chevron" aria-hidden="true">›</span>
  </button></h2>
  <div id="now-body">
    <ul id="now-list" class="row-list">${skeletonRows(2)}</ul>
  </div>
</section>

<section id="mailbox-section" class="panel-section" aria-label="Mailbox" data-owner-tab="decisions">
  <h2><span>Mailbox</span></h2>
  <div id="mailbox" class="mailbox" aria-label="Mailbox"></div>
  <script>document.getElementById("mailbox")?.setAttribute("role", "list");</script>
</section>

<!-- DECISIONS: the needs-me set alone -- W1-T257's merged-proposal reconciler and the
     escalation-lifecycle reconciler already run ahead of this render (GET /v1/feedback,
     status.ts's deriveStatus), so an item they have already resolved never reaches
     renderNeedsMe's own needsHuman/grilling/proposed filter in the first place. This tab adds
     NO third staleness rule of its own -- it renders exactly the set those two verdicts leave
     pending, same as today, just gated to its own tab now instead of the flat stack. -->
<section id="needs-me" class="panel-section" aria-label="Needs me" data-owner-tab="decisions">
  <h2><button type="button" class="section-header" id="needs-me-toggle" aria-expanded="true" aria-controls="needs-me-body">
    <span>Needs me</span><span class="section-summary" id="needs-me-summary">…</span><span class="section-chevron" aria-hidden="true">›</span>
  </button></h2>
  <div id="needs-me-body">
    <ul id="needs-me-list" class="row-list">${skeletonRows(2)}</ul>
    <!-- W1-T3183: the verify:human backlog (W1-T507) is a SEPARATE population from the asks
         above -- its own list, its own heading, its own count, never blended into needs-me-list
         or needs-me-summary (see renderNeedsMe's own doc, below). W1-T507's purpose (the queue
         stays VISIBLE) survives exactly: this list is never collapsed, hidden or paginated. -->
    <h3>Awaiting verification <span id="needs-me-backlog-summary" class="section-summary">…</span></h3>
    <ul id="needs-me-backlog-list" class="row-list" aria-label="verify: human backlog, no action required"></ul>
  </div>
</section>

<section id="pr-queue" class="panel-section" aria-label="Pull request queue" data-owner-tab="queue" hidden>
  <h2><span>Pull request queue</span><span class="section-summary" id="pr-queue-summary">…</span></h2>
  <div id="pr-queue-unavailable" class="gh-banner" hidden role="status" aria-live="polite"></div>
  <div class="pr-queue-toolbar" role="group" aria-label="Pull request queue filters">
    <label for="pr-queue-actionability">Actionability
      <select id="pr-queue-actionability">
        <option value="all">All</option><option value="actionable">Actionable</option><option value="active">Active</option>
        <option value="ready-held">Ready or held</option><option value="waiting">Waiting</option><option value="unknown">Unknown</option>
      </select>
    </label>
    <label for="pr-queue-review">Review state
      <select id="pr-queue-review">
        <option value="all">All</option><option value="success">Passed</option><option value="failure">Failed</option>
        <option value="pending">Pending</option><option value="none">Not yet reviewed</option><option value="unreadable">Unreadable</option>
      </select>
    </label>
    <label for="pr-queue-task">Task
      <select id="pr-queue-task"><option value="all">All tasks</option><option value="unattributed">Unattributed</option></select>
    </label>
  </div>
  <ol id="pr-queue-list" class="row-list">${skeletonRows(3)}</ol>
</section>

<!-- W1-T285: "accepted" is a real feedback status (set by NEEDS ME's own Accept button AND by a
     proposal PR merging, panel-graph.ts's reconcileFeedbackEntries) but until this section existed
     it had NO consumer -- an accepted entry just stopped matching NEEDS ME's grilling/proposed
     filter and vanished with no downstream trace. This section is that consumer: it renders the
     SAME latestFeedbackEntries NEEDS ME already receives (never a second, parallel fetch), so an
     entry accepted by the button and one accepted by a merge are indistinguishable here -- both are
     just status === "accepted" rows off the one feed. Owned by FEED, not Decisions: a resolved
     decision is archaeology, and Decisions' own criterion is that a resolved item is FILTERED OUT,
     never merely sorted into a sibling section of the same tab. -->
<section id="accepted" class="panel-section" aria-label="Accepted" data-owner-tab="feed">
  <h2><button type="button" class="section-header" id="accepted-toggle" aria-expanded="true" aria-controls="accepted-body">
    <span>Accepted</span><span class="section-summary" id="accepted-summary">…</span><span class="section-chevron" aria-hidden="true">›</span>
  </button></h2>
  <div id="accepted-body">
    <ul id="accepted-list" class="row-list">${skeletonRows(1)}</ul>
  </div>
</section>

<section id="up-next" class="panel-section" aria-label="Up next" data-owner-tab="now">
  <h2><button type="button" class="section-header" id="up-next-toggle" aria-expanded="true" aria-controls="up-next-body">
    <span>Up next</span><span class="section-summary" id="up-next-summary">…</span><span class="section-chevron" aria-hidden="true">›</span>
  </button></h2>
  <div id="up-next-body">
    <!-- W1-T202: starts DISABLED (the safe default -- no write affordance renders armed until a
         client-held write token actually proves out; see probeWriteScope/applyControlStatus). -->
    <div class="up-next-actions"><button type="button" id="drain-now-btn" data-confirming="false" aria-pressed="false" disabled title="Read-only — enter a write token to enable this action">Gather now</button></div>
    <ul id="up-next-list" class="row-list">${skeletonRows(3)}</ul>
  </div>
</section>

<section id="recent" class="panel-section" aria-label="Recent" data-owner-tab="feed">
  <h2><button type="button" class="section-header" id="recent-toggle" aria-expanded="true" aria-controls="recent-body">
    <span>Recent</span><span class="section-summary" id="recent-summary">…</span><span class="section-chevron" aria-hidden="true">›</span>
  </button></h2>
  <div id="recent-body">
    <ul id="recent-list" class="row-list">${skeletonRows(3)}</ul>
  </div>
</section>

<section id="rest" class="panel-section" aria-label="Everything else" data-owner-tab="feed">
  <h2><button type="button" class="section-header" id="rest-toggle" aria-expanded="true" aria-controls="rest-detail">
    <span>Everything else</span><span class="section-summary" id="rest-summary">…</span><span class="section-chevron" aria-hidden="true">›</span>
  </button></h2>
  <!-- W1-T183: EXPANDED BY DEFAULT while non-empty (W1-T223 formalizes this per-section, below:
       every section defaults collapsed ONLY while genuinely empty). W1-T153's original v0 IA hid
       this whole corpus behind an "Expand" click, which is exactly what fails this task's own
       density/one-click bars against a realistic (mostly queued, low-activity) fleet: NOW/NEEDS
       ME/RECENT are near-empty and UP NEXT caps at 5, so under a couple hundred plain tasks a
       collapsed rest section left a first screen with a handful of rows, and any task living only
       in "everything else" needed an expand-THEN-click (two interactions) to reach its card.
       Rendering these as DENSE single-line rows (see .row-list .row CSS) removed the original
       space cost that motivated collapsing them, so a non-empty corpus still renders open --
       the header remains available for anyone who wants the compact grouped-count summary instead. -->
  <div id="rest-detail">
    <!-- W1-T157 FIND layer: instant client-side fuzzy search (id + title), faceted filters with
         LIVE counts, sortable columns, all persisted to the URL (shareable / survives reload). -->
    <label for="find-search" class="sr-only">Search id or title</label>
    <input id="find-search" type="text" role="searchbox" aria-controls="rest-list" placeholder="fuzzy — e.g. W1-T157 or words from the title" />
    <div id="find-facets" class="find-facets" role="group" aria-label="Filters (live counts)"></div>
    <div id="find-sort" class="find-sort" role="group" aria-label="Sort">
      <span class="counts">Sort:</span>
      <button type="button" class="sort-header" data-sort="id" aria-pressed="false">id</button>
      <button type="button" class="sort-header" data-sort="status" aria-pressed="false">status</button>
      <button type="button" class="sort-header" data-sort="recency" aria-pressed="false">recency</button>
      <button type="button" class="sort-header" data-sort="age" aria-pressed="false">age</button>
    </div>
    <p id="find-count" class="counts" aria-live="polite"></p>
    <ul id="rest-list" class="row-list">${skeletonRows(5)}</ul>
  </div>
</section>

<section id="controls" class="panel-section" aria-label="Fleet control" data-owner-tab="now">
  <h2>Fleet control</h2>
  <!-- W1-T202: the write token lives HERE, client-side only (sessionStorage), never in the URL --
       the bookmark's own \`?token=\` carries only the read token (see this shell's bootstrap,
       below). Every write affordance on this page starts DISABLED with a stated reason (standing
       rule 22) and is re-enabled by probeWriteScope only once a client-held write token actually
       proves out against GET /v1/auth/scope -- never merely because one was typed.
       W1-T2409: the "Get one by running: rmd console-url --write" instruction used to be the ONLY
       way to obtain a write token -- an already-authenticated operator had to leave this page for
       a shell. #write-token-request-btn calls the new GET /v1/console/write-grant "ask" (see that
       route's own doc, serve.ts) with the read token this tab already carries, and stores what it
       returns exactly where a pasted token already lives -- never the URL, never a new disk path,
       never a log line. The paste form stays as a fallback (a token minted on another host, or a
       tab whose read token this route itself would reject). -->
  <div id="write-token-panel" class="write-token-panel">
    <p id="write-token-status" role="status" aria-live="polite" class="counts">Read-only — write actions are unavailable. Request a write token for this tab, or paste one. Get one by running: rmd console-url --write</p>
    <div class="btn-row">
      <button id="write-token-request-btn" type="button">Request write access</button>
    </div>
    <form id="write-token-form" class="inline-action">
      <label for="write-token-input">Write token</label>
      <input id="write-token-input" type="password" autocomplete="off" placeholder="paste write token" />
      <button type="submit">Enable write access</button>
    </form>
    <button id="write-token-clear-btn" type="button" hidden>Clear write token</button>
  </div>
  <label for="reason">Reason (optional, for Pause/STOP)</label>
  <input id="reason" type="text" />
  <div class="btn-row">
    <button id="pause-btn" type="button" aria-pressed="false" disabled title="Read-only — enter a write token to enable this action">Pause</button>
    <button id="resume-btn" type="button" aria-pressed="false" disabled title="Read-only — enter a write token to enable this action">Resume</button>
    <button id="stop-btn" type="button" class="danger" aria-pressed="false" disabled title="Read-only — enter a write token to enable this action">STOP</button>
    <label style="display:flex; align-items:center; gap:0.35rem; margin:0;">
      <input id="quiet-hours" type="checkbox" disabled title="Read-only — enter a write token to enable this action" /> Quiet hours
    </label>
  </div>
  <p id="controls-status" role="status" aria-live="polite" class="counts"></p>
  <!-- W1-T364: the operator's own write control over the daily cost ceiling override (W1-T332's
       state/DAILY_COST_CEILING_OVERRIDE store), gated on W1-T363 (shipped, #1410) so a write here
       is actually enforced by the daemon's very next tick, never a display-only value. Arm-then-
       confirm like STOP/Drain now above -- never a bare Confirm (design note ii) -- and the
       read-back in the armed label states the restart truth verified from source: the daemon's
       reloader re-resolves the ceiling fresh every tick, so no restart is needed. The current
       effective value renders beside the control from GET /v1/account-usage's own
       resolveDailyCostCeiling-derived payload (renderCostCeilingControl, below) -- never a second
       derivation (design note iii); the ACCOUNT strip above shows the SAME fields. -->
  <label for="cost-ceiling-input">Daily cost ceiling ($)</label>
  <div class="btn-row" id="cost-ceiling-row">
    <input id="cost-ceiling-input" type="number" step="0.01" min="0" disabled title="Read-only — enter a write token to enable this action" />
    <button id="cost-ceiling-set-btn" type="button" data-confirming="false" aria-pressed="false" disabled title="Read-only — enter a write token to enable this action">Set ceiling</button>
    <button id="cost-ceiling-clear-btn" type="button" data-confirming="false" aria-pressed="false" disabled title="Read-only — enter a write token to enable this action">Clear override</button>
  </div>
  <p id="cost-ceiling-status" role="status" aria-live="polite" class="counts"></p>
  <fieldset id="provider-policy-controls">
    <legend>Provider routing policy</legend>
    <p id="provider-policy-status" role="status" aria-live="polite" class="counts">Waiting for the daemon policy projection…</p>
    <div class="btn-row">
      <label><input id="provider-policy-enabled-claude" type="checkbox" disabled /> Claude enabled</label>
      <label><input id="provider-policy-enabled-codex" type="checkbox" disabled /> Codex enabled</label>
      <label for="provider-policy-preference">Preference</label>
      <select id="provider-policy-preference" disabled>
        <option value="automatic">Automatic</option>
        <option value="claude">Prefer Claude</option>
        <option value="codex">Prefer Codex</option>
      </select>
      <label for="provider-policy-reserve">Reserve (%)</label>
      <input id="provider-policy-reserve" type="number" min="0" max="50" step="1" disabled />
      <label for="provider-policy-codex-model">Codex model</label>
      <select id="provider-policy-codex-model" disabled><option value="">Automatic mapped choice</option></select>
    </div>
    <div class="btn-row">
      <label for="provider-policy-park-claude">Park Claude</label>
      <select id="provider-policy-park-claude" disabled>
        <option value="0">Not parked</option><option value="15">15 minutes</option><option value="60">1 hour</option><option value="240">4 hours</option>
      </select>
      <label for="provider-policy-park-codex">Park Codex</label>
      <select id="provider-policy-park-codex" disabled>
        <option value="0">Not parked</option><option value="15">15 minutes</option><option value="60">1 hour</option><option value="240">4 hours</option>
      </select>
      <label for="provider-policy-expiry">Override duration</label>
      <select id="provider-policy-expiry" disabled>
        <option value="60">1 hour</option><option value="240">4 hours</option><option value="1440">24 hours</option>
      </select>
      <button id="provider-policy-apply-btn" type="button" data-confirming="false" aria-pressed="false" disabled>Apply policy</button>
      <button id="provider-policy-clear-btn" type="button" data-confirming="false" aria-pressed="false" disabled>Clear provider override</button>
    </div>
    <p class="counts">A valid change is effective on the next dispatch. It does not start, stop, restart, recycle or deploy either container, and it cannot bypass provider readability or reserve. Account-visible unmapped Codex models remain read-only proposal seeds until a git-reviewed <code>.remudero/mounts.yaml</code> PR assigns their capability.</p>
  </fieldset>
  <fieldset id="merge-hold-fleet">
    <legend>Automatic merge hold</legend>
    <p id="merge-hold-fleet-status" role="status" aria-live="polite" class="counts">Waiting for the atomic hold projection…</p>
    <form class="merge-hold-action" data-scope="the whole fleet">
      <label for="merge-hold-fleet-reason">Reason</label>
      <input id="merge-hold-fleet-reason" type="text" required placeholder="why automatic merges should be held or released" disabled title="Read-only — enter a write token to enable this action" />
      <button id="merge-hold-fleet-btn" class="danger" type="submit" data-action="engage" data-confirming="false" aria-pressed="false" disabled title="Read-only — enter a write token to enable this action">Engage fleet hold</button>
    </form>
    <ul id="merge-hold-current" class="row-list merge-hold-current"></ul>
    <p class="counts">This only engages or releases the daemon's existing automatic-merge refusal. Release returns the PR to the ordinary sweep; it does not merge, select a merge method, bypass protection, or start, stop, restart, recycle, or deploy anything.</p>
  </fieldset>
</section>

<section id="more" class="panel-section" aria-label="More tools" data-owner-tab="feed">
  <h2>More tools</h2>
  <div class="btn-row">
    <!-- IN-SHELL PANELS, not page hops: a browser NAVIGATION to a header-only /v1 route cannot
         send the Authorization header, so a bare anchor click 401s (the #339 bootstrap-paradox
         at the LINK layer). These fetch WITH the header the page already carries. -->
    <button id="feedback-btn" type="button">Feedback inbox</button>
  </div>
  <section id="panel" aria-label="Tool panel" hidden>
    <h2 id="panel-title"></h2>
    <div id="panel-controls"></div>
    <pre id="panel-body" class="mono"></pre>
  </section>
</section>

<!-- W1-T222: the DETAIL layer is now INLINE, not a bottom panel. This RETIRES W1-T158's
     #task-detail/#journey-view panel-section pair (standing rule 21 successor, not an amendment
     -- see this task's own plan note) -- reaching a task's detail must not mean leaving its row.
     EVERY task row (NOW/NEEDS ME/UP NEXT/RECENT/rest) is itself the expand trigger (a right-edge
     chevron is the visible affordance; the whole row is the hit target); its own card is inserted
     as a sibling <li class="row-detail"> DIRECTLY BENEATH that row by reconcileRows/expandRow
     below, never a scroll-away section. The full journey (rmd trace, the SAME GET /v1/trace route
     W1-T158 used) lazy-loads INSIDE that card on demand (.card-journey-toggle), never eagerly. -->
</main>

<!-- W1-T157 cmd+K command palette: a global, additive modal (NOT a sixth section — the five-section
     order invariant stays intact). Opened by Cmd/Ctrl+K from ANY view via one document-level keydown
     listener; jumps to a task/PR or fires a fleet/panel action through the EXACT existing button. -->
<div id="cmdk-overlay" class="cmdk-overlay" hidden>
  <div id="cmdk-dialog" role="dialog" aria-modal="true" aria-label="Command palette">
    <input id="cmdk-input" type="text" autocomplete="off" aria-controls="cmdk-results" aria-label="Command palette search" placeholder="Jump to a task or PR, or run an action… (Esc to close)" />
    <ul id="cmdk-results" class="cmdk-results" role="listbox" aria-label="Command palette results"></ul>
  </div>
</div>

<script type="module">
  // W1-T2731: the shell's PURE client helpers, emitted from the REAL, unit-tested function objects
  // in lib/console-shell-script.ts via \`Function.prototype.toString()\` — the same technique
  // W1-T281 already uses for \`resolveFreshness\` (now embedded by consoleShellClientSource,
  // below, rather than here), and for the same reason: ONE definition, so this shell can never
  // drift from the code the tests exercise. They were 56 declarations inline here, and every
  // line of them was credited as covered the instant renderShellHtml was called; as a real
  // module lcov scores them line by line.
${renderConsoleShellScript()}

  // W1-T2902: EVERYTHING ELSE this shell's script tag used to carry as a raw, unparsed string
  // (event wiring, fetch("/v1/…") calls, DOM rendering — ~3,755 lines) now lives as a real,
  // typed, unit-tested function -- lib/console-shell-client.ts's \`bootConsoleShellClient\`,
  // spliced in here via its own named seam, \`consoleShellClientSource\`, exactly as
  // \`renderConsoleShellScript\` is for the pure helpers just above. See that module's header for
  // why this changes nothing about how the code runs.
${consoleShellClientSource(phaseElapsedThresholdsMs)}
</script>
</body>
</html>
`;
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
    const moduleDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    const sha = exec(moduleDir).trim();
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
 * W1-T2562 — THE STALE-CODE BANNER, disposition (ii). `rmd serve` runs BOOT-TIME code while the
 * checkout advances under it, and the two containers share ONE bind mount, so every file-level
 * diagnostic reports CURRENT code — the files genuinely are current; only the loaded modules are
 * not. `stat -c %d:%i` on package.json returns the identical device:inode from both containers. A
 * reader checking "is serve up to date" by reading its tree gets a confident, wrong yes.
 *
 * WHY A BANNER RATHER THAN A RESTART, AND WHY THE EXISTING EXIT IS NOT ENOUGH. W1-T2229 already
 * ships {@link gateStaleCodeExit}, which exits when the code is stale AND no client is connected
 * AND no write is in flight. That gate is live and correct — and it starves exactly when the
 * console is being used: MEASURED 2026-09-01, a week after it shipped, `remudero-serve` was up 20
 * hours with ONE boot line, ZERO restarts, and 60 commits behind its own checkout. A watched
 * console never reaches `clients === 0`. The alternative disposition — exiting stale like the
 * daemon does — restarts on EVERY merge, a measured median of 63/day, roughly every 23 minutes,
 * each one dropping the live SSE connections the console holds open. That trades a stale console
 * for a flapping one, which is worse for the same operator. So the staleness is REPORTED and the
 * human restarts deliberately.
 *
 * NOT ON `GET /v1/version`, DELIBERATELY: that payload's keys are pinned by a standing security
 * invariant (test/serve.test.ts, "the served payload carries the sha and NO credential-shaped
 * key"), and the same reasoning W1-T2269 recorded for the credential state applies — the console
 * is the surface an operator watches, so the SHELL is where a state he must act on belongs.
 *
 * SERVER-SIDE AND STATIC, like the "console build" and "github credential" chips beside it: no
 * client-script field, so this carries no risk to the template literal that has broken the last
 * five PRs that edited it. Escaped through {@link escapeHtml} for the same reason those are.
 */
export function renderConsoleCodeStalenessHtml(input: { bootSha: string; currentSha: string }): string {
  if (input.bootSha === CONSOLE_SHA_UNKNOWN || input.currentSha === CONSOLE_SHA_UNKNOWN) {
    // ABSENT IS NOT FRESH. An unresolved sha on either side cannot decide the question, and
    // saying so is the same discipline `isConsoleCodeStale` follows by never calling it stale.
    return `<span class="console-code-unknown">unknown — the checkout sha could not be read, so staleness is undecided</span>`;
  }
  if (!isConsoleCodeStale(input.bootSha, input.currentSha)) return `<span class="console-code-current">current</span>`;
  // `resolveConsoleSha` yields hex or CONSOLE_SHA_UNKNOWN, so neither side can carry markup today.
  // Escaped anyway, for the reason `renderGithubCredentialHtml` beside it states: the render site
  // should never depend on the producer's string set staying free of `<`/`&` forever.
  const esc = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return (
    `<span class="console-code-stale">STALE — serving ${esc(input.bootSha.slice(0, 12))} while the checkout reads ` +
    `${esc(input.currentSha.slice(0, 12))}. Restart remudero-serve to pick it up.</span>`
  );
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
  /** One ledger line naming the decision, mirroring {@link ServiceOptions.log}. */
  log?: (step: string, extra?: Record<string, unknown>) => void;
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
export function gateStaleCodeExit(deps: StaleCodeExitDeps): StaleCodeExitGate {
  const resolveCurrentSha = deps.resolveCurrentSha ?? resolveConsoleSha;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? (() => {});
  let clients = 0;
  let inFlightWrites = 0;
  const maybeExit = (): void => {
    if (clients !== 0 || inFlightWrites !== 0) return;
    const currentSha = resolveCurrentSha();
    if (!isConsoleCodeStale(deps.bootSha, currentSha)) return;
    log("serve.stale_code_exit", { bootSha: deps.bootSha, currentSha, clients, inFlightWrites });
    exit(0);
  };
  return {
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
/**
 * The "github credential" glance chip's inner text — rendered SERVER-SIDE, the same
 * "no client-script risk" discipline the sibling "console build" chip already follows (see that
 * section's own comment). Three states, all named rather than inferred from a blank value
 * (standing rule: "absent is not zero" — idle-reasons-panel.ts's header):
 *   - not armed: the console holds whatever `GH_TOKEN` it was started with for its whole life —
 *     this is claim 2's "a credential that cannot be replaced", surfaced rather than left to
 *     look like a normal, healthy board.
 *   - armed, no failure recorded: the in-process refresh loop is live.
 *   - armed, most recent attempt failed: named with github-app.ts's own reason string, never a
 *     bare "failed" that would send the operator back to the ledger to find out why.
 */
function renderGithubCredentialHtml(state: GithubCredentialState): string {
  if (!state.armed) {
    return `<span class="gh-credential-static">static (no renewal configured)</span>`;
  }
  if (state.lastFailureReason) {
    // `lastFailureReason` is one of github-app.ts's own fixed reason strings (never user input,
    // never a secret — see that module's file header) but escaped anyway: the render site should
    // never depend on the producer's string set staying free of `<`/`&` forever.
    const escaped = state.lastFailureReason.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<span class="gh-credential-failed">refresh failed: ${escaped}</span>`;
  }
  return `<span class="gh-credential-ok">refreshing (App)</span>`;
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

export function buildShellRoute(
  phaseElapsedThresholdsMs: Record<string, number>,
  consoleSha: string,
  // W1-…/impl-FC: the WHY-IDLE panel's inputs. Appended LAST and defaulted so no positional caller
  // shifts. `readLedger` is the same `readLedgerLines` the board's routes already use — one ledger
  // read path, never a second.
  idle: { ledgerPath?: string; readLedger?: (p: string) => ReadonlyArray<Record<string, unknown>>; now?: () => Date } = {},
  // W1-T2269: the LIVE credential-renewability object {@link buildServeRoutes} arms — read fresh
  // on every request, same as `idle` above, so a refresh failure that lands after boot shows up
  // on the very next page load without a server restart. Defaulted so no existing caller shifts.
  credential: GithubCredentialState = { armed: false },
  // W1-T2562: re-resolve the CURRENT on-disk sha, fresh, per request — the same primitive
  // `gateStaleCodeExit` compares against, called again. Injectable so a test never shells to git.
  // Appended last and defaulted so no positional caller shifts.
  resolveCurrentSha: () => string = resolveConsoleSha,
): Route {
  return {
    method: "GET",
    path: "/",
    scope: "read",
    allowQueryToken: true,
    handler: (_req, res) => {
      let panel: string;
      if (idle.readLedger && idle.ledgerPath) {
        try {
          // Tests and production use the same ledger reader for this server-rendered fragment; an
          // unreadable ledger must render UNKNOWN with the read failure's own reason.
          const lines = idle.readLedger(idle.ledgerPath);
          panel = renderIdleReasonsHtml(readIdleReasons(lines, idle.now?.() ?? new Date()));
        } catch (e) {
          panel = renderIdleReasonsHtml({ kind: "unknown", why: `ledger unreadable: ${String((e as Error)?.message ?? e)}` });
        }
      } else {
        panel = renderIdleReasonsHtml({ kind: "unknown", why: "idle reasons refresh off the bounded console data routes" });
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      let consoleCodeHtml: string;
      if (resolveCurrentSha !== resolveConsoleSha) {
        try {
          consoleCodeHtml = renderConsoleCodeStalenessHtml({ bootSha: consoleSha, currentSha: resolveCurrentSha() });
        } catch {
          // A failing injected resolver cannot decide freshness, so render the existing unknown state.
          consoleCodeHtml = renderConsoleCodeStalenessHtml({ bootSha: CONSOLE_SHA_UNKNOWN, currentSha: CONSOLE_SHA_UNKNOWN });
        }
      } else {
        consoleCodeHtml = renderConsoleCodeStalenessHtml({ bootSha: consoleSha, currentSha: consoleSha });
      }
      res.end(renderShellHtml(phaseElapsedThresholdsMs, consoleSha, panel, renderGithubCredentialHtml(credential), consoleCodeHtml));
    },
  };
}
/**
 * `GET /v1/auth/scope` — W1-T222's write-scope PROBE, nothing else. A plain, side-effect-free
 * GET gated `scope: "write"`: it 200s for a write-token caller and 403s (service.ts's own
 * unwritten-through mechanism) for a read-only one — the shell's inline detail card uses that
 * boolean, resolved once at boot, to decide whether it renders ANY write affordance at all
 * (cardActionsHtml's own doc: standing rule 22, "an action the viewer cannot take must not be
 * rendered as available"). Deliberately the smallest thing that answers "which scope am I" —
 * W1-T202 (not yet built) is where the shell's write-CREDENTIAL channel itself gets redesigned;
 * this route only ever tells a caller what it already proved by the token it sent.
 */
function buildAuthScopeRoute(): Route {
  return {
    method: "GET",
    path: "/v1/auth/scope",
    scope: "write",
    // W1-T404: LOW — a side-effect-free probe of "do I have write scope at all", the least
    // consequential thing a write token can do (rationale note: worth settling whether this
    // needs write scope at all; unchanged by this task either way).
    tier: "low",
    handler: (_req, res) => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ scope: "write" }));
    },
  };
}
/**
 * `GET /v1/console/write-grant` — W1-T2409's in-console "ask", replacing "leave the page and run
 * `rmd console-url --write` in a shell" with one in-page round trip. The write-token panel's own
 * text used to say exactly that; this route is what a click on its new button now calls instead.
 *
 * `scope: "read"` DELIBERATELY. Before this call, the only credential an operator's tab holds is
 * the read bearer the shell booted with (Q1 of this task's rationale: the bearer token is the
 * only in-process gate `serve.ts` has — the tailnet/Cloudflare login in front of it is invisible
 * to this code). Requiring `write` scope here would be asking for the very thing this route
 * exists to hand out, so it cannot be write-scoped and does not need a {@link WriteTier}.
 *
 * THIS DOES NOT COLLAPSE READ INTO WRITE (Q2). Every write-scoped route's own scope check is
 * completely unchanged — a caller presenting only the read token still 403s on
 * `POST /v1/control/pause` and every other write route, exactly as before (see
 * test/console-write-entry.test.ts). What this route adds is a way to LEARN the separate write
 * bearer's value, over the same in-memory {@link ServiceTokens} this process already holds for
 * every request's own auth check — never a new disk read (this handler never touches the
 * filesystem), so the write token is written to no path it was not already written to, and it
 * never rides the URL: no `allowQueryToken`, a GET with the value in the JSON response body only,
 * never a redirect `Location` header or a query string. The client stores the returned value in
 * sessionStorage exactly where a pasted token already lives (W1-T202's own `WRITE_TOKEN_STORAGE_KEY`)
 * — never a second disk location, never a log line (service.ts's own request logging never
 * includes a response body).
 *
 * No pacing, no throttle, no delay: side-effect-free and synchronous, the same shape
 * `buildAuthScopeRoute` above already uses for the read half of this same probe/reveal pair.
 */
function buildConsoleWriteGrantRoute(tokens: ServiceTokens): Route {
  return {
    method: "GET",
    path: "/v1/console/write-grant",
    scope: "read",
    handler: (_req, res) => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ token: tokens.write }));
    },
  };
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
 * The panel body, as a server-rendered HTML fragment — SERVER-SIDE ON PURPOSE, the same reason
 * {@link renderIdleReasonsHtml} is: this touches no part of the client script that lives inside
 * this file's own template literal (`buildShellRoute`'s own note: that script "has broken the
 * last five PRs that edited it").
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
function assembleServeRoutes(deps: ServeDeps): ServeRoutesAssembly {
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
  const fleetControlDeps: PanelActionDeps = { root: deps.fleetControlRoot, ledgerPath: deps.ledgerPath, issues: deps.issues };
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
  const rawRoutes = [
    buildStatusRoute(deps.board, lastSeen),
    buildRecentRoute(deps.board),
    buildInboxDigestsRoute({ root: deps.fleetControlRoot }),
    buildDaemonHealthRoute(daemonHealthDeps),
    buildAccountUsageRoute(accountUsageDeps),
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
    // note below). `fleetControlDeps` carries no `threadStorePath` (production wiring of the real
    // thread-store path is a separate concern, mirroring escalate.ts's own OPTIONAL field, W1-T2494)
    // — so this route currently refuses every real call with "no thread store configured", the SAME
    // safe refusal it gives any thread it cannot confirm, never a silent unattached filing.
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
    ...buildPanelGraphRoutes(panelGraphDeps),
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
    // W1-T477: the operator's four analytics questions, aggregated over the rotation union — see
    // analytics-route.ts's module header for the reader discipline and scope.
    buildAnalyticsRoute({ ...deps.analytics, ledgerPath: deps.ledgerPath }),
    buildAuthScopeRoute(),
    // W1-T2409: the in-console write-grant "ask" — see buildConsoleWriteGrantRoute's own doc.
    buildConsoleWriteGrantRoute(deps.tokens),
    buildShellRoute(
      deps.phaseElapsedThresholdsMs ?? DEFAULT_PHASE_ELAPSED_THRESHOLDS_MS,
      consoleSha,
      { ledgerPath: deps.ledgerPath, readLedger: readLedgerLines },
      githubCredential.state,
      // W1-T2562: threaded from ServeDeps so a test observes the staleness chip without shelling
      // to git, exactly as `gateStaleCodeExit`'s own `resolveCurrentSha` seam already allows.
      deps.resolveCurrentSha ?? resolveConsoleSha,
    ),
    buildVersionRoute(consoleSha),
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
      log: deps.log,
    }),
  ];
  const routes = boundConsoleReadRoutes(rawRoutes, deps);
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
  // W1-T2229: resolved ONCE, here, and threaded through to `buildServeRoutes` below (explicitly,
  // via the spread) so `GET /v1/version` and the shell's "console build" chip report the EXACT
  // sha {@link gateStaleCodeExit} is comparing against — never a second independent resolution
  // that could drift from the one the exit decision uses.
  const consoleSha = deps.consoleSha ?? resolveConsoleSha();
  const staleExit = gateStaleCodeExit({ bootSha: consoleSha, log: deps.log });
  const routeAssembly = assembleServeRoutes({ ...deps, consoleSha, confirmNonces });
  const routes = routeAssembly.routes.map((route) =>
    // rationale (7): HIGH-tier IS the write-consequence set this task must respect — the same
    // five paths (`/v1/manual/approve`, `/v1/drain/kick`, `/v1/drain/run`, `/v1/inbox/approve`,
    // `/v1/skills/run`) `HIGH_TIER_WRITE_PATHS` names client-side, read here off the route table's
    // own declared `tier` (already asserted complete, above in `buildServeRoutes`) rather than a
    // second hard-coded path list that could drift from it.
    route.tier === "high" ? staleExit.wrapWrite(route) : route,
  );
  // W1-T3176 — VERIFY BEFORE MOUNTING. Installed ONLY when the entry document is really there, so
  // an absent build cannot half-render: `/console/*` 404s, `/` and every `/v1` route are untouched.
  // The daemon degrades on one surface, never on both.
  const consoleBuild = consoleBuildStatus(deps.consoleBuildRoot, deps.consoleBuildIo ?? { realpath: consoleBuildRealpath });
  if (consoleBuild && consoleBuild.kind !== "present") {
    // REPORTED, NOT DISCOVERED. The motivating failure is an operator staring at a blank tab with
    // no idea which directory was searched, so the path is in the line.
    deps.log?.("serve.console_build_missing", { kind: consoleBuild.kind, root: consoleBuild.root, reason: consoleBuild.reason });
  }
  const server = createService({
    tokens: deps.tokens,
    identity: deps.identity,
    // W1-T996: APPENDED through the seam, never by reordering `createService`'s built-in array —
    // the token-first order is the pre-seam W1-T371 contract, and preserving it is what keeps
    // every CLI caller unaffected. Empty unless BOTH Access config values are present.
    providers: accessIdentityProviders({
      teamDomain: deps.accessTeamDomain ?? accessConfig().accessTeamDomain,
      audience: deps.accessAudience ?? accessConfig().accessAudience,
      log: deps.log,
    }),
    routes,
    // Absent build -> no mount -> `/console/*` is a plain 404 rather than a shell with no assets.
    staticMount:
      consoleBuild?.kind === "present"
        ? {
            prefix: "/console/",
            root: consoleBuild.root,
            scope: "read",
            clientRoutes: ["/console/", "/console/index.html"],
            io: { realpath: consoleBuildRealpath, readFile: (p) => readFileSync(p) },
          }
        : undefined,
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
    enforceWriteTiers: true,
  });
  server.on("close", prewarm.stop);
  return { server, githubAppReady: routeAssembly.githubAppReady };
}

/**
 * W1-T3176 — IS THERE A CONSOLE BUILD, AND WAS IT LOOKED FOR?
 *
 * THE FAILURE MODE DOES NOT EXIST YET, WHICH IS WHY IT IS WORTH BUILDING NOW. Production runs
 * TypeScript directly and nothing is precompiled, so today the console is a string inside the
 * source that runs and CANNOT be older than the code around it. As a build output that stops
 * being true, and a checkout that updates without rebuilding serves a stale or absent console.
 *
 * REFUSE, DO NOT DEGRADE: a shell without its assets is a blank page indistinguishable from a hung
 * daemon. `/v1` keeps serving either way — `rmd status` with a dead console beats neither — but the
 * console surface must fail legibly. ABSENCE ONLY: staleness needs a provenance stamp, and folding
 * it in would put two mechanisms behind one falsifier.
 */
/** A realpath that tells ABSENCE from FAILURE — the reason {@link ConsoleBuildStatus} has three
 *  states. ⚠ The first version swallowed EVERY error and returned null, so a real EACCES reported
 *  as `absent` and the `unreadable` arm was UNREACHABLE in production; every test injected a
 *  throwing fake, so none could see it. ENOENT alone means "not there". */
export function consoleBuildRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

export type ConsoleBuildStatus =
  | { kind: "present"; root: string }
  | { kind: "absent"; root: string; reason: string }
  | { kind: "unreadable"; root: string; reason: string };

export interface ConsoleBuildIo {
  /** The entry document's real path, or `null` when it is not there. */
  realpath: (p: string) => string | null;
}

/** THE ENTRY DOCUMENT IS THE TEST, not the directory. An empty `dist/` is what a failed build
 *  leaves behind, and a directory check would call that present and serve nothing. */
export function consoleBuildStatus(root: string | undefined, io: ConsoleBuildIo): ConsoleBuildStatus | null {
  if (!root) return null; // no console build configured — this daemon serves the string shell only
  const entry = join(root, "index.html");
  try {
    return io.realpath(entry) === null
      ? { kind: "absent", root, reason: `no index.html under ${root}` }
      : { kind: "present", root };
  } catch (err) {
    // UNREADABLE IS NOT ABSENT. A permission error or a broken mount must not read as "no build",
    // because the remedies differ and one of them is not "rebuild".
    return { kind: "unreadable", root, reason: String((err as Error)?.message ?? err) };
  }
}

/** The one line an operator reads at boot. It NAMES THE PATH SEARCHED, because "console build
 *  missing" with no path sends them looking in the wrong tree. */
export function consoleBuildBannerLine(status: ConsoleBuildStatus | null): string | null {
  if (status === null) return null;
  if (status.kind === "present") return `    console build: ${status.root}`;
  return `    console build: ${status.kind.toUpperCase()} — ${status.reason} (the /v1 API is unaffected)`;
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
