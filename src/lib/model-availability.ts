import type { Config } from "./config-schema.js";
import type { Escalation } from "./escalate.js";
import { appendLedger } from "./ledger.js";
import type { Mounts } from "./mounts.js";
import { humanGatedFamily } from "./model-gate.js";
import { readLedgerLines } from "./status.js";
import { OPENWEIGHT_API_KEY_ENV, OPENWEIGHT_PRICES, openWeightDeploymentReady } from "./worker-provider.js";

/**
 * A SUCCESSOR MODEL IS ANNOUNCED AND NOBODY HEARS (W1-T4080, operator ruling
 * `operator-ruling#azure-gpt6-2026-09-22`). W1-T4079 shipped the automatic switch once a model is
 * DEPLOYED AND PRICED — both operator acts that spend money and change the account, so they stay
 * manual. The automation that remains is telling the operator, ONCE, the moment the catalog
 * offers a successor: this module owns that watch and nothing else.
 *
 * DESIGN, taken verbatim from the task record: (i) on the measurement cadence, read the cash
 * data-plane and Codex model lists — a successor is a listed id in a routed family with a higher
 * generation that no ladder row routes as READY. (ii) classify it: announced (listed, not
 * deployed), deployed-unpriced, or ready. (iii) raise ONE alert per successor per STATE through
 * the existing escalation path, naming the exact next step; never repeat for an unchanged state,
 * ledger every reading. (iv) human-gated families (Astra, Fable — model-gate.ts) are reported but
 * never proposed for routing.
 *
 * TRAP: a Codex-subscription model needs no separate deploy-or-price step, so it can never sit in
 * the "announced but not switched" state this watch exists to surface — see {@link
 * routedLadderRows}'s own doc for why only the CASH ladder seeds a "ready" row.
 *
 * FALSIFIER (task record): a catalog successor watch already existed at build time — it did not
 * (`grep -rn watchSuccessorModels src/` was empty before this file).
 */

// ── Parsing a model id into (family, generation) ───────────────────────────

export interface ParsedModelId {
  family: string;
  generation: number;
}

/** `gpt-<generation>-<family>`, the only shape every routed and catalog-listed id in this
 *  codebase takes (`gpt-6-luna`, `gpt-5.6-terra`, `gpt-6-astra`, ...). Anything else is not a
 *  member of a family this watch can compare generations within, and is left alone. */
export const MODEL_ID_RE = /^gpt-([0-9]+(?:\.[0-9]+)?)-([a-z][a-z0-9]*)$/i;

export function parseModelId(id: string): ParsedModelId | undefined {
  const m = MODEL_ID_RE.exec(id);
  if (!m) return undefined;
  const generation = Number.parseFloat(m[1]!);
  if (!Number.isFinite(generation)) return undefined;
  return { family: m[2]!.toLowerCase(), generation };
}

// ── The catalog + routing snapshot this watch reasons over ────────────────

export interface CatalogSnapshot {
  /** Every model id ANY provider catalog currently lists (cash data-plane + Codex account,
   *  design (i)) — the "announced" signal, regardless of whether THIS account has deployed or
   *  priced it yet. */
  listed: readonly string[];
  /** Model ids with an actual Azure deployment on the cash endpoint's account. */
  deployed: readonly string[];
  /** Model ids carrying a published price row (worker-provider.ts's `OPENWEIGHT_PRICES`). */
  priced: readonly string[];
}

export interface RoutedLadderRow {
  /** A model id a cash ladder row candidates today, at any capability/effort. */
  model: string;
  /** Whether that row is presently selectable as READY — see worker-provider.ts's
   *  `openWeightDeploymentReady` for the exact meaning (priced, shaped, sized, not known-absent). */
  ready: boolean;
}

export type SuccessorState = "announced" | "deployed-unpriced" | "ready";

export interface SuccessorModel {
  model: string;
  family: string;
  generation: number;
  /** The routed model this succeeds, when the family has one — see {@link findSuccessors}'s own
   *  doc for why a human-gated family may carry none (the ladder never routes that family at all,
   *  so there is no predecessor generation to have succeeded). */
  predecessor?: string;
}

/**
 * Every listed id that is a successor: a higher generation than the highest-generation READY row
 * in its family (design (i)) — OR any listed id in a human-gated family (Astra, Fable —
 * model-gate.ts's `humanGatedFamily`), reported UNCONDITIONALLY, because a gated family is never
 * a ladder row at all (design (iv)), so "no ladder row routes it as READY" is vacuously true for
 * every generation it ever lists, not just a higher one. An id already routed as READY (its exact
 * id, not merely its family) is never its own successor.
 */
export function findSuccessors(listed: readonly string[], routed: readonly RoutedLadderRow[]): SuccessorModel[] {
  const readyByFamily = new Map<string, { generation: number; model: string }>();
  const readyIds = new Set<string>();
  for (const row of routed) {
    if (!row.ready) continue;
    readyIds.add(row.model);
    const parsed = parseModelId(row.model);
    if (!parsed) continue;
    const current = readyByFamily.get(parsed.family);
    if (!current || parsed.generation > current.generation) {
      readyByFamily.set(parsed.family, { generation: parsed.generation, model: row.model });
    }
  }

  const out: SuccessorModel[] = [];
  const seen = new Set<string>();
  for (const id of listed) {
    if (readyIds.has(id) || seen.has(id)) continue;
    const parsed = parseModelId(id);
    if (!parsed) continue;
    const ready = readyByFamily.get(parsed.family);
    if (humanGatedFamily(id) !== undefined) {
      seen.add(id);
      out.push({ model: id, family: parsed.family, generation: parsed.generation, predecessor: ready?.model });
      continue;
    }
    if (!ready || parsed.generation <= ready.generation) continue;
    seen.add(id);
    out.push({ model: id, family: parsed.family, generation: parsed.generation, predecessor: ready.model });
  }
  return out;
}

/** Design (ii)'s three states, read off the SAME catalog snapshot {@link findSuccessors} used. */
export function classifySuccessor(model: string, catalog: Pick<CatalogSnapshot, "deployed" | "priced">): SuccessorState {
  if (!catalog.deployed.includes(model)) return "announced";
  if (!catalog.priced.includes(model)) return "deployed-unpriced";
  return "ready";
}

// ── One escalation per successor state, naming the exact next step ────────

const AZ_DEPLOY_COMMAND = (model: string): string =>
  `az cognitiveservices account deployment create --name <account> --resource-group <rg> ` +
  `--deployment-name ${model} --model-name ${model} --model-version latest --model-format OpenAI ` +
  `--sku-name GlobalStandard --sku-capacity 1`;

/**
 * Build the {@link Escalation} for one successor at one state — class MANUAL (mirrors
 * ops.ts's `buildAlertEscalation`: this loop never deploys, prices, or approves a model itself,
 * every one of those is an operator act that spends money or changes the account). `taskId` is
 * derived from the model id alone (not the state), so `escalate()`'s own dedup keys off it the
 * same way {@link import("./ops.js").alertTaskId} does for alerts — {@link watchSuccessorModels}
 * is the layer that decides WHETHER to call this at all for an unchanged state (design (iii)).
 */
export function buildSuccessorEscalation(successor: SuccessorModel, state: SuccessorState): Escalation {
  const gated = humanGatedFamily(successor.model);
  const relation = successor.predecessor
    ? `${successor.model} is a successor to routed model ${successor.predecessor} in the ${successor.family} family.`
    : `${successor.model} is newly listed in the ${successor.family} family, which no ladder row routes today.`;
  // DESIGN (iv): reported, never proposed for routing — this paragraph is the only thing that
  // changes for a gated family; the deploy/price next-step text below is unaffected, because
  // deploying or pricing a gated model is still a legitimate operator act, distinct from routing
  // it (model-gate.ts's HumanGatedModelError fires at LAUNCH time, not at deploy/price time).
  const gatedNote = gated
    ? `${successor.model} is in the human-gated ${gated} family (src/lib/model-gate.ts, operator ` +
      `ruling 2026-09-22): it is reported here but is NEVER proposed for automatic routing — only an ` +
      `explicit { model, approvedBy, approvedAt } entry in config.json's modelApprovals can allow it, ` +
      `regardless of this state.`
    : undefined;

  let summary: string;
  let nextStep: string;
  let recommendation: string;
  if (state === "announced") {
    summary = `${successor.model} is listed but not deployed`;
    nextStep = `deploy it: ${AZ_DEPLOY_COMMAND(successor.model)}`;
    recommendation = "deploy";
  } else if (state === "deployed-unpriced") {
    summary = `${successor.model} is deployed but has no published price row`;
    nextStep = `add its price row to OPENWEIGHT_PRICES in src/lib/worker-provider.ts, then the ladder ` +
      `switches to it automatically (W1-T4079) — nothing else to change.`;
    recommendation = "price";
  } else {
    summary = `${successor.model} is deployed and priced`;
    nextStep = gated
      ? `nothing is missing on the deploy/price axis — routing still needs the explicit operator approval named above.`
      : `nothing is missing — the ladder already switches to ${successor.model} over ` +
        `${successor.predecessor ?? "its predecessor"} automatically (W1-T4079).`;
    recommendation = "acknowledge";
  }

  return {
    class: "MANUAL",
    taskId: `model-successor-${successor.model}`,
    summary: `successor model: ${summary}`,
    detail: [relation, gatedNote, nextStep].filter((l): l is string => l !== undefined).join("\n\n"),
    options: [
      { label: recommendation, detail: nextStep },
      { label: "dismiss", detail: `record that ${successor.model} needs no action right now and dismiss this alert` },
    ],
    recommendation,
  };
}

// ── The orchestrator: one alert per successor STATE, ledgering every reading ──

export interface ModelAvailabilityDeps {
  /** The existing escalation path (design (iii)) — production passes `escalate` from
   *  escalate.ts directly; tests inject a call-counting fake, mirroring alert-lane.ts's
   *  `AlertLaneDeps.escalate`. */
  escalate: (e: Escalation) => string | Promise<string>;
  ledgerPath: string;
  runId: string;
  /** Injectable ledger reader (dedup source); defaults to {@link readLedgerLines}. */
  readLedger?: (path: string) => Array<Record<string, unknown>>;
}

export interface ModelAvailabilityAlertedEntry {
  successor: SuccessorModel;
  state: SuccessorState;
  issueUrl: string;
}

export interface ModelAvailabilityResult {
  alerted: ModelAvailabilityAlertedEntry[];
  /** A successor whose state matches its own most recent `model-availability.alerted` ledger
   *  line — design (iii): "never repeat for an unchanged state". */
  skippedUnchanged: Array<{ successor: SuccessorModel; state: SuccessorState }>;
}

/** The most recent state this exact model was alerted at, or `undefined` if never alerted. */
function priorAlertedState(lines: Array<Record<string, unknown>>, model: string): SuccessorState | undefined {
  let last: SuccessorState | undefined;
  for (const line of lines) {
    if (line.step === "model-availability.alerted" && line.model === model && typeof line.state === "string") {
      last = line.state as SuccessorState;
    }
  }
  return last;
}

/** The two outcomes of {@link watchSuccessorModelsBestEffort}: the watch ran, or it failed and
 *  the error is carried rather than rethrown. */
export type SuccessorWatchOutcome =
  | { status: "watched"; result: ModelAvailabilityResult }
  | { status: "failed"; error: unknown };

/**
 * The successor watch as the measurement cadence runs it (W1-T4080 design (i): on the cadence, not
 * per tick). BEST-EFFORT BY DESIGN, like every other read the cadence folds in: `watch` reads the
 * snapshot and runs {@link watchSuccessorModels}, and a throw from either is returned as
 * `{ status: "failed" }` rather than rethrown, so a catalog read or escalation failure never costs
 * the cadence the rest of its report.
 */
export async function watchSuccessorModelsBestEffort(
  watch: () => Promise<ModelAvailabilityResult>,
): Promise<SuccessorWatchOutcome> {
  try {
    return { status: "watched", result: await watch() };
  } catch (error) {
    return { status: "failed", error };
  }
}

/**
 * Run the watch over one catalog snapshot: find every successor, ledger the reading (ALWAYS —
 * design (iii)'s second half), and escalate exactly once per (model, state) pair.
 */
export async function watchSuccessorModels(
  catalog: CatalogSnapshot,
  routed: readonly RoutedLadderRow[],
  deps: ModelAvailabilityDeps,
): Promise<ModelAvailabilityResult> {
  const readLedger = deps.readLedger ?? readLedgerLines;
  const lines = readLedger(deps.ledgerPath);
  const successors = findSuccessors(catalog.listed, routed);

  const alerted: ModelAvailabilityAlertedEntry[] = [];
  const skippedUnchanged: ModelAvailabilityResult["skippedUnchanged"] = [];

  for (const successor of successors) {
    const state = classifySuccessor(successor.model, catalog);
    const taskId = `model-successor-${successor.model}`;
    appendLedger(deps.ledgerPath, {
      run_id: deps.runId,
      task_id: taskId,
      step: "model-availability.read",
      model: successor.model,
      family: successor.family,
      predecessor: successor.predecessor ?? null,
      state,
      gated: humanGatedFamily(successor.model) ?? null,
    });

    if (priorAlertedState(lines, successor.model) === state) {
      skippedUnchanged.push({ successor, state });
      continue;
    }

    const issueUrl = await deps.escalate(buildSuccessorEscalation(successor, state));
    appendLedger(deps.ledgerPath, {
      run_id: deps.runId,
      task_id: taskId,
      step: "model-availability.alerted",
      model: successor.model,
      state,
      issue_url: issueUrl,
    });
    alerted.push({ successor, state, issueUrl });
  }

  return { alerted, skippedUnchanged };
}

// ── Real reads (production wiring only; every fixture above injects its own) ──

/**
 * capability -> effort -> ordered candidate model ids, {@link Mounts.capabilities}'s own cash
 * shape (canonical `cash`, falling back to the deprecated `openweight` spelling — W1-T3607, the
 * SAME fallback `openWeightEndpoint` reads in worker-provider.ts).
 *
 * WHY THIS IS THE ONLY LADDER {@link findSuccessors} COMPARES AGAINST — this task's own worked
 * example, "gpt-6-luna for gpt-5.6-luna", and W1-T4079's automatic switch, are both about the
 * CASH/Azure ladder. A Codex-subscription model needs no separate deploy-or-price step (the
 * account simply lists it), so it can never sit in the "announced but not switched" state this
 * watch exists to surface, and never seeds a "ready" row here.
 */
export function routedLadderRows(
  mounts: Pick<Mounts, "capabilities">,
  ready: (model: string) => boolean = openWeightDeploymentReady,
): RoutedLadderRow[] {
  const table = mounts.capabilities?.cash ?? mounts.capabilities?.openweight ?? {};
  const rows: RoutedLadderRow[] = [];
  const seen = new Set<string>();
  for (const byEffort of Object.values(table)) {
    for (const candidates of Object.values(byEffort)) {
      for (const model of candidates) {
        if (seen.has(model)) continue;
        seen.add(model);
        rows.push({ model, ready: ready(model) });
      }
    }
  }
  return rows;
}

export interface CashCatalogReadDeps {
  fetchImpl?: typeof fetch;
  cashEndpoint?: string;
  apiKey?: string;
}

/** One best-effort GET against a cash data-plane listing endpoint (`openai/models` or
 *  `openai/deployments`) — a missing endpoint/key, a non-2xx status, or an unparseable body all
 *  read as "nothing observed" (empty array), never a thrown error: a catalog-watch read must
 *  never block the measurement cadence it rides (design (i)'s own framing — this is a READ, not
 *  the deploy/price act itself). */
async function cashListingIds(path: string, deps: Required<Pick<CashCatalogReadDeps, "fetchImpl">> & CashCatalogReadDeps): Promise<string[]> {
  if (!deps.cashEndpoint || !deps.apiKey) return [];
  try {
    const base = deps.cashEndpoint.endsWith("/") ? deps.cashEndpoint : `${deps.cashEndpoint}/`;
    const url = new URL(`${path}?api-version=2024-10-21`, base).toString();
    const response = await deps.fetchImpl(url, { headers: { "api-key": deps.apiKey } });
    if (!response.ok) return []; // non-2xx — reported nothing this reading, not an outage worth failing the cadence over
    const body = (await response.json()) as { data?: Array<Record<string, unknown>> };
    if (!Array.isArray(body.data)) return [];
    return body.data.map((row) => row.id).filter((id): id is string => typeof id === "string");
  } catch {
    return []; // network/parse failure — best-effort read, see this function's own doc
  }
}

/** The cash data-plane half of {@link CatalogSnapshot} (design (i)'s first read point):
 *  `openai/models` for `listed`, `openai/deployments` for `deployed`. Codex's own catalog (the
 *  second read point) is a documented gap — see this module's own header. */
export async function readCashCatalog(deps: CashCatalogReadDeps = {}): Promise<Pick<CatalogSnapshot, "listed" | "deployed">> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const [listed, deployed] = await Promise.all([
    cashListingIds("openai/models", { ...deps, fetchImpl }),
    cashListingIds("openai/deployments", { ...deps, fetchImpl }),
  ]);
  return { listed, deployed };
}

/** The full production snapshot: cash catalog reads plus the priced set {@link
 *  import("./worker-provider.js").OPENWEIGHT_PRICES} already tracks, and this account's cash
 *  ladder rows. `config.workerProviders?.cashEndpoint`/`OPENWEIGHT_API_KEY_ENV` unset (no cash
 *  provider configured) degrades to an empty catalog, never a thrown error — the same "read,
 *  never block" contract {@link readCashCatalog} documents. */
export async function readModelAvailabilitySnapshot(
  config: Config,
  mounts: Pick<Mounts, "capabilities">,
  fetchImpl?: typeof fetch,
): Promise<{ catalog: CatalogSnapshot; routed: RoutedLadderRow[] }> {
  const { listed, deployed } = await readCashCatalog({
    cashEndpoint: config.workerProviders?.cashEndpoint ?? config.workerProviders?.openweightEndpoint,
    apiKey: process.env[OPENWEIGHT_API_KEY_ENV],
    fetchImpl,
  });
  return {
    catalog: { listed, deployed, priced: Object.keys(OPENWEIGHT_PRICES) },
    routed: routedLadderRows(mounts),
  };
}
