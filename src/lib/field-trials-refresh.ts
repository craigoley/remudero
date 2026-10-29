import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendLedger } from "./ledger.js";
import { ghIssueGateway, tryEscalate, type IssueGateway } from "./escalate.js";

export const REFRESH_STEPS = ["routing-review", "case-files", "snapshot"] as const;
export interface RefreshStep {
  name: typeof REFRESH_STEPS[number];
  state: "ok" | "failed" | "skipped";
  exitCode: number | null;
}
export interface FieldTrialsRefresh {
  state: "ok" | "partial" | "failed";
  steps: readonly RefreshStep[];
  scriptBlob: string;
  snapshotAsOf: string | null;
  lastGoodSnapshotAsOf: string | null;
  caseFilesFallback: "previous" | "none";
  alerts: Partial<Record<RefreshStep["name"], string>>;
  alertErrors: string[];
}

export function parseRefreshSteps(values: readonly string[], recordOnly: boolean): RefreshStep[] {
  const result: RefreshStep[] = [];
  for (const value of values) {
    const [name, code, extra] = value.split("=");
    if (!REFRESH_STEPS.includes(name as RefreshStep["name"]) || extra !== undefined
      || result.some(step => step.name === name) || !(code === "skipped" || /^(0|[1-9][0-9]{0,2})$/.test(code ?? ""))
      || (code !== "skipped" && Number(code) > 255)) throw new Error(`invalid refresh step: ${value}`);
    result.push({ name: name as RefreshStep["name"], state: code === "skipped" ? "skipped" : code === "0" ? "ok" : "failed",
      exitCode: code === "skipped" ? null : Number(code) });
  }
  if (!recordOnly && !result.some(step => step.name === "snapshot")) result.push({ name: "snapshot", state: "ok", exitCode: 0 });
  if (result.length !== REFRESH_STEPS.length || result.find(step => step.name === "snapshot")?.state !== (recordOnly ? "failed" : "ok")) {
    throw new Error("refresh requires every step, with a failed snapshot in record-only mode");
  }
  return REFRESH_STEPS.map(name => result.find(step => step.name === name)!);
}

function previousRefresh(path: string): { prior: Partial<FieldTrialsRefresh>; error?: string } {
  try {
    const prior = JSON.parse(readFileSync(path, "utf8")) as Partial<FieldTrialsRefresh>;
    if (prior === null || typeof prior !== "object" || !Array.isArray(prior.steps)
      || typeof prior.alerts !== "object" || prior.alerts === null) throw new Error("invalid refresh history");
    return { prior };
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { prior: {} };
    return { prior: {}, error: `refresh history unreadable: ${String(error)}` };
  }
}

export function refreshSection(steps: readonly RefreshStep[], scriptBlob: string, snapshotAsOf: string | null,
  lastGoodSnapshotAsOf: string | null): FieldTrialsRefresh {
  return { state: steps.every(step => step.state === "ok") ? "ok" : snapshotAsOf === null ? "failed" : "partial",
    steps, scriptBlob, snapshotAsOf, lastGoodSnapshotAsOf,
    caseFilesFallback: steps.some(step => step.name === "case-files" && step.state === "failed") ? "previous" : "none",
    alerts: {}, alertErrors: [] };
}

/** One collector outcome, including failed snapshots; alert delivery never erases the outcome. */
export function recordFieldTrialsRefresh(input: { outDir: string; ledgerPath: string; asOf: string; scriptBlob: string;
  steps: readonly RefreshStep[]; snapshotAsOf: string | null; priorSnapshotAsOf?: string | null; issues?: IssueGateway;
  caseFilesFallback?: "previous" | "none"; repo?: string }): FieldTrialsRefresh {
  const path = join(input.outDir, "field-trials-refresh-v1.json");
  const { prior, error } = previousRefresh(path);
  const lastGood = prior.lastGoodSnapshotAsOf === undefined ? input.priorSnapshotAsOf ?? null : prior.lastGoodSnapshotAsOf;
  const result = refreshSection(input.steps, input.scriptBlob, input.snapshotAsOf, lastGood);
  if (error) result.alertErrors.push(error);
  if (result.caseFilesFallback === "previous" && input.caseFilesFallback !== undefined) result.caseFilesFallback = input.caseFilesFallback;
  if (result.state === "ok" && input.snapshotAsOf !== null) result.lastGoodSnapshotAsOf = input.snapshotAsOf;
  result.alerts = { ...prior.alerts };
  const [owner, repo] = (input.repo ?? "craigoley/remudero").split("/");
  const issues = input.issues ?? ghIssueGateway(owner!, repo!);
  const runId = `field-trials-refresh-${randomUUID()}`;
  for (const step of input.steps) {
    const url = result.alerts[step.name];
    if (step.state === "failed" && !url && prior.steps?.some(previous => previous.name === step.name && previous.state === "failed")) {
      const raised = tryEscalate({ class: "MANUAL", taskId: `field-trials-refresh-${step.name}`, headDedup: "independent",
        summary: `field trials ${step.name} failed on consecutive passes`,
        detail: `Step ${step.name} exited ${step.exitCode} at ${input.asOf}; script blob ${input.scriptBlob}. Last good snapshot: ${lastGood ?? "none"}.`,
        options: [{ label: "repair", detail: "Inspect the refresh log and repair the failed collector step." }], recommendation: "repair" },
      { issues, ledgerPath: input.ledgerPath, runId });
      if (raised) result.alerts[step.name] = raised;
      else result.alertErrors.push(`${step.name}: escalation not delivered`);
    } else if (step.state === "ok" && url) {
      try {
        if (!issues.closeWithComment) throw new Error("issue gateway cannot resolve alerts");
        issues.closeWithComment(url, `Refresh step ${step.name} succeeded at ${input.asOf}; script blob ${input.scriptBlob}.`);
        delete result.alerts[step.name];
      } catch (error) {
        const reason = `${step.name}: ${String(error)}`;
        result.alertErrors.push(reason);
      }
    }
  }
  appendLedger(input.ledgerPath, { run_id: runId, task_id: "field-trials-refresh", step: "field-trials.refresh", asOf: input.asOf, ...result });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(result) + "\n", { mode: 0o600 });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
  return result;
}
