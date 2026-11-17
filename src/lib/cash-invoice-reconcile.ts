import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile as readFileAsync, readdir as readdirAsync, stat as statAsync } from "node:fs/promises";
import { join } from "node:path";
import { cashDeploymentEndpoint, type Config } from "./config-schema.js";
import { appendLedger } from "./ledger.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { readLedgerUnionRecords, readLedgerUnionRecordsSync } from "./ledger-union.js";
import { spendRoleOf } from "./spend-rows.js";
import { isFoundryClaudeDeployment, OPENWEIGHT_PRICES, type OpenWeightPrice } from "./worker-provider.js";

/**
 * W1-T10858: AN OPEN-WEIGHT ARM CANNOT LEAD A CASH ROW ON A LIST PRICE.
 *
 * The fleet prices every cash request from {@link OPENWEIGHT_PRICES}. This module compares one UTC day of those
 * metered figures with what Azure billed, read from an Azure Cost Management actual-cost export file. The daemon
 * holds data-plane keys only, so the bill reaches it as a file; nothing here calls Azure.
 *
 * THE BAND IS MEASURED, NEVER A CONSTANT. The acceptable divergence for a day is the largest divergence among that
 * same day's control deployments: the rows that carry `unbilledAzureOpenAi429` (the Azure OpenAI family, whose
 * billing is not disputed). A control counts only when it carried traffic, its receipts are complete and the export
 * has rows for it. A day with no control decides nothing: every open-weight deployment is `unreconcilable`.
 *
 * A deployment with no traffic on the day stays `unreconcilable`. A reconciliation never sends a request to create
 * traffic.
 */

export const CASH_INVOICE_RECONCILED_STEP = "cash.invoice.reconciled" as const;
const CASH_INVOICE_RECONCILE_FAILED_STEP = "cash.invoice.reconcile_failed" as const;
/** Where the operator puts actual-cost export files, under the state directory. */
export const COST_EXPORTS_DIR = "cost-exports";

export type CashInvoiceMeter = "input" | "cached input" | "output";
const METERS: readonly CashInvoiceMeter[] = ["input", "cached input", "output"];

/**
 * The meter-name stem Azure gives a deployment's model, where it is not the deployment id itself. An export row
 * belongs to a deployment when its account matches the deployment's endpoint account and its normalised meter name
 * starts with the normalised stem. Read from the Azure Retail Prices API meter names (2026-10-27). A wrong or
 * missing stem matches no rows, and the deployment then reads `unreconcilable: no export rows`, never `reconciled`.
 */
const INVOICE_METER_STEMS: Readonly<Record<string, string>> = {
  "DeepSeek-V4-Flash": "V4 Flash",
  "DeepSeek-V4.1-Flash": "V4.1 Flash",
  "Kimi-K2.6": "K2.6",
};

export interface CashInvoiceMeterFigure {
  meter: CashInvoiceMeter;
  meteredUsd: number;
  billedUsd: number;
  /** |billed - metered| / metered. `null` when something was billed and nothing was metered: unbounded. */
  divergence: number | null;
}

export interface CashInvoiceDeploymentFigures {
  deployment: string;
  /** True when the price row carries `unbilledAzureOpenAi429`: a control, never verdicted. */
  control: boolean;
  receipts: number;
  incompleteReceipts: number;
  exportRows: number;
  meters: CashInvoiceMeterFigure[];
}

export type CashInvoiceVerdict =
  | { verdict: "reconciled" }
  | { verdict: "diverged"; meter: CashInvoiceMeter; meteredUsd: number; billedUsd: number; divergence: number | null }
  | { verdict: "unreconcilable"; reason: "no traffic" | "no control" | "no export rows" | "incomplete receipts" };

export type CashInvoiceDeploymentVerdict = CashInvoiceDeploymentFigures & CashInvoiceVerdict;

export interface CashInvoiceReconciliation {
  day: string;
  /** The largest control divergence of the day; `null` when no control qualified. */
  band: number | null;
  controls: CashInvoiceDeploymentFigures[];
  verdicts: CashInvoiceDeploymentVerdict[];
  /** Export rows on the day that no priced deployment claimed, or whose meter is neither input, cached nor output. */
  unattributedExportRows: number;
}

export interface CashInvoiceInput {
  /** The UTC day, YYYY-MM-DD. */
  day: string;
  /** Ledger rows; only produced cash receipts stamped on `day` are read. */
  receipts: readonly Record<string, unknown>[];
  /** The Azure Cost Management actual-cost export, CSV text. */
  exportCsv: string;
  /** Deployment to Azure account name (the endpoint's first host label). A deployment not named here is matched on
   *  its meter name alone. */
  accounts?: Readonly<Record<string, string>>;
  prices?: Readonly<Record<string, OpenWeightPrice>>;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const normalise = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const finite = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** RFC 4180 rows: quoted fields, doubled quotes, CRLF or LF. A leading byte-order mark is dropped. */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quoted) {
      if (c === "\"" && body[i + 1] === "\"") { field += "\""; i++; }
      else if (c === "\"") quoted = false;
      else field += c;
    } else if (c === "\"") quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && body[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((cell) => cell !== "")) rows.push(row);
  return rows;
}

interface ExportRow { day: string; account: string; meterName: string; costUsd: number }

/** The export's own day for a row: ISO `YYYY-MM-DD...` or US `MM/DD/YYYY`. */
function exportDay(raw: string): string | undefined {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim());
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(raw.trim());
  return us ? `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}` : undefined;
}

/** Parse an actual-cost export. Refuses, by name, a file without the columns it needs or billed in another
 *  currency than US dollars, because the price table is in US dollars. */
function parseCostExport(text: string): ExportRow[] {
  const [header, ...body] = csvRows(text);
  if (!header) throw new Error("cost export is empty");
  const names = header.map((name) => name.trim().toLowerCase());
  const column = (...candidates: string[]): number => {
    for (const candidate of candidates) { const at = names.indexOf(candidate); if (at >= 0) return at; }
    return -1;
  };
  const date = column("date", "usagedate", "usagedatetime");
  const resource = column("resourceid", "instanceid", "instancename");
  const meter = column("metername");
  const usd = column("costinusd");
  const billing = column("costinbillingcurrency", "pretaxcost", "cost");
  const currency = column("billingcurrency", "billingcurrencycode", "currency");
  const missing = [date < 0 ? "Date" : "", resource < 0 ? "ResourceId" : "", meter < 0 ? "MeterName" : "",
    usd < 0 && billing < 0 ? "CostInUsd or CostInBillingCurrency" : ""].filter(Boolean);
  if (missing.length > 0) throw new Error(`cost export lacks the column(s) ${missing.join(", ")}`);
  return body.map((cells, index) => {
    const day = exportDay(cells[date] ?? "");
    if (!day) throw new Error(`cost export row ${index + 2} has an unreadable date ${JSON.stringify(cells[date] ?? "")}`);
    if (usd < 0 && currency >= 0 && (cells[currency] ?? "").trim() !== "" && (cells[currency] ?? "").trim().toUpperCase() !== "USD")
      throw new Error(`cost export row ${index + 2} is billed in ${cells[currency]}, not USD, and has no CostInUsd column`);
    const cost = Number((cells[usd >= 0 ? usd : billing] ?? "").trim());
    if (!Number.isFinite(cost)) throw new Error(`cost export row ${index + 2} has an unreadable cost`);
    const id = (cells[resource] ?? "").trim();
    return { day, account: (/\/accounts\/([^/]+)/i.exec(id)?.[1] ?? id.split("/").pop() ?? "").toLowerCase(),
      meterName: cells[meter] ?? "", costUsd: cost };
  });
}

function meterOf(meterName: string): CashInvoiceMeter | undefined {
  const words = new Set(normalise(meterName).split(" "));
  if (words.has("cached") || words.has("cache") || words.has("cchd")) return "cached input";
  if (words.has("outp") || words.has("output") || words.has("out")) return "output";
  if (words.has("inp") || words.has("input") || words.has("in")) return "input";
  return undefined;
}

/** The metered dollars of one receipt row, split by meter. Cached tokens go to the input meter when the row prices
 *  no separate cached rate; cache writes are input. */
function meteredRow(deployment: string, price: OpenWeightPrice, tokens: Record<string, unknown>): Record<CashInvoiceMeter, number> {
  const input = finite(tokens.input);
  const cached = finite(tokens.cacheRead);
  const written = finite(tokens.cacheCreation);
  // Foundry Claude reports uncached input apart from cache reads and writes; the chat adapters include both in it.
  const uncached = isFoundryClaudeDeployment(deployment) ? input : Math.max(0, input - cached - written);
  const prompt = uncached + cached + written;
  const rate = price.longContext && (price.longContext.thresholdInputTokens < 0 || prompt > price.longContext.thresholdInputTokens)
    ? price.longContext : price;
  const cachedRate = rate.cachedInputUsdPerMillion ?? price.cachedInputUsdPerMillion;
  return {
    input: (uncached * rate.inputUsdPerMillion + written * (rate.cacheWriteUsdPerMillion ?? rate.inputUsdPerMillion) +
      (cachedRate === undefined ? cached * rate.inputUsdPerMillion : 0)) / 1_000_000,
    "cached input": cachedRate === undefined ? 0 : cached * cachedRate / 1_000_000,
    output: finite(tokens.output) * rate.outputUsdPerMillion / 1_000_000,
  };
}

/** A produced cash receipt row: the unit the reconciler meters. */
function cashReceipt(row: Record<string, unknown>): boolean {
  return row.provider === "cash" && typeof row.model === "string" && spendRoleOf(row) === "produced" &&
    row.tokens !== null && typeof row.tokens === "object";
}

export function reconcileCashInvoice(input: CashInvoiceInput): CashInvoiceReconciliation {
  if (!DAY.test(input.day)) throw new Error(`reconcile day must be YYYY-MM-DD, got ${JSON.stringify(input.day)}`);
  const prices = input.prices ?? OPENWEIGHT_PRICES;
  const exported = parseCostExport(input.exportCsv).filter((row) => row.day === input.day);
  const claimed = new Set<ExportRow>();
  const figures = Object.keys(prices).sort().map((deployment): CashInvoiceDeploymentFigures => {
    const price = prices[deployment]!;
    const metered: Record<CashInvoiceMeter, number> = { input: 0, "cached input": 0, output: 0 };
    const billed: Record<CashInvoiceMeter, number> = { input: 0, "cached input": 0, output: 0 };
    let receipts = 0;
    let incompleteReceipts = 0;
    for (const row of input.receipts) {
      if (row.model !== deployment || !cashReceipt(row) || String(row.ts ?? "").slice(0, 10) !== input.day) continue;
      receipts++;
      if (row.token_usage_state === "partial" || row.token_usage_state === "unavailable") incompleteReceipts++;
      const split = meteredRow(deployment, price, row.tokens as Record<string, unknown>);
      for (const meter of METERS) metered[meter] += split[meter];
    }
    const stem = normalise(INVOICE_METER_STEMS[deployment] ?? deployment);
    const account = input.accounts?.[deployment]?.toLowerCase();
    let exportRows = 0;
    for (const row of exported) {
      const meter = meterOf(row.meterName);
      const name = normalise(row.meterName);
      if (!meter || !(name === stem || name.startsWith(`${stem} `)) || (account !== undefined && row.account !== account)) continue;
      claimed.add(row);
      exportRows++;
      billed[meter] += row.costUsd;
    }
    const meters = METERS.filter((meter) => metered[meter] > 0 || billed[meter] > 0).map((meter) => ({
      meter, meteredUsd: metered[meter], billedUsd: billed[meter],
      divergence: metered[meter] > 0 ? Math.abs(billed[meter] - metered[meter]) / metered[meter] : null,
    }));
    return { deployment, control: price.unbilledAzureOpenAi429 === true, receipts, incompleteReceipts, exportRows, meters };
  });
  const traffic = (f: CashInvoiceDeploymentFigures): boolean => f.meters.some((m) => m.meteredUsd > 0);
  const controls = figures.filter((f) => f.control && traffic(f) && f.incompleteReceipts === 0 && f.exportRows > 0);
  // Only metered meters set the band: a control meter billed with nothing metered has no ratio to offer.
  const spreads = controls.flatMap((f) => f.meters.flatMap((m) => m.divergence === null ? [] : [m.divergence]));
  const band = controls.length > 0 && spreads.length > 0 ? Math.max(...spreads) : null;
  const verdicts = figures.filter((f) => !f.control).map((f): CashInvoiceDeploymentVerdict => {
    if (!traffic(f)) return { ...f, verdict: "unreconcilable", reason: "no traffic" };
    if (f.incompleteReceipts > 0) return { ...f, verdict: "unreconcilable", reason: "incomplete receipts" };
    if (f.exportRows === 0) return { ...f, verdict: "unreconcilable", reason: "no export rows" };
    if (band === null) return { ...f, verdict: "unreconcilable", reason: "no control" };
    const worst = [...f.meters].sort((a, b) => (b.divergence ?? Infinity) - (a.divergence ?? Infinity))[0]!;
    if (worst.divergence === null || worst.divergence > band)
      return { ...f, verdict: "diverged", meter: worst.meter, meteredUsd: worst.meteredUsd, billedUsd: worst.billedUsd, divergence: worst.divergence };
    return { ...f, verdict: "reconciled" };
  });
  return { day: input.day, band, controls, verdicts, unattributedExportRows: exported.filter((row) => !claimed.has(row)).length };
}

/** The produced cash receipts from the day's start onward; the reconciler keeps the day itself. Refuses an
 *  incomplete ledger union, because a missing rotation would read as missing traffic. */
export async function readCashInvoiceReceipts(stateDir: string, day: string): Promise<Record<string, unknown>[]> {
  if (!DAY.test(day)) throw new Error(`reconcile day must be YYYY-MM-DD, got ${JSON.stringify(day)}`);
  const unread: string[] = [];
  const rows = await readLedgerUnionRecords(stateDir, { since: `${day}T00:00:00.000Z`,
    where: (row) => cashReceipt(row) && String(row.ts ?? "").slice(0, 10) === day,
    onUnreadArchive: (path) => unread.push(path), onUnreadLive: (path) => unread.push(path),
    onUnreadDirectory: (path) => unread.push(path) });
  if (unread.length > 0) throw new Error(`cash receipts ledger unreadable: ${unread.join(", ")}`);
  return rows;
}

/** The same fail-closed receipt view, streamed through the daemon's async ledger reader. */
export async function readCashInvoiceReceiptsAsync(stateDir: string, day: string): Promise<Record<string, unknown>[]> {
  if (!DAY.test(day)) throw new Error(`reconcile day must be YYYY-MM-DD, got ${JSON.stringify(day)}`);
  const unread: string[] = [];
  const rows = await readLedgerUnionRecords(stateDir, { since: `${day}T00:00:00.000Z`,
    where: (row) => cashReceipt(row) && String(row.ts ?? "").slice(0, 10) === day,
    onUnreadArchive: (path) => unread.push(path), onUnreadLive: (path) => unread.push(path),
    onUnreadDirectory: (path) => unread.push(path) });
  if (unread.length > 0) throw new Error(`cash receipts ledger unreadable: ${unread.join(", ")}`);
  return rows;
}

/** Each priced deployment's Azure account name, from the first host label of its configured cash endpoint. */
export function cashInvoiceAccounts(config: Pick<Config, "workerProviders">): Record<string, string> {
  const accounts: Record<string, string> = {};
  for (const deployment of Object.keys(OPENWEIGHT_PRICES)) {
    const endpoint = cashDeploymentEndpoint(config, deployment);
    if (endpoint === undefined) continue;
    let host: string;
    try { host = new URL(endpoint).hostname; }
    catch {
      // A malformed endpoint names no account; the deployment is then matched on its meter name alone.
      continue;
    }
    accounts[deployment] = host.split(".")[0]!;
  }
  return accounts;
}

export function costExportDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** One `cash.invoice.reconciled` row per open-weight deployment and day. */
export function recordCashInvoiceVerdicts(stateDir: string, result: CashInvoiceReconciliation,
  source: Pick<CostExportSource, "path" | "digest">, runId: string): void {
  for (const verdict of result.verdicts) {
    appendLedger(join(stateDir, LEDGER_FILENAME), { run_id: runId, task_id: `cash-invoice-${result.day}`,
      step: CASH_INVOICE_RECONCILED_STEP, day: result.day, deployment: verdict.deployment, verdict,
      band: result.band, controls: result.controls, unattributed_export_rows: result.unattributedExportRows,
      export_file: source.path, export_digest: source.digest });
  }
}

export function recordCashInvoiceFailure(stateDir: string, day: string, source: Pick<CostExportSource, "path" | "digest">, runId: string, error: unknown): void {
  appendLedger(join(stateDir, LEDGER_FILENAME), { run_id: runId, task_id: `cash-invoice-${day}`,
    step: CASH_INVOICE_RECONCILE_FAILED_STEP, day, export_file: source.path, export_digest: source.digest,
    reason: error instanceof Error ? error.message : String(error) });
}

export interface CostExportSource { path: string; digest: string; text: string }
export type CostExportCandidate = CostExportSource & ({ day: string } | { refused: string });

/**
 * The measurement cadence's input: the newest `.csv` under `<state>/cost-exports/` (by modification time), and the
 * newest UTC day in it before `today` (today is not over). `undefined` when there is no directory or file, when the
 * file has no such day, or when that day and file were already reconciled; so each day and file runs once. A file the
 * parser refuses comes back once as `refused`, so the cadence ledgers why, and is not read again until it changes.
 */
export async function newestCostExport(stateDir: string, today: string, read: (path: string) => string): Promise<CostExportCandidate | undefined> {
  const dir = join(stateDir, COST_EXPORTS_DIR);
  if (!existsSync(dir)) return undefined;
  const newest = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((name) => name.toLowerCase().endsWith(".csv"))
    .map((name) => join(dir, name)).map((path) => ({ path, stat: statSync(path) })).filter((file) => file.stat.isFile())
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || b.path.localeCompare(a.path))[0];
  if (!newest) return undefined;
  const text = read(newest.path);
  const digest = costExportDigest(text);
  const history = (await readLedgerUnionRecords(stateDir, { step: [CASH_INVOICE_RECONCILED_STEP, CASH_INVOICE_RECONCILE_FAILED_STEP] }))
    .filter((row) => row.export_digest === digest);
  let days: string[];
  try { days = parseCostExport(text).map((row) => row.day); }
  catch (error) {
    if (history.some((row) => row.step === CASH_INVOICE_RECONCILE_FAILED_STEP)) return undefined;
    return { path: newest.path, digest, text, refused: error instanceof Error ? error.message : String(error) };
  }
  const day = days.filter((d) => d < today).sort().pop();
  if (day === undefined || history.some((row) => row.day === day)) return undefined;
  return { path: newest.path, digest, text, day };
}

/** The daemon-loop variant of {@link newestCostExport}; directory, export and ledger reads are asynchronous. */
export async function newestCostExportAsync(stateDir: string, today: string): Promise<CostExportCandidate | undefined> {
  const dir = join(stateDir, COST_EXPORTS_DIR);
  let names: string[];
  try { names = await csvPaths(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const files = await Promise.all(names.map(async (path) => ({ path, stat: await statAsync(path) })));
  const newest = files.filter((file) => file.stat.isFile())
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || b.path.localeCompare(a.path))[0];
  if (!newest) return undefined;
  const text = await readFileAsync(newest.path, "utf8");
  const digest = costExportDigest(text);
  const unread: string[] = [];
  const history = (await readLedgerUnionRecords(stateDir, { step: [CASH_INVOICE_RECONCILED_STEP, CASH_INVOICE_RECONCILE_FAILED_STEP],
    onUnreadArchive: (path) => unread.push(path), onUnreadLive: (path) => unread.push(path),
    onUnreadDirectory: (path) => unread.push(path) }));
  if (unread.length > 0) throw new Error(`cash invoice history ledger unreadable: ${unread.join(", ")}`);
  let days: string[];
  try { days = parseCostExport(text).map((row) => row.day); }
  catch (error) {
    if (history.some((row) => row.export_digest === digest && row.step === CASH_INVOICE_RECONCILE_FAILED_STEP)) return undefined;
    return { path: newest.path, digest, text, refused: error instanceof Error ? error.message : String(error) };
  }
  const day = days.filter((d) => d < today).sort().pop();
  if (day === undefined || history.some((row) => row.export_digest === digest && row.day === day)) return undefined;
  return { path: newest.path, digest, text, day };
}

async function csvPaths(dir: string): Promise<string[]> {
  const paths: string[] = [];
  const entries = await readdirAsync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) paths.push(...await csvPaths(path));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".csv")) paths.push(path);
  }
  return paths;
}

export interface InvoiceVerdictRead {
  /** False when a ledger rotation could not be read; every open-weight arm is then not eligible to lead. */
  ok: boolean;
  unread: string[];
  /** Each deployment's newest `cash.invoice.reconciled` row, by day and then by write time. */
  newest: Map<string, Record<string, unknown>>;
}

export async function readNewestInvoiceVerdicts(stateDir: string): Promise<InvoiceVerdictRead> {
  const unread: string[] = [];
  const rows = await readLedgerUnionRecords(stateDir, { step: CASH_INVOICE_RECONCILED_STEP,
    onUnreadArchive: (path) => unread.push(path), onUnreadLive: (path) => unread.push(path),
    onUnreadDirectory: (path) => unread.push(path) });
  const newest = new Map<string, Record<string, unknown>>();
  const order = (row: Record<string, unknown>): string => `${String(row.day ?? "")} ${String(row.ts ?? "")}`;
  for (const row of rows) {
    if (typeof row.deployment !== "string") continue;
    const prior = newest.get(row.deployment);
    if (prior === undefined || order(row) >= order(prior)) newest.set(row.deployment, row);
  }
  return { ok: unread.length === 0, unread, newest };
}

/** Async variant for the daemon cadence's deployment bake-off. */
export async function readNewestInvoiceVerdictsAsync(stateDir: string): Promise<InvoiceVerdictRead> {
  const unread: string[] = [];
  const rows = await readLedgerUnionRecords(stateDir, { step: CASH_INVOICE_RECONCILED_STEP,
    onUnreadArchive: (path) => unread.push(path), onUnreadLive: (path) => unread.push(path),
    onUnreadDirectory: (path) => unread.push(path) });
  const newest = new Map<string, Record<string, unknown>>();
  const order = (row: Record<string, unknown>): string => `${String(row.day ?? "")} ${String(row.ts ?? "")}`;
  for (const row of rows) {
    if (typeof row.deployment !== "string") continue;
    const prior = newest.get(row.deployment);
    if (prior === undefined || order(row) >= order(prior)) newest.set(row.deployment, row);
  }
  return { ok: unread.length === 0, unread, newest };
}

/** An arm is open-weight when its deployment's price row does not carry `unbilledAzureOpenAi429`. */
function isOpenWeightArm(model: string, prices: Readonly<Record<string, OpenWeightPrice>> = OPENWEIGHT_PRICES): boolean {
  return prices[model]?.unbilledAzureOpenAi429 !== true;
}

const percent = (value: unknown): string => typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "unbounded (billed with nothing metered)";
const usd = (value: unknown): string => typeof value === "number" ? `$${value.toFixed(4)}` : "unknown";

function verdictText(row: Record<string, unknown> | undefined): { eligible: boolean; text: string } {
  const verdict = row?.verdict as (CashInvoiceVerdict & Partial<CashInvoiceDeploymentFigures>) | undefined;
  if (!row || !verdict) return { eligible: false, text: "no invoice verdict yet" };
  const day = String(row.day);
  if (verdict.verdict === "reconciled") {
    const worst = Math.max(0, ...(verdict.meters ?? []).map((m) => m.divergence ?? 0));
    return { eligible: true, text: `reconciled on ${day}: largest divergence ${percent(worst)} inside the control band ${percent(row.band)}` };
  }
  if (verdict.verdict === "diverged") {
    return { eligible: false, text: `diverged on ${day}: ${verdict.meter} metered ${usd(verdict.meteredUsd)}, billed ${usd(verdict.billedUsd)}, ` +
      `divergence ${percent(verdict.divergence)} outside the control band ${percent(row.band)}` };
  }
  return { eligible: false, text: `unreconcilable on ${day}: ${verdict.reason}` };
}

/**
 * The bake-off proposal's lead-eligibility lines. An open-weight cash arm is "not eligible to lead" unless its
 * deployment's newest invoice verdict is `reconciled`; each line states the verdict and its figures. Ranking and
 * routing are not changed. Empty when no open-weight cash arm ran.
 */
export function invoiceLeadEligibility(rows: readonly { candidate: string; label: string; billing: string; status?: string }[],
  verdicts: InvoiceVerdictRead): string {
  const lines = rows.filter((row) => row.billing === "cash" && row.status !== "capacity_shortfall").flatMap((row) => {
    if (!row.candidate.startsWith("cash:")) return [];
    const model = row.candidate.slice("cash:".length, row.candidate.lastIndexOf(":"));
    if (!isOpenWeightArm(model)) return [];
    const state = verdicts.ok ? verdictText(verdicts.newest.get(model))
      : { eligible: false, text: `invoice verdicts unreadable (${verdicts.unread.join(", ")})` };
    return [`- ${state.eligible ? "eligible to lead" : "not eligible to lead"}: ${row.label} — ${state.text}`];
  });
  if (lines.length === 0) return "";
  return ["Lead eligibility: an open-weight arm leads a cash row only after its newest invoice verdict is reconciled (W1-T10858).", ...lines].join("\n");
}
