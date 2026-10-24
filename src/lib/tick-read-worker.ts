import { hydrateDependencyMainIdentitiesSteps } from "./dependency-main-identity.js";
/**
 * lib/tick-read-worker.ts — W1-T9722: the daemon's read-plane worker starts here, not from src/run-task.ts.
 *
 * W1-T4075 moved the daemon's tick reads onto a worker thread, but handed startReadPlane run-task.ts's own URL,
 * so the worker isolate loaded the whole CLI (758 modules, 97.9 MiB heapUsed under tsx, offline) to run one
 * producer. createTickReadProducer and the declarations only it uses MOVED here byte-for-byte; run-task.ts
 * imports back what it still calls and re-exports the rest, so every import path keeps working.
 *
 * This module is the worker's entry: its top level installs the producer in a read-plane worker and does
 * nothing anywhere else. It must never import src/run-task.ts, directly or through another module
 * (test/the-read-plane-worker-starts-from-a-narrow-entry.test.ts walks its static import graph).
 * scripts/build-child-entries.mjs lists it in WORKER_ENTRIES, so startTickReadWorker starts a current
 * bundle under plain node (startWorker, W1-T8777/W1-T9370) and the .ts source under tsx on every doubt.
 * The worker's first row, `read_plane.worker_started`, says which it ran and what its isolate holds.
 */
import { relative } from "node:path";
import { boundChildByLoopTime } from "./loop-bounded-child.js";
import { GIT_FETCH_KILL_GRACE_MS } from "./git-fetch-retry.js";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { fileURLToPath } from "node:url";
import { SHARE_ENV, Worker, workerData as threadData, type WorkerOptions } from "node:worker_threads";
import { READ_PLANE_KIND, freezeReadGeneration, revisionedProducer, type RevisionedRequest } from "./read-plane.js";
import { readPlaneWorkerInput, readPlaneWorkerLog, runReadPlaneWorker } from "./read-plane.worker.js";
import { runsBundled, startWorker } from "./child-entry-argv.js";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { ghExec, ghJsonAsync, ghLinesAsync, ghTextAsync } from "./github-transport.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig, type Config } from "./config.js";
import { ledgerPathFor } from "./ledger-path.js";
import { createBoardSnapshotCache } from "./board-snapshot-cache.js";
import { createChangedFilesCache } from "./changed-files-cache.js";
import { readFileIfExists } from "./fs-race-safe.js";
import { ghIssueGateway, type IssueGateway, type OpenIssue, prReferentFromIssueText } from "./escalate.js";
import { checkRunsRestArgs, createGhCallPacer, fetchOpenPrsRest, fetchOpenPrsRestSteps, type OpenPrRest, hydrateMergeConflictEvidenceSteps, hydratePlanFilingFilesSteps, hydrateSupersessionVerdictsSteps, hydrateWorkflowRunsSteps, hydrateMergeStateObservationsSteps, hydrateScannerBlockerObservationsSteps, hydrateCodeqlHeadAlertsSteps, codeqlCheckFailed, isScannerBlockerCandidate, paceGhEntryAsync, hydrateReviewReuseFactsSteps, type GhApiFetcher, type GhCallPacer, createPlanFilingFileCache, type PlanFilingFileCache, type PlanFilingFileObservation } from "./open-prs-rest.js";
import { codeqlAlertsReadDue } from "./pr-blocker.js";
import { planFilesIdentity } from "./thread-plan.js";
import { isInPlanScope } from "./plan-architect.js";
import { appendLedger } from "./ledger.js";
import { systemClock } from "./clock.js";
import { createSizedMemo } from "./ledger-union.js";
import { type BoardItem } from "./board-review.js";
import { loadPlan, DEFAULT_RISK, PlanBlobCache, mergePlanBlobsQuarantiningDuplicates, readBlobsAtRef, type QuarantinedTask, type MergedResolver, type Plan, type Task } from "./plan.js";
import { cappedOverrideFromLedger, postedArmFactsFromLedger, lastPendingReviewStatusFromLedger, assessPendingReviewOwner, priorReviewVerdictFromLedger, reviewLedgerKeyFor, reviewRowNamesPr, UNFILED_RUN_SENTINEL, enforcementDataInDiff, bodyReviewContractDigest, reviewContractDigest, reviewTaskNarrative, reviewInputDigest, isCriterionRefusal, type PendingReviewOwnerAssessment, type PendingReviewStatusRecord, type CriterionVerdict, type CriterionRefusal } from "./review.js";
import { buildBatchedGithub, defaultCreditStorePath, loadCreditStore, buildCommitTrailerIndex, deriveStatus, isGhRateLimitError, projectPlan, readLedgerLines, type DeriveDeps, type GitHub, isBookkeepingOnlyChangeset, type PrRef, type StatusProjection, taskIdFromRunBranch, creditsByAnchoredTrailer, readMergeCreditedTaskIds, readRequiredStatusCheckContextsAsync, isPlanTextDeliverable, type RequiredContextsRead } from "./status.js";
import { DEFAULT_SWEEP_POLICY, RUNNER_TIMEOUT_LINE, actionableGateFailuresFromReasons, cancelledRequiredCheckNames, withoutDownstreamGateFailure, earlyRedEvidenceRollup, checksStateFromRollup, checksPendingSinceFromRollup, dedupeRollupByLatestAttempt, fixLedgerRowsForHead, fixRoundTally, listRetirableEscalationIssues, operatorVerdictEvidence, REQUIRED_CHECK_FAIL, closedPrFacts, type ClosedPrFact, redQualityGateNames, pendingQualityGateNames, usableInstrumentEntanglementPaths, type ActionableGateFailure, type CancelledRequiredCheck, type CiFailure, type CiLogUnavailableCause, MAX_CI_LOG_FAILURE_DETAIL, type CiTailSource, type CiAnnotationFallback, type CreditCandidate, type EscalationReconcileCandidate, type InstrumentEntanglementPaths, type OpenPrView, type StrikeAttempt, DEFAULT_FIX_CLASSES, checkJobId, corroboratedIneligibility, creditSubjectIsImplementation, isPostReviewDiffCeilingRefusal, isRetryableReviewThrow, codeScanningHeadSettled, reviewInputLoopFacts, type BaseChangedFiles } from "./sweep.js";
import { readCiGateRequiredChecks } from "./ci-gate-required.js";
import { ghJson } from "./worker.js";
import { runStepsAsync, runStepsSync, step, type Steps } from "./git-push.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { repoRoot, resolveOwnerRepo } from "./repo-location.js";
import { reviewTaskIdFromBody } from "./report-commands.js";

/** REST rollups preserve check-run order: retain external_id and the exact head/constituent
 * outcome beside each row without changing the shared REST mapper's unrelated callers. */
export function attachPostedGateIds<T extends object>(
  rollup: T[],
  response: unknown,
): T[] {
  const runs = (response as { check_runs?: Array<{ external_id?: unknown; head_sha?: unknown; output?: { summary?: unknown } }> } | undefined)?.check_runs;
  runs?.forEach((run, index) => {
    if (typeof run.external_id === "string" && rollup[index]) {
      (rollup[index] as T & { externalId?: string }).externalId = run.external_id;
    }
    if (rollup[index] && typeof run.head_sha === "string" && /^[a-f0-9]{40}$/.test(run.head_sha)) {
      (rollup[index] as T & { headSha?: string }).headSha = run.head_sha;
      const name = (rollup[index] as T & { name?: string }).name;
      const summary = typeof name === "string"
        ? `W1-T4399: reported by this job's ${name} step(s) (outcome(s): cancelled)` : undefined;
      if (summary !== undefined && run.output?.summary === summary) {
        (rollup[index] as T & { outputSummary?: string }).outputSummary = summary;
      }
    }
  });
  return rollup;
}

export function* openPrsWithPostedIdsSteps(owner: string, repo: string, fetch: GhApiFetcher): Steps<OpenPrRest[]> {
  const checkRuns = new Map<string, unknown>();
  const prs = yield* fetchOpenPrsRestSteps(owner, repo, (args, onRateLimit) => {
    const remember = (response: unknown) => {
      if (args[1]?.includes("/check-runs?")) checkRuns.set(args[1], response);
      return response;
    };
    const response = fetch(args, onRateLimit);
    return response instanceof Promise ? response.then(remember) : remember(response);
  });
  for (const pr of prs) {
    if (pr.statusCheckRollup) {
      attachPostedGateIds(pr.statusCheckRollup, checkRuns.get(checkRunsRestArgs(owner, repo, pr.headRefOid)[1]));
    }
  }
  return prs;
}

/**
 * Extract the generator name a failing check's OWN log names as its fix — every generator this
 * class covers fails with the IDENTICAL `Run 'npm run <name>' and commit the result.` sentence
 * (see this section's own header doc for where that was grepped, not assumed). `undefined` when
 * the log names no such sentence, which is the ordinary case for the vast majority of CI failures
 * (a real test failure, a lint error, a type error) — that absence is exactly what keeps this
 * class bounded to what it targets (rationale (5a)), never a widening net.
 */
export function remedyGeneratorNamedInLog(logTail: string): string | undefined {
  const m = /Run 'npm run ([\w:@./-]+)' and commit the result\.?/.exec(logTail ?? "");
  return m ? m[1] : undefined;
}

/**
 * W1-T2733 — HOW MANY DISTINCT REMEDY LINES ARE CARRIED FORWARD FROM OUTSIDE THE TAIL.
 * BACKSTOP, not the primary control: deduplication is what actually stops a repetitive log growing
 * the fix prompt (one remedy repeated 3,000 times retains ONCE), and this catches only the residue
 * that dedupe cannot — a log naming many DISTINCT generators, which no honest CI run does. Small
 * because {@link allCiFailuresAreGeneratorFixable} needs one remedy per failing check, not a
 * catalogue; a job naming more than this is not a case the deterministic rung should be reasoning
 * about at all.
 */
export const MAX_RETAINED_REMEDY_LINES = 5;

/** W1-T2733 — the marker that says these lines did not come from the tail. Present ONLY when
 *  something was retained, so a log with no recognised remedy is byte-identical to before. */
export const RETAINED_REMEDY_HEADER = "--- generator remedy line(s) retained from earlier in this job (W1-T2733) ---";

/** W1-T3387: the semantic reviewer's hard cap for a PR with no task id (and so no declared `budget_usd`). */
export const UNTASKED_REVIEW_BUDGET_USD = 15;

/**
 * W1-T3084 — THE ONE RULE BOTH RUNGS APPLY. `sweep.ts:1347` declines any candidate whose
 * `creditIsImplementation !== true`; `defaultCreditedMergedIds` used to filter on `.merged` alone,
 * so the verb that WRITES `status: merged` into the plan was strictly more permissive than the
 * read-only rung auditing it. MEASURED 2026-09-07 by running the real verb both ways on the real
 * plan: 1036 shards flipped as shipped, 953 with this rule — 83 apart.
 *
 * BOTH NON-TRUE VALUES DECLINE: `undefined` (the merge subject fell outside the scanned window, so
 * nothing is known) and `false` (a filing earned the credit). Reading `undefined` as a credit is
 * how #4461 was closed against a `chore(plan)`.
 *
 * `=== true` RATHER THAN A TRUTHY TEST, and honestly: for `boolean | undefined` the two are
 * behaviourally IDENTICAL, so this is a statement of intent, not a behavioural guard — a mutation
 * to `!!c.creditIsImplementation` passes every test here, which was measured, not assumed. It is
 * written this way to match sweep.ts:1347's `!== true` exactly, so a reader comparing the two rungs
 * sees one rule and not two spellings of it.
 *
 * Exported as a PREDICATE rather than inlined so a test can drive all three values directly: the
 * function below reads config, a ledger and GitHub, and none of that is the rule under test.
 */
export function creditIsReconcilable(c: { merged?: boolean; creditIsImplementation?: boolean; creditHasBuildDiff?: boolean; creditHasOtherBuildMerge?: boolean }): boolean {
  return c.merged === true && (c.creditIsImplementation === true || c.creditHasBuildDiff === true || c.creditHasOtherBuildMerge === true);
}

/**
 * W1-T2304's board-review rung: the open board as {@link BoardItem}s. PURE mapping; {@link defaultBoardReviewItems} is
 * its one real read. Every absent input fails OPEN: an unknown age is zero, an unreadable rollup is zero red, an
 * unreadable projection is no escalation, and a PR whose task or `origin:` cannot be resolved is not self-produced
 * (W1-T2465), because marking on an uncertain read would hide a real board item from every finding.
 * Why: docs/forensics/tick-read-worker.md#boarditemescalationinfo
 */
export interface BoardItemEscalationInfo {
  title?: string;
  issueUrl?: string;
  unverified?: true;
  /** W1-T2466: the escalation's own `StatusProjection.escalationOpenedAt` — when it became a
   *  needs-human item, threaded through unread the same way title/issueUrl/unverified are. */
  openedAt?: string;
}

/** W1-T2465: the SAME `board-review:stale:<ref>` / `board-review:escalation:<ref>` shape
 *  `board-review.ts` mints and `lib/inbox.ts`'s `deriveLegacyReferent` parses — duplicated here
 *  deliberately rather than imported, the same "a deliberate, small duplication rather than a
 *  cross-layer import" precedent `board-review.ts`'s own header sets, because importing either
 *  of those (pure-module / registry) modules back from this reader would be a cycle. */
const BOARD_REVIEW_PROPOSAL_ORIGIN_PATTERN = /^board-review:(?:stale|escalation):.+$/;

export function boardItemsFromOpenPrs(
  prs: readonly OpenPrRest[],
  now: Date,
  escalationsByPrNumber: ReadonlyMap<number, BoardItemEscalationInfo> = new Map(),
  originByPrNumber: ReadonlyMap<number, string> = new Map(),
): BoardItem[] {
  return prs.map((pr) => {
    const openedMs = pr.createdAt ? Date.parse(pr.createdAt) : Number.NaN;
    const ageHours = Number.isNaN(openedMs) ? 0 : Math.max(0, (now.getTime() - openedMs) / 3_600_000);
    const red = (pr.statusCheckRollup ?? []).filter((e) => e.conclusion === "FAILURE" || e.conclusion === "TIMED_OUT").length;
    const escalation = escalationsByPrNumber.get(pr.number);
    const originatesFromProposalId = originByPrNumber.get(pr.number);
    return {
      id: `#${pr.number}`,
      isDraft: pr.isDraft === true,
      status: "open" as const,
      ageHours,
      redCheckCount: red,
      unhandledEscalations: escalation ? 1 : 0,
      ...(escalation?.title !== undefined ? { escalationTitle: escalation.title } : {}),
      ...(escalation?.issueUrl !== undefined ? { escalationIssueUrl: escalation.issueUrl } : {}),
      ...(escalation?.unverified ? { escalationUnverified: true as const } : {}),
      ...(escalation?.openedAt !== undefined ? { escalationOpenedAt: escalation.openedAt } : {}),
      ...(originatesFromProposalId !== undefined ? { originatesFromProposalId } : {}),
    };
  });
}

/** The three real reads {@link defaultBoardReviewItems} chains, injectable as one bundle so a
 *  test can drive the whole reader over synthetic rows — the same one-seam discipline
 *  {@link PlanLifecycleCountsIo} already follows. */
export interface BoardReviewItemsIo {
  fetchOpenPrs?: (owner: string, repo: string) => OpenPrRest[];
  resolveOwnerRepo?: () => { owner: string; repo: string };
  loadPlan?: (path: string) => Plan;
  projectPlan?: (plan: Plan, deps: DeriveDeps, cachePath?: string) => Map<string, StatusProjection>;
  now?: () => Date;
}

/** The synchronous open-PR read {@link defaultBoardReviewItems} defaults to. */
export const syncBoardReviewOpenPrs = (o: string, r: string): OpenPrRest[] => fetchOpenPrsRest(o, r, ghJson);

/**
 * The board-review rung's ONE real read — the injected edge, exactly the role
 * {@link buildOpenPrViews} plays for the sweep.
 *
 * ONE LIST CALL PLUS THE ROLLUPS IT ALREADY CARRIES. `fetchOpenPrsRest` hydrates
 * `statusCheckRollup` per PR itself, so the red arm costs nothing this read was not already
 * paying. It runs on EVERY daemon tick's check, not only on a fire (W1-T5481 measured 30-98 s each,
 * 1+2N synchronous `gh` calls), so the daemon prefetches it off the loop instead.
 *
 * NEVER THROWS, and that is a deliberate fail direction: a GitHub outage must degrade this rung
 * to "no items, therefore no fire", never take out the daemon tick that hosts it. An empty list
 * makes {@link decideBoardReviewTrigger} answer `fire: false`, which is the same thing a healthy
 * empty board says — acceptable here precisely because this rung only ever REPORTS, so a missed
 * report costs one period, whereas a thrown tick costs the loop.
 */
export function defaultBoardReviewItems(config: Config, io: BoardReviewItemsIo = {}): BoardItem[] {
  try {
    const { owner, repo } = (io.resolveOwnerRepo ?? resolveOwnerRepo)();
    const prs = (io.fetchOpenPrs ?? syncBoardReviewOpenPrs)(owner, repo);
    let escalations = new Map<number, BoardItemEscalationInfo>();
    let originByPrNumber = new Map<number, string>();
    try {
      const plan = (io.loadPlan ?? loadPlan)(join(repoRoot, "plan", "tasks.yaml"));
      const proj = (io.projectPlan ?? projectPlan)(
        plan,
        { ledgerPath: ledgerPathFor(config), github: buildBatchedGithub(owner, repo) },
        join(config.root, "state", "status.json"),
      );
      // W1-T2453: carry the SAME entries' `escalationTitle`/`escalationIssueUrl`/
      // `escalationUnverified` through — they are already on `p`, one line above, so naming the
      // escalation in `boardItemsFromOpenPrs` costs no second read. W1-T2466: `escalationOpenedAt`
      // rides the same join, for the same reason.
      escalations = new Map(
        [...proj.values()]
          .filter((p) => p.needsHuman && p.prNumber !== undefined)
          .map((p) => [
            p.prNumber!,
            {
              title: p.escalationTitle,
              issueUrl: p.escalationIssueUrl,
              unverified: p.escalationUnverified,
              openedAt: p.escalationOpenedAt,
            },
          ] as const),
      );
      // W1-T2465: the SAME projection's `taskId`, joined to the plan it was already built from,
      // answers "was this PR's task born from a board-review proposal" with no second read.
      // `plan.byId?.get(...)` is deliberately optional — a plan shape without an index (or a
      // task the plan no longer carries) yields `undefined` here, never a throw, so this arm
      // fails toward NOT-SELF-PRODUCED rather than taking the whole read (escalations included)
      // down with it.
      originByPrNumber = new Map(
        [...proj.values()]
          .filter((p) => p.prNumber !== undefined)
          .map((p) => [p.prNumber!, plan.byId?.get(p.taskId)?.origin] as const)
          .filter((entry): entry is [number, string] => BOARD_REVIEW_PROPOSAL_ORIGIN_PATTERN.test(entry[1] ?? "")),
      );
    } catch {
      // The escalation/origin arms degrade to zero rather than taking the whole read down — the
      // open-PR list is the arm that qualified on 2026-08-26 and it is already in hand.
    }
    return boardItemsFromOpenPrs(prs, io.now?.() ?? systemClock.date(), escalations, originByPrNumber);
  } catch {
    // AN OUTAGE YIELDS NO ITEMS, AND THAT IS THE CHOSEN FAIL DIRECTION, not an oversight. An
    // empty board makes `decideBoardReviewTrigger` answer `fire: false`, which is the same thing
    // a genuinely healthy empty board says — acceptable ONLY because this rung exclusively
    // REPORTS: the cost of the confusion is one missed report, bounded by `minIntervalMinutes`,
    // whereas letting the throw escape would cost the daemon tick that hosts it. The distinction
    // is not lost to the operator either: `check` returns its reason and the tick ledgers
    // `board_review.skipped` with it.
    return [];
  }
}

export interface TickReadOptions {
  owner: string;
  repo: string;
  config: Config;
  ledgerPath: string;
  checkoutRoot: string;
}

export function createTickReadProducer(options: TickReadOptions, io: {
  fetch?: GhApiFetcher;
  github?: GitHub;
  issues?: IssueGateway;
  changedFilesFetch?: (prNumber: string) => Promise<string[] | undefined>;
  commitTrailerIndex?: () => Map<string, PrRef[]> | null;
  evidenceRootFor?: (owner: string, repo: string) => string | undefined;
  viewsDeps?: Parameters<typeof buildOpenPrViewsAsync>[3];
  /** W1-T6591: the open-PR reads' async transport; absent, `fetch` or `ghJsonAsync` answers them. */
  fetchAsync?: GhApiFetcher;
  pacer?: GhCallPacer;
  log?: (step: string, extra?: Record<string, unknown>) => void;
} = {}) {
  const { owner, repo, config, ledgerPath, checkoutRoot } = options;
  const log = io.log ?? (() => {});
  const pacer = io.pacer ?? createGhCallPacer();
  const snapshotCache = createBoardSnapshotCache(config.root, owner, repo, { log });
  const fileOptions = { log, ...(io.changedFilesFetch ? { fetch: io.changedFilesFetch } : {}) };
  const files = createChangedFilesCache(config.root, owner, repo, fileOptions);
  let openFiles = files;
  const filingFiles = createPlanFilingFileCache();
  let reads = new Map<string, unknown>();
  let generationClock = 0;
  const closedAt = new Map<number, string>();
  let closedRows: ReadonlyArray<{ number: number; url: string; state: string }> = [];
  const readKey = (args: string[]) => {
    const endpoint = args.find((arg) => arg.startsWith(`repos/${owner}/${repo}/`));
    let key = args.join("\0");
    if (endpoint?.includes("/pulls?") && endpoint.includes("state=open")) {
      const url = new URL(endpoint, "https://api.github.com/");
      url.searchParams.delete("sort");
      url.searchParams.delete("direction");
      if (!url.searchParams.has("page")) url.searchParams.set("page", "1");
      url.searchParams.sort();
      key = url.pathname + url.search;
    }
    return { endpoint, key };
  };
  const remember = (endpoint: string | undefined, key: string, answer: unknown) => {
    reads.set(key, answer);
    if (endpoint?.includes("state=closed") && Array.isArray(answer)) { // W1-T5318: GitHub's own terminal times
      for (const pr of answer as Array<{ number?: unknown; merged_at?: unknown; closed_at?: unknown }>) {
        const at = pr.merged_at ?? pr.closed_at;
        if (typeof pr.number === "number" && typeof at === "string") closedAt.set(pr.number, at);
      }
    }
    return answer;
  };
  const fetch: GhApiFetcher = (args, budget) => {
    const { endpoint, key } = readKey(args);
    return reads.has(key) ? reads.get(key) : remember(endpoint, key, (io.fetch ?? ghJson)(args, budget));
  };
  const fetchAsync: GhApiFetcher = async (args, budget) => {
    const { endpoint, key } = readKey(args);
    if (reads.has(key)) return reads.get(key);
    const read: GhApiFetcher = io.fetchAsync ?? io.fetch ?? ((a, b) => ghJsonAsync(a, undefined, b));
    return remember(endpoint, key, await read(args, budget));
  };
  const github = io.github ?? buildBatchedGithub(owner, repo, {
    log, pacer, snapshotCache: {
      ...snapshotCache,
      closedSeed: () => { const seed = snapshotCache.closedSeed(); if (seed) closedRows = [...seed.values()]; return seed; },
      commitClosed: (rows) => { closedRows = rows; return snapshotCache.commitClosed(rows); },
      commitOpen: (rows) => snapshotCache.commitOpen?.(rows, systemClock.now()) ?? false,
    }, changedFilesCache: {
      lookup: (url, state) => (state === "MERGED" || state === "CLOSED" ? files : openFiles).lookup(url, state),
      settle: async () => { await files.settle(); await openFiles.settle(); },
    },
    // A logical tick clock expires each half once per generation, independent of read duration.
    // Only cache age uses it; the persisted open snapshot above retains the real clock.
    now: () => generationClock, ttlMs: 1, mergedTtlMs: 1,
    // Every read goes through the generation-memoised JSON fetch: the gateway's one `--jq` read
    // (changed files) is answered by the changed-files cache above and never reaches `exec`.
    exec: (args) => JSON.stringify(fetch(args)),
    commitTrailerIndex: io.commitTrailerIndex ?? (() => buildCommitTrailerIndex({ slug: `${owner}/${repo}`, cwd: checkoutRoot })()),
  });
  return async (request: { plan: Plan; previousProjection?: Array<[string, StatusProjection]> }) => {
    const { plan } = request;
    reads = new Map();
    openFiles = createChangedFilesCache(config.root, owner, repo, fileOptions);
    generationClock++;
    github.resetFailureFlags?.();
    let openPrRows: OpenPrRest[] | undefined;
    let openPrError: string | undefined;
    try { openPrRows = await fetchOpenPrsWithPostedIdsAsync(owner, repo, fetchAsync, pacer); }
    catch (error) {
      openPrError = String(error);
      log("read_plane.open_failed", { reason: openPrError });
    }
    let prior = request.previousProjection;
    if (!prior) {
      const stored = readFileIfExists(join(config.root, "state", "status.json"));
      if (stored) {
        try {
          const parsed = JSON.parse(stored) as { tasks?: Record<string, StatusProjection> };
          if (parsed.tasks && typeof parsed.tasks === "object") prior = Object.entries(parsed.tasks);
        } catch (error) { log("read_plane.previous_unreadable", { reason: String(error) }); }
      }
    }
    const previous = new Map(prior);
    const creditBefore = loadCreditStore(defaultCreditStorePath(ledgerPath));
    let credits = creditBefore;
    const creditIo: Pick<DeriveDeps, "readCreditStore" | "writeCreditStore"> = {
      readCreditStore: () => credits,
      writeCreditStore: (store) => { credits = store; },
    };
    let openBranches: PrRef[] | undefined;
    const derive = () => projectPlan(plan, {
      ledgerPath, github, skipUncreditedBuildWarning: true, ...creditIo,
      previousProjection: (id) => previous.get(id),
      observeOpenPrCount: (rows) => { openBranches = rows ? [...rows] : undefined; },
    });
    let projection = derive();
    await files.settle();
    await openFiles.settle();
    // Warm-up credit precedes its file evidence; only the settled derivation may publish it.
    credits = creditBefore;
    projection = derive();
    const openPrViews = openPrRows ? await buildOpenPrViewsAsync(owner, repo, ledgerPath, {
      ...io.viewsDeps, fetchAsync, pacer, planFilingFileCache: filingFiles, openPrRows,
      readMainPlan: () => plan, isMerged: (task) => projection.get(task.id)?.merged ?? false,
    }) : [];
    const evidenceRootFor = io.evidenceRootFor ?? (() => checkoutRoot);
    const credit = () => buildCreditCandidates(owner, repo, plan, ledgerPath, log, github, evidenceRootFor, readLedgerLines, creditIo);
    const beforeCreditRead = credits;
    let creditCandidates = credit();
    await files.settle();
    await openFiles.settle();
    credits = beforeCreditRead;
    creditCandidates = credit();
    let escalationIntake: EscalationIntake | undefined;
    const escalationCandidates = buildEscalationReconcileCandidates(owner, repo, plan, ledgerPath, log, {
      github, issues: io.issues, evidenceRootFor, creditIo,
      onIntake: (intake) => { escalationIntake = intake; },
    });
    const boardItems = openPrRows ? defaultBoardReviewItems(config, {
      resolveOwnerRepo: () => ({ owner, repo }), fetchOpenPrs: () => openPrRows,
      loadPlan: () => plan, projectPlan: () => projection,
    }) : [];
    const staleGateWorkflowsByPr = buildStaleGateWorkflowsByPr(owner, repo, openPrViews);
    const baseChangedFilesByPr = new Map<number, BaseChangedFiles>();
    const behindMainByPr = buildBehindMainByPr(owner, repo, openPrViews, fetch, undefined, baseChangedFilesByPr);
    const mergedFixPrNumbers = [...new Set(DEFAULT_FIX_CLASSES.map((entry) => entry.fixPrNumber))]
      .filter((number) => github.prByRef(number)?.state === "MERGED");
    const rawByNumber = new Map(openPrRows?.map((pr) => [pr.number, pr]));
    const postFixCiFailuresByPr = new Map<number, CiFailure[] | undefined>();
    for (const pr of openPrViews) {
      const raw = rawByNumber.get(pr.prNumber);
      const syncRead = io.viewsDeps?.fetchCiFailureEvidence;
      postFixCiFailuresByPr.set(pr.prNumber, pr.checksState === "pending" && raw && !raw.rollupUnreadable
        ? (syncRead ? syncRead(owner, repo, raw.statusCheckRollup)
          : await (io.viewsDeps?.fetchCiFailureEvidenceAsync ?? fetchCiFailuresAsync)(owner, repo, raw.statusCheckRollup))
        : pr.ciFailures);
    }
    const creditUpdates = Object.entries(credits)
      .filter(([id, value]) => JSON.stringify(value) !== JSON.stringify(creditBefore[id]))
      .map(([id, after]) => ({ id, before: creditBefore[id], after }));
    const closedPrs: ClosedPrFact[] = closedPrFacts(closedRows, closedAt, new Set(openPrRows?.map((pr) => pr.number)));
    return { plan, projection: [...projection], openBranches, openPrRows, openPrViews, openPrError, creditUpdates,
      creditCandidates, escalationCandidates, escalationIntake, boardItems,
      staleGateWorkflowsByPr, behindMainByPr, baseChangedFilesByPr, mergedFixPrNumbers, postFixCiFailuresByPr, closedPrs };
  };
}

// LiveInflightRun / liveInflightRuns moved to src/lib/report-commands.ts (W1-T2888) — imported/
// re-exported below.

/**
 * W1-T1212 — the required-context → workflow-file map the stale-gate discriminator draws on.
 * Branch protection names exactly two required contexts today (`ghRequiredStatusCheckContexts`,
 * status.ts): `remudero-review` (never a member here — it is a commit status carrying the review
 * verdict, not a check run defined by a workflow file at all, and `checksStateFromRollup`
 * already excludes it from `ciFailures` for the same reason) and `ci-gate`, whose own workflow
 * file is the ONE #2477 fixed (the recon this task cites verbatim). A failing check name this
 * map does not carry produces NO stale-gate signal — fail toward "don't fire," never a guess at
 * a file that may not exist. Widening this to a general check-name → workflow-file resolver is a
 * separate, out-of-scope shard (design note (vi) names none of that in scope).
 */
const STALE_GATE_WORKFLOW_FILE: Readonly<Record<string, string>> = {
  "ci-gate": ".github/workflows/ci-gate.yml",
};

/**
 * W1-T1212 — one file's git blob sha at one ref (`gh api repos/<o>/<r>/contents/<path>?ref=<ref>`,
 * the single-contents-read design note (i) calls for). `undefined` on ANY failure (missing file,
 * bad ref, `gh` unreachable) — never thrown, so a read this lane cannot complete simply
 * contributes no stale-gate evidence rather than aborting the whole sweep pass.
 */
function blobShaAtRef(owner: string, repo: string, path: string, ref: string): string | undefined {
  try {
    const out = ghExec(["api", `repos/${owner}/${repo}/contents/${path}`, "-f", `ref=${ref}`, "--jq", ".sha"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const sha = out.trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    // Every failure above is no stale-gate evidence, never an absent blob: the lane adds none.
    return undefined;
  }
}

/**
 * W1-T1212 — THE READ HALF OF THE DISCRIMINATOR (design note i): for one red PR, which of its
 * OWN currently-failing checks (a subset of {@link OpenPrView.ciFailures}) are defined by a
 * workflow file whose blob sha differs between this PR's OWN merge ref (`pull/<n>/merge` — the
 * SAME ref `pull_request` itself evaluates, frozen at this PR's last `synchronize`, per the
 * recon this task cites) and `main` RIGHT NOW. A name with no {@link STALE_GATE_WORKFLOW_FILE}
 * entry, or whose blob read fails on either ref, contributes nothing — fail toward "not stale."
 */
function staleGateFailureNames(owner: string, repo: string, pr: OpenPrView): string[] {
  const out: string[] = [];
  for (const failure of pr.ciFailures ?? []) {
    const path = STALE_GATE_WORKFLOW_FILE[failure.name];
    if (!path) continue;
    const prSha = blobShaAtRef(owner, repo, path, `pull/${pr.prNumber}/merge`);
    const mainSha = blobShaAtRef(owner, repo, path, "main");
    if (prSha !== undefined && mainSha !== undefined && prSha !== mainSha) out.push(failure.name);
  }
  return out;
}

/**
 * W1-T1212 — {@link SweepDeps.staleGateWorkflowsByPr}'s real wiring. One map entry per
 * checks-red PR that has at least one stale-gate name — every already-green/pending PR costs no
 * `gh api` read at all, keeping this bounded to the population the mechanism actually concerns.
 */
export function buildStaleGateWorkflowsByPr(
  owner: string,
  repo: string,
  openPrs: readonly OpenPrView[],
): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const pr of openPrs) {
    if (pr.checksState !== "red") continue;
    const names = staleGateFailureNames(owner, repo, pr);
    if (names.length > 0) out.set(pr.prNumber, names);
  }
  return out;
}

/** PRIMARY CONTROL — the most direct graph evidence the distance-refresh rung may read on one pass.
 * It ignores GitHub's `mergeable_state`: `open-prs-rest.ts` normalizes `behind` to `clean`, and
 * GitHub can report `clean` even when its compare endpoint says main is many commits ahead. Three
 * serial reads every five-minute rotation keep the observation bounded while eventually covering
 * every open, updateable PR.
 */
export const DISTANCE_REFRESH_PROBE_LIMIT = 3;

export const DISTANCE_REFRESH_ROTATION_MS = 5 * 60_000;

/** W1-T3277 — choose a small, fair rotating slice of PRs for direct graph comparison. A draft or
 * conflicted PR cannot reach `update-branch`, so probing it would spend GitHub capacity without
 * creating an admissible candidate. The activity order is stable within a window; the window
 * offset guarantees an unchanged population larger than the cap is not permanently starved. */
export function distanceRefreshProbeTargets(
  openPrs: readonly OpenPrView[],
  nowMs: number = systemClock.now(),
): OpenPrView[] {
  const eligible = openPrs
    .filter((pr) => pr.isDraft !== true && pr.mergeState !== "dirty" && pr.mergeable !== false)
    .slice()
    .sort((a, b) => a.lastActivityAt.localeCompare(b.lastActivityAt) || a.prNumber - b.prNumber);
  if (eligible.length <= DISTANCE_REFRESH_PROBE_LIMIT) return eligible;
  const window = Math.floor(nowMs / DISTANCE_REFRESH_ROTATION_MS);
  const start = (window * DISTANCE_REFRESH_PROBE_LIMIT) % eligible.length;
  return Array.from(
    { length: DISTANCE_REFRESH_PROBE_LIMIT },
    (_, index) => eligible[(start + index) % eligible.length]!,
  );
}

/**
 * W1-T3277 — the generic stale-PR distance reader. It deliberately derives freshness from the
 * compare endpoint rather than `mergeable_state`: the latter is a mergeability label, not a
 * graph-distance guarantee. The pure selector in `sweep.ts` receives only measured distances.
 */
/** GitHub's compare endpoint lists at most this many files; a list this long may be cut short. */
const BASE_COMPARE_FILES_CAP = 300;

export function buildBehindMainByPr(
  owner: string,
  repo: string,
  openPrs: readonly OpenPrView[],
  fetch: GhApiFetcher = ghJson,
  nowMs: number = systemClock.now(),
  baseChangedFilesOut?: Map<number, BaseChangedFiles>,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const pr of distanceRefreshProbeTargets(openPrs, nowMs)) {
    try {
      const compare = fetch(["api", `repos/${owner}/${repo}/compare/${pr.headSha}...main`]) as {
        ahead_by?: unknown;
        files?: unknown;
      };
      if (typeof compare?.ahead_by === "number" && Number.isFinite(compare.ahead_by)) {
        out.set(pr.prNumber, compare.ahead_by);
        // W1-T5696: the same response's files[] is the base-side change list (GitHub caps it at 300).
        // A response without a files array records nothing, which the distance arm reads as unknown.
        if (baseChangedFilesOut !== undefined && Array.isArray(compare.files)) {
          const files = compare.files.flatMap((f) =>
            typeof (f as { filename?: unknown } | null)?.filename === "string" ? [(f as { filename: string }).filename] : [],
          );
          baseChangedFilesOut.set(pr.prNumber, { files, truncated: compare.files.length >= BASE_COMPARE_FILES_CAP });
        }
      }
    } catch {
      // Best-effort distance: an unreadable compare omits this PR from the distance rung.
    }
  }
  return out;
}

// ── rmd sweep — the level-triggered PR-pipeline reconciler (W1-T77, P22 core) ──
//
// The deterministic core (predicate + orchestration + idempotence) lives in
// lib/sweep.ts and is graded by test/sweep.test.ts over INJECTED deps. This is
// its real wiring: it BUILDS the observed open-PR state from `gh`/the ledger and
// supplies the four gated effects (arm / dispatch-fix / close / escalate). The
// SAME `runSweep` entry point is invoked by `rmd daemon`'s poll loop (see
// buildSweepHook, wired into DaemonDeps.sweep) — acceptance 4's shared impl.

/** One rollup check entry as `gh pr list --json statusCheckRollup` returns it. */
export interface RollupCheck {
  /** Exact REST identity and posted constituent outcome; absent on unreadable/GraphQL-only rows. */
  headSha?: string;
  outputSummary?: string;
  checkRunId?: number;
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  /** The check's GitHub Actions job URL, when GitHub has not rewritten it to a check-run URL. */
  detailsUrl?: string;
  /** Checks API posts retain `job:<id>` here when GitHub rewrites their details URL. */
  externalId?: string;
  /** When this attempt started — see {@link RollupCheckEntry.startedAt} (lib/sweep.ts), which this
   *  type is structurally assignable to. Feeds {@link dedupeRollupByLatestAttempt} (W1-T457). */
  startedAt?: string;
  /** Terminal completion time from the REST-composed rollup. `fetchCiFailures` preserves it
   * only for the newest deduped failure; it never guesses from the start time (W1-T3422). */
  completedAt?: string;
}

export interface RawOpenPr {
  number: number;
  url: string;
  headRefName: string;
  headRefOid: string;
  updatedAt: string;
  body: string;
  autoMergeRequest: unknown;
  contributionOrigin?: OpenPrRest["contributionOrigin"];
  statusCheckRollup?: RollupCheck[];
  /** W1-T528: GitHub's `draft`, carried by `mapRestPr` (lib/open-prs-rest.ts). */
  isDraft?: boolean;
  /**
   * W1-T1201 — the PR's creation timestamp, projected onto `OpenPrView.createdAt` below for
   * `deriveDisposition`'s age clamp. Optional so this type stays satisfied by today's
   * `mapRestPr` output (lib/open-prs-rest.ts), which does not carry it yet — see that gap named
   * in this task's own rationale. Wiring a real producer here is a follow-up (`created_at` sits
   * on the SAME REST row `updated_at` already comes from); until then this is always `undefined`,
   * the same fail-toward-unclamped default `OpenPrView.createdAt` documents.
   */
  createdAt?: string;
}

export const REVIEW_CTX = "remudero-review";

/** Map the `remudero-review` rollup entry onto the sweep's reviewState. */
export function reviewStateFromRollup(rollup: RollupCheck[] | undefined): OpenPrView["reviewState"] {
  const r = (rollup ?? []).find((c) => c.context === REVIEW_CTX || c.name === REVIEW_CTX);
  if (!r) return "none";
  const s = (r.state ?? r.conclusion ?? r.status ?? "").toUpperCase();
  if (s === "SUCCESS") return "success";
  if (s === "FAILURE" || s === "ERROR") return "failure";
  return "pending";
}

/**
 * W1-T2299 — {@link OpenPrView.reviewVerdictPostedAt}'s producer: when the CURRENT `remudero-review`
 * rollup entry started, off the SAME entry {@link reviewStateFromRollup} above already finds (no
 * extra request). For the commit-status shape `remudero-review` is actually posted as (see
 * lib/review.ts's `postStatus`, `repos/.../statuses/...`), this is the status's own `created_at` —
 * `RestRollupEntry.startedAt`'s own doc (lib/open-prs-rest.ts) names exactly this mapping ("a
 * status context's mapped from createdAt"). `undefined` when the rollup carries no matching entry
 * or that entry has no dateable start — the same "cannot date it" case {@link OpenPrView.reviewVerdictPostedAt}'s
 * own doc says reads as NOT superseded (fail closed).
 */
export function reviewVerdictPostedAtFromRollup(rollup: RollupCheck[] | undefined): string | undefined {
  const r = (rollup ?? []).find((c) => c.context === REVIEW_CTX || c.name === REVIEW_CTX);
  return r?.startedAt;
}

/**
 * Has the deterministic `rmd review` post already been attempted and refused for this exact
 * task/synthetic key + PR URL + head + body digest? Deliberately not `review.post_failed`
 * (a transient `gh` error, which must keep retrying, never escalate on a
 * mere network hiccup) and NOT `review.posted` (a real post always flips
 * GitHub's live rollup away from "zero runs," so `reviewStateFromRollup`
 * itself carries that outcome on the next read — no ledger check needed).
 * A commit or body edit changes the identity and resets this refusal dedup immediately.
 */
function reviewPostRefusedFor(
  ledger: Array<Record<string, unknown>>,
  taskId: string,
  prUrl: string,
  headSha: string,
  inputDigest: string,
): boolean {
  return ledger.some(
    (l) =>
      l.step === "review.post_refused" &&
      reviewRowNamesPr(l, taskId, prUrl) &&
      l.head_sha === headSha &&
      l.review_input_digest === inputDigest &&
      // A thrown post (a transient 401, a timeout) is the sweep's bounded retry clock, not a refusal;
      // only the diff-ceiling throw is final. Same classification as the sweep's own fold (W1-T2753).
      (!isRetryableReviewThrow(l.reason) || isPostReviewDiffCeilingRefusal(l.reason)),
  );
}

/** Completed review judgments for one exact, current review input. Unlike the historical orphan
 * scan below, this is the retry/backoff counter: only `review.posted` counts, and only when task,
 * PR, head and body digest all match. A refusal did not judge the input; a legacy row without the
 * identity cannot safely block it; and a commit or body edit changes the digest and resets both
 * the count and its clock immediately. */
export interface ReviewInputAttemptFacts {
  attempts: number;
  lastAttemptAt?: string;
}

export function reviewAttemptsForInput(
  ledger: Array<Record<string, unknown>>,
  taskId: string,
  prUrl: string,
  headSha: string,
  inputDigest: string,
): ReviewInputAttemptFacts {
  let attempts = 0;
  let latestTs = -Infinity;
  for (const line of ledger) {
    if (line.step !== "review.posted") continue;
    if (!reviewRowNamesPr(line, taskId, prUrl)) continue;
    if (line.head_sha !== headSha || line.review_input_digest !== inputDigest) continue;
    attempts++;
    const parsed = typeof line.ts === "string" ? Date.parse(line.ts) : NaN;
    if (!Number.isNaN(parsed) && parsed > latestTs) latestTs = parsed;
  }
  const lastAttemptAt = Number.isFinite(latestTs) ? new Date(latestTs).toISOString() : undefined;
  return lastAttemptAt === undefined ? { attempts } : { attempts, lastAttemptAt };
}

/**
 * WRITTEN AS TWO DIRECT `.step ===` COMPARISONS ON PURPOSE, not as a `Set.has()` over a `typeof`
 * guard. `test/ledger-rotation.test.ts` derives the expected `DECISION_RELEVANT_LEDGER_STEPS`
 * membership by scanning consumer source for `/\.step\s*(?:===|!==)\s*["']…["']/`, so this shape
 * makes the dependency VISIBLE to the very check that exists to find it. Both steps are already in
 * that set (`ledger.ts:337`), which stops rotation from erasing the historical-head evidence used
 * to explain an orphaned status. The retry bound itself is produced separately by
 * {@link reviewAttemptsForInput} and counts only completed postings for the exact current input.
 *
 * The first draft guarded with a `typeof` check against the step field and CI caught it: the
 * scanner read that guard's own type literal as a step name and failed. That was a false positive,
 * but the honest fix is to write the comparison the scanner can read rather than to phrase around
 * it. NOTE the scanner does not strip comments, so prose here must avoid the compared-literal shape
 * too — this very paragraph failed the check once for describing it verbatim.
 */
function isReviewPostedStep(step: unknown): boolean {
  return step === "review.posted" || step === "review.post_refused";
}

/** W1-T1015 — the old head a successful sweep update superseded. The non-success siblings (W1-T5949:
 * head-moved, up-to-date too) are read here so rotation retains their evidence, but they never add a
 * head to the suppression set: a conflict, error, moved or current head minted no replacement head. */
function sweepUpdatedHeadsForTask(ledger: Array<Record<string, unknown>>, taskId: string, prUrl?: string): Set<string> {
  const updatedHeads = new Set<string>();
  for (const line of ledger) {
    if (prUrl === undefined ? line.task_id !== taskId : !reviewRowNamesPr(line, taskId, prUrl)) continue;
    if (
      line.step !== "sweep.update_branch.attempted" &&
      line.step !== "sweep.update_branch.updated" &&
      line.step !== "sweep.update_branch.conflict" &&
      line.step !== "sweep.update_branch.error" &&
      line.step !== "sweep.update_branch.head-moved" &&
      line.step !== "sweep.update_branch.up-to-date"
    ) continue;
    if (line.step !== "sweep.update_branch.updated") continue;
    if (typeof line.head_sha !== "string" || line.head_sha.length === 0) continue;
    updatedHeads.add(line.head_sha);
  }
  return updatedHeads;
}

/** Historical-head facts used to distinguish an orphaned review from a first review. */
interface ReviewOrphanFacts {
  /** True iff this PR was reviewed on a head that is no longer the current one. */
  orphanedByPush: boolean;
  /**
   * How many distinct reviewable prior heads carry an outcome. Retained as diagnostic history;
   * it no longer feeds the retry cap. When `diffDigestForHead` is supplied, two prior heads whose
   * digest matches count as ONE, never two — a base-repair merge that leaves the PR's own diff
   * unchanged is housekeeping, not a retry, and must not spend the same budget one does.
   */
  priorOrphans: number;
  /**
   * The latest ledger timestamp among qualifying historical-head outcomes. Diagnostic only; the
   * live backoff clock comes from {@link reviewAttemptsForInput} for the exact current input.
   * `undefined` when no qualifying line carried a parseable `ts` (including the empty-prior-heads
   * case, where this key is omitted entirely rather than set to `undefined` — see the early return
   * below).
   */
  lastAttemptAt?: string;
}

/**
 * W1-T225: {@link reviewOrphansFor} reads, from the ledger the pass already holds, whether a review was posted
 * at another head; a row with no `head_sha` never counts. Only `orphanedByPush` drives a disposition.
 * Why: docs/forensics/tick-read-worker.md#revieworphansfor
 */
/**
 * CAPPED-ARM-ESCALATION — is the arm refusal for this exact head TERMINAL?
 *
 * PURE, AND EXPORTED SO A TEST CAN REACH IT. `buildOpenPrViews`, the only caller, is not evaluated
 * by any unit test here, so a branch written inline there would be untestable added lines — the
 * same reason `cashDivertSpawnFields` and `harnessCommitForShellLessWorker` live where they do.
 *
 * DERIVED FROM THE SAME TWO READS `decideSweepArm` (lib/sweep.ts) MAKES, deliberately: this value
 * exists to warn that arming will refuse, so deriving it from different facts than the refusal
 * itself would let the warning and the behaviour drift apart.
 *
 * THE THREE ANSWERS, and why the middle one is not a boolean:
 *   - `true`   capped, non-plan-only, no override at this head. Nothing re-judges a fixed head into
 *              an uncapped verdict, so the refusal is permanent until a new head or an override.
 *   - `false`  a verdict IS recoverable and WILL arm — uncapped, plan-only (the W1-T205 carve-out
 *              arms with no override), or already overridden.
 *   - `undefined` NO verdict recoverable at all. Not "fine" and not "terminal": `decideSweepArm`
 *              ARMS on this absence ("no evidence to refuse on"), so there is nothing to warn
 *              about, and a rotated or unreadable ledger cannot manufacture an escalation.
 */
export function terminalArmRefusal(
  ledger: Array<Record<string, unknown>>,
  taskId: string | undefined,
  headSha: string | undefined,
  prUrl?: string,
): boolean | undefined {
  const facts = postedArmFactsFromLedger(ledger, taskId, headSha, prUrl);
  if (!facts) return undefined;
  if (!facts.capped || facts.planOnly) return false;
  return cappedOverrideFromLedger(ledger, taskId!, headSha!, prUrl) === undefined;
}

export function reviewOrphansFor(
  ledger: Array<Record<string, unknown>>,
  taskId: string | undefined,
  headSha: string,
  diffDigestForHead?: (sha: string) => string | undefined,
  prUrl?: string,
): ReviewOrphanFacts {
  if (!taskId || !headSha) return { orphanedByPush: false, priorOrphans: 0 };
  const sweepUpdatedHeads = sweepUpdatedHeadsForTask(ledger, taskId, prUrl);
  const priorHeads = new Map<string, number>(); // sha -> latest parseable ts (ms since epoch)
  // W1-T5713: a sweep-superseded head is an orphan the review-reuse rows must see, but not a foreign push,
  // so it joins neither `priorHeads` (the count) nor `lastAttemptAt` (the clock).
  let sweepSuperseded = false;
  for (const l of ledger) {
    if (!isReviewPostedStep(l.step)) continue;
    if (prUrl === undefined ? l.task_id !== taskId : !reviewRowNamesPr(l, taskId, prUrl)) continue;
    const sha = typeof l.head_sha === "string" ? l.head_sha : "";
    if (!sha || sha === headSha) continue; // absent sha, or the CURRENT head — neither is an orphan
    if (sweepUpdatedHeads.has(sha)) { sweepSuperseded = true; continue; } // the sweep itself superseded this reviewed head
    const parsed = typeof l.ts === "string" ? Date.parse(l.ts) : NaN;
    const prior = priorHeads.get(sha);
    if (prior === undefined) {
      priorHeads.set(sha, parsed); // first sighting always registers the sha, even with an unparseable/absent ts
    } else if (!Number.isNaN(parsed) && (Number.isNaN(prior) || parsed > prior)) {
      priorHeads.set(sha, parsed); // a later, parseable ts wins over an earlier missing/older one
    }
  }
  if (priorHeads.size === 0) return { orphanedByPush: sweepSuperseded, priorOrphans: 0 };

  let priorOrphans: number;
  if (diffDigestForHead) {
    const seenDigests = new Set<string>();
    priorOrphans = 0;
    for (const sha of priorHeads.keys()) {
      const digest = diffDigestForHead(sha);
      // An unreadable digest never merges with anything (fail toward counting, see doc above) —
      // keyed on the sha itself so it can never accidentally collide with a real digest string.
      const key = digest ?? `unreadable:${sha}`;
      if (!seenDigests.has(key)) {
        seenDigests.add(key);
        priorOrphans++;
      }
    }
  } else {
    priorOrphans = priorHeads.size;
  }

  let latestTs = -Infinity;
  for (const ts of priorHeads.values()) if (!Number.isNaN(ts) && ts > latestTs) latestTs = ts;
  const lastAttemptAt = Number.isFinite(latestTs) ? new Date(latestTs).toISOString() : undefined;

  return lastAttemptAt === undefined
    ? { orphanedByPush: true, priorOrphans }
    : { orphanedByPush: true, priorOrphans, lastAttemptAt };
}

/**
 * W1-T100: {@link fetchCiFailures} names each failing required check with a tail of its log, the ci-log fix
 * mode's only input. A log it cannot read degrades to an empty tail with a {@link CiLogUnavailableCause}, never
 * a throw. `owner`/`repo` pass as `--repo`, never gh's cwd-inferred repo. It dedupes with
 * {@link dedupeRollupByLatestAttempt} and filters on {@link REQUIRED_CHECK_FAIL}, the same definitions
 * `checksStateFromRollup` reads, so the two agree by construction (W1-T457, #1728).
 * Why: docs/forensics/tick-read-worker.md#fetchcifailures
 */
/**
 * Reads a check run's ANNOTATION messages — the fallback source for {@link fetchCiFailures}'s log
 * tail. Deliberately the REST annotations endpoint and not the log blob: measured on this repo's
 * own proxy, `GET /actions/jobs/<id>/logs` and `gh run view --log-failed` both answer 403 while
 * `GET /check-runs/<id>/annotations` answers 200, which is the entire reason this seam exists.
 *
 * INJECTABLE, WITH THE PARAMETER APPENDED LAST at the call site so no positional caller shifts.
 * The default really shells out; a test that supplies its own recorder proves the wiring, and a
 * test that lets this run proves the default is reachable at all.
 */
export type CiAnnotationFetch = (owner: string, repo: string, checkRunId: string) => string[];

export type CiJobLogFetch = (owner: string, repo: string, jobId: string) => string;

/** The runner's own exit line, as GitHub really writes it: any code, with a trailing period. It
 *  says only THAT a step failed, so it is never evidence of WHY. */
const BARE_EXIT_CODE_LINE = /^(?:Error: )?Process completed with exit code \d+\.?$/;

export function isBareExitCodeAnnotation(message: string): boolean {
  return BARE_EXIT_CODE_LINE.test(message.trim());
}

/** PRIMARY CONTROL: per pass, this is the default ceiling on annotation API reads. */
export const DEFAULT_CI_ANNOTATION_READ_LIMIT = 8;

export interface CiFailureFetchOptions {
  fetchAnnotations?: CiAnnotationFetch;
  fetchJobLog?: CiJobLogFetch;
  annotationReadLimit?: number;
}

function ciFetchOptions(options: CiAnnotationFetch | CiFailureFetchOptions | undefined): Required<CiFailureFetchOptions> {
  if (typeof options === "function") {
    return {
      fetchAnnotations: options,
      fetchJobLog: defaultCiJobLogFetch,
      annotationReadLimit: DEFAULT_CI_ANNOTATION_READ_LIMIT,
    };
  }
  return {
    fetchAnnotations: options?.fetchAnnotations ?? defaultCiAnnotationFetch,
    fetchJobLog: options?.fetchJobLog ?? defaultCiJobLogFetch,
    annotationReadLimit: options?.annotationReadLimit ?? DEFAULT_CI_ANNOTATION_READ_LIMIT,
  };
}

/** The real annotations read: `gh api` against the endpoint that answers, parsed as JSON. Only
 *  FAILURE-level annotations are kept: every ubuntu-latest job also carries a runner-image
 *  `notice`, and that notice was being handed to fix workers as the failure. */
export function defaultCiAnnotationFetch(owner: string, repo: string, checkRunId: string): string[] {
  const out = ghExec(["api", `repos/${owner}/${repo}/check-runs/${checkRunId}/annotations`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  return failureAnnotationLines(out);
}

export async function defaultCiAnnotationFetchAsync(owner: string, repo: string, checkRunId: string): Promise<string[]> {
  return failureAnnotationLines(await ghTextAsync(["api", `repos/${owner}/${repo}/check-runs/${checkRunId}/annotations`]));
}

function failureAnnotationLines(out: string): string[] {
  const annotations = JSON.parse(out) as Array<{ annotation_level?: string; message?: string }>;
  return annotations
    .filter((a) => a.annotation_level === "failure" && typeof a.message === "string")
    .flatMap((a) => (a.message as string).split("\n"))
    .filter((l) => l.trim() !== "");
}

/** The real Actions job-log read. This endpoint stayed readable when `gh run view --log` returned zero bytes. */
export function defaultCiJobLogFetch(owner: string, repo: string, jobId: string): string {
  return ghExec(["api", `repos/${owner}/${repo}/actions/jobs/${jobId}/logs`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 1 << 22,
  });
}

export function defaultCiJobLogFetchAsync(owner: string, repo: string, jobId: string): Promise<string> {
  return ghTextAsync(["api", `repos/${owner}/${repo}/actions/jobs/${jobId}/logs`], { maxBuffer: 1 << 22 });
}

/** GitHub's job-log endpoint stamps every line; every line pattern below is anchored after it. */
const ACTIONS_LOG_TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;

/** PRIMARY CONTROL: lines of a failed step's own output kept before each `##[error]` marker. */
export const CI_STEP_ERROR_CONTEXT_LINES = 8;

const CI_STEP_GROUP_LINE = /^##\[(?:end)?group\]/;

const CI_TAP_FAILURE_LINE = /^\s*not ok \d+ - /;

const CI_TAP_BLOCK_END_LINE = /^\s*\.\.\.\s*$/;

const CI_FLAKE_RETRY_LINE = /FLAKE-RETRY(?:-RECOVERED)?\s*:/;

/** A run whose every test passed but whose coverage report died names the cause only here, far
 *  above the step's `##[error]`; without it the region reads as an unnamed flake (#10400). */
const CI_COVERAGE_REPORT_FAILED_LINE = /Could not report code coverage|COVERAGE-REPORT-FAILED:/;

const CI_FAILING_TESTS_LINE = /(?:✖|✕|✗|x)\s+failing tests:/i;

const CI_TEST_SUMMARY_LINE = /^\s*(?:#|ℹ)\s+(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b/;

/** Each failed step's own last output lines, read back from its `##[error]` marker to the step's
 *  header. In a job that runs many gates this is what names WHICH gate failed and why. */
function stepErrorContext(lines: readonly string[]): number[] {
  const kept: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith("##[error]")) continue;
    let start = index;
    while (start > 0 && index - start < CI_STEP_ERROR_CONTEXT_LINES && !CI_STEP_GROUP_LINE.test(lines[start - 1])) start -= 1;
    for (let at = start; at <= index; at += 1) kept.push(at);
  }
  return kept;
}

export function extractCiFailureRegion(log: string, tailLines: number): string {
  const pool = poolVerdictRetention();
  const rule = ruleSuitesRetention();
  const summary = testSummaryRetention();
  for (const line of log.split("\n")) {
    pool.push(line);
    rule.push(line);
    summary.push(line);
  }
  return rule.wrap(pool.wrap(summary.wrap(extractCiFailureRegionBase(log, tailLines))));
}

function extractCiFailureRegionBase(log: string, tailLines: number): string {
  const lines = log.split("\n").map((line) => line.replace(ACTIONS_LOG_TIMESTAMP, ""));
  const kept = new Set<number>();
  const isRetryLine = (line: string) => CI_FLAKE_RETRY_LINE.test(line);
  const isCoverageReportLine = (line: string) => CI_COVERAGE_REPORT_FAILED_LINE.test(line);
  const coverageReport: number[] = [];
  let inTapFailure = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (CI_TAP_FAILURE_LINE.test(line)) inTapFailure = true;
    if (inTapFailure) kept.add(index);
    if (inTapFailure && CI_TAP_BLOCK_END_LINE.test(line)) inTapFailure = false;
    if (isRetryLine(line)) kept.add(index);
    if (isCoverageReportLine(line)) coverageReport.push(index);
  }
  const stepErrors = stepErrorContext(lines);
  // One copy of each retry or coverage-report line: a shard repeats the same one dozens of times,
  // and node prints its coverage warning once per reporter (`ℹ Warning` and `# Warning`).
  const region = (indexes: Iterable<number>) => {
    const repeatSeen = new Set<string>();
    return [...new Set(indexes)]
      .sort((a, b) => a - b)
      .filter((index) => {
        if (!isRetryLine(lines[index]) && !isCoverageReportLine(lines[index])) return true;
        const key = lines[index].trim().replace(/^(?:ℹ|#)\s+/, "");
        const seen = repeatSeen.has(key);
        repeatSeen.add(key);
        return !seen;
      })
      .slice(-Math.max(1, tailLines))
      .map((index) => lines[index])
      .join("\n")
      .trim();
  };
  if (kept.size > 0) return region([...kept, ...stepErrors, ...coverageReport]);
  const failingTestsAt = lines.findIndex((line) => CI_FAILING_TESTS_LINE.test(line.trim()));
  if (failingTestsAt >= 0) {
    const summaryAt = lines.findIndex(
      (line, index) =>
        index > failingTestsAt && CI_TEST_SUMMARY_LINE.test(line),
    );
    const end = summaryAt >= 0 ? summaryAt : failingTestsAt + tailLines;
    return lines.slice(failingTestsAt, Math.min(end, failingTestsAt + tailLines)).join("\n").trim();
  }
  if (stepErrors.length > 0) return region([...stepErrors, ...coverageReport]);
  return lines.slice(-tailLines).join("\n").trim();
}

function retainGeneratorRemediesForRegion(fullLog: string, region: string): string {
  const regionLines = region.split("\n");
  const seen = new Set(regionLines.map((l) => l.trim()).filter((l) => remedyGeneratorNamedInLog(l) !== undefined));
  const retained: string[] = [];
  for (const line of (fullLog ?? "").split("\n")) {
    if (remedyGeneratorNamedInLog(line) === undefined) continue;
    const trimmed = line.trim();
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    retained.push(trimmed);
    if (retained.length >= MAX_RETAINED_REMEDY_LINES) break;
  }
  if (retained.length === 0) return region;
  return [RETAINED_REMEDY_HEADER, ...retained, "", region].join("\n");
}

const PROOF_DISCRIMINATION_FAIL_LINE = /proof-discrimination: FAIL — \d+ proof\(s\) pass at both PR head and merge base/;

const PROOF_DISCRIMINATION_PROOF_LINE = /^\s*proof: \S/;

/** PRIMARY CONTROL: the gate's FAIL header plus the stale proofs it names, kept wherever they sit in the job. */
export const MAX_RETAINED_VERDICT_LINES = 64;

export const RETAINED_VERDICT_HEADER = "--- proof-discrimination verdict line(s) retained from earlier in this job ---";

/** The proof-discrimination gate prints each stale proof's full output AFTER naming it, so the region
 *  ending at `##[error]` kept only that output and the sweep's proof-repair route never saw a stale
 *  proof: #10234 escalated instead of being repaired. The verdict lines ride along like remedies. */
export function gateVerdictRetention(): { push(line: string): void; wrap(region: string): string } {
  const kept: string[] = [];
  let open = false;
  return {
    push(line) {
      if (PROOF_DISCRIMINATION_FAIL_LINE.test(line)) open = true;
      else if (!open || !PROOF_DISCRIMINATION_PROOF_LINE.test(line)) return;
      const trimmed = line.trim();
      if (kept.length < MAX_RETAINED_VERDICT_LINES && !kept.includes(trimmed)) kept.push(trimmed);
    },
    wrap(region) {
      return kept.every((line) => region.includes(line)) ? region : [RETAINED_VERDICT_HEADER, ...kept, "", region].join("\n");
    },
  };
}

/** W1-T8038: the pure-test-pool verdict lines — pool failed, also fails isolated, passes isolated, POOL DEFECT
 *  with its leaker and victim, and each judged run's complete/FAILED line. Locate-probe chatter is not one. */
const CI_POOL_VERDICT_LINE =
  /^pure-test-pool: (?:the pool of \d+ file\(s\) failed|the pooled files also fail|every pooled file passes|POOL DEFECT|[A-Za-z]+ run complete|[A-Za-z]+ RUN )/;

/** PRIMARY CONTROL: pool verdict lines kept, one copy each. A shard prints a handful; this only bounds a runaway. */
export const MAX_RETAINED_POOL_LINES = 24;

export const RETAINED_POOL_HEADER = "--- pure-test-pool verdict line(s) retained from earlier in this job ---";

/** Like {@link gateVerdictRetention}: the pool's verdict lines ride along wherever they sit in the job, because
 *  a shard cancelled at its ceiling prints them far above the runner's own cancel marker. */
export function poolVerdictRetention(): { push(line: string): void; wrap(region: string): string } {
  const kept: string[] = [];
  return {
    push(line) {
      const trimmed = line.replace(ACTIONS_LOG_TIMESTAMP, "").trim();
      if (CI_POOL_VERDICT_LINE.test(trimmed) && kept.length < MAX_RETAINED_POOL_LINES && !kept.includes(trimmed)) kept.push(trimmed);
    },
    wrap(region) {
      const have = new Set(region.split("\n").map((l) => l.trim()));
      const missing = kept.filter((line) => !have.has(line));
      return missing.length === 0 ? region : [RETAINED_POOL_HEADER, ...missing, "", region].join("\n");
    },
  };
}

/** W1-T7848: the rule-checks runner's closing line naming every suite it failed. Under node 24's spec reporter
 *  the region is the first `failing tests:` block, far above it, so it rides along like the pool's verdicts. */
const CI_RULE_SUITES_FAILED_LINE = /^rule-checks: failed suites: \S/;

export const RETAINED_RULE_SUITES_HEADER = "--- rule-checks failed-suites line retained from this job ---";

export function ruleSuitesRetention(): { push(line: string): void; wrap(region: string): string } {
  let kept: string | undefined;
  return {
    push(line) {
      const trimmed = line.replace(ACTIONS_LOG_TIMESTAMP, "").trim();
      if (CI_RULE_SUITES_FAILED_LINE.test(trimmed)) kept = trimmed;
    },
    wrap(region) {
      return kept === undefined || region.split("\n").some((l) => l.trim() === kept) ? region
        : [RETAINED_RULE_SUITES_HEADER, kept, "", region].join("\n");
    },
  };
}

/** W1-T9932: an artifact finalize failure annotates only itself and the self-hosted hint, never the passing
 *  tests before it (#12415), so the job log is read for the region that names them. */
const ARTIFACT_FINALIZE_ANNOTATION_LINE = /^(?:Failed to FinalizeArtifact:|If you are using self-hosted runners, )/;

/** W1-T9932: the runner's closing counts and the tier manifest's "K/M file(s) reported" line. */
const CI_RUNNER_COUNT_LINE = /^# (tests|pass|fail) \d+$/;
const CI_MANIFEST_COMPLETE_LINE = /^test-tier-manifest: .* run complete — (\d+)\/(\d+) file\(s\) reported/;

export const RETAINED_TEST_SUMMARY_HEADER = "--- test-runner summary line(s) retained from earlier in this job ---";

/** W1-T9932: a step error's region starts at that step, so a job whose tests all passed before a later step
 *  failed (#12415) lost the summary saying so. The last counts ride along beside it, plus every failing count
 *  and partial manifest line, so a classifier reading the region fails closed, and the failed step's header. */
export function testSummaryRetention(): { push(line: string): void; wrap(region: string): string } {
  const last = new Map<string, string>();
  const failing: string[] = [];
  let stepHeader: string | undefined;
  let failedStep: string | undefined;
  let stepError = false;
  return {
    push(line) {
      const trimmed = line.replace(ACTIONS_LOG_TIMESTAMP, "").trim();
      if (trimmed.startsWith("##[group]Run ")) stepHeader = trimmed;
      if (trimmed.startsWith("##[error]") && !stepError) [stepError, failedStep] = [true, stepHeader];
      const count = CI_RUNNER_COUNT_LINE.exec(trimmed);
      const manifest = CI_MANIFEST_COMPLETE_LINE.exec(trimmed);
      if (count) last.set(count[1], trimmed);
      if (manifest) last.set("manifest", trimmed);
      const bad = (count?.[1] === "fail" && !trimmed.endsWith(" 0")) || (manifest && manifest[1] !== manifest[2]);
      if (bad && !failing.includes(trimmed)) failing.push(trimmed);
    },
    wrap(region) {
      const have = new Set(region.split("\n").map((l) => l.trim()));
      const missing = [...new Set([...failing, ...last.values()])].filter((line) => !have.has(line));
      if (!stepError || missing.length === 0) return region;
      const step = failedStep !== undefined && !have.has(failedStep) ? [failedStep] : [];
      return [RETAINED_TEST_SUMMARY_HEADER, ...missing, ...step, "", region].join("\n");
    },
  };
}

export function ciFailureRegionReducer(tailLines: number): { push(rawLine: string): void; finish(): string } {
  const regionCap = Math.max(1, tailLines);
  const remedyCap = MAX_RETAINED_REMEDY_LINES + regionCap;
  const selected: Array<{ index: number; line: string }> = [];
  const recent: Array<{ index: number; line: string }> = [];
  const tail: string[] = [];
  const failingTests: string[] = [];
  const retrySeen = new Set<string>();
  const remedies: string[] = [];
  let index = -1;
  let kept = 0;
  let stepErrors = 0;
  let inTapFailure = false;
  let failingTestsState: "unseen" | "open" | "closed" = "unseen";
  const verdict = gateVerdictRetention();
  const pool = poolVerdictRetention();
  const rule = ruleSuitesRetention();
  const summary = testSummaryRetention();
  const select = (at: number, line: string): void => {
    let slot = selected.length;
    while (slot > 0 && selected[slot - 1].index >= at) {
      if (selected[slot - 1].index === at) return;
      slot -= 1;
    }
    selected.splice(slot, 0, { index: at, line });
    if (selected.length > regionCap) selected.shift();
  };
  return {
    push(rawLine: string): void {
      index += 1;
      const line = rawLine.replace(ACTIONS_LOG_TIMESTAMP, "");
      verdict.push(line);
      pool.push(line);
      rule.push(line);
      summary.push(line);
      const trimmedRaw = rawLine.trim();
      if (remedies.length < remedyCap && remedyGeneratorNamedInLog(rawLine) !== undefined && !remedies.includes(trimmedRaw)) {
        remedies.push(trimmedRaw);
      }
      if (CI_TAP_FAILURE_LINE.test(line)) inTapFailure = true;
      const retry = CI_FLAKE_RETRY_LINE.test(line);
      if (inTapFailure || retry) kept += 1;
      if (retry && !retrySeen.has(line.trim())) select(index, line);
      if (retry) retrySeen.add(line.trim());
      if (inTapFailure && !retry) select(index, line);
      if (inTapFailure && CI_TAP_BLOCK_END_LINE.test(line)) inTapFailure = false;
      if (line.startsWith("##[error]")) {
        stepErrors += 1;
        let start = recent.length;
        while (start > 0 && !CI_STEP_GROUP_LINE.test(recent[start - 1].line)) start -= 1;
        for (const prior of recent.slice(start)) if (!CI_FLAKE_RETRY_LINE.test(prior.line)) select(prior.index, prior.line);
        if (!retry) select(index, line);
      }
      recent.push({ index, line });
      if (recent.length > CI_STEP_ERROR_CONTEXT_LINES) recent.shift();
      if (failingTestsState === "unseen" && CI_FAILING_TESTS_LINE.test(line.trim())) failingTestsState = "open";
      else if (failingTestsState === "open" && CI_TEST_SUMMARY_LINE.test(line)) failingTestsState = "closed";
      if (failingTestsState === "open" && failingTests.length < tailLines) failingTests.push(line);
      tail.push(line);
      if (tail.length > tailLines) tail.shift();
    },
    finish(): string {
      const region = summary.wrap(
        kept === 0 && failingTestsState !== "unseen"
          ? failingTests.join("\n").trim()
          : kept > 0 || stepErrors > 0
            ? selected.map((entry) => entry.line).join("\n").trim()
            : tail.join("\n").trim());
      const seen = new Set(region.split("\n").map((l) => l.trim()).filter((l) => remedyGeneratorNamedInLog(l) !== undefined));
      const retained = remedies.filter((l) => !seen.has(l)).slice(0, MAX_RETAINED_REMEDY_LINES);
      return verdict.wrap(rule.wrap(pool.wrap(retained.length === 0 ? region : [RETAINED_REMEDY_HEADER, ...retained, "", region].join("\n"))));
    },
  };
}

export async function defaultCiJobLogRegionAsync(owner: string, repo: string, jobId: string, tailLines: number): Promise<string> {
  const reducer = ciFailureRegionReducer(tailLines);
  await ghLinesAsync(["api", `repos/${owner}/${repo}/actions/jobs/${jobId}/logs`], (line) => reducer.push(line));
  return reducer.finish();
}

// Delay only annotation lines until their TAP verdict; keep the rest of a large job streaming.
function annotationLogReducer(annotations: NonNullable<CiFailure["annotations"]>, tailLines: number) {
  const reducer = ciFailureRegionReducer(tailLines);
  const retention = [gateVerdictRetention(), ruleSuitesRetention(), poolVerdictRetention(), testSummaryRetention()];
  const frames: Array<{ indent: number; seen: Set<number>; lines: Set<string> }> = [];
  const passed = new Set<number>();
  const failed = new Set<number>();
  const primary: string[] = [];
  let inFailure = false;
  let inSpecFailure = false;
  let lastError: string | undefined;
  let hasFailure = false;
  const emit = (line: string) => {
    const tap = CI_TAP_FAILURE_LINE.test(line);
    const fail = /^\s*FAIL\b/.test(line) || CI_FAILING_TESTS_LINE.test(line.trim());
    if (tap) inFailure = true;
    if (CI_FAILING_TESTS_LINE.test(line.trim())) inSpecFailure = true;
    if (CI_TEST_SUMMARY_LINE.test(line)) inSpecFailure = false;
    if (tap || fail || inFailure || inSpecFailure) {
      if (primary.length < Math.max(1, tailLines)) primary.push(line);
    }
    if (inFailure && CI_TAP_BLOCK_END_LINE.test(line)) inFailure = false;
    if (line.startsWith("##[error]")) lastError = line;
    if (tap || fail || (line.startsWith("##[error]") && !isBareExitCodeAnnotation(line.slice(9)))) hasFailure = true;
    reducer.push(line);
    for (const retainer of retention) retainer.push(line);
  };
  const close = (passing: boolean) => {
    const frame = frames.pop()!;
    for (const index of frame.seen) {
      (passing ? passed : failed).add(index);
      annotations[index].from_passing_test = passed.has(index) && !failed.has(index);
    }
    if (!passing) for (const line of frame.lines) {
      emit(line);
      if (primary.length < Math.max(1, tailLines)) primary.push(line);
    }
  };
  return {
    push(rawLine: string) {
      const line = rawLine.replace(ACTIONS_LOG_TIMESTAMP, "");
      const start = /^(\s*)# Subtest:/.exec(line);
      const verdict = /^(\s*)(not )?ok \d+ - /.exec(line);
      if (start) {
        while (frames.length && frames.at(-1)!.indent >= start[1].length) close(false);
        frames.push({ indent: start[1].length, seen: new Set(), lines: new Set() });
      }
      if (verdict) {
        while (frames.length && frames.at(-1)!.indent > verdict[1].length) close(false);
        if (frames.at(-1)?.indent === verdict[1].length) close(verdict[2] === undefined);
      }
      const matches = annotations.flatMap((annotation, index) => line.includes(annotation.message) ? [index] : []);
      const frame = frames.at(-1);
      if (matches.length && frame) {
        for (const index of matches) frame.seen.add(index);
        frame.lines.add(line);
        if (frame.lines.size > Math.max(1, tailLines)) frame.lines.delete(frame.lines.values().next().value!);
      } else {
        for (const index of matches) {
          failed.add(index);
          annotations[index].from_passing_test = false;
        }
        emit(line);
      }
    },
    finish() {
      while (frames.length) close(false);
      // Step context can crowd a distant test out of the ordinary region. Keep that test first.
      const region = primary.length ? [...primary, ...(lastError && !primary.includes(lastError) ? [lastError] : [])]
        .slice(0, Math.max(1, tailLines)).join("\n") : reducer.finish();
      return {
        region: retention.reduceRight((text, retainer) => retainer.wrap(text),
          retainGeneratorRemediesForRegion(reducer.finish(), region)),
        hasFailure, lastError,
      };
    },
  };
}

export function fetchCiFailures(
  owner: string,
  repo: string,
  rollup: RollupCheck[] | undefined,
  tailLines = 60,
  options: CiAnnotationFetch | CiFailureFetchOptions = {},
): CiFailure[] {
  return runStepsSync(ciFailuresSteps(owner, repo, rollup, tailLines, ciFetchOptions(options)));
}

export interface CiFailureFetchOptionsAsync {
  fetchAnnotations?: (owner: string, repo: string, checkRunId: string) => string[] | Promise<string[]>;
  fetchJobLog?: (owner: string, repo: string, jobId: string) => string | Promise<string>;
  annotationReadLimit?: number;
}

export function fetchCiFailuresAsync(
  owner: string,
  repo: string,
  rollup: RollupCheck[] | undefined,
  tailLines = 60,
  options: CiFailureFetchOptionsAsync = {},
): Promise<CiFailure[]> {
  return runStepsAsync(
    ciFailuresSteps(owner, repo, rollup, tailLines, {
      fetchAnnotations: options.fetchAnnotations ?? defaultCiAnnotationFetchAsync,
      fetchJobLog: options.fetchJobLog ?? defaultCiJobLogFetchAsync,
      annotationReadLimit: options.annotationReadLimit ?? DEFAULT_CI_ANNOTATION_READ_LIMIT,
      readJobLogRegion: options.fetchJobLog ? undefined : defaultCiJobLogRegionAsync,
    }),
  );
}

function* ciFailuresSteps(
  owner: string,
  repo: string,
  rollup: RollupCheck[] | undefined,
  tailLines: number,
  fetch: Required<CiFailureFetchOptionsAsync> & {
    readJobLogRegion?: (owner: string, repo: string, jobId: string, tailLines: number) => Promise<string>;
  },
): Steps<CiFailure[]> {
  let annotationReads = 0;
  const failing = dedupeRollupByLatestAttempt(rollup ?? []).filter((c) => {
    const s = (c.state ?? c.conclusion ?? c.status ?? "").toUpperCase();
    return REQUIRED_CHECK_FAIL.has(s);
  });
  const failures: CiFailure[] = [];
  for (const c of failing) {
    const name = c.name ?? c.context ?? "unknown";
    let logTail = "";
    // The named outcome for an empty tail. STILL BEST-EFFORT: every path below either assigns a
    // cause or leaves one assigned, and NONE of them rethrows — a log that cannot be read must
    // never take down the fix attempt that needs it. What changes is only that the reason now
    // SURVIVES the read, instead of being swallowed with the error that carried it.
    let logUnavailable: CiLogUnavailableCause | undefined = { kind: "no-job-id" };
    let tailSource: CiTailSource | undefined;
    // W1-T2298: native Actions jobs have matching job and check-run ids. Posted gates preserve
    // their posting job in externalId when their detailsUrl is rewritten to /runs/<check-run-id>.
    // Hoisted out of the `try` so the fallback can reach it after the read has already failed.
    const jobId = checkJobId(c);
    let annotationFallback: CiAnnotationFallback | undefined;
    let runnerTimeoutLines: string | undefined;
    let finalizeAnnotation: string | undefined;
    let annotations: NonNullable<CiFailure["annotations"]> = [];
    if (jobId && annotationReads < fetch.annotationReadLimit) {
      try {
        annotationReads += 1;
        const messages = (yield* step(() => fetch.fetchAnnotations(owner, repo, jobId))).filter((m) => m.trim() !== "");
        const evidence = messages.filter((m) => !isBareExitCodeAnnotation(m));
        annotations = evidence.map((message) => ({ message, from_passing_test: false }));
        const bareExitOnly = messages.length > 0 && evidence.length === 0;
        // W1-T8038: a job killed at its ceiling annotates only the runner's own timeout lines, which name no test.
        // They are kept, and the job log is read beside them below.
        if (evidence.length > 0 && evidence.every((m) => RUNNER_TIMEOUT_LINE.test(m))) {
          runnerTimeoutLines = evidence.join("\n").split("\n").slice(-tailLines).join("\n");
          logTail = runnerTimeoutLines;
          logUnavailable = undefined;
          tailSource = "annotations";
          annotationFallback = { outcome: "runner-timeout-only" };
        } else if (evidence.some((m) => /^Failed to FinalizeArtifact:/.test(m.trim())) &&
            evidence.every((m) => ARTIFACT_FINALIZE_ANNOTATION_LINE.test(m.trim()))) {
          finalizeAnnotation = evidence.join("\n").split("\n").slice(-tailLines).join("\n");
          logTail = finalizeAnnotation;
          logUnavailable = undefined;
          tailSource = "annotations";
          annotationFallback = { outcome: "artifact-finalize-only" };
        } else if (evidence.length > 0) {
          logTail = evidence.join("\n").split("\n").slice(-tailLines).join("\n");
          logUnavailable = undefined;
          tailSource = "annotations";
          annotationFallback = { outcome: "recovered" };
        } else if (bareExitOnly) {
          annotationFallback = { outcome: "bare-exit-code" };
        } else {
          annotationFallback = { outcome: "empty" };
        }
      } catch (err) {
        let detail = "unknown error";
        try {
          const e = err as { code?: unknown; message?: unknown };
          const code = typeof e?.code === "string" && e.code ? `${e.code}: ` : "";
          detail = `${code}${typeof e?.message === "string" && e.message ? e.message : String(err)}`.slice(
            0,
            MAX_CI_LOG_FAILURE_DETAIL,
          );
        } catch {
          /* keep the placeholder - an outcome is still named, which is the whole point */
        }
        annotationFallback = { outcome: "failed", detail };
      }
    } else if (jobId) {
      annotationFallback = { outcome: "skipped-limit" };
    }
    if (jobId) {
      try {
        const readRegion = fetch.readJobLogRegion;
        if (annotations.length > 0 && runnerTimeoutLines === undefined && finalizeAnnotation === undefined) {
          const reducer = annotationLogReducer(annotations, tailLines);
          if (readRegion) yield* step(() => ghLinesAsync(
            ["api", `repos/${owner}/${repo}/actions/jobs/${jobId}/logs`], (line) => reducer.push(line)));
          else {
            const out = yield* step(() => fetch.fetchJobLog(owner, repo, jobId));
            for (const line of out.split("\n")) reducer.push(line);
          }
          const { region, hasFailure, lastError } = reducer.finish();
          const evidence = annotations.filter((a) => !a.from_passing_test).map((a) => a.message);
          if (!hasFailure && evidence.length) {
            logTail = [...evidence, ...(lastError ? [lastError] : [])].join("\n");
            tailSource = "annotations";
          } else {
            logTail = region;
            tailSource = logTail.trim() ? "log" : undefined;
          }
          logUnavailable = logTail.trim() ? undefined : { kind: "empty-log" };
        } else if (readRegion) logTail = yield* step(() => readRegion(owner, repo, jobId, tailLines));
        else {
          const out = yield* step(() => fetch.fetchJobLog(owner, repo, jobId));
          const extracted = extractCiFailureRegion(out, tailLines);
          // W1-T2733: the region, PLUS any declared generator remedy the slice would have discarded.
          // Identical bytes to the region whenever the log names no recognised remedy.
          const verdict = gateVerdictRetention();
          for (const line of out.split("\n")) verdict.push(line.replace(ACTIONS_LOG_TIMESTAMP, ""));
          logTail = verdict.wrap(retainGeneratorRemediesForRegion(out, extracted));
        }
        if (runnerTimeoutLines !== undefined) {
          // The runner line stays beside the region so the timeout stays visible; an empty log keeps the annotations.
          logTail = logTail.trim() === "" ? runnerTimeoutLines : `${runnerTimeoutLines}\n${logTail}`;
          logUnavailable = undefined;
          tailSource = logTail === runnerTimeoutLines ? "annotations" : "log";
        } else if (finalizeAnnotation !== undefined) {
          // The region carries the same `##[error]` line after the test summary it now keeps (W1-T9932), so it
          // replaces the annotation rather than sitting beside it; an empty log keeps the annotation.
          if (logTail.trim() === "") logTail = finalizeAnnotation;
          logUnavailable = undefined;
          tailSource = logTail === finalizeAnnotation ? "annotations" : "log";
        } else if (annotations.length === 0) {
          logUnavailable = logTail.trim() === "" ? { kind: "empty-log" } : undefined;
          if (logUnavailable === undefined) tailSource = "log";
        }
      } catch (err) {
        let detail = "unknown error";
        try {
          const e = err as { code?: unknown; message?: unknown };
          const code = typeof e?.code === "string" && e.code ? `${e.code}: ` : "";
          const message = typeof e?.message === "string" && e.message ? e.message : String(err);
          detail = `${code}${message}`.slice(0, MAX_CI_LOG_FAILURE_DETAIL);
        } catch {
          /* keep the placeholder — a cause is still named, which is the whole point */
        }
        if (runnerTimeoutLines !== undefined) {
          // The log could not be read, but the runner's own timeout lines were: keep exactly what was read before.
          logTail = runnerTimeoutLines;
          logUnavailable = undefined;
          tailSource = "annotations";
        } else if (finalizeAnnotation !== undefined) {
          logTail = finalizeAnnotation;
          logUnavailable = undefined;
          tailSource = "annotations";
        } else if (annotations.some((a) => !a.from_passing_test)) {
          logTail = annotations.filter((a) => !a.from_passing_test).map((a) => a.message)
            .join("\n").split("\n").slice(-tailLines).join("\n");
          logUnavailable = undefined;
          tailSource = "annotations";
        } else {
          logUnavailable = { kind: "fetch-failed", detail };
          logTail = "";
          tailSource = undefined;
        }
      }
    }
    failures.push({
      name,
      logTail,
      conclusion: (c.state ?? c.conclusion ?? c.status ?? "").toUpperCase(),
      ...(c.completedAt ? { completedAt: c.completedAt } : {}),
      ...(jobId ? { jobId } : {}),
      ...(logUnavailable === undefined ? {} : { logUnavailable }),
      ...(tailSource ? { tailSource } : {}),
      ...(annotationFallback ? { annotationFallback } : {}),
      ...(annotations.length ? { annotations } : {}),
    });
  }
  // #2918: `ci-gate` is a downstream aggregator — see `withoutDownstreamGateFailure`'s own doc.
  // Applied HERE, at the single producer, so every consumer (the fix prompt, the escalation body,
  // `describeCiFailures`) sees the same narrowed list rather than each re-deriving it.
  return withoutDownstreamGateFailure(failures);
}

/**
 * W1-T1223 (design i) — the real gateway's producer for {@link OpenPrView.cancelledRequiredChecks},
 * mirroring how {@link fetchCiFailures} is the real gateway's producer for `ciFailures`: both name
 * off the SAME `cancelledRequiredCheckNames` predicate lib/sweep.ts owns, so this producer and
 * `checksStateFromRollup`'s red verdict can never drift into disagreeing about which check is
 * cancelled. `jobId` uses the SAME URL-or-external-id resolver `fetchCiFailures` reads —
 * best-effort, `undefined` when neither carries a job id, so
 * `requeueCheck`'s real wiring degrades to a named no-op rather than guessing a re-queue target.
 * Posted gates use `externalId` when GitHub rewrites their URL to /runs/<check-run-id>.
 *
 * W1-T2283 — `requiredContexts` is READ (still the one precondition — see
 * {@link cancelledRequiredCheckNames}'s own doc) but no longer narrows WHICH cancelled check gets
 * named: `ci-gate`, the ONE name branch protection on this repo actually declares required, is a
 * downstream aggregator that reports FAILURE — never CANCELLED — when a sibling it depends on
 * (`coverage-ratchet`, itself not a declared-required context) is cancelled. Narrowing to
 * `requiredContexts` before testing for CANCELLED therefore named nothing on both measured
 * incidents (#2794, #2841); this producer now agrees with {@link fetchCiFailures}, which already
 * reads CANCELLED off this same rollup with no such narrowing.
 */
export function cancelledRequiredChecks(
  rollup: RollupCheck[] | undefined,
  requiredContexts: string[] | undefined,
  headSha?: string,
): CancelledRequiredCheck[] {
  const names = new Set(cancelledRequiredCheckNames(rollup, requiredContexts));
  if (names.size === 0) return [];
  const deduped = dedupeRollupByLatestAttempt(rollup ?? []);
  return deduped
    .filter((c) => names.has(c.name ?? c.context ?? "unknown"))
    .map((c) => {
      const check: CancelledRequiredCheck = { name: c.name ?? c.context ?? "unknown", jobId: checkJobId(c) };
      const producer = c.detailsUrl?.match(/\/actions\/runs\/([1-9]\d*)\/job\/([1-9]\d*)(?:[/?#]|$)/);
      if (!headSha || !/^[a-f0-9]{40}$/.test(headSha) || c.headSha !== headSha || (c.status ?? "").toUpperCase() !== "COMPLETED" || !producer || producer[2] !== check.jobId) return check;
      const aliases = deduped.flatMap(posted => {
        const id = posted.externalId?.match(/^run:([1-9]\d*):([1-9]\d*):job:([1-9]\d*)$/);
        const name = posted.name ?? posted.context;
        if (!name || name === check.name || posted.headSha !== headSha || !id ||
            id[1] !== producer[1] || id[3] !== check.jobId || checkJobId(posted) !== check.jobId ||
            !Number.isSafeInteger(posted.checkRunId) || (posted.checkRunId ?? 0) <= 0 || !Number.isSafeInteger(Number(id[2])) ||
            (posted.conclusion ?? posted.state ?? "").toUpperCase() !== "FAILURE" ||
            (posted.status ?? "").toUpperCase() !== "COMPLETED" ||
            posted.outputSummary !== `W1-T4399: reported by this job's ${name} step(s) (outcome(s): cancelled)`) return [];
        return [{ name, attempt: Number(id[2]), checkRunId: posted.checkRunId! }];
      });
      if (aliases.length > 0 && new Set(aliases.map(a => a.attempt)).size === 1) {
        check.explainedFailures = aliases.map(({ name, checkRunId }) => ({ name, checkRunId }));
        check.runAttempt = aliases[0].attempt;
      }
      return check;
    });
}

/**
 * Is `prUrl` a plan-only filing PR, per the ONE positive signal `OpenPrView.isPlanFiling`'s
 * own doc (lib/sweep.ts) requires: a `pr.opened{plan_only:true}` ledger line the emitter
 * itself wrote for THIS pr_url — never inferred from an absent trailer (that would also
 * swallow a genuinely mis-trailered IMPLEMENTING PR) and never inferred from the diff
 * touching only `plan/**` (a hand-authored plan PR would misclassify). The retro/triage/
 * `rmd plan` filing flows all write this line right after their own deterministic
 * plan-only-diff guard passes (this file's `log("pr.opened", { pr_url, plan_only: true, ... })`
 * call sites) — a positive record from the ONE place that already verified the diff, not a
 * guess from this function.
 */
export function isPlanOnlyFilingPr(ledger: Array<Record<string, unknown>>, prUrl: string): boolean {
  return ledger.some((l) => l.step === "pr.opened" && l.pr_url === prUrl && l.plan_only === true);
}

export type PlanFilingClassificationSource = "emitter-ledger" | "github-files" | "unreadable" | "not-plan-only";

export interface PlanFilingClassification {
  isPlanFiling: boolean;
  source: PlanFilingClassificationSource;
}

export interface PlanFilingClassificationEvent {
  prNumber: number;
  headSha: string;
  source: PlanFilingClassificationSource;
}

export type ClassifiedOpenPrView = OpenPrView & { planFilingSource: PlanFilingClassificationSource };

/** Titles and branch names may nominate a read, but only the emitter record or material paths grant it. */
export function classifyPlanFiling(
  emitterLedger: boolean,
  files: PlanFilingFileObservation | undefined,
): PlanFilingClassification {
  if (emitterLedger) return { isPlanFiling: true, source: "emitter-ledger" };
  if (!files || files.state === "unreadable") return { isPlanFiling: false, source: "unreadable" };
  const isPlanOnly = files.paths.length > 0 && files.paths.every(isInPlanScope);
  const touchesEnforcementData = enforcementDataInDiff([...files.paths]).length > 0;
  return isPlanOnly && !touchesEnforcementData
    ? { isPlanFiling: true, source: "github-files" }
    : { isPlanFiling: false, source: "not-plan-only" };
}

function introducedTaskIdsFromPlanPaths(paths: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const path of paths) {
    const match = /^plan\/tasks\.d\/(W\d+-T\d+)-/.exec(path);
    if (match) ids.add(match[1]);
  }
  return [...ids].sort();
}

/**
 * Resolve the task identity shared by the direct review path and the open-PR board path.
 * An exact trailer wins; a positively identified plan-only filing is intentionally
 * unattributed; otherwise the fleet's task-bearing run branch is the safe fallback.
 */
export function resolveReviewTaskId(
  body: string,
  headRefName: string,
  planOnlyFiling: boolean,
): string | undefined {
  const fromTrailer = reviewTaskIdFromBody(body);
  if (fromTrailer) return fromTrailer;
  if (planOnlyFiling) return undefined;
  return taskIdFromRunBranch(headRefName);
}

/** Generated lanes have correlation ids, not filed task records; keep their bounded semantic review.
 *  A synthetic `PR-<n>` id (a hand-fix PR's trailer) names no shard either: it gets the defaults a trailerless PR
 *  gets, on any branch, so the trailer can never cost a review (#13305: refused on every pass for 4.5 h). */
export function usesUntaskedReviewMetadata(taskId: string | undefined, headRefName: string): boolean {
  if (taskId === undefined || taskId === UNFILED_RUN_SENTINEL || /^PR-[1-9]\d*$/.test(taskId)) return true;
  return taskIdFromRunBranch(headRefName) === taskId &&
    /^(?:RETRO(?:-.+)?|TRIAGE-.+|PLAN-.+|APPROVE-.+|main-repair-(?:(?:ratchet|revert)-)?[0-9a-f]{12})$/.test(taskId);
}

/**
 * Resolve a PR's task id (W1-T453): the `Remudero-Task:` trailer first, the `run-<taskId>-*` head ref only as
 * a fallback. The fallback is withheld for a plan-only filing (#1527), judged by the caller's own
 * {@link classifyPlanFiling} verdict (W1-T3505), so a filing never credits the task its run branch names.
 * Why: docs/forensics/tick-read-worker.md#resolveopenprtaskid
 */
function resolveOpenPrTaskId(pr: RawOpenPr, planOnlyFiling: boolean): string | undefined {
  return resolveReviewTaskId(pr.body ?? "", pr.headRefName, planOnlyFiling);
}

/**
 * MAY THIS ID ESTABLISH DUPLICATE-WORK OWNERSHIP? (W1-T3535)
 *
 * `unfiled` is a BRANCH-SHAPE SENTINEL, not a task. W1-T3388 made `run-unfiled-<epochMs>`
 * ({@link RUN_BRANCH_UNFILED_FORM}) the canonical head ref for an ad-hoc repair with no filed
 * task — `scripts/head-identity-gate.mjs` REFUSES a PR that does not use it — and
 * {@link resolveOpenPrTaskId} then recovers the literal `unfiled` from every such branch, because
 * `taskIdFromRunBranch`'s `namesATask` check (lib/status.ts) only rejects an id with a suffix
 * STAPLED ON and `unfiled` has none.
 *
 * So `buildOpenPrViews`'s supersession arithmetic grouped every ad-hoc PR in the repo under ONE
 * key and marked all but the highest-numbered `supersededBy`, and the sweep's `stale` row closed
 * them. OBSERVED TWICE: #5411 closed by #5412 (2026-09-13, this task's filing evidence) and again
 * on 2026-09-15, when #5632 — a `/v1/status` change sharing NOT ONE changed path — closed #5630
 * and #5631. The two gates contradicted each other: one mandates the name, the other punishes it.
 *
 * SCOPE IS DELIBERATELY ONE PREDICATE AT ONE CONCERN. `unfiled` stays a perfectly good REVIEW and
 * LEDGER attribution fallback — `resolveOpenPrTaskId` is untouched, `reviewLedgerKey` still reads
 * it, `criteriaRecoverable` is unchanged — because attributing a review to a branch is not the
 * same act as asserting two PRs are the same work. Only ownership is narrowed, and a real id from
 * a trailer or a `run-<taskId>-<epochMs>` branch still groups exactly as before.
 */
function isSupersessionOwnerTaskId(taskId: string | undefined): taskId is string {
  return taskId !== undefined && taskId !== UNFILED_RUN_SENTINEL;
}

/** Recover refusal metadata from a review's structured decision verdict. It is deliberately not
 * inferred from `reason`: that field is presentation prose, while this read needs a closed class
 * before the sweep may skip a strike. */
function refusalByClaimFromDecisionVerdict(value: unknown): Map<string, CriterionRefusal> {
  const refusals = new Map<string, CriterionRefusal>();
  if (value === null || typeof value !== "object") return refusals;
  const criteria = (value as { criteria?: unknown }).criteria;
  if (!Array.isArray(criteria)) return refusals;
  for (const entry of criteria) {
    if (entry === null || typeof entry !== "object") continue;
    const candidate = entry as { claim?: unknown; met?: unknown; refusal?: unknown };
    if (candidate.met === false && typeof candidate.claim === "string" && isCriterionRefusal(candidate.refusal)) {
      refusals.set(candidate.claim, candidate.refusal);
    }
  }
  return refusals;
}

/**
 * Recover the most recent failing review's unmet criteria from review.posted rows.
 * No PR-head checkout needed just to ROUTE the disposition — the fix rung itself
 * re-derives the authoritative verdict when it runs. Proof context comes from
 * that row's decision verdict; legacy missing execution outcomes stay unknown.
 */
export function unmetFromLedger(lines: Array<Record<string, unknown>>, taskId: string, prUrl?: string): CriterionVerdict[] {
  let claims: string[] = [];
  let reasons: string[] = [];
  let refusals = new Map<string, CriterionRefusal>();
  let proofContext = new Map<string, Partial<CriterionVerdict>>();
  for (const line of lines) {
    if (line.step !== "review.posted") continue;
    if (prUrl === undefined ? line.task_id !== taskId : !reviewRowNamesPr(line, taskId, prUrl)) continue;
    proofContext = new Map();
    if (line.state === "success") { claims = []; reasons = []; refusals = new Map(); continue; }
    if (Array.isArray(line.unmet_criteria)) claims = line.unmet_criteria.map(String);
    if (Array.isArray(line.reasons)) reasons = line.reasons.map(String);
    refusals = refusalByClaimFromDecisionVerdict(line.decision_verdict);
    const decision = line.decision_verdict as { criteria?: unknown } | null | undefined;
    if (Array.isArray(decision?.criteria)) {
      for (const entry of decision.criteria) {
        if (entry === null || typeof entry !== "object") continue;
        const criterion = entry as Partial<CriterionVerdict>;
        if (criterion.met === false && typeof criterion.claim === "string") proofContext.set(criterion.claim, criterion);
      }
    }
  }
  return claims.map((claim, i) => ({
    claim,
    proof: proofContext.get(claim)?.proof ?? "",
    met: false,
    reason: reasons[i] ?? "",
    // Legacy ledger rows can lack this required live-verdict field (W1-T5020).
    proof_exec: proofContext.get(claim)?.proof_exec as CriterionVerdict["proof_exec"],
    ...(typeof proofContext.get(claim)?.proofFailureOutput === "string"
      ? { proofFailureOutput: proofContext.get(claim)!.proofFailureOutput } : {}),
    refusal: refusals.get(claim),
  }));
}

/**
 * The failing review's own summary for THIS PR's CURRENT head — the `failure_reason` (`verdict.summary`)
 * the latest exact-head `review.posted` row carries, the text {@link OpenPrView.reviewSummary} promises.
 * Until this producer the field was hard-coded `undefined`, so `namesRule15Refusal`/`namesUnsatisfiableGate`
 * (lib/sweep.ts) could never see the reviewer's real reason. Same scan and PR matcher as
 * {@link unmetFromLedger}, but HEAD-SCOPED: a summary posted for an older head never describes this one.
 * The latest exact-head row wins, so a later success (or a row with no summary) yields `undefined`.
 */
export function reviewSummaryFromLedger(
  lines: ReadonlyArray<Record<string, unknown>>,
  key: string | undefined,
  prUrl: string,
  headSha: string,
): string | undefined {
  let summary: string | undefined;
  for (const line of lines) {
    if (line.step !== "review.posted" || line.head_sha !== headSha || !reviewRowNamesPr(line, key, prUrl)) continue;
    const verdict = line.decision_verdict as { summary?: unknown } | null | undefined;
    const text = typeof line.failure_reason === "string" ? line.failure_reason : verdict?.summary;
    summary = line.state === "failure" && typeof text === "string" && text !== "" ? text : undefined;
  }
  return summary;
}

/**
 * W1-T923: a failing review's named remedy, read from the ledger's structured `reasons` (never the prose
 * `failure_reason`, never `failure_class`). One reason is copied through verbatim; two or more name a choice and
 * are excluded; none yields `[]`. The single-form decision is {@link actionableGateFailuresFromReasons}.
 * Why: docs/forensics/tick-read-worker.md#actionablegatefailuresfromledger
 */
function actionableGateFailuresFromLedger(lines: Array<Record<string, unknown>>, key: string, prUrl?: string): ActionableGateFailure[] {
  let unmetCount = 0;
  let reasons: string[] = [];
  for (const line of lines) {
    if (line.step !== "review.posted") continue;
    if (prUrl === undefined ? line.task_id !== key : !reviewRowNamesPr(line, key, prUrl)) continue;
    if (line.state === "success") { unmetCount = 0; reasons = []; continue; }
    unmetCount = Array.isArray(line.unmet_criteria) ? line.unmet_criteria.length : 0;
    reasons = Array.isArray(line.reasons) ? line.reasons.map(String) : [];
  }
  if (unmetCount > 0) return [];
  return actionableGateFailuresFromReasons(reasons);
}

function instrumentEntanglementFromLedger(
  lines: Array<Record<string, unknown>>,
  key: string,
  prUrl: string,
  headSha: string,
  inputDigest: string,
): InstrumentEntanglementPaths | undefined {
  let result: InstrumentEntanglementPaths | undefined;
  for (const line of lines) {
    if (
      line.step !== "review.posted" ||
      !reviewRowNamesPr(line, key, prUrl) ||
      line.head_sha !== headSha ||
      line.review_input_digest !== inputDigest
    ) {
      continue;
    }
    result = undefined;
    if (line.state !== "failure" || line.failure_class !== "instrument_entangled") continue;
    const verdict = line.decision_verdict;
    if (verdict === null || typeof verdict !== "object") continue;
    const structured = verdict as { instrumentEntangled?: unknown; instrumentEntanglementPaths?: unknown };
    if (
      structured.instrumentEntangled !== true ||
      !usableInstrumentEntanglementPaths(structured.instrumentEntanglementPaths)
    ) {
      continue;
    }
    result = {
      instrumentPaths: [...structured.instrumentEntanglementPaths.instrumentPaths],
      srcPaths: [...structured.instrumentEntanglementPaths.srcPaths],
    };
  }
  return result;
}

/** W1-T3309 — the last Rule-25 refusal for THIS PR that reached the prerequisite-worker arm.
 *
 * The row is intentionally NOT scoped to `head_sha`: an author can push a new head that leaves the
 * same instrument/src entanglement intact, and that is still an ineffective repeat. `pr_url`
 * keeps the history from a different PR for the same task out. A malformed newer row clears an
 * older value rather than letting a partial ledger record authorize an escalation. */
function previousInstrumentEntanglementFromLedger(
  lines: Array<Record<string, unknown>>,
  key: string,
  prUrl: string,
): InstrumentEntanglementPaths | undefined {
  let result: InstrumentEntanglementPaths | undefined;
  for (const line of lines) {
    if (line.step !== "fix.instrument_entangled" || !reviewRowNamesPr(line, key, prUrl)) continue;
    result = undefined;
    const candidate = { instrumentPaths: line.instrument_paths, srcPaths: line.src_paths };
    if (!usableInstrumentEntanglementPaths(candidate)) continue;
    result = {
      instrumentPaths: [...candidate.instrumentPaths],
      srcPaths: [...candidate.srcPaths],
    };
  }
  return result;
}

/**
 * Fix strikes already attempted for a PR. W1-T78 fixed the cold-dispatch `log` wrapper (`buildSweepEffects`'s
 * `dispatchFix`) to stamp the REAL `task.id` on every `fix.dispatch`/`fix.review`
 * line it writes — before that fix, a cold dispatch's lines carried the OUTER
 * caller's synthetic id ("SWEEP"/"FIX"/"DAEMON"), so this function used to fall
 * back to counting `sweep.disposed{disposition:"blocked-fixable",acted:true}`
 * lines by `pr_number` as a PROXY (one such line ⇒ one dispatchFix CALL, which
 * internally runs up to `strikeCap` strikes before returning). That proxy is
 * REMOVED now that the root cause is fixed: `fix.dispatch` lines are reliably
 * task-tagged for every caller, so counting BOTH would double-count every real
 * strike (N `fix.dispatch` lines + 1 proxy line per dispatchFix call) and could
 * starve an answered PR of its one legitimate extra strike (W1-T78's
 * `strikeCapForAnswer` ceiling check). W1-T2788 makes that count head-generational through
 * {@link fixLedgerRowsForHead}: a changed PR head re-earns the configured allowance while an
 * unchanged head remains bounded.
 */
/**
 * The regime the CURRENT verdict for a task was produced under (W1-T199) — read
 * from the most recent `review.posted` ledger line's `proof_exec`.
 *
 * This is what decides whether keyword-era strikes are amnestied: the amnesty
 * applies only when the verdict the rung would act on NOW is itself evidence.
 * A task still being judged by keyword overlap gets no amnesty, because there is
 * nothing better to spend the next strike against.
 */
export function currentStrikeRegimeFor(lines: Array<Record<string, unknown>>, taskId: string | undefined): StrikeRegime {
  if (!taskId) return "keyword_only";
  let latest: Record<string, unknown> | undefined;
  for (const line of lines) {
    if (line.step === "review.posted" && line.task_id === taskId) latest = line;
  }
  const pe = latest?.proof_exec;
  if (!Array.isArray(pe)) return "keyword_only";
  return pe.some((x) => x !== "not_executable") ? "executed" : "keyword_only";
}

/**
 * The verdict regime a fix-rung strike was spent against (W1-T199).
 *
 * `"executed"` — the floor RAN at least one proof, so the unmet criteria the
 * strike was dispatched against are EVIDENCE.
 * `"keyword_only"` — no proof executed, so the strike was spent against keyword
 * overlap. Historical `fix.dispatch` lines carry no tag at all and are read as
 * this, because every one of them predates the executor.
 */
export type StrikeRegime = "executed" | "keyword_only";

/**
 * Strikes that COUNT toward the cap, for a task, under `currentRegime` (W1-T199).
 *
 * WHY THIS IS NOT A PLAIN COUNT. `fix.dispatch` lines are append-only and
 * monotonic, so a strike spent months ago against a keyword-only verdict gated
 * the rung forever — including after the executor shipped and the SAME rung had
 * demonstrably converged on executed evidence (PR #457: executed_fail → fix
 * worker → executed_pass ×3 → merged, while #449/#452 were refused at 2/2 with
 * executed_fail verdicts of their own).
 *
 * Under the `"executed"` regime, keyword-only strikes are NOT counted: they were
 * spent against noise and say nothing about whether the rung would converge on
 * evidence. Under `"keyword_only"` every strike counts, because there is no
 * better signal to distinguish them and the bound must not silently vanish.
 *
 * THE BOUND STAYS REAL either way — strikes spent under the CURRENT regime always
 * count, so a task genuinely failing against executed evidence still exhausts.
 * This never mutates the ledger: it changes how strikes are READ.
 */
export function priorStrikesFor(
  lines: Array<Record<string, unknown>>,
  taskId: string | undefined,
  currentRegime: StrikeRegime = "keyword_only",
  currentHeadSha?: string,
): number {
  return fixRoundTally(lines, taskId, currentHeadSha, currentRegime).strikes;
}

/**
 * W1-T78: what each fix-rung strike TRIED for a task and current PR head, ledger ground truth
 * ONLY (never inferred) — the clarification-question rung's "what the fix
 * worker tried per strike" input. `fix.dispatch` opens a strike (round +
 * unmet count going IN); `fix.review` (only reached once CI is green) records
 * its outcome. A strike with no matching `fix.review` line simply never
 * reached a review (e.g. `fix.ci_not_green` — CI never went green). W1-T2788 selects the same
 * head generation as the cap before pairing rows, so repeated strike numbers from older heads
 * cannot leak into a current clarification.
 */
export function deriveStrikeHistory(
  lines: Array<Record<string, unknown>>,
  taskId: string | undefined,
  currentHeadSha?: string,
): StrikeAttempt[] {
  if (!taskId) return [];
  const byStrike = new Map<number, StrikeAttempt>();
  for (const line of fixLedgerRowsForHead(lines, taskId, currentHeadSha)) {
    const strike = typeof line.strike === "number" ? line.strike : undefined;
    if (strike === undefined) continue;
    if (line.step === "fix.dispatch") {
      const unmetClaims = Array.isArray(line.unmet_claims) && line.unmet_claims.every((claim) => typeof claim === "string")
        ? line.unmet_claims.map((claim) => String(claim))
        : undefined;
      byStrike.set(strike, {
        strike,
        round: line.round === "fresh" ? "fresh" : "resume",
        unmetCount: typeof line.unmet_count === "number" ? line.unmet_count : 0,
        ...(unmetClaims === undefined ? {} : { unmetClaims }),
        ciGreen: false,
      });
    } else if (line.step === "fix.review") {
      const existing = byStrike.get(strike);
      if (existing) {
        existing.ciGreen = true; // fix.review only ever runs once CI is green
        existing.reviewState = line.state === "success" ? "success" : "failure";
      }
    }
  }
  return [...byStrike.values()].sort((a, b) => a.strike - b.strike);
}

/**
 * `plan/questions.ndjson` (worker.ts's `appendQuestion`/`appendQuestionAnswer`), read fresh for
 * {@link operatorVerdictEvidence}'s answered-clarification half — a LOCAL file, never GitHub
 * (W1-T435: "no GitHub read anywhere"). Best-effort, mirroring `readLedgerLines`' own tolerance
 * of an absent/malformed file: a fresh checkout with no questions yet, or a torn line from a
 * concurrent write, degrades to skipping that line rather than throwing the whole sweep pass.
 */
export function readQuestionsNdjson(root: string): Array<Record<string, unknown>> {
  const path = join(root, "plan", "questions.ndjson");
  if (!existsSync(path)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // torn/malformed line — skip it, never take out the whole read (same discipline as
      // readLedgerLines' own `torn` handling).
    }
  }
  return out;
}

const openPrViewPlans = new WeakMap<(root: string) => Plan, { path: string; identity: string; plan: Plan }>();

function openPrPlanIdentity(path: string): { kind: "readable"; identity: string } | { kind: "unreadable"; reason: string } {
  const identity = planFilesIdentity(path);
  if (identity.split("\n").some((line) => line === "-" || line.endsWith("=-"))) {
    return { kind: "unreadable", reason: "plan file metadata is unavailable" };
  }
  try {
    // W1-T6247: distinguish an unreadable listing from planFilesIdentity's empty-directory fallback.
    readdirSync(join(dirname(path), "tasks.d"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { kind: "unreadable", reason: String(err) };
  }
  return { kind: "readable", identity };
}

interface OpenPrViewReads {
  read: GhApiFetcher;
  dependencyIdentityRead?: GhApiFetcher;
  openPrRows: () => unknown;
  ciFailures: (owner: string, repo: string, rollup: RollupCheck[] | undefined) => CiFailure[] | Promise<CiFailure[]>;
  requiredContexts: (owner: string, repo: string) => RequiredContextsRead | Promise<RequiredContextsRead>;
}

export function* openPrViewSteps(
  owner: string,
  repo: string,
  ledgerPath: string,
  // APPENDED LAST, both defaulted, so none of the three positional call sites shift. Injectable
  // because the merge-state wiring below is otherwise unreachable in a test — every existing
  // sweep test builds `OpenPrView` fixtures by hand and so never exercises this function at all.
  deps: {
    openPrRows?: OpenPrRest[];
    fetch?: GhApiFetcher;
    requiredContexts?: (owner: string, repo: string) => string[] | undefined;
    /**
     * PACES this function's enumeration call against the daemon's OTHER two burst call sites —
     * lib/status.ts's board-gateway PR list and issue list (W1-T468). OPTIONAL and omitted by
     * every existing caller/fixture: absent ⇒ the enumeration fires with no gap, exactly the
     * pre-W1-T468 behavior. `buildSweepHook`'s real (non-test) wiring is the only caller that
     * threads one through, sharing the SAME instance `buildBatchedGithub` is given there.
     */
    pacer?: GhCallPacer;
    /** Injectable seams for the checked-in ci-gate contract and its already-fetched red evidence. */
    readCiGateRequired?: (root: string) => string[];
    fetchCiFailureEvidence?: typeof fetchCiFailures;
    /** Local-only owner probe; never performs a GitHub read. */
    assessPendingOwner?: (record: PendingReviewStatusRecord) => PendingReviewOwnerAssessment;
    /** Process-lifetime complete-read cache; the daemon owns one for all of its poll passes. */
    planFilingFileCache?: PlanFilingFileCache;
    /** Primary per-pass miss bound. Production reuses the existing cheap-lane admission bound. */
    planFilingFileMissCap?: number;
    /** Bounded classification telemetry; production de-duplicates unchanged head/source pairs. */
    onPlanFilingClassification?: (event: PlanFilingClassificationEvent) => void;
    /** W1-T3283 — the main-plan read that branch-derived trailer repair depends on. Injectable for
     *  the same reason `readCiGateRequired` above is: `repoRoot` is a MODULE-level import, not a
     *  parameter, so without a seam no test can reach the unreadable-plan arm below — the checkout
     *  a test runs in always has a readable plan. Omitted, it is `loadPlan` on the real path. */
    readMainPlan?: (root: string) => Plan;
    /** Plan-file location for identity checks and the default loader; omitted uses the checkout. */
    mainPlanPath?: string;
    /** W1-T3585 — the SAME freshly-derived merged-task set daemon dispatch consults (the daemon's
     *  own `refreshMerged()` projection, never a second GitHub walk this producer invents), threaded
     *  through so {@link currentPlanIneligibilityReason} can resolve an unmet dependency exactly as
     *  drain.ts's `isDispatchEligible` would. Omitted ⇒ `planResequenceIneligible` stays `undefined`
     *  for every PR — fail closed, exactly today's behavior for every existing caller/fixture. */
    isMerged?: MergedResolver;
  } = {},
  io: OpenPrViewReads,
): Steps<ClassifiedOpenPrView[]> {
  const fetch = io.read;
  const assessPendingOwner =
    deps.assessPendingOwner ??
    ((record: PendingReviewStatusRecord) => assessPendingReviewOwner(record, { isPidAlive: defaultIsPidAlive }));
  const raw = (deps.openPrRows ?? (yield* step(io.openPrRows))) as RawOpenPr[];
  const ledger = readLedgerLines(ledgerPath);
  // W1-T435: the SAME evidence pass that quotes an operator's steering note also produces
  // `pendingAnswer` from an answered clarification — a local file read, never GitHub.
  const questionLines = readQuestionsNdjson(repoRoot);
  // W1-T103: branch protection's OWN required-contexts list, read ONCE per
  // repo for this whole sweep pass (never per-PR, never hardcoded) — see
  // checksStateFromRollup's doc for why this must gate checksState instead of
  // every reported check.
  // W1-T2399: the CLASSIFIED read, so a failure keeps its reason all the way to the escalation.
  // `deps.requiredContexts` (the injectable used by every existing fixture) still answers the old
  // `string[] | undefined` shape and is wrapped back into the classified one, so no fixture moves;
  // only the real, unwrapped path can produce an `unreadable` cause, which is the only path that
  // ever had one to lose.
  const requiredRead: RequiredContextsRead = deps.requiredContexts
    ? ((r) => (r && r.length > 0 ? ({ kind: "contexts", contexts: r } as const) : ({ kind: "none" } as const)))(
        deps.requiredContexts(owner, repo),
      )
    : yield* step(() => io.requiredContexts(owner, repo));
  const requiredContexts = requiredRead.kind === "contexts" ? requiredRead.contexts : undefined;
  // W1-T2399: the read failure's own cause, hoisted so the view below can assign the key
  // unconditionally — see that assignment's own comment for why the conditional-spread form could
  // not be used. `undefined` for every read that succeeded, which is every existing fixture.
  const requiredContextsReadFailure =
    requiredRead.kind === "unreadable" ? { branch: requiredRead.branch, reason: requiredRead.reason } : undefined;
  // W1-T2599: one checked-out contract read per board build, never one filesystem or API read per PR.
  const ciGateRequired = deps.readCiGateRequired
    ? deps.readCiGateRequired(repoRoot)
    : readCiGateRequiredChecks(repoRoot);
  let mainPlan: Plan | undefined;
  const mainPlanPath = deps.mainPlanPath ?? join(repoRoot, "plan", "tasks.yaml");
  const planReader = deps.readMainPlan ?? loadPlan;
  try {
    const observation = openPrPlanIdentity(mainPlanPath);
    const identity = observation.kind === "readable" ? observation.identity : undefined;
    const held = openPrViewPlans.get(planReader);
    if (identity !== undefined && held?.path === mainPlanPath && held.identity === identity) {
      mainPlan = held.plan;
    } else {
      openPrViewPlans.delete(planReader);
      mainPlan = deps.readMainPlan ? deps.readMainPlan(repoRoot) : loadPlan(mainPlanPath);
      if (identity !== undefined) openPrViewPlans.set(planReader, { path: mainPlanPath, identity, plan: mainPlan });
    }
  } catch {
    // An unreadable local plan only disables branch-derived trailer repair for this pass.
    mainPlan = undefined;
  }

  // W1-T2864: the local emitter receipt is still the zero-request positive answer. Only PRs
  // without it enter the bounded REST hydrator; complete reads are cached by exact head.
  const emitterPlanFilings = new Map(raw.map((pr) => [pr.number, isPlanOnlyFilingPr(ledger, pr.url)]));
  const planFilingFileCache = deps.planFilingFileCache ?? createPlanFilingFileCache();
  const planFilingFiles = yield* hydratePlanFilingFilesSteps(
    owner,
    repo,
    raw
      .filter((pr) => emitterPlanFilings.get(pr.number) !== true)
      .map((pr) => ({
        number: pr.number, headRefOid: pr.headRefOid, nominated: resolveOpenPrTaskId(pr, false) === undefined,
      })),
    fetch,
    planFilingFileCache,
    { missCap: deps.planFilingFileMissCap ?? DEFAULT_SWEEP_POLICY.planFilingAdmissionBound },
  );
  const dependencyMainIdentities = yield* hydrateDependencyMainIdentitiesSteps(
    owner, repo, raw, planFilingFiles, io.dependencyIdentityRead ?? fetch, planFilingFileCache,
  );
  const planFilingClassifications = new Map<number, PlanFilingClassification>();
  for (const pr of raw) {
    const classification = classifyPlanFiling(emitterPlanFilings.get(pr.number) === true, planFilingFiles.get(pr.number));
    planFilingClassifications.set(pr.number, classification);
    deps.onPlanFilingClassification?.({ prNumber: pr.number, headSha: pr.headRefOid, source: classification.source });
  }

  // MERGE STATE: one bounded follow-up fetch per PR, because the LIST endpoint omits
  // `mergeable_state` (see hydrateMergeStates' doc for the live verification and the incident).
  // Scoped to the PRs this pass will actually disposition — measured median 1, p95 6, max 23 over
  // 5,735 sweeps — and hard-capped, so the pathological case cannot run away. Best-effort by
  // construction: an exhausted budget yields an empty map and every PR keeps the `undefined` it
  // has carried since the REST migration, i.e. exactly today's behaviour.
  const mergeStateObservations = yield* hydrateMergeStateObservationsSteps(
    owner,
    repo,
    raw.map((p) => p.number),
    fetch,
  );
  const mergeStates = new Map(
    [...mergeStateObservations]
      .filter(([, observation]) => observation.state !== undefined)
      .map(([number, observation]) => [number, observation.state!] as const),
  );

  // CONFLICT EVIDENCE (W1-T984 — the `mergeConflict` half of the row directly above's own
  // "third instance of the single-PR-only field class" header): a SECOND bounded follow-up fetch,
  // scoped to the PRs the FIRST one just confirmed `mergeState === "dirty"` — never the whole
  // `raw` list, so a healthy sweep pays nothing extra. "main" is this repo's one merge target,
  // the same literal `ghPrCreateFillCommand`'s own `--base` argv already hardcodes.
  const dirtyPrs = raw.filter((p) => mergeStates.get(p.number) === "dirty").map((p) => ({ number: p.number, headRefOid: p.headRefOid }));
  const mergeConflictGaps = new Map<number, string>();
  const mergeConflicts = yield* hydrateMergeConflictEvidenceSteps(owner, repo, "main", dirtyPrs, fetch, undefined, mergeConflictGaps);

    // WORKFLOW RUNS (W1-T2340 — the producer `OpenPrView.workflowRuns` has lacked since it was
    // declared): a THIRD bounded follow-up fetch, scoped the same way the conflict-evidence one
    // directly above is. Only heads whose `checksState` reads `pending` are fetched — that is
    // exactly the population `stalledRunReason` exists for, since a stalled head is one this
    // sweep would otherwise wait on forever, and a green or red head pays nothing. Within a PR,
    // `fetchWorkflowRunObservations` fetches jobs only for runs that have ALREADY concluded,
    // because a run still going cannot satisfy the predicate's first clause — so a pending PR
    // whose runs are all in flight costs one call, and only a genuinely stalled head costs more.
    // Nothing here loops or waits: one read per pass, on a population that is usually empty.
    const pendingPrs = raw
      .filter((p) => checksStateFromRollup(p.statusCheckRollup, requiredContexts) === "pending")
      .map((p) => ({ number: p.number, headRefOid: p.headRefOid }));
    const workflowRuns = yield* hydrateWorkflowRunsSteps(owner, repo, pendingPrs, fetch);

  // supersededBy: the HIGHEST-numbered other open PR crediting the same task.
  const byTask = new Map<string, number[]>();
  for (const pr of raw) {
    // W1-T3505: the SAME already-computed classification the returned view stamps as
    // `isPlanFiling`/`planFilingSource` below — never `isPlanOnlyFilingPr` re-derived narrower,
    // which only sees the emitter-ledger receipt and misses a `github-files`-sourced filing.
    const t = resolveOpenPrTaskId(pr, planFilingClassifications.get(pr.number)?.isPlanFiling ?? false);
    // W1-T3535: the SENTINEL IS NOT AN OWNER — see isSupersessionOwnerTaskId. `!t` alone admitted
    // the literal `unfiled`, which every ad-hoc PR's conforming branch yields, so all of them
    // grouped together here and the highest-numbered one superseded the rest.
    if (!isSupersessionOwnerTaskId(t)) continue;
    (byTask.get(t) ?? byTask.set(t, []).get(t)!).push(pr.number);
  }

  // W1-T2384: the supersession producer's SCOPED SET — only PRs the arithmetic ALREADY flagged.
  // This mirrors `dirtyPrs` above (which `hydrateMergeConflictEvidence` takes) rather than
  // fetching per open PR: the population is exactly those with a higher-numbered peer crediting
  // the same task, measured at FIVE across a 7-day window in fb-repair-stale-2954 and three in its
  // successor. Two calls per flagged PR over a single-digit set, never N+1 over the board — the
  // unscoped shape that made W1-T2340's first attempt N+1 per PR.
  const supersededPrs: { number: number; supersededBy: number; taskId: string }[] = [];
  for (const pr of raw) {
    // W1-T3505: see the `byTask` loop above — the classified boolean, not the emitter-only one.
    const t = resolveOpenPrTaskId(pr, planFilingClassifications.get(pr.number)?.isPlanFiling ?? false);
    // W1-T3535: the same exclusion as the `byTask` loop, restated rather than inferred from the
    // map being empty — an unfiled PR must never reach `hydrateSupersessionVerdicts` either, and
    // a lookup that happened to miss is not the same statement as an id that cannot own.
    if (!isSupersessionOwnerTaskId(t)) continue;
    const peers = byTask.get(t) ?? [];
    const newest = peers.length ? Math.max(...peers) : pr.number;
    if (newest > pr.number) supersededPrs.push({ number: pr.number, supersededBy: newest, taskId: t });
  }
  const supersessionVerdicts = yield* hydrateSupersessionVerdictsSteps(owner, repo, supersededPrs, fetch, isInPlanScope);

  // W1-T3704 (completed here) — THE CURRENT SIDE OF THE REVIEW-REUSE COMPARISON, hydrated ONCE for a bounded set.
  //
  // SCOPED TO ALREADY-ORPHANED PRs, and the scoping is the cost argument, not an optimisation. A
  // compare per open PR per pass is exactly the fan-out GitHub's SECONDARY limit punishes — it
  // counts request CADENCE, not volume, so it trips while `rate_limit` still reads full. Only a PR
  // whose review was orphaned by a push can reach the `review-reused`/`discriminate-only` rows at
  // all, so only those are asked about. On a healthy board that set is empty and this costs zero
  // requests; `hydrateReviewReuseFacts` caps it either way.
  //
  // The orphan test is `reviewOrphansFor` — the SAME call the per-PR walk below makes for
  // `reviewOrphanedByPush`, over the SAME ledger already in hand, so this adds no read and cannot
  // disagree with the field the disposition rows gate on.
  const reviewOrphanedPrs = raw
    .filter((pr) => {
      const t = resolveOpenPrTaskId(pr, planFilingClassifications.get(pr.number)?.isPlanFiling ?? false);
      return reviewOrphansFor(ledger, reviewLedgerKeyFor(t, pr.number), pr.headRefOid, undefined, pr.url).orphanedByPush;
    })
    .map((pr) => ({ number: pr.number, headRefOid: pr.headRefOid }));
  const reviewReuseCurrent = yield* hydrateReviewReuseFactsSteps(
    owner, repo, "main", reviewOrphanedPrs, fetch, undefined,
    (prNumber, reason) => {
      const pr = raw.find((candidate) => candidate.number === prNumber)!;
      appendLedger(ledgerPath, {
        run_id: `sweep-review-reuse-${systemClock.now()}`, task_id: "SWEEP", lane: "sweep",
        step: "sweep.review_reuse_unreadable", pr_number: prNumber, pr_url: pr.url,
        head_sha: pr.headRefOid, reason,
      });
    },
  );
  const scannerBlockers = yield* hydrateScannerBlockerObservationsSteps(
    owner,
    repo,
    raw
      .filter((pr) =>
        isScannerBlockerCandidate({
          autoMergeArmed: pr.autoMergeRequest != null,
          isDraft: pr.isDraft,
          checksState: checksStateFromRollup(pr.statusCheckRollup, requiredContexts),
          reviewState: reviewStateFromRollup(pr.statusCheckRollup),
          mergeable: mergeStateObservations.get(pr.number)?.mergeable,
          mergeableState: mergeStateObservations.get(pr.number)?.mergeableState,
        }),
      )
      .map((pr) => ({ number: pr.number, headSha: pr.headRefOid, merge: mergeStateObservations.get(pr.number) })),
    fetch,
  );

  // W1-T5633: a head whose latest `CodeQL` check failed has its open high alerts read, unless its ledger
  // already holds a terminal code-scanning ruling for that head (a false positive, or a fix dispatched).
  // W1-T9731: so does a head whose newest arm the security policy refused on a new high alert.
  const codeqlHeadAlerts = yield* hydrateCodeqlHeadAlertsSteps(
    owner,
    repo,
    raw
      .filter((pr) => pr.isDraft !== true &&
        codeqlAlertsReadDue(ledger, pr.number, pr.headRefOid, codeqlCheckFailed(pr.statusCheckRollup)) &&
        !codeScanningHeadSettled(ledger, pr.number, pr.headRefOid))
      .map((pr) => ({ number: pr.number, headSha: pr.headRefOid })),
    fetch,
  );

  const ciFailuresByPr = new Map<number, CiFailure[] | undefined>();
  for (const pr of raw) {
    const redRequiredChecks = redQualityGateNames(pr.statusCheckRollup, ciGateRequired);
    const red = checksStateFromRollup(pr.statusCheckRollup, requiredContexts) === "red";
    if (!red && redRequiredChecks.length === 0) continue;
    const evidenceRollup = red ? pr.statusCheckRollup : earlyRedEvidenceRollup(pr.statusCheckRollup, redRequiredChecks);
    ciFailuresByPr.set(pr.number, yield* step(() => io.ciFailures(owner, repo, evidenceRollup)));
  }

  return raw.map((pr) => {
    const planFiling = planFilingClassifications.get(pr.number) ?? { isPlanFiling: false, source: "unreadable" as const };
    // W1-T3505: thread the SAME classification this view stamps below into task-identity
    // resolution, so a `github-files`-classified plan filing withholds its run-branch id exactly
    // like an emitter-ledger-classified one already does — see resolveOpenPrTaskId's own doc.
    const taskId = resolveOpenPrTaskId(pr, planFiling.isPlanFiling);
    const taskRecord = taskId ? mainPlan?.byId.get(taskId) : undefined;
    // W1-T3585 — fail-closed on EVERY input this needs: an exact trailer-owned `taskId` (above), a
    // readable current plan that resolves it (`taskRecord`/`mainPlan`), AND a freshly-derived
    // merged-task set (`deps.isMerged`). Any one absent leaves `planResequenceIneligible`
    // `undefined` — never inferred from `taskId`/`headRefName` alone. See
    // `currentPlanIneligibilityReason`'s own doc (lib/sweep.ts) for the reason it can return.
    // W1-T4633: the unmet ids ride along as data so the pass's fresh-credit re-check
    // (`projectMergedTaskCandidates`, lib/sweep.ts) can clear a dependency the ledger lags on.
    const resequence =
      mainPlan && taskRecord && deps.isMerged
        ? corroboratedIneligibility(mainPlan, taskRecord, deps.isMerged, (ids) =>
            ids.length === 0 ? new Set<string>() : readMergeCreditedTaskIds(ledgerPath, { candidates: ids }).credited,
          )
        : undefined;
    const planResequenceIneligible = resequence?.reason;
    const planResequenceUnmetDependencies =
      resequence && resequence.unmetDependencies.length > 0 ? resequence.unmetDependencies : undefined;
    const fileObservation = planFilingFiles.get(pr.number);
    const observedFiles = fileObservation?.state === "complete" ? fileObservation.paths : undefined;
    const reviewLedgerKey = reviewLedgerKeyFor(taskId, pr.number);
    // W1-T5866: the fix lane's rows for a run-unfiled PR are written under `PR-<n>` (fixRungTaskFor), so its strikes are READ there.
    const fixLedgerKey = taskId === undefined ? undefined : reviewLedgerKey;
    const inputDigest = reviewInputDigest(pr.headRefOid, pr.body ?? "");
    const peers = isSupersessionOwnerTaskId(taskId) ? (byTask.get(taskId) ?? []) : [];
    const newest = peers.length ? Math.max(...peers) : pr.number;
    const supersededBy = newest > pr.number ? newest : undefined;
    const reviewState = reviewStateFromRollup(pr.statusCheckRollup);
    // W1-T2299: the SAME rollup read `reviewState` above already scanned — no extra request. See
    // `OpenPrView.reviewVerdictPostedAt`'s own doc for the disposition row this feeds.
    const reviewVerdictPostedAt = reviewVerdictPostedAtFromRollup(pr.statusCheckRollup);
    const checksState = checksStateFromRollup(pr.statusCheckRollup, requiredContexts);
    const redRequiredChecks = redQualityGateNames(pr.statusCheckRollup, ciGateRequired);
    const ciFailures = ciFailuresByPr.get(pr.number);
    // Historical heads explain why a status is absent. The separate exact-input scan below owns
    // retry count/backoff, so prior heads and infrastructure refusals cannot spend its budget.
    const reviewOrphans = reviewOrphansFor(ledger, reviewLedgerKey, pr.headRefOid, undefined, pr.url);
    // W1-T3704 (completed here) — the REVIEWED side of the reuse comparison, off the SAME ledger already in hand.
    // `priorReviewVerdictFromLedger` takes the LAST `review.posted` row for this task, which for a
    // PR that IS orphaned is by definition a row at some earlier head — and `reviewedHeadSha`
    // carries that sha so the disposition's reason names the head the reused verdict judged,
    // rather than asserting a reuse no reader can audit.
    const priorReviewForReuse = priorReviewVerdictFromLedger(ledger, reviewLedgerKey, pr.url);
    const currentTaskNarrative = reviewTaskNarrative(taskRecord ?? {});
    const currentContractDigest = taskRecord?.acceptance?.length && currentTaskNarrative !== undefined
      ? reviewContractDigest({
          taskId: taskRecord.id,
          acceptance: taskRecord.acceptance,
          declaredFiles: taskRecord.files,
          risk: taskRecord.risk,
          budgetUsd: taskRecord.budget_usd,
          ...currentTaskNarrative,
        })
      : taskRecord
        ? undefined
        : bodyReviewContractDigest({
            reviewLedgerKey, body: pr.body ?? "",
            unfiled: usesUntaskedReviewMetadata(taskId, pr.headRefName),
            recordedDigest: priorReviewForReuse?.reviewContractDigest,
            semanticRisk: DEFAULT_RISK, semanticBudgetUsd: UNTASKED_REVIEW_BUDGET_USD,
          });
    const reviewAttempts = reviewAttemptsForInput(ledger, reviewLedgerKey, pr.url, pr.headRefOid, inputDigest);
    // Every task-id-less review is written under `PR-<n>` by reviewCommand/runReview, and the
    // escalation + synthetic fix-task paths use that exact identity too. W1-T456 originally
    // read it back only for positively marked plan filings. That left ordinary agent-authored
    // PRs blind to their own structured review evidence: PR #3559 carried four executed-fail
    // `unmet_criteria` values under `PR-3559`, yet the sweep manufactured `[]`, escalated
    // "criteria unrecoverable", and never dispatched the already-supported synthetic fix rung.
    // Read the identity the producer actually wrote for every PR; an absent row still returns
    // `[]`, and this does not invent a creditable plan task or widen `criteriaRecoverable`.
    const unmetKey = reviewLedgerKey;
    // W1-T913: the SAME synthetic `PR-<n>` fallback `reviewCommand`/`runReview` already key every
    // `review.pending_posted`/`review.posted` ledger line with (task.id there, `taskId ?? PR-<n>`
    // here) — never a second, independently-derived key. Only consulted when the LIVE rollup
    // itself reads "pending" (never speculatively), and only trusted when the ledger's own
    // `head_sha` still matches the CURRENT head — an older pending record surviving under a
    // superseded head must never be read as dating the head observed right now.
    const pendingRecord = reviewState === "pending" ? lastPendingReviewStatusFromLedger(ledger, unmetKey, pr.url) : undefined;
    const currentPendingRecord = pendingRecord?.headSha === pr.headRefOid ? pendingRecord : undefined;
    const reviewPendingSince = currentPendingRecord?.postedAt;
    const reviewPendingOwnerDead =
      currentPendingRecord && assessPendingOwner(currentPendingRecord) === "dead" ? true : undefined;
    // W1-T923 (design note ii): the SAME synthetic `PR-<n>` fallback {@link escalationTaskIdFor}
    // already mints, but WITH NO `isPlanOnlyFilingPr` restriction — that restriction is what
    // confines `filingUnmetKey` above to plan filings, and #1991 (the motivating case) is a
    // `DECISIONS.md` PR, not a filing. This widens WHERE a gate failure's remedy can be READ
    // FROM; it does not touch `unmetKey`/`criteriaRecoverable` or what either means.
    const gateFailureKey = reviewLedgerKey;
    const instrumentEntanglement = reviewState === "failure"
      ? instrumentEntanglementFromLedger(ledger, reviewLedgerKey, pr.url, pr.headRefOid, inputDigest)
      : undefined;
    const previousInstrumentEntanglement = reviewState === "failure"
      ? previousInstrumentEntanglementFromLedger(ledger, reviewLedgerKey, pr.url)
      : undefined;
    return {
      prNumber: pr.number,
      prUrl: pr.url,
      taskId,
      reviewState,
      reviewPendingSince,
      reviewPendingOwnerDead,
      reviewVerdictPostedAt,
      checksState,
      // W1-T4054: the pending check's own start, so a push, comment or label never resets the age.
      checksPendingSince: checksPendingSinceFromRollup(pr.statusCheckRollup, requiredContexts,
        { headSha: pr.headRefOid, workflowRuns: workflowRuns.get(pr.number) }),
      unmetCriteria: reviewState === "failure" ? unmetFromLedger(ledger, unmetKey, pr.url) : [],
      // W1-T440: whether a `Remudero-Task:` trailer resolved a task id AT ALL — i.e. whether
      // `unmetCriteria` above is attributable to a plan task. The synthetic key can populate it
      // for a task-id-less PR too, but that does not make the PR creditable to a plan task; this
      // stays `false` for that population on purpose.
      criteriaRecoverable: taskId !== undefined,
      // W1-T2439 (half one) — THE PRODUCER `isPlanFiling` HAS BEEN WAITING FOR. Its declaration
      // (lib/sweep.ts) shipped the mechanism end-to-end and said so in its own SCOPE note:
      // "`run-task.ts`'s `buildOpenPrViews` does not populate it yet. Until that producer wiring
      // lands, this is always `undefined` in the real gateway". This is that wiring, and the
      // predicate is NOT re-derived here — `isPlanOnlyFilingPr` (above) already implements the ONE
      // positive signal that doc requires: a `pr.opened{plan_only:true}` line the emitter itself
      // wrote for THIS pr_url, never an absent trailer and never a plan/**-only diff.
      //
      // ASSIGNED UNCONDITIONALLY, WITH THE CONDITION IN THE VALUE — never `...(cond ? {k} : {})`.
      // `producerAssignedKeys` (lib/producer-completeness.ts) walks this literal's TOP-LEVEL KEYS
      // and pushes any SPREAD onto `unresolvableSpreads`; that is deliberate and has its own
      // passing test, which is exactly what made #3127 read as unwired after a conditional spread.
      // A plain key whose value is a call is what the census recognises.
      isPlanFiling: planFiling.isPlanFiling,
      planFilingSource: planFiling.source,
      taskRetirement: taskRecord?.retirement,
      planResequenceIneligible,
      planResequenceUnmetDependencies,
      planResequenceHeld: undefined,
      // W1-T923: a SIBLING read, off the SAME `review.posted` ledger line `unmetCriteria` above
      // already scans — see `actionableGateFailuresFromLedger`'s own doc for why it is keyed
      // differently (no `isPlanOnlyFilingPr` gate) and why it never parses `failure_reason`.
      actionableGateFailures: reviewState === "failure" ? actionableGateFailuresFromLedger(ledger, gateFailureKey, pr.url) : [],
      instrumentEntangled: instrumentEntanglement === undefined ? undefined : true,
      instrumentEntanglementPaths: instrumentEntanglement,
      previousInstrumentEntanglementPaths: previousInstrumentEntanglement,
      priorStrikes: priorStrikesFor(ledger, fixLedgerKey, currentStrikeRegimeFor(ledger, fixLedgerKey), pr.headRefOid),
      repeatedFixRefusal: fixRoundTally(ledger, fixLedgerKey, pr.headRefOid).repeatedRefusal,
      fixRefusalsAtHead: fixRoundTally(ledger, fixLedgerKey, pr.headRefOid).refusals.length,
      // W1-T7096: initialized at the canonical OpenPrView producer, then populated only by
      // runSweep after its progress judge rules on the exact exhausted head.
      progressEscalation: undefined,
      strikeHistory: deriveStrikeHistory(ledger, fixLedgerKey, pr.headRefOid),
      supersededBy,
      // W1-T2794 — DECLARED HERE, STAMPED LATER, and the two are not the same thing. The real
      // writer is `projectMergedTaskCandidates` (lib/sweep.ts), which runs AFTER this producer
      // because it needs the credit-candidate set this function has no access to; that ordering
      // IS the fix, so it cannot be collapsed into this literal. The value is `undefined` because
      // this producer genuinely cannot know it — and per OpenPrView.taskMergedBy's own doc, ABSENT
      // MEANS UNKNOWN, NEVER "NOT MERGED", so the default is also the safe one.
      //
      // Assigned rather than omitted for the reason the comment above `isPlanFiling` already
      // states: `producerAssignedKeys` (lib/producer-completeness.ts) recognises a producer only by
      // its TOP-LEVEL KEYS, so a field written solely through a `{ ...pr, k }` transformer reads
      // UNWIRED — #3127 hit the same wall from the conditional-spread side. This key is what makes
      // the census's answer match the truth; it is NOT the guard on the projection itself, which
      // is covered by test/merged-task-open-pr-supersession.test.ts's neutering arm.
      taskMergedBy: undefined,
      lastActivityAt: pr.updatedAt,
      // W1-T1201: the age clamp's other half — see `RawOpenPr.createdAt`'s own doc for why this
      // is `undefined` in the real gateway today (no producer in lib/open-prs-rest.ts yet) and
      // OpenPrView.createdAt's doc (lib/sweep.ts) for the fail-toward-unclamped default that
      // makes carrying it through unconditionally here safe either way.
      createdAt: pr.createdAt,
      headSha: pr.headRefOid,
      autoMergeArmed: pr.autoMergeRequest != null,
      // W1-T54 routing: Dependabot PRs go to the dep-review lane, never the
      // fix/clarification rungs — branch prefix is Dependabot's own contract.
      isDependabot: (pr.headRefName ?? "").startsWith("dependabot/"),
      // The ABSENT-check-suite remedy pushes an empty commit to THIS branch. Already fetched
      // for isDependabot above — carried through rather than re-queried.
      headRefName: pr.headRefName,
      body: pr.body,
      taskExistsOnMain: taskId === undefined ? undefined : taskRecord !== undefined,
      introducedTaskIds: observedFiles === undefined ? undefined : introducedTaskIdsFromPlanPaths(observedFiles),
      changedFiles: observedFiles,
      dependencyMainIdentity: dependencyMainIdentities.get(pr.number),
      taskDeclaredFiles: taskRecord?.files,
      // W1-T528: the operator's hold, straight off the SAME list row the enumeration already
      // fetched — no extra request, because `draft` rides on GitHub's `pull-request-simple`
      // schema. This is the producer `test/producer-completeness.test.ts` demands; without it
      // `selectUpdateBranchTarget`'s draft exclusion would be permanently inert in production.
      isDraft: pr.isDraft,
      reviewSummary: reviewState === "failure" ? reviewSummaryFromLedger(ledger, reviewLedgerKey, pr.url, pr.headRefOid) : undefined,
      // W1-T100/W1-T2599: ci-log fix evidence for the ordinary red aggregate, or for a red
      // REQUIRED child already visible while that aggregate is still pending.
      ciFailures,
      redRequiredChecks,
      pendingRequiredChecks: pendingQualityGateNames(pr.statusCheckRollup, ciGateRequired), // W1-T10067
      // W1-T1223 — the "absence of a verdict" observable, populated alongside `ciFailures`
      // above off the SAME rollup read (no extra request); see `cancelledRequiredChecks`'s own
      // doc.
      //
      // W1-T2283 — COMPUTED UNCONDITIONALLY, NEVER GATED ON `checksState === "red"`. While a
      // cancellation is fresh and the required aggregate (`ci-gate`) has not yet concluded, this
      // PR's `checksState` reads "pending" for up to ~10.5 measured minutes (#2794, #2841) before
      // it flips to "red" — gating this field on "red" made the observation `undefined` for that
      // whole window even though the SAME already-fetched rollup carried it the entire time. This
      // is a pure read of a rollup already in hand (no extra `gh` call either way, exactly like
      // `ciFailures` above), so there is no cost to carrying it rather than discarding it; whether
      // `runSweep` ACTS on a cancellation before the gate concludes red is a separate question
      // `isBlockedCi` still gates (lib/sweep.ts) — this only stops the data itself from being
      // thrown away while pending.
      cancelledRequiredChecks: cancelledRequiredChecks(pr.statusCheckRollup, requiredContexts, pr.headRefOid),
      // W1-T176: only meaningful in the zero-runs shape post-review routes on;
      // cheap to compute unconditionally rather than re-deriving checksState
      // green/reviewState none here just to gate the ledger scan.
      reviewPostRefused: reviewPostRefusedFor(ledger, reviewLedgerKey, pr.url, pr.headRefOid, inputDigest),
      // Historical-head reason plus exact-input retry facts, both from the ledger already held —
      // no extra request. Assigned inside this literal deliberately: PR #1083's
      // producer-completeness test anchors on an object literal assigning every required
      // OpenPrView field, so an assignment made anywhere else would still read as unwired.
      reviewOrphanedByPush: reviewOrphans.orphanedByPush,
      // W1-T3704 (completed here) — THE FIVE REVIEW-REUSE INPUTS, ASSIGNED HERE AS TOP-LEVEL KEYS. W1-T3704 shipped
      // `reviewReuseVerdict` and both disposition rows that call it, and NOTHING EVER PRODUCED ANY
      // OF THESE — the function's own comment said "Not yet populated by the real gateway", so its
      // five-way absence guard returned `full-review` on every call and every orphaned review was
      // re-derived from scratch. That is the "why does it want ANOTHER review?" #5941 hit.
      //
      // ASSIGNED DIRECTLY, NOT THROUGH A CONDITIONAL SPREAD, for the reason the `requiredContexts-
      // ReadFailure` comment below states at length: `producerAssignedKeys`
      // (lib/producer-completeness.ts) resolves an object literal's keys STATICALLY, so a field
      // written inside `...(cond ? {f} : {})` reads as having NO PRODUCER — which is the exact
      // census result these five fields have carried since they were declared.
      //
      // The `reviewed*` three come from the ledger line the review itself wrote; the `current*` two
      // from the bounded compare hydrated above. `undefined` on any of them is a FIRST-CLASS answer
      // meaning "unreadable", and `reviewReuseVerdict` refuses to reuse on it — absence degrades
      // toward a full re-review, never toward reusing a verdict on evidence nobody recorded.
      // CAPPED-ARM-ESCALATION — CAN THE VERDICT LEDGERED FOR THIS EXACT HEAD EVER ARM? Derived
      // from the SAME two ledger reads `decideSweepArm` makes, over the SAME lines already in hand
      // — no extra request, and no second opinion that could disagree with the arming path it
      // warns about. TERMINAL means capped, NOT plan-only, and no override recorded for this head.
      armRefusalIsTerminal: terminalArmRefusal(ledger, taskId && reviewLedgerKey, pr.headRefOid, pr.url),
      reviewedOwnDiffDigest: priorReviewForReuse?.ownDiffDigest,
      reviewedMergeBaseSha: priorReviewForReuse?.mergeBaseSha,
      reviewedHeadSha: priorReviewForReuse?.headSha,
      reviewedContractDigest: priorReviewForReuse?.reviewContractDigest,
      currentContractDigest,
      currentOwnDiffDigest: reviewReuseCurrent.get(pr.number)?.ownDiffDigest,
      currentMergeBaseSha: reviewReuseCurrent.get(pr.number)?.mergeBaseSha,
      priorReviewAttemptsForInput: reviewAttempts.attempts,
      reviewInputLoop: reviewInputLoopFacts(ledger, pr.url, pr.headRefOid, inputDigest, reviewLedgerKey),
      // Exact-input elapsed-time-backoff clock; see `reviewInputBackoffElapsed`.
      reviewInputLastAttemptAt: reviewAttempts.lastAttemptAt,
      reviewInputDigest: inputDigest,
      // W1-T176 (design boundary (ii)): `ghRequiredStatusCheckContexts` fails
      // SOFT to undefined/empty on an unreadable protection rule — that same
      // signal must gate the zero-runs discriminator OFF (never assume
      // permissive on missing information).
      // W1-T2399: UNCHANGED in what it decides — `none` and `unreadable` both still read true, so
      // every disposition row gated on this behaves exactly as before. What is new is the sibling
      // field below, which is populated ONLY for a genuine read failure.
      requiredContextsUnreadable: !requiredContexts || requiredContexts.length === 0,
      // ASSIGNED DIRECTLY, NOT THROUGH A CONDITIONAL SPREAD — and that is a wiring requirement, not
      // a style choice. `producerAssignedKeys` (lib/producer-completeness.ts) resolves an object
      // literal's keys STATICALLY, and its own test pins that "a spread inside a producer literal is
      // reported as unresolvable rather than silently ignored" — so `...(cond ? { field } : {})`
      // hides the assignment and `OpenPrView`'s completeness audit reads the field as having NO
      // PRODUCER. The key is therefore written unconditionally and the CONDITION moved into the
      // value (`requiredContextsReadFailure` above). Behaviour is unchanged: every consumer reads it
      // for truthiness (`sweep.ts`'s `const f = pr.requiredContextsReadFailure`), and `undefined` and
      // absent are indistinguishable to all of them — nothing does an `in`/`hasOwnProperty` check.
      requiredContextsReadFailure,
      // Absent from the map ⇒ GitHub had not computed it (or we could not ask) ⇒ undefined, the
      // pre-existing value. Only a DEFINITE observed "dirty" ever reaches the conflicted rows.
      mergeState: mergeStates.get(pr.number),
      // W1-T984: the mergeConflict producer — populated ONLY for a PR the line above just read
      // "dirty" (mergeConflicts was fetched for exactly that subset). Absent from the map ⇒ the
      // fetch was never attempted (not dirty) or failed best-effort ⇒ undefined, the pre-existing
      // value every PR has always carried — see lib/sweep.ts's DISPOSITION_RULES for how the
      // policy-gated `conflicted` row and the `blocked-ambiguous` row beneath it each read this.
      mergeConflict: mergeConflicts.get(pr.number),
      mergeConflictGap: mergeConflictGaps.get(pr.number),
      // W1-T3920: the normalized mergeState intentionally maps raw `blocked` to `clean`; retain
      // both raw fields so the stale-blocked refresh predicate is reachable in the real gateway.
      mergeable: mergeStateObservations.get(pr.number)?.mergeable,
      mergeableState: mergeStateObservations.get(pr.number)?.mergeableState,
      scannerBlocker: scannerBlockers.get(pr.number),
      codeqlHeadAlerts: codeqlHeadAlerts.get(pr.number),
      workflowRuns: workflowRuns.get(pr.number),
      // W1-T2384: the supersessionVerdict producer W1-T920 deferred and never filed — populated
      // ONLY for a PR `supersededBy` above just flagged (the hydration was scoped to exactly that
      // subset). Absent from the map ⇒ never attempted, or a best-effort read failed ⇒ undefined,
      // the pre-existing value every PR has always carried. BOTH policy flags that read this stay
      // OFF by default (`supersessionDisposalEnabled`, `conceptCoexistenceEnabled`), so no
      // disposition moves — see lib/sweep.ts's DISPOSITION_RULES.
      supersessionVerdict: supersessionVerdicts.get(pr.number),
      // W1-T435: `pendingAnswer`'s long-promised producer (see that field's own "SCOPE" doc,
      // lib/sweep.ts) — an operator's steering note on a `wrong`/`needs-follow-up` verdict, or an
      // answered clarification from the console, either re-arms the `blocked-fixable` disposition
      // row via the SAME strikeCapForAnswer ceiling that row has always checked.
      pendingAnswer: taskId ? operatorVerdictEvidence(taskId, ledger, questionLines) : undefined,
    };
  });
}

type OpenPrCiFailureRead = (owner: string, repo: string, rollup: RollupCheck[] | undefined) => Promise<CiFailure[]>;

export function fetchOpenPrsWithPostedIdsAsync(
  owner: string,
  repo: string,
  read: GhApiFetcher,
  pacer: GhCallPacer | undefined,
): Promise<OpenPrRest[]> {
  return paceGhEntryAsync(pacer, isGhRateLimitError, () => runStepsAsync(openPrsWithPostedIdsSteps(owner, repo, read)));
}

/** W1-T6591: {@link buildOpenPrViews} in ONE pass, every remote read awaited at its own step. */
export function buildOpenPrViewsAsync(
  owner: string,
  repo: string,
  ledgerPath: string,
  deps: Omit<NonNullable<Parameters<typeof openPrViewSteps>[3]>, "fetch"> & {
    fetchAsync?: GhApiFetcher;
    fetchCiFailureEvidenceAsync?: OpenPrCiFailureRead;
    readRequiredContextsAsync?: (owner: string, repo: string) => Promise<RequiredContextsRead>;
  } = {},
): Promise<ClassifiedOpenPrView[]> {
  const transport: GhApiFetcher = deps.fetchAsync ?? ((args, onRateLimit) => ghJsonAsync(args, undefined, onRateLimit));
  const read = transport;
  return runStepsAsync(openPrViewSteps(owner, repo, ledgerPath, deps, {
    read,
    dependencyIdentityRead: (args, onRateLimit) => paceGhEntryAsync(deps.pacer, isGhRateLimitError, async () => transport(args, onRateLimit)),
    openPrRows: () => fetchOpenPrsWithPostedIdsAsync(owner, repo, read, deps.pacer),
    ciFailures: deps.fetchCiFailureEvidence ?? deps.fetchCiFailureEvidenceAsync ?? fetchCiFailuresAsync,
    requiredContexts: deps.readRequiredContextsAsync ?? readRequiredStatusCheckContextsAsync,
  }));
}

/**
 * Build the credit-backfill rung's input (W1-T150, ratifies P30): one
 * {@link CreditCandidate} per task in `plan` whose merge state — derived via
 * the SAME `deriveStatus` ownership rule dispatch and calibration already
 * trust (P29(i)/W1-T149 sibling credit: ANY run of the task owning the merged,
 * trailer-anchored PR counts, not just the run the ledger happens to name) —
 * is currently MERGED on GitHub. Uses the BATCHED gateway (one `gh pr list`
 * for the whole repo, not one per task — the same O(N)-avoidance
 * `buildBatchedGithub`'s own doc motivates for the board) since this walks
 * every task in the plan on every sweep/daemon poll. Best-effort: a
 * plan-unavailable repo (already logged by the caller) simply yields plan.tasks
 * === [] here, never a hard failure of its own.
 */
type MergeLogReadOptions = {
  ref?: string;
  cache?: { mergedPathsByPr?: Map<number, string[]>; mergeSubjects?: Map<number, string> };
};

/**
 * W1-T3067 — every merge commit's CHANGED PATHS on `origin/main`, keyed by the PR number a squash
 * merge puts in `(#N)`. ONE local git invocation per pass. This is the producer the plan-only DIFF
 * refusal needs: a merged PR's merge commit is on `origin/main` by definition, so this answers for
 * exactly the population credit is derived over, and it answers for FREE.
 *
 * ⚠ WITHOUT THIS THE REFUSAL IS INERT. `DeriveDeps.mergedPathsByPr` defaults to absent, and absent
 * means the pre-W1-T3067 shortcut decides — which is what credited #3195, a `chore(plan)` on its
 * own run branch, and cost the validated build in #4461.
 *
 * ⚠ BEST-EFFORT, AND AN EMPTY MAP IS THE SAFE ANSWER: a failed or truncated read leaves every PR
 * without an entry, which restores exactly today's behaviour rather than refusing anything. A
 * transient git failure must never be able to uncredit the plan.
 *
 * `root: undefined` (W1-T3873) — {@link creditEvidenceRootFor} could not prove a checkout for the
 * requested `owner/repo`, so there is nothing local left to scan. Same empty-map answer as an
 * unreadable root, and for the same reason: absence must never manufacture a refusal, only decline
 * to grant one.
 */
export function readMergedPathsByPr(root: string | undefined, limit = MERGED_PATHS_SCAN_LIMIT, opts: MergeLogReadOptions = {}): Map<number, string[]> {
  const byPr = new Map<number, string[]>();
  if (root === undefined) return byPr;
  if (opts.cache?.mergedPathsByPr) return opts.cache.mergedPathsByPr;
  try {
    const out = execFileSync(
      "git",
      ["log", opts.ref ?? "origin/main", "--first-parent", "--name-only", "--format=%x00%s", "-n", String(limit)],
      { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 },
    );
    let current: number | undefined;
    for (const raw of out.split("\n")) {
      if (raw.startsWith("\u0000")) {
        const m = raw.slice(1).match(/\(#(\d+)\)\s*$/);
        current = m ? Number(m[1]) : undefined;
        if (current !== undefined && !byPr.has(current)) byPr.set(current, []);
        continue;
      }
      const path = raw.trim();
      if (!path || current === undefined) continue;
      const files = byPr.get(current);
      // FIRST commit wins per PR: `--first-parent` walks newest-first, and a PR number appearing
      // twice means a re-merge, whose newest paths are the ones credit was derived from.
      if (files && files.length < MERGED_PATHS_PER_PR_CAP) files.push(path);
    }
    if (opts.cache) {
      opts.cache.mergedPathsByPr = byPr;
      if (mergeLogEvidenceByRoot.get(root) === opts.cache) mergeLogEvidenceByRoot.set(root, mergeLogEvidenceByRoot.get(root)!);
    }
  } catch {
    /* best-effort: an unreadable log yields an empty map, and absent restores today's behaviour */
  }
  return byPr;
}

/**
 * W1-T3063 — `origin/main`'s merge subjects, keyed by the PR number a squash merge puts in
 * `(#N)`. ONE local git invocation per sweep pass; no network, no per-candidate cost.
 *
 * ⚠ BEST-EFFORT, AND AN EMPTY MAP IS THE SAFE ANSWER. A failed or truncated read leaves every
 * candidate's subject undefined, which {@link creditSubjectIsImplementation} reports as unknown and
 * every destructive consumer declines on. The failure mode is a PR that stays open one pass longer,
 * never one that closes on evidence nobody read.
 *
 * `root: undefined` (W1-T3873) — same meaning and same empty-map answer as
 * {@link readMergedPathsByPr}'s own: {@link creditEvidenceRootFor} found nothing provably rooted in
 * the requested `owner/repo`.
 */
function readMergeSubjectsByPr(root: string | undefined, opts: MergeLogReadOptions = {}): Map<number, string> {
  const byPr = new Map<number, string>();
  if (root === undefined) return byPr;
  if (opts.cache?.mergeSubjects) return opts.cache.mergeSubjects;
  try {
    const out = execFileSync("git", ["log", opts.ref ?? "origin/main", "--format=%s", "-n", String(MERGE_SUBJECT_SCAN_LIMIT)], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1 << 24,
    });
    for (const line of out.split("\n")) {
      const m = line.match(/\(#(\d+)\)\s*$/);
      if (m && !byPr.has(Number(m[1]))) byPr.set(Number(m[1]), line);
    }
    if (opts.cache) {
      opts.cache.mergeSubjects = byPr;
      if (mergeLogEvidenceByRoot.get(root) === opts.cache) mergeLogEvidenceByRoot.set(root, mergeLogEvidenceByRoot.get(root)!);
    }
  } catch {
    /* best-effort: an unreadable log yields an empty map, and unknown declines */
  }
  return byPr;
}

/** How far back {@link readMergedPathsByPr} scans. A BACKSTOP on cost, not a correctness bound: a
 *  merge outside the window has no entry and takes the pre-existing path. */
export const MERGED_PATHS_SCAN_LIMIT = 4000;

/** Per-PR path cap. `isPlanOnlyChangeset` only needs to see ONE non-plan path to answer, so a
 *  1,000-file merge does not need 1,000 strings held to decide it. */
const MERGED_PATHS_PER_PR_CAP = 200;

/** How far back {@link readMergeSubjectsByPr} scans. A BACKSTOP on cost, not a correctness bound:
 *  a credit older than this window reads UNKNOWN and therefore declines, which is the safe side. */
export const MERGE_SUBJECT_SCAN_LIMIT = 5000;

export const mergeLogEvidenceByRoot = createSizedMemo<string, NonNullable<MergeLogReadOptions["cache"]> & { sha: string }>();

/** W1-T4774: retain one successful snapshot per checkout; failed reads remain retryable. */
function resolveMergeLogReadOptions(root: string | undefined): MergeLogReadOptions {
  if (root === undefined) return {};
  const resolved = spawnSync("git", ["rev-parse", "--verify", "origin/main^{commit}"], { cwd: root, encoding: "utf8" });
  const sha = resolved.status === 0 ? resolved.stdout.trim() : "";
  if (!sha) {
    mergeLogEvidenceByRoot.delete(root);
    return {};
  }
  let cache = mergeLogEvidenceByRoot.get(root);
  if (cache?.sha !== sha) {
    cache = { sha };
    mergeLogEvidenceByRoot.set(root, cache);
  }
  return { ref: sha, cache };
}

/**
 * W1-T3873 — THE GIT-EVIDENCE ROOT BOTH READERS BELOW MUST SCAN for a credit pass over
 * `owner/repo`: the engine `repoRoot` for a SELF target (the checkout this process already runs
 * from), or that target's OWN already-synced checkout otherwise — `join(configRoot, "repos",
 * repo)`, the SAME expression `daemonCommand`'s `targetCheckoutRoot` already resolves for
 * cross-target COMMIT-TRAILER credit (W1-T3779, this file). Before this, `readMergedPathsByPr`
 * and `readMergeSubjectsByPr` were always handed the bare `repoRoot` module constant, so a target
 * repository's PR number was answered by the ENGINE repo's merge of the same number, or by
 * nothing — see this task's rationale for the two ways that reads wrong.
 *
 * PROVES the checkout belongs to `owner/repo` before handing it back, the same way
 * {@link buildCommitTrailerIndex} (lib/status.ts) proves a foreign checkout: comparing that
 * checkout's `git remote.origin.url` against the requested slug. A missing, foreign or unreadable
 * checkout returns `undefined` — a genuine ABSENCE, never a fallback to the engine's own history.
 * A failed `loadConfig()` (no fleet config yet) degrades the same way: `undefined`, never a throw
 * that could take out the whole credit pass over one config read.
 *
 * `undefined` back at the two readers means "no entry for ANY PR" — the SAME safe "no opinion"
 * a failed `git log` already yields today (both readers' own best-effort catch). It can only
 * WITHHOLD a credit that would otherwise have been answered from foreign evidence; it can never
 * manufacture one (design clause (iii), this task).
 */
export function creditEvidenceRootFor(
  owner: string,
  repo: string,
  opts: {
    /** This checkout's own owner/repo, defaulting to {@link resolveOwnerRepo}. Injectable so a
     *  test can name a self target without a real git repo backing `repoRoot`. */
    selfOwnerRepo?: { owner: string; repo: string };
    /** Where a non-self target's checkout lives — `join(configRoot, "repos", repo)`. Defaults to
     *  `loadConfig().root`. */
    configRoot?: string;
    /** `git -C <cwd> <args>`, returning stdout; throws like `execFileSync`. Injectable so a test
     *  can prove/disprove a fabricated checkout's origin without shelling out for real. */
    exec?: (args: string[], cwd: string) => string;
    /** Resolves THIS checkout's own owner/repo when `selfOwnerRepo` is not supplied, defaulting
     *  to {@link resolveOwnerRepo}. Injectable so a test can force the "repoRoot has no readable
     *  origin" branch below IN-PROCESS, without a real broken git config on this checkout. */
    resolveOwnerRepo?: () => { owner: string; repo: string };
  } = {},
): string | undefined {
  const self =
    opts.selfOwnerRepo ??
    (() => {
      try {
        return (opts.resolveOwnerRepo ?? resolveOwnerRepo)();
      } catch {
        return undefined; // repoRoot has no readable origin — cannot prove a self match either way
      }
    })();
  if (self && owner.toLowerCase() === self.owner.toLowerCase() && repo.toLowerCase() === self.repo.toLowerCase()) {
    return repoRoot;
  }
  let configRoot = opts.configRoot;
  if (configRoot === undefined) {
    try {
      configRoot = loadConfig().root;
    } catch {
      return undefined; // no fleet config to locate the target checkout under — the safe, empty answer
    }
  }
  const candidate = join(configRoot, "repos", repo);
  const exec = opts.exec ?? ((args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" }));
  let originUrl: string;
  try {
    originUrl = exec(["config", "--get", "remote.origin.url"], candidate).trim();
  } catch {
    return undefined; // missing checkout, unreadable, or no `origin` remote — a genuine absence
  }
  const slug = originUrl.replace(/\.git$/, "").replace(/^.*[:/]([^/]+\/[^/]+)$/, "$1");
  return slug.toLowerCase() === `${owner}/${repo}`.toLowerCase() ? candidate : undefined;
}

/**
 * W1-T4078 — identify the measured Rule-25 prerequisite shape without turning PR prose into a
 * general-purpose subject classifier. `undefined` means the body was not readable, so callers
 * must preserve the existing answer rather than infer either implementation or prerequisite.
 * Both markers are required: a body that merely mentions a prerequisite, or merely mentions an
 * instrument, is not enough to withdraw a previously valid commit-trailer credit.
 */
export function prerequisiteOnlyMergeBody(body: string | undefined, taskId: string): boolean | undefined {
  if (body === undefined) return undefined;
  const escapedTaskId = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const namesPrerequisite = new RegExp(`^Prerequisite split for\\s+${escapedTaskId}\\b`, "im").test(body);
  const carriesOnlyInstrument = /\bthis\s+PR\s+carries\s+ONLY\s+the\s+instrument\b/i.test(body);
  return namesPrerequisite && carriesOnlyInstrument;
}

export type ReconcileCreditCandidate = CreditCandidate & { creditHasOtherBuildMerge?: boolean };

function creditEvidenceFor(
  task: Pick<Task, "id" | "files">,
  prNumber: number,
  body: string | undefined,
  mergeSubjects: ReadonlyMap<number, string>,
  mergedPaths: ReadonlyMap<number, readonly string[]>,
): Pick<CreditCandidate, "creditIsImplementation" | "creditHasBuildDiff"> {
  const subjectCredit = creditSubjectIsImplementation(mergeSubjects.get(prNumber));
  const prerequisiteOnly = prerequisiteOnlyMergeBody(body, task.id);
  const paths = mergedPaths.get(prNumber);
  let creditHasBuildDiff: boolean | undefined;
  if (prerequisiteOnly === true) creditHasBuildDiff = false;
  else if (paths !== undefined && paths.length > 0) creditHasBuildDiff = !isBookkeepingOnlyChangeset(paths) || isPlanTextDeliverable(task, paths);
  // W1-T4078 — a readable, explicitly prerequisite-only body is negative evidence even when
  // the squash commit carries the task trailer. Unreadable body evidence stays with the
  // subject result so this repair can only subtract the measured false credit.
  return { creditIsImplementation: prerequisiteOnly === true ? false : subjectCredit, creditHasBuildDiff };
}

/** Map one whole-plan projection to the credit consumer's narrow candidate shape. Keeping this
 * pure makes the performance refactor unable to change the merged/pr/url ownership filter. */
export function creditCandidatesFromProjection(
  projections: Iterable<StatusProjection>,
  mergeSubjects: ReadonlyMap<number, string>,
  mergeBodies: ReadonlyMap<number, string> = new Map(),
  mergedPaths: ReadonlyMap<number, readonly string[]> = new Map(),
  mergedCreditsFor: (taskId: string) => readonly PrRef[] = () => [],
  tasksById: ReadonlyMap<string, Pick<Task, "id" | "files">> = new Map(),
): ReconcileCreditCandidate[] {
  const candidates: ReconcileCreditCandidate[] = [];
  for (const projection of projections) {
    if (!projection.merged || projection.prNumber === undefined || projection.prUrl === undefined) continue;
    const id = projection.taskId;
    const task = tasksById.get(id) ?? { id };
    const evidence = creditEvidenceFor(task, projection.prNumber, mergeBodies.get(projection.prNumber), mergeSubjects, mergedPaths);
    const candidate: ReconcileCreditCandidate = { taskId: id, prNumber: projection.prNumber, prUrl: projection.prUrl, merged: true, ...evidence };
    const buildsOnMain = (pr: PrRef): boolean =>
      pr.state === "MERGED" && pr.number !== projection.prNumber && (creditsByAnchoredTrailer("MERGED", pr.headRefName, pr.body, id) || taskIdFromRunBranch(pr.headRefName) === id) &&
      creditIsReconcilable({ merged: true, ...creditEvidenceFor(task, pr.number, pr.body ?? mergeBodies.get(pr.number), mergeSubjects, mergedPaths) });
    if (!creditIsReconcilable(candidate) && mergedCreditsFor(id).some(buildsOnMain)) candidate.creditHasOtherBuildMerge = true;
    candidates.push(candidate);
  }
  return candidates;
}

// W1-T3873: exported (was module-private) so test/cross-target-credit-evidence.test.ts can drive
// it directly, the same way buildEscalationReconcileCandidates already was — no behaviour change.
export function buildCreditCandidates(
  owner: string,
  repo: string,
  plan: Plan,
  ledgerPath: string,
  log?: (step: string, extra?: Record<string, unknown>) => void,
  // APPENDED LAST so neither positional call site shifts — the same convention
  // `buildEscalationReconcileCandidates`' own `injected.github` seam below already follows.
  // Supplied by {@link buildSweepHook} so the daemon's per-poll rung reuses ONE warm gateway
  // (see that function's doc for the measurement); omitted by `sweepCommand`, a one-shot CLI
  // invocation with no second pass to amortise a row cache over.
  github?: GitHub,
  // W1-T3873 — ALSO APPENDED LAST, same convention: resolves the git-evidence root the two
  // readers below scan for `owner/repo` (see {@link creditEvidenceRootFor}'s own doc). Every real
  // caller omits this and gets that function's live git/config resolution; a test injects a fake
  // to drive a self/target/foreign checkout without a real one on disk.
  evidenceRootFor: (owner: string, repo: string) => string | undefined = creditEvidenceRootFor,
  // Injectable only for the one-read regression; production uses projectPlan's normal reader.
  readLedger: DeriveDeps["readLedger"] = readLedgerLines,
  creditIo: Pick<DeriveDeps, "readCreditStore" | "writeCreditStore"> = {},
): ReconcileCreditCandidate[] {
  // W1-T181: wires the same fetch-size/fetch-failure observability the SERVE board gateway gets —
  // this sweep/daemon-poll gateway shells the identical `gh pr list` this outage's fix targeted.
  // W1-T3067: the free local evidence the plan-only DIFF refusal needs, built ONCE for the whole
  // walk below rather than per task — `deriveStatus` runs once per plan task (~1,400 a pass).
  // W1-T3873: rooted in `owner`/`repo`'s OWN checkout, never unconditionally the engine's.
  const evidenceRoot = evidenceRootFor(owner, repo);
  const mergeLog = resolveMergeLogReadOptions(evidenceRoot);
  const baseGithub = github ?? buildBatchedGithub(owner, repo, { log });
  // This consumer already owns a whole-plan credit pass. Keep the merged batch (the projection's
  // fail-closed corroboration) but disable the unrelated open-board batch and taskless surface.
  const projectionGithub: GitHub = {
    ...baseGithub,
    listOpenHeadBranches: undefined,
  };
  const deps: DeriveDeps = {
    ...creditIo,
    ledgerPath,
    github: projectionGithub,
    mergedPathsByPr: readMergedPathsByPr(evidenceRoot, MERGED_PATHS_SCAN_LIMIT, mergeLog),
    readLedger,
    skipTasklessEscalations: true,
    skipUncreditedBuildWarning: true,
  };
  // W1-T3063 — ONE local `git log` for the whole pass, never one per candidate and never a GitHub
  // call: W1-T2794 promised this rung adds no new read, and that promise is kept. A squash merge
  // puts `(#N)` in the subject, which is what maps a credit back to what earned it.
  const mergeSubjects = readMergeSubjectsByPr(evidenceRoot, mergeLog);
  const projection = projectPlan(plan, deps);
  // W1-T4078 — `buildBatchedGithub` already has each merged PR body in the same cache that fed
  // the projection. Read those bodies by PR number so the measured prerequisite-only split can
  // be refused without adding a GitHub request or weakening ordinary commit-trailer credit.
  const mergeBodies = new Map<number, string>();
  for (const candidate of projection.values()) {
    if (!candidate.merged || candidate.prNumber === undefined || candidate.prUrl === undefined) continue;
    const pr = baseGithub.prByRef(candidate.prUrl);
    if (pr?.body !== undefined) mergeBodies.set(candidate.prNumber, pr.body);
  }
  let mergedByTask: Map<string, PrRef[]> | undefined;
  const mergedCreditsFor = (taskId: string): readonly PrRef[] => {
    if (!mergedByTask) {
      mergedByTask = new Map();
      for (const pr of [...(baseGithub.listMergedHeadBranches?.() ?? [])].sort((a, b) => b.number - a.number)) {
        const owners = new Set([...(pr.body ?? "").matchAll(/^Remudero-Task:\s*(\S+)\s*$/gm)].map((m) => m[1]!).concat(taskIdFromRunBranch(pr.headRefName) ?? []));
        for (const id of owners) mergedByTask.set(id, [...(mergedByTask.get(id) ?? []), pr]);
      }
    }
    return mergedByTask.get(taskId) ?? [];
  };
  return creditCandidatesFromProjection(projection.values(), mergeSubjects, mergeBodies, deps.mergedPathsByPr, mergedCreditsFor, plan.byId);
}

/**
 * fb-1784756088300-6a481e: one {@link EscalationReconcileCandidate} per OPEN needs-human
 * issue, pairing it with its referenced task's CURRENT state — the SAME #737/#741-corrected
 * `deriveStatus` every other rung trusts. The task id is read from the issue body's
 * `**Task:** <id>` line (W1-T186 — `renderIssueBody` writes it on every escalation). An issue
 * with no named task, or one whose task is not in THIS plan, yields NO candidate — genuinely-
 * human territory, left untouched. Uses the BATCHED gateway (one `gh pr list`) for derivation
 * and one `gh issue list` for the open queue; a FAILED issue-list read yields [] (do nothing
 * this cycle, never a false "zero open"), the same best-effort contract as buildCreditCandidates.
 */
/**
 * What the escalation reconciler's INTAKE saw, so `total: 0` stops being ambiguous.
 *
 * `sweep.escalation_reconcile.summary` logs `total` = `candidates.length`, counted AFTER the open
 * issues have been turned into candidates — so `total: 0` reads identically whether nothing was
 * open or everything open was dropped. That ambiguity cost a full recon: an operator saw `total: 0`
 * beside three open needs-human issues and reasonably concluded the reconciler was broken. It was
 * not — they had been closed minutes earlier, one of them BY the reconciler. But the defective
 * reading was REAL as recently as the same afternoon: between 16:00 and 17:48, two issues were open
 * and labelled while 23 of 24 summaries reported `total: 0` (fixed by PR #1084).
 *
 * `issuesSeen: 3, total: 0` is the signature of that defect. The old line could not express it.
 */
export interface EscalationIntake {
  /** Issues the query returned, taken one statement after the read and before the candidate loop. */
  issuesSeen: number;
  /** Dropped for carrying no `**Task:**` trailer — genuinely human territory. */
  droppedNoTaskTrailer: number;
  /** Dropped for naming neither a plan task nor any resolvable PR referent. */
  droppedNoReferent: number;
}

/** W1-T4043 — the escalation closer is a DESTRUCTIVE consumer of merge credit, so a
 * head-branch-only projection must carry the same implementation-subject evidence as the
 * credit-backfill closer. The ordinary status projection deliberately remains broader: it is
 * read by dispatch and the board, and the subject is not ground truth for implementation. This
 * guard is only for the issue close, where unknown evidence must leave the receipt open. */
function reconcileImplementationEvidence(
  taskId: string,
  projection: StatusProjection,
  github: GitHub,
  mergeSubjects: ReadonlyMap<number, string>,
): boolean | undefined {
  if (!projection.merged || projection.source !== "head-branch" || projection.prNumber === undefined) return true;
  const recorded = mergeSubjects.get(projection.prNumber);
  if (recorded !== undefined) return creditSubjectIsImplementation(recorded);

  // The local subject map is intentionally bounded and may lag one merge behind. The batched
  // gateway already has the live PR title in its head-branch rows, so consult that in-memory
  // surface before paying for a direct lookup. A missing title remains UNKNOWN, never a filing.
  try {
    const branchHit = github.findMergedByHeadBranch?.(taskId)?.find((pr) => pr.number === projection.prNumber);
    if (branchHit?.title !== undefined) return creditSubjectIsImplementation(branchHit.title);
  } catch {
    /* an unreadable live surface is unknown implementation evidence, not a close */
  }
  try {
    const direct = github.prByRef(projection.prNumber);
    if (direct?.title !== undefined) return creditSubjectIsImplementation(direct.title);
  } catch {
    /* same fail-open direction: retain the human receipt until the next readable pass */
  }
  return undefined;
}

export function buildEscalationReconcileCandidates(
  owner: string,
  repo: string,
  plan: Plan,
  ledgerPath: string,
  log?: (step: string, extra?: Record<string, unknown>) => void,
  // Injectable seams (mirrors buildCreditCandidates' buildBatchedGithub): real callers omit
  // both and get the live `gh` gateways; tests supply fakes to drive the parse + derivation
  // without shelling out.
  injected: {
    issues?: IssueGateway;
    github?: GitHub;
    onIntake?: (intake: EscalationIntake) => void;
    // W1-T3873 — the same trailing evidence-root seam buildCreditCandidates takes positionally,
    // folded into this builder's existing injected-object convention instead of a new positional
    // parameter. Omitted ⇒ {@link creditEvidenceRootFor}'s live git/config resolution.
    evidenceRootFor?: (owner: string, repo: string) => string | undefined;
    creditIo?: Pick<DeriveDeps, "readCreditStore" | "writeCreditStore">;
  } = {},
): EscalationReconcileCandidate[] {
  const issues = injected.issues ?? ghIssueGateway(owner, repo);
  let open: OpenIssue[];
  try {
    // W1-T349: needs-human AND fleet-notice — a demoted item must still self-retire.
    open = listRetirableEscalationIssues(issues);
  } catch (e) {
    log?.("sweep.escalation_reconcile.list_failed", { error: String((e as Error)?.message ?? e) });
    return []; // a failed read is "do nothing this cycle", never a confident "zero open needs-human"
  }
  // WHERE `issuesSeen` IS TAKEN, and why HERE. This is the list as the gateway returned it and as
  // the loop below is about to consume it — one statement after the read, before the loop, before
  // any per-issue derivation. Every drop the summary's ambiguity is about happens in that loop, so
  // `issuesSeen - total` counts exactly those drops and nothing else.
  //
  // Deliberately NOT the raw REST row count. `parseLabelledIssuesRest` already drops rows carrying
  // `pull_request` (escalate.ts:160-173) — an intended filter, not a defect — so counting rows
  // would make `issuesSeen > total` on a healthy pass whenever a PR happens to carry the label,
  // i.e. a false alarm in the one field added to stop false alarms.
  const intake: EscalationIntake = { issuesSeen: open.length, droppedNoTaskTrailer: 0, droppedNoReferent: 0 };
  // W1-T3067 — THE SECOND DESTRUCTIVE CONSUMER, wired for the same reason as the first. This
  // builder reads `proj.merged` and feeds the closer that CLOSES a needs-human issue; a credit
  // earned by a plan-only filing would close an escalation whose task is not done, which is the
  // supersession incident (#4461) in a different surface. The free local evidence must reach here
  // too, or the refusal is fixed in one place and open in the other.
  //
  // W1-T3873: rooted in `owner`/`repo`'s OWN checkout, never unconditionally the engine's — see
  // {@link creditEvidenceRootFor}'s own doc, and `buildCreditCandidates`' identical fix above.
  const evidenceRoot = (injected.evidenceRootFor ?? creditEvidenceRootFor)(owner, repo);
  const mergeLog = resolveMergeLogReadOptions(evidenceRoot);
  const mergeSubjects = readMergeSubjectsByPr(evidenceRoot, mergeLog);
  const deps: DeriveDeps = {
    ...injected.creditIo,
    ledgerPath,
    github: injected.github ?? buildBatchedGithub(owner, repo, { log }),
    mergedPathsByPr: readMergedPathsByPr(evidenceRoot, MERGED_PATHS_SCAN_LIMIT, mergeLog),
  };
  const candidates: EscalationReconcileCandidate[] = [];
  for (const issue of open) {
    const taskId = /^\*\*Task:\*\*\s*(\S+)\s*$/m.exec(issue.body ?? "")?.[1];
    if (!taskId) {
      intake.droppedNoTaskTrailer++;
      continue; // no named task — leave untouched (human territory)
    }
    const task = plan.byId.get(taskId);
    // SYNTHETIC PR REFERENT. An escalation for an untrailered operator-lane PR names it `PR-<n>`
    // (see the clarification rung's `escalate`, above) — a real, resolvable referent that is
    // simply not a PLAN TASK, so `plan.byId` misses it by construction and the `!task` guard below
    // would drop it forever. That is exactly how 53 issues became unretirable.
    //
    // Resolving it needs no plan entry: the PR NUMBER is the referent, and the SAME batched
    // gateway `deriveStatus` is about to use already answers merged/closed for a bare number via
    // `prByRef`. So this derives the identical `derived` shape from the number and hands the
    // reconciler a candidate it can actually close — the round trip the synthetic id is only
    // worth minting if it completes.
    //
    // FAIL-SOFT, matching `deriveStatus`'s own polarity: a gateway that CANNOT answer yields
    // `indeterminate`, never a confident "not merged" — the closer already refuses to act on an
    // indeterminate referent, so an unreadable PR leaves its issue open rather than closing it on
    // a read failure.
    if (!task) {
      const synthetic = /^PR-(\d+)$/.exec(taskId);
      // impl-DY: an id the plan does not own and that was NOT minted in the `PR-<n>` shape still names its
      // referent — `renderIssueBody` writes the PR as a full URL into the issue text. Read it back rather
      // than dropping the issue forever. This is the operator's own framing ("the system should be able to
      // determine that those are already handled") and it is the last remaining way an escalation becomes
      // permanently unretirable: `TRIAGE-fb-1784732687221-3be743` (PR #707, merged 2026-07-24) and
      // `TRIAGE-fb-1784917146019-88250d` (PR #775, merged 2026-07-25) survived a hand-cleanup of 55 siblings
      // for exactly this reason. Title is the fallback source — every escalation title carries the PR URL too,
      // so a body that was edited (or truncated by a gateway) still resolves.
      const bodyReferent = synthetic ? undefined : prReferentFromIssueText(issue.body) ?? prReferentFromIssueText(issue.title);
      if (!synthetic && bodyReferent === undefined) {
        intake.droppedNoReferent++;
        continue; // no task, no PR anywhere — genuinely human territory
      }
      const prNumber = synthetic ? Number(synthetic[1]) : bodyReferent!;
      const ref = deps.github.prByRef(prNumber);
      const state = ref?.state?.toUpperCase();
      candidates.push({
        issueUrl: issue.url,
        issueNumber: issue.number,
        taskId,
        derived: {
          merged: state === "MERGED",
          closed: state === "CLOSED",
          indeterminate: ref === null || ref === undefined ? true : undefined,
          prUrl: ref?.url,
          prNumber: ref?.number ?? prNumber,
          source: synthetic ? "pr-referent" : "pr-referent-from-issue-text",
        },
      });
      continue;
    }
    const proj = deriveStatus(task, deps);
    const implementationEvidence = reconcileImplementationEvidence(taskId, proj, deps.github, mergeSubjects);
    const implementationGuardedMerged =
      proj.merged && (proj.source !== "head-branch" || implementationEvidence === true);
    // W1-T162: a referent whose PR CLOSED WITHOUT MERGING is also terminal — superseded or
    // abandoned, no longer a live blocker — distinct from an open/blocked-pending-fix PR.
    // deriveStatus's `prState` carries the raw GitHub state through unchanged (status.ts's
    // `fromPrState` only ever sets `status: "blocked"` for a raw "closed" state, so checking
    // `prState` directly here is the same signal, made explicit rather than inferred from
    // `status`). Mutually exclusive with `merged` by construction (fromPrState never sets both).
    const closedWithoutMerge = !proj.merged && proj.prState?.toUpperCase() === "CLOSED";
    candidates.push({
      issueUrl: issue.url,
      issueNumber: issue.number,
      taskId,
      derived: {
        merged: implementationGuardedMerged,
        closed: closedWithoutMerge,
        indeterminate:
          proj.indeterminate ||
          (proj.merged && proj.source === "head-branch" && implementationEvidence === undefined)
            ? true
            : undefined,
        prUrl: proj.prUrl,
        prNumber: proj.prNumber,
        source: proj.source,
      },
    });
  }
  // NON-FATAL BY CONSTRUCTION: a throwing observer must never take out the sweep, which runs this
  // every pass on the live fleet. The reconciler proceeds with whatever it built either way.
  try {
    injected.onIntake?.(intake);
  } catch {
    /* observability only — never fatal */
  }
  return candidates;
}

// ── W1-T9722: the read-plane worker's entry ─────────────────────────────────────────────────────────────

/** The read-plane worker's entry, this module's own URL: what the daemon hands startReadPlane. */
export function tickReadWorkerUrl(): URL {
  return new URL(import.meta.url);
}

/** The global the worker's boot counts loaded modules on, read once by its start row. */
const LOADED_MODULES = "__rmdTickReadLoadedModules";

/**
 * The worker's boot, run as an eval stub: count each module the isolate loads (node's in-thread
 * registerHooks), register tsx first only for a TypeScript entry (tsx's main-thread loader does not install
 * itself in a worker's module loader, W1-T4075), then import the entry. A bundle loads under plain node.
 */
export function tickReadWorkerBoot(entry: string): string {
  const tsx = /\.[cm]?tsx?$/.test(new URL(entry).pathname)
    ? `const { register } = await import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))}); register();`
    : "";
  return [
    "const { registerHooks } = require('node:module');",
    "const { workerData } = require('node:worker_threads');",
    `globalThis.${LOADED_MODULES} = 0;`,
    `registerHooks({ load(url, context, next) { globalThis.${LOADED_MODULES}++; return next(url, context); } });`,
    `(async () => { ${tsx} await import(workerData.entry); })();`,
  ].join("\n");
}

/**
 * Start the read-plane worker from this module: a current worker bundle under plain node when startWorker
 * vouches for one, the .ts source under tsx otherwise. `start` is a test's seam for startWorker.
 */
export function startTickReadWorker(input: TickReadOptions, opts: { url?: URL; start?: typeof startWorker } = {}): Worker {
  const url = opts.url ?? tickReadWorkerUrl();
  const workerData = { kind: READ_PLANE_KIND, input, entry: url.href };
  // SHARE_ENV: the daemon's hourly GH_TOKEN refresh must reach the worker's reads. startWorker decides the entry
  // and, for a bundle, the execArgv without tsx; the boot imports whichever entry it chose.
  return (opts.start ?? startWorker)(url, { workerData, env: SHARE_ENV }, {
    construct: (entry, given: WorkerOptions) => new Worker(tickReadWorkerBoot(String(entry)), {
      eval: true, env: SHARE_ENV, execArgv: given.execArgv, workerData: { ...workerData, entry: String(entry) },
    }),
  });
}

/** The tree this module's source sits in (a bundle maps its URL to the source too). */
const TREE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * What the worker's isolate holds once its entry has loaded: the start row's fields. `entry` is the module the
 * worker was STARTED from (its workerData), tree-relative, so a daemon that hands the worker another entry says
 * so. Unknown is absent, never 0.
 */
export function tickReadWorkerStartFacts(data: unknown = threadData): Record<string, unknown> {
  const loaded = (globalThis as Record<string, unknown>)[LOADED_MODULES];
  const entry = (data as { entry?: unknown } | null | undefined)?.entry;
  return {
    ...(typeof entry === "string" ? { entry: entry.startsWith("file:") ? relative(TREE_ROOT, fileURLToPath(entry)) : entry } : {}),
    bundled: runsBundled(),
    ...(typeof loaded === "number" ? { loaded_modules: loaded } : {}),
    heap_used_bytes: process.memoryUsage().heapUsed,
  };
}

/**
 * A `git fetch`/`git show` step failed. Distinct from a generic Error so callers can tell
 * "the plan sync itself is broken" apart from any other failure and react the fail-closed
 * way (§ named ledger error, no spawn — W1-T60).
 */
export class GitFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitFetchError";
  }
}

export function originPlanBlobs(relPath: string, blob: string, shards: Array<{ relPath: string; text: string }>): Array<{ label: string; text: string }> {
  return [
    { label: `origin/main:${relPath}`, text: blob },
    ...shards.map((s) => ({ label: `origin/main:${s.relPath}`, text: s.text })),
  ];
}

/** BACKSTOP, per git call of the awaited plan sync (fetch, show, ls-tree, cat-file). MEASURED 2026-10-06: the
 *  sync shard read held the daemon loop 3.4 s; a call still running at five minutes is hung, not slow. */
export const PLAN_SYNC_GIT_TIMEOUT_MS = 300_000;

/** An awaited plan-sync git call killed at its bound. Never read as "no shards": the sync refuses, naming it. */
export class PlanSyncGitTimeoutError extends RmdError {
  constructor(args: readonly string[], timeoutMs: number) {
    super("git", GENERIC_EXIT_CODE, `git ${args[0]} timed out after ${timeoutMs}ms and was killed`, { verb: args[0], timeoutMs });
    this.name = "PlanSyncGitTimeoutError";
  }
}

/** {@link GitRunner}, awaited. */
export type GitRunnerAsync = (args: string[], stdin?: string) => Promise<string>;

/** The real {@link GitRunnerAsync}: `git -C <repoDir>` off the loop, `stdin` piped, SIGTERM then SIGKILL past its
 *  bound, which rejects with {@link PlanSyncGitTimeoutError}; any other failure rejects with git's own error. */
export function planSyncGitRunnerAsync(
  repoDir: string,
  opts: { timeoutMs?: number; graceMs?: number; gitBin?: string; maxBuffer?: number } = {},
): GitRunnerAsync {
  const timeoutMs = opts.timeoutMs ?? PLAN_SYNC_GIT_TIMEOUT_MS;
  return (args, stdin) =>
    new Promise((resolve, reject) => {
      const child = execFile(opts.gitBin ?? "git", ["-C", repoDir, ...args], { encoding: "utf8", maxBuffer: opts.maxBuffer ?? 1 << 26 }, (err, stdout) => {
        bound.cancel();
        if (bound.timedOut) return reject(new PlanSyncGitTimeoutError(args, timeoutMs));
        return err ? reject(err) : resolve(stdout);
      });
      // EPIPE when git exits before reading its stdin: the exit itself reports that failure above.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(stdin ?? "");
      const bound = boundChildByLoopTime(child, timeoutMs, { escalateAfterMs: opts.graceMs ?? GIT_FETCH_KILL_GRACE_MS });
    });
}

/** W1-T9763: `key` is `<tasks.yaml blob>:<tasks.d tree>`; `commit` is where a reader without it reads it again. */
export interface PlanRevision {
  key: string;
  commit: string;
  repoDir: string;
  relPath: string;
}

export type RevisionLoad = { plan: Plan; quarantined: QuarantinedTask[] };

/** One parsed {@link Plan} per {@link PlanRevision}; `adopt` reuses each unchanged blob's tasks. */
export interface PlanRevisionStore {
  get(key: string): RevisionLoad | undefined;
  adopt(revision: PlanRevision, blobs: Array<{ label: string; text: string }>): RevisionLoad;
  revisionOf(plan: Plan): PlanRevision | undefined;
  counts(): { parsed: number; reused: number; held: number; retained: number };
}

/** A plan is frozen, so a reader that mutates it throws instead of changing every reader's plan, and held weakly, so
 *  one no reader holds is released; `retainLatest` keeps the newest for a reader holding nothing between requests. */
export function createPlanRevisionStore(opts: { retainLatest?: boolean } = {}): PlanRevisionStore {
  const blobCache = new PlanBlobCache();
  const held = new Map<string, WeakRef<Plan>>();
  const meta = new WeakMap<Plan, { revision: PlanRevision; quarantined: QuarantinedTask[] }>();
  const released = new FinalizationRegistry<string>((key) => {
    if (held.get(key)?.deref() === undefined) held.delete(key);
  });
  let latest: Plan | undefined;
  let parsed = 0;
  let reused = 0;
  const lookup = (key: string): RevisionLoad | undefined => {
    const plan = held.get(key)?.deref();
    const known = plan && meta.get(plan);
    return plan && known ? { plan, quarantined: known.quarantined } : undefined;
  };
  const hit = (key: string): RevisionLoad | undefined => {
    const load = lookup(key);
    if (load) reused++;
    return load;
  };
  return {
    get: hit,
    adopt: (revision, blobs) => {
      const already = hit(revision.key);
      if (already) return already;
      const read = mergePlanBlobsQuarantiningDuplicates(blobs, blobCache);
      parsed++;
      freezeReadGeneration(read.plan);
      held.set(revision.key, new WeakRef(read.plan));
      meta.set(read.plan, { revision, quarantined: read.quarantined });
      released.register(read.plan, revision.key);
      if (opts.retainLatest) latest = read.plan;
      return { plan: read.plan, quarantined: read.quarantined };
    },
    revisionOf: (plan) => meta.get(plan)?.revision,
    counts: () => ({ parsed, reused, held: held.size, retained: latest ? 1 : 0 }),
  };
}

export async function planBlobsAtRevision(revision: PlanRevision, runGit: GitRunnerAsync): Promise<Array<{ label: string; text: string }>> {
  let blob: string;
  try {
    blob = await runGit(["show", `${revision.commit}:${revision.relPath}`]);
  } catch (err) {
    throw new GitFetchError(`git show ${revision.commit}:${revision.relPath} failed in ${revision.repoDir}: ${String(err)}`);
  }
  const shards = await readOriginShardsAtRefAsync(revision.repoDir, dirname(revision.relPath), runGit, revision.commit);
  return originPlanBlobs(revision.relPath, blob, shards);
}

export async function planAtRevisionAsync(store: PlanRevisionStore, revision: PlanRevision,
  runGit: GitRunnerAsync = planSyncGitRunnerAsync(revision.repoDir)): Promise<RevisionLoad> {
  return store.get(revision.key) ?? store.adopt(revision, await planBlobsAtRevision(revision, runGit));
}

export function shardListingArgs(ref: string, shardRelDir: string): string[] {
  return ["ls-tree", "--name-only", ref, `${shardRelDir}/`];
}

export function shardPathsFromListing(listing: string): string[] {
  return listing
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && (line.endsWith(".yaml") || line.endsWith(".yml")));
}

export function shardReadFailure(ref: string, shardRelDir: string, repoDir: string, err: unknown): GitFetchError {
  return new GitFetchError(`git cat-file --batch over ${ref}:${shardRelDir}/ failed in ${repoDir}: ${String(err)}`);
}

/**
 * {@link readOriginShardsAtRef} through an awaited runner: the same listing, the same one `cat-file --batch` and
 * framing (`readBlobsAtRef` parses the bytes the awaited call returned). ONE DIFFERENCE, on purpose: a listing
 * killed at its bound throws {@link GitFetchError} naming it, where the sync read's catch would call it no shards
 * and silently drop every shard task from the dispatched plan.
 */
export async function readOriginShardsAtRefAsync(
  repoDir: string,
  planRelDir: string,
  runGit: GitRunnerAsync = planSyncGitRunnerAsync(repoDir),
  ref = "origin/main",
): Promise<Array<{ relPath: string; text: string }>> {
  const shardRelDir = join(planRelDir, "tasks.d");
  let shardListing: string;
  try {
    shardListing = await runGit(shardListingArgs(ref, shardRelDir));
  } catch (err) {
    if (err instanceof PlanSyncGitTimeoutError) throw new GitFetchError(`git ls-tree ${ref}:${shardRelDir}/ failed in ${repoDir}: ${err.message}`);
    // No tasks.d/ at the ref (or a ref-dir lookup miss) is the no-shards case, exactly as the sync read reads it.
    shardListing = "";
  }
  const shardRelPaths = shardPathsFromListing(shardListing);
  if (shardRelPaths.length === 0) return [];
  let texts: string[];
  try {
    const request = shardRelPaths.map((p) => `${ref}:${p}`).join("\n") + "\n";
    const raw = await runGit(["cat-file", "--batch"], request);
    // readBlobsAtRef builds this same request; any drift hands it no bytes, and it fails loud naming the first path.
    texts = readBlobsAtRef((_args, stdin) => (stdin === request ? raw : ""), ref, shardRelPaths);
  } catch (err) {
    throw shardReadFailure(ref, shardRelDir, repoDir, err);
  }
  return shardRelPaths.map((relPath, i) => ({ relPath, text: texts[i] }));
}

export type TickReadFacts = Awaited<ReturnType<ReturnType<typeof createTickReadProducer>>>;
export type TickReadInput = Parameters<ReturnType<typeof createTickReadProducer>>[0];
export type TickReadRequest = TickReadInput | RevisionedRequest<TickReadInput, PlanRevision>;

/** W1-T9763: a revision resolves through `plans`, this side's own store, and the facts carry no plan back. */
export function tickReadProducer(options: TickReadOptions, io: Parameters<typeof createTickReadProducer>[1],
  plans: PlanRevisionStore): (input: TickReadRequest) => Promise<TickReadFacts> {
  return revisionedProducer(createTickReadProducer(options, io),
    async (revision: PlanRevision) => (await planAtRevisionAsync(plans, revision)).plan);
}

const readWorkerOptions = readPlaneWorkerInput<TickReadOptions>();
if (readWorkerOptions) {
  runReadPlaneWorker(tickReadProducer(readWorkerOptions, { log: readPlaneWorkerLog }, createPlanRevisionStore({ retainLatest: true })));
  readPlaneWorkerLog("read_plane.worker_started", tickReadWorkerStartFacts());
}
