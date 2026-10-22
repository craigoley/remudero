/** Fixed patch-generation controls. Arbitrary model code requires a qualified isolated executor. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const object = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object"
  && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const shape = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length
  && keys.every(k => Object.hasOwn(v, k));
const errorType = (v: unknown) => v instanceof Error ? v.name : "non-error";
import type { CanaryPin } from "./model-canary-runner.js";
import type { CanaryTrialBlock } from "./model-canary-metrics.js";

export interface CanaryCodingContract {
  version: "canary-coding-slot-v1";
  day: string;
  seed: string;
  caseId: CodingCaseId;
  pins: CanaryPin[];
  aa: boolean;
  trial: CanaryTrialBlock;
}

export type CodingCaseId = "coding-parser" | "coding-cleanup" | "coding-accounting";

const cases = {
  "coding-parser": {
    instruction: "Repair parseCount. Accept canonical decimal strings from 0 through 9999. Reject other input with TypeError. Preserve valid input behavior.",
    baseline: 'export const parseCount = value => Number.parseInt(value, 10);\n',
    reference: 'export function parseCount(value) { if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || Number(value) > 9999) throw new TypeError("invalid count"); return Number(value); }\n',
    wrong: 'export const parseCount = value => Number(value);\n',
    grader: `import { parseCount } from '../src/solution.mjs';
test('valid behavior remains', () => { assert.equal(parseCount('0'),0); assert.equal(parseCount('42'),42); assert.equal(parseCount('9999'),9999); });
test('invalid input is rejected', () => { for (const v of ['', '12x', '01', '-1', '10000', ' 2', 2, null]) assert.throws(() => parseCount(v), TypeError); });`,
  },
  "coding-cleanup": {
    instruction: "Repair withDeadline so its owned scheduler handle is cleared exactly once on success, rejected promises and synchronous task errors. Preserve the task value/error. The scheduler has set(callback) and clear(handle).",
    baseline: 'export async function withDeadline(task, scheduler) { const h = scheduler.set(() => {}); const result = await task(); scheduler.clear(h); return result; }\n',
    reference: 'export async function withDeadline(task, scheduler) { const h = scheduler.set(() => {}); try { return await task(); } finally { scheduler.clear(h); } }\n',
    wrong: 'export async function withDeadline(task, scheduler) { const h = scheduler.set(() => {}); scheduler.clear(h); return await task(); }\n',
    grader: `import { withDeadline } from '../src/solution.mjs';
test('valid behavior remains', async () => { const calls=[]; const s={set:()=>17,clear:h=>calls.push(h)}; const value=await withDeadline(()=>{assert.equal(calls.length,0);return 7;},s); assert.equal(value,7); assert.deepEqual(calls,[17]); });
test('failure cleanup preserves error', async () => { for (const sync of [true,false]) { const calls=[]; const error=new Error('task failure'); const s={set:()=>17,clear:h=>calls.push(h)}; await assert.rejects(withDeadline(()=>{if(sync)throw error;return Promise.reject(error);},s),e=>e===error); assert.deepEqual(calls,[17]); } });`,
  },
  "coding-accounting": {
    instruction: 'Repair totalCharges. Each row has a nonempty string id and nonnegative safe integer cents. Identical repeated ids count once. Missing/invalid/conflicting data or an unsafe total returns {state:"unknown",total:null}; otherwise return {state:"known",total:number}. Conflicts must stay unknown in either order.',
    baseline: 'export const totalCharges = rows => ({state:"known",total:rows.reduce((n,r)=>n+r.cents,0)});\n',
    reference: 'export function totalCharges(rows) { const seen=new Map(); for(const r of rows) { if(!r || typeof r.id!=="string" || !r.id || !Number.isSafeInteger(r.cents) || r.cents<0 || (seen.has(r.id) && seen.get(r.id)!==r.cents)) return {state:"unknown",total:null}; seen.set(r.id,r.cents); } const total=[...seen.values()].reduce((n,v)=>n+v,0); return Number.isSafeInteger(total)?{state:"known",total}:{state:"unknown",total:null}; }\n',
    wrong: 'export const totalCharges = rows => ({state:"known",total:[...new Map(rows.map(r=>[r.id,r.cents])).values()].reduce((n,v)=>n+v,0)});\n',
    grader: `import { totalCharges } from '../src/solution.mjs';
test('valid behavior remains', () => { assert.deepEqual(totalCharges([]),{state:'known',total:0}); assert.deepEqual(totalCharges([{id:'A',cents:0},{id:'B',cents:7}]),{state:'known',total:7}); });
test('duplicates and uncertainty are preserved', () => { const a={id:'A',cents:7},b={id:'A',cents:8}; assert.deepEqual(totalCharges([a,a]),{state:'known',total:7}); for(const rows of [[a,b],[b,a],[{id:'',cents:1}],[{id:'A',cents:-1}],[{id:'A',cents:0.5}],[{id:'A'}],[{id:'A',cents:Number.MAX_SAFE_INTEGER},{id:'B',cents:1}]]) assert.deepEqual(totalCharges(rows),{state:'unknown',total:null}); });`,
  },
} as const;
function selected(id: CodingCaseId) {
  if (!Object.hasOwn(cases, id)) throw new Error("coding-case-unknown");
  return cases[id];
}
const graderSource = (id: CodingCaseId) => 'import assert from "node:assert/strict";\nimport { test } from "node:test";\n' + selected(id).grader;

/** Model-facing input omits grader and reference patches. No model or isolation authority here. */
export function codingCaseRequests() {
  return (Object.keys(cases) as CodingCaseId[]).map(id => {
    const c = selected(id);
    return { id, cadence: "weekly" as const, instruction: c.instruction, allowedFiles: ["src/solution.mjs"],
      baseline: c.baseline, suiteHash: hash(JSON.stringify([id, c.instruction, c.baseline, graderSource(id)])),
      outputContract: 'Return only JSON {"files":[{"path":"src/solution.mjs","text":"complete replacement source"}]}.' };
  });
}

/** Scope admission is not code-safety certification and never executes arbitrary submissions. */
export function prepareCodingSubmission(id: CodingCaseId, value: unknown) {
  selected(id);
  const input = object(value), files = input?.files;
  if (!input || !shape(input, ["files"]) || !Array.isArray(files) || files.length !== 1)
    return { state: "refused" as const, reason: "coding-file-contract-invalid" };
  const file = object(files[0]);
  if (!file || !shape(file, ["path", "text"]) || file.path !== "src/solution.mjs" || typeof file.text !== "string"
    || file.text.length === 0 || file.text.includes("\0") || Buffer.byteLength(file.text, "utf8") > 65_536)
    return { state: "refused" as const, reason: "coding-file-scope-or-bound" };
  const request = codingCaseRequests().find(c => c.id === id)!;
  return { state: "prepared" as const, taskId: id, suiteHash: request.suiteHash,
    submissionHash: hash(file.text), file: { path: file.path, text: file.text },
    verification: "unscored" as const, execution: "qualified-isolated-executor-required" as const, adapterQualified: false as const };
}

export interface CodingControlPorts {
  run(cwd: string): Promise<{ exitCode: number; stdout: string }>;
  cleanup(cwd: string): Promise<void>;
}
const defaults: CodingControlPorts = {
  async run(cwd) {
    try {
      const result = await exec(process.execPath, ["--test", "--test-reporter=tap", "test/grade.test.mjs"], {
        cwd, timeout: 5000, maxBuffer: 65_536,
        env: { PATH: dirname(process.execPath), TZ: "UTC", TMPDIR: cwd },
      });
      return { exitCode: 0, stdout: result.stdout };
    } catch (error) {
      const e = error as { code?: unknown; stdout?: unknown };
      if (typeof e.code === "number" && typeof e.stdout === "string") return { exitCode: e.code, stdout: e.stdout };
      throw error;
    }
  },
  cleanup: cwd => rm(cwd, { recursive: true, force: true }),
};

/** The real default child executes only fixed trusted corpus controls, never model-submitted text. */
export async function scoreCodingControl(id: CodingCaseId, control: "reference" | "baseline" | "wrong", ports = defaults) {
  const c = selected(id);
  if (!["reference", "baseline", "wrong"].includes(control)) throw new Error("coding-control-unknown");
  const cwd = await mkdtemp(join(tmpdir(), "rmd-coding-control-"));
  const outcome: { state: "complete" | "unavailable"; passed: boolean | null; counts?: Record<string, number>;
    reason: string; errorType?: string; cleanupFailure?: string; scope: "trusted-corpus-control-only"; modelCalls: 0; adapterQualified: false } = {
    state: "unavailable", passed: null, reason: "coding-control-unproven", scope: "trusted-corpus-control-only", modelCalls: 0, adapterQualified: false,
  };
  try {
    await chmod(cwd, 0o700); await mkdir(join(cwd, "src")); await mkdir(join(cwd, "test"));
    await writeFile(join(cwd, "src/solution.mjs"), c[control], { flag: "wx", mode: 0o600 });
    await writeFile(join(cwd, "test/grade.test.mjs"), graderSource(id), { flag: "wx", mode: 0o600 });
    const result = await ports.run(cwd), counts: Record<string, number> = {};
    for (const key of ["tests", "pass", "fail", "cancelled", "skipped"]) {
      const matches = [...result.stdout.matchAll(new RegExp("^# " + key + " ([0-9]+)$", "gm"))];
      if (matches.length !== 1) { outcome.reason = "coding-real-test-summary-unproven"; return outcome; }
      counts[key] = Number(matches[0]![1]);
    }
    if (counts.tests !== 2 || counts.pass! + counts.fail! !== 2 || counts.cancelled !== 0 || counts.skipped !== 0
      || !result.stdout.includes("# Subtest: valid behavior remains")
      || !result.stdout.includes("# Subtest: " + (id === "coding-parser" ? "invalid input is rejected"
        : id === "coding-cleanup" ? "failure cleanup preserves error" : "duplicates and uncertainty are preserved"))
      || (result.exitCode === 0) !== (counts.fail === 0) || ![0, 1].includes(result.exitCode)) {
      outcome.reason = "coding-real-test-population-unproven"; return outcome;
    }
    Object.assign(outcome, { state: "complete", counts, passed: counts.fail === 0,
      reason: counts.fail === 0 ? "coding-controls-passed" : "coding-controls-failed" });
  } catch (error) {
    Object.assign(outcome, { state: "unavailable", passed: null, reason: "coding-control-process-unavailable", errorType: errorType(error) });
  } finally {
    try { await ports.cleanup(cwd); }
    catch (error) { Object.assign(outcome, { state: "unavailable", passed: null, reason: "coding-control-cleanup-unavailable", cleanupFailure: errorType(error) }); }
  }
  return outcome;
}
