import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CASH_INVOICE_RECONCILED_STEP, COST_EXPORTS_DIR, cashInvoiceAccounts, invoiceLeadEligibility, readNewestInvoiceVerdicts, reconcileCashInvoice,
  recordCashInvoiceVerdicts, type CashInvoiceDeploymentVerdict } from "#src/lib/cash-invoice-reconcile.js";
import { runDeploymentBakeoff, type DeployedModel, type DeploymentBakeoffCandidate } from "#src/lib/bakeoff-trigger.js";
import { renderBakeoff, type BakeoffRow } from "#src/lib/inbox-bakeoff.js";
import type { Config } from "#src/lib/config.js";
import { buildMeasurementCadenceDaemonHooks, cashReconcileCommand } from "#test/helpers/run-task-test.js";

type Row = Record<string, unknown>;
const day = "2026-11-14";
const account = "fleet-east";
const resource = (name = account) => `/subscriptions/0000/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/${name}`;
const accounts = { "gpt-5-nano": account, "DeepSeek-V4-Flash": account, "Kimi-K2.6": account };

function receipt(model: string, tokens: { input: number; output: number; cacheRead?: number }, at = `${day}T10:00:00.000Z`): Row {
  return { ts: at, run_id: "R", task_id: "W1-T1", step: "implement.done", provider: "cash", model, billing_mode: "api",
    tokens: { input: tokens.input, output: tokens.output, cacheRead: tokens.cacheRead ?? 0, cacheCreation: 0 }, total_cost_usd: 0.5 };
}
function csv(rows: Array<[string, string, string, number]>): string {
  return ["Date,ResourceId,MeterName,CostInBillingCurrency,BillingCurrency",
    ...rows.map(([date, id, meter, cost]) => `${date},${id},"${meter}",${cost},USD`)].join("\r\n") + "\r\n";
}
// gpt-5-nano (control): 2M input at $0.05, 1M output at $0.40 = $0.10 and $0.40 metered.
const nano = receipt("gpt-5-nano", { input: 2_000_000, output: 1_000_000 });
// DeepSeek-V4-Flash: 1M uncached input at $0.19, 1M cached at $0.028, 1M output at $0.51.
const deepseek = receipt("DeepSeek-V4-Flash", { input: 2_000_000, cacheRead: 1_000_000, output: 1_000_000 });
const controlBill = (inputUsd: number, outputUsd: number, date = day): Array<[string, string, string, number]> => [
  [date, resource(), "gpt-5-nano Inp glbl Tokens", inputUsd], [date, resource(), "gpt-5-nano Outp glbl Tokens", outputUsd]];
const deepseekBill = (input: number, cached: number, output: number): Array<[string, string, string, number]> => [
  [day, resource(), "V4 Flash Inp glbl Tokens", input], [day, resource(), "V4 Flash cached glbl Tokens", cached],
  [day, resource(), "V4 Flash Outp glbl Tokens", output]];
const verdictOf = (verdicts: CashInvoiceDeploymentVerdict[], deployment: string) => verdicts.find((v) => v.deployment === deployment)!;
const close = (actual: number | null | undefined, expected: number, label: string) =>
  assert.ok(actual !== null && actual !== undefined && Math.abs(actual - expected) < 1e-9, `${label}: ${actual} is not ${expected}`);

test("W1-T10858: a day is reconciled per deployment and meter against the actual-cost export", () => {
  const result = reconcileCashInvoice({ day, accounts,
    receipts: [nano, deepseek, receipt("DeepSeek-V4-Flash", { input: 9_000_000, output: 9_000_000 }, "2026-11-13T23:59:59.000Z"),
      { ...deepseek, provider: "codex" }, { ...deepseek, step: "verdict" }],
    exportCsv: csv([...controlBill(0.102, 0.396), ...deepseekBill(0.1919, 0.02828, 0.5151),
      ["2026-11-13", resource(), "V4 Flash Outp glbl Tokens", 50],
      [day, resource("another-account"), "V4 Flash Outp glbl Tokens", 50],
      [day, resource(), "V4.1 Flash Outp glbl Tokens", 50]]) });
  const flash = verdictOf(result.verdicts, "DeepSeek-V4-Flash");
  assert.equal(flash.receipts, 1, "only the day's produced cash receipt is metered");
  assert.equal(flash.exportRows, 3, "only the day's rows for this account and this model's meters are billed to it");
  assert.deepEqual(flash.meters.map((m) => m.meter), ["input", "cached input", "output"]);
  for (const [meter, metered, billed] of [["input", 0.19, 0.1919], ["cached input", 0.028, 0.02828], ["output", 0.51, 0.5151]] as const) {
    const figure = flash.meters.find((m) => m.meter === meter)!;
    close(figure.meteredUsd, metered, `${meter} metered`);
    close(figure.billedUsd, billed, `${meter} billed`);
    close(figure.divergence, 0.01, `${meter} divergence`);
  }
  assert.equal(flash.verdict, "reconciled");
  assert.deepEqual(result.controls.map((c) => c.deployment), ["gpt-5-nano"]);
  close(result.controls[0]!.meters.find((m) => m.meter === "input")!.meteredUsd, 0.1, "control input metered");
  assert.equal(result.unattributedExportRows, 1, "the other account's row is nobody's on this day");
  assert.equal(verdictOf(result.verdicts, "DeepSeek-V4.1-Flash").exportRows, 1, "the V4.1 meter belongs to V4.1, never to V4");
  assert.ok(!result.verdicts.some((v) => v.deployment === "gpt-5-nano"), "a control is measured, never verdicted");
});

test("W1-T10858: the noise band comes from the same day controls and no control decides nothing", () => {
  const flashAt3 = deepseekBill(0.1957, 0.02884, 0.5253);
  const wide = reconcileCashInvoice({ day, accounts, receipts: [nano, deepseek], exportCsv: csv([...controlBill(0.105, 0.4), ...flashAt3]) });
  close(wide.band, 0.05, "band is the largest control divergence");
  assert.equal(verdictOf(wide.verdicts, "DeepSeek-V4-Flash").verdict, "reconciled", "3% inside a 5% control band");
  const narrow = reconcileCashInvoice({ day, accounts, receipts: [nano, deepseek], exportCsv: csv([...controlBill(0.102, 0.4), ...flashAt3]) });
  close(narrow.band, 0.02, "the same arm against a 2% control band");
  const diverged = verdictOf(narrow.verdicts, "DeepSeek-V4-Flash");
  assert.equal(diverged.verdict, "diverged");
  assert.ok(diverged.verdict === "diverged" && diverged.divergence !== null && diverged.divergence > 0.02);
  const cached = reconcileCashInvoice({ day, accounts, receipts: [nano, deepseek],
    exportCsv: csv([...controlBill(0.102, 0.4), ...deepseekBill(0.19, 10, 0.51)]) });
  const blown = verdictOf(cached.verdicts, "DeepSeek-V4-Flash");
  assert.ok(blown.verdict === "diverged");
  assert.equal(blown.meter, "cached input");
  close(blown.meteredUsd, 0.028, "names the metered figure");
  close(blown.billedUsd, 10, "names the billed figure");
  // No traffic is never reconciled, even on a day with a control.
  const idle = verdictOf(wide.verdicts, "Kimi-K2.6");
  assert.ok(idle.verdict === "unreconcilable" && idle.reason === "no traffic");
  // No control traffic on the day: the control's export rows and a control receipt from another day decide nothing.
  const lonely = reconcileCashInvoice({ day, accounts, receipts: [deepseek, receipt("gpt-5-nano", { input: 1, output: 1 }, "2026-11-13T10:00:00.000Z")],
    exportCsv: csv([...controlBill(0.1, 0.4), ...deepseekBill(0.19, 0.028, 0.51)]) });
  assert.equal(lonely.band, null);
  assert.deepEqual(lonely.controls, []);
  const undecided = verdictOf(lonely.verdicts, "DeepSeek-V4-Flash");
  assert.equal(undecided.verdict, "unreconcilable");
  assert.ok(undecided.verdict === "unreconcilable" && undecided.reason === "no control");
  // A control with traffic but no export rows sets no band either.
  const unbilled = reconcileCashInvoice({ day, accounts, receipts: [nano, deepseek], exportCsv: csv(deepseekBill(0.19, 0.028, 0.51)) });
  assert.equal(unbilled.band, null);
  assert.equal(verdictOf(unbilled.verdicts, "DeepSeek-V4-Flash").verdict, "unreconcilable");
  // An arm with traffic and no export rows of its own is unreconcilable, not reconciled.
  const missing = reconcileCashInvoice({ day, accounts, receipts: [nano, deepseek], exportCsv: csv(controlBill(0.102, 0.4)) });
  const absent = verdictOf(missing.verdicts, "DeepSeek-V4-Flash");
  assert.ok(absent.verdict === "unreconcilable" && absent.reason === "no export rows");
});

const incumbent: DeploymentBakeoffCandidate = { id: "incumbent", label: "incumbent", model: "sonnet", billing: "subscription", tools: true };
const deployed: DeployedModel[] = ["DeepSeek-V4-Flash", "Kimi-K2.6", "gpt-5-nano"].map((model) => ({ model, billing: "cash", efforts: [] }));
const scored = (candidates: readonly DeploymentBakeoffCandidate[]): BakeoffRow[] => candidates.map((c, i) => ({
  candidate: c.id, label: c.label, billing: c.billing, proposals: 1, drafted: 1, clean: 1, contractErrors: 0, truncated: 0,
  otherErrors: 0, syntheses: 0, cashUsd: c.billing === "cash" ? 0.01 * (i + 1) : 0, notionalUsd: 0, wallMs: 1000,
  cleanPerDollar: c.billing === "cash" ? 100 / (i + 1) : null }));

async function proposalFor(stateDir: string): Promise<{ summary: string; rows: BakeoffRow[] }> {
  let rows: BakeoffRow[] = [];
  const [proposal] = await runDeploymentBakeoff({ stateDir, deployed, incumbent, replay: async (candidates) => (rows = scored(candidates)) });
  return { summary: proposal!.summary, rows };
}

test("W1-T10858: an unreconciled open-weight arm is not eligible to lead", async () => {
  const fresh = mkdtempSync(join(tmpdir(), "rmd-invoice-lead-none-"));
  const judged = mkdtempSync(join(tmpdir(), "rmd-invoice-lead-judged-"));
  try {
    const none = await proposalFor(fresh);
    assert.ok(none.summary.includes(renderBakeoff(none.rows)), "the ranking table is unchanged");
    assert.match(none.summary, /not eligible to lead: cash DeepSeek-V4-Flash \(thinking off\) — no invoice verdict yet/);
    assert.match(none.summary, /not eligible to lead: cash Kimi-K2\.6 \(thinking off\) — no invoice verdict yet/);
    assert.doesNotMatch(none.summary, /eligible to lead: cash gpt-5-nano/, "an Azure OpenAI arm is not held");
    assert.doesNotMatch(none.summary, /- eligible to lead/);

    const kimi = receipt("Kimi-K2.6", { input: 1_000_000, output: 100_000 });
    const result = reconcileCashInvoice({ day, accounts, receipts: [nano, deepseek, kimi],
      exportCsv: csv([...controlBill(0.102, 0.4), ...deepseekBill(0.19, 10, 0.51),
        [day, resource(), "K2.6 Thinking Inp glbl Tokens", 0.9595], [day, resource(), "K2.6 Thinking Outp glbl Tokens", 0.404]]) });
    recordCashInvoiceVerdicts(judged, result, { path: "export.csv", digest: "d1" }, "CASH-INVOICE-test");
    const held = await proposalFor(judged);
    assert.match(held.summary, /not eligible to lead: cash DeepSeek-V4-Flash \(thinking off\) — diverged on 2026-11-14: cached input metered \$0\.0280, billed \$10\.0000, divergence [0-9.]+% outside the control band 2\.0%/);
    assert.match(held.summary, /- eligible to lead: cash Kimi-K2\.6 \(thinking off\) — reconciled on 2026-11-14: largest divergence 1\.0% inside the control band 2\.0%/);
    assert.ok(held.summary.includes(renderBakeoff(held.rows)), "ranking is not reordered by eligibility");

    // The newest verdict decides: a later unreconcilable day takes Kimi's lead away again.
    const later = reconcileCashInvoice({ day: "2026-11-15", accounts, receipts: [], exportCsv: csv([]) });
    recordCashInvoiceVerdicts(judged, later, { path: "export.csv", digest: "d2" }, "CASH-INVOICE-test");
    const rows = readFileSync(join(judged, "ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Row)
      .filter((row) => row.step === CASH_INVOICE_RECONCILED_STEP);
    assert.ok(rows.length > 0);
    const text = invoiceLeadEligibility(held.rows, await readNewestInvoiceVerdicts(judged));
    assert.match(text, /not eligible to lead: cash Kimi-K2\.6 \(thinking off\) — unreconcilable on 2026-11-15: no traffic/);
  } finally {
    rmSync(fresh, { recursive: true, force: true });
    rmSync(judged, { recursive: true, force: true });
  }
});

test("W1-T10858: the rmd verb and the measurement cadence reconcile an export and ledger one row per deployment", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-invoice-cadence-"));
  try {
    const stateDir = join(root, "state");
    mkdirSync(join(stateDir, COST_EXPORTS_DIR, "daily"), { recursive: true });
    writeFileSync(join(stateDir, "ledger.ndjson"), [nano, deepseek].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const file = join(stateDir, COST_EXPORTS_DIR, "daily", "export.csv");
    writeFileSync(file, csv([...controlBill(0.102, 0.396), ...deepseekBill(0.1919, 0.02828, 0.5151)]));
    const config = { root, workerProviders: { cashEndpoint: `https://${account}.openai.azure.com/` } } as Config;
    const verdictRows = () => readFileSync(join(stateDir, "ledger.ndjson"), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as Row).filter((row) => row.step === CASH_INVOICE_RECONCILED_STEP);

    const hooks = buildMeasurementCadenceDaemonHooks({ config, now: () => new Date("2026-11-15T06:00:00.000Z"),
      verifyHumanCadenceResult: async () => { throw new Error("fixture stops sibling work"); } });
    await assert.rejects(hooks.runMeasurementCadence(), /fixture stops sibling work/);
    const cadence = verdictRows();
    assert.ok(cadence.length > 0 && cadence.every((row) => row.day === day && typeof row.export_digest === "string"));
    assert.equal(new Set(cadence.map((row) => row.deployment)).size, cadence.length, "one row per deployment and day");
    assert.equal((cadence.find((row) => row.deployment === "DeepSeek-V4-Flash")!.verdict as Row).verdict, "reconciled");
    await assert.rejects(hooks.runMeasurementCadence(), /fixture stops sibling work/);
    assert.equal(verdictRows().length, cadence.length, "the same day and file are reconciled once");

    const out: string[] = [];
    const err: string[] = [];
    const host = { config: () => config, out: (line: string) => void out.push(line), err: (line: string) => void err.push(line) };
    assert.equal(await cashReconcileCommand(["--day", day, "--export", file], host), 0);
    assert.equal((JSON.parse(out[0]!) as { day: string }).day, day);
    assert.equal(verdictRows().length, cadence.length * 2, "the verb runs on demand");
    assert.equal(await cashReconcileCommand(["--day", "yesterday", "--export", file], host), 2);
    assert.equal(await cashReconcileCommand(["--day", day, "--export", join(root, "missing.csv")], host), 1);
    assert.equal(err.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cash invoice: an export with US dates is read, and one the price table cannot be compared with is refused by name", () => {
  const line = (meter: string, cost: number) => `11/14/2026,${resource()},${meter},${cost}`;
  const result = reconcileCashInvoice({ day, accounts, receipts: [nano, deepseek], exportCsv: ["UsageDate,InstanceId,MeterName,CostInUsd",
    line("gpt-5-nano Inp glbl Tokens", 0.102), line("gpt-5-nano Outp glbl Tokens", 0.4), line("V4 Flash Inp glbl Tokens", 0.19),
    line("V4 Flash cached glbl Tokens", 0.028), line("V4 Flash Outp glbl Tokens", 0.51), line("V4 Flash Provisioned Hours", 3)].join("\n") });
  assert.equal(verdictOf(result.verdicts, "DeepSeek-V4-Flash").verdict, "reconciled");
  assert.equal(result.unattributedExportRows, 1, "a meter that is neither input, cached nor output is billed to nobody");
  const refused = (exportCsv: string, why: RegExp) => assert.throws(() => reconcileCashInvoice({ day, receipts: [], exportCsv }), why);
  refused(`Date,ResourceId,MeterName,Cost,Currency\n${day},${resource()},V4 Flash Inp glbl Tokens,1,EUR\n`, /row 2 is billed in EUR, not USD/);
  refused(`Date,MeterName\n${day},V4 Flash Inp glbl Tokens\n`, /lacks the column\(s\) ResourceId, CostInUsd or CostInBillingCurrency/);
  refused("", /cost export is empty/);
  assert.throws(() => reconcileCashInvoice({ day: "yesterday", receipts: [], exportCsv: csv([]) }), /reconcile day must be YYYY-MM-DD/);
});

test("cash invoice: a deployment's account is its endpoint's first host label, and a malformed endpoint names none", () => {
  const named = cashInvoiceAccounts({ workerProviders: { cashEndpoint: `https://${account}.openai.azure.com/`,
    cashDeploymentEndpoints: { "Kimi-K2.6": { endpoint: "not a url" } } } } as unknown as Config);
  assert.equal(named["DeepSeek-V4-Flash"], account);
  assert.ok(!Object.hasOwn(named, "Kimi-K2.6"), "the deployment is then matched on its meter name alone");
  assert.deepEqual(cashInvoiceAccounts({} as Config), {});
});

const failedRows = (stateDir: string): Row[] => readFileSync(join(stateDir, "ledger.ndjson"), "utf8").trim().split("\n")
  .map((text) => JSON.parse(text) as Row).filter((row) => row.step === "cash.invoice.reconcile_failed");

test("cash invoice: the cadence ledgers once why an export was refused or its reconcile failed", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-invoice-refused-"));
  try {
    const stateDir = join(root, "state");
    mkdirSync(join(stateDir, COST_EXPORTS_DIR), { recursive: true });
    const file = join(stateDir, COST_EXPORTS_DIR, "export.csv");
    const twice = async (config: Config) => {
      const hooks = buildMeasurementCadenceDaemonHooks({ config, now: () => new Date("2026-11-15T06:00:00.000Z"),
        verifyHumanCadenceResult: async () => { throw new Error("fixture stops sibling work"); } });
      await assert.rejects(hooks.runMeasurementCadence(), /fixture stops sibling work/);
      await assert.rejects(hooks.runMeasurementCadence(), /fixture stops sibling work/);
    };

    writeFileSync(file, `Date,MeterName\n${day},V4 Flash Inp glbl Tokens\n`);
    await twice({ root } as Config);
    const refused = failedRows(stateDir);
    assert.equal(refused.length, 1, "an unchanged refused file is ledgered once");
    assert.equal(refused[0]!.day, "unparsed");
    assert.equal(refused[0]!.export_file, file);
    assert.match(String(refused[0]!.reason), /lacks the column\(s\) ResourceId/);

    // A readable export whose reconcile throws: the day and the file are ledgered with the reason, and not retried.
    writeFileSync(file, csv([...controlBill(0.102, 0.396), ...deepseekBill(0.1919, 0.02828, 0.5151)]));
    await twice({ root, get workerProviders(): never { throw new Error("fixture config has no providers"); } } as unknown as Config);
    const failed = failedRows(stateDir).filter((row) => row.day === day);
    assert.equal(failed.length, 1, "the same day and file are not retried");
    assert.match(String(failed[0]!.reason), /fixture config has no providers/);
    assert.equal(failedRows(stateDir).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cash invoice: an unreadable ledger rotation fails the verb and holds every open-weight arm", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-invoice-unread-"));
  try {
    const stateDir = join(root, "state");
    // A directory where a rotation should be: the union cannot read it.
    const rotation = "ledger.2026-11-14T12-00-00-000Z.ndjson";
    mkdirSync(join(stateDir, rotation), { recursive: true });
    const file = join(root, "export.csv");
    writeFileSync(file, csv(controlBill(0.102, 0.4)));
    const err: string[] = [];
    const host = { config: () => ({ root }) as Config, out: () => undefined, err: (text: string) => void err.push(text) };
    assert.equal(await cashReconcileCommand(["--day", day, "--export", file], host), 1);
    assert.ok(err[0]!.includes("cash receipts ledger unreadable") && err[0]!.includes(rotation), err[0]);

    const verdicts = await readNewestInvoiceVerdicts(stateDir);
    assert.equal(verdicts.ok, false);
    const arm = { candidate: "cash:DeepSeek-V4-Flash:off", label: "cash DeepSeek-V4-Flash (thinking off)", billing: "cash" };
    const held = invoiceLeadEligibility([arm, { candidate: "incumbent", label: "incumbent", billing: "subscription" }], verdicts);
    assert.match(held, /- not eligible to lead: cash DeepSeek-V4-Flash \(thinking off\) — invoice verdicts unreadable \(/);
    assert.ok(held.includes(rotation), "the line names the file that could not be read");
    assert.equal(invoiceLeadEligibility([{ candidate: "incumbent", label: "incumbent", billing: "cash" }], verdicts), "", "no open-weight cash arm, no lines");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
