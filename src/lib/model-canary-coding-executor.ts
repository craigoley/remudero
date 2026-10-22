/** Unregistered execution mechanics. Default admission refuses until native runtime,
 * containment, host capacity and durable production-priority ownership are qualified.
 * Injected controls exercise orchestration only; no result here certifies containment.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { prepareCodingSubmission, type CodingCaseId } from "./model-canary-coding.js";
import { CODING_ISOLATION_LIMITS, codingIsolationInspectionMatches, codingIsolationPlan,
  gradeCodingSandboxValues } from "./model-canary-coding-isolation.js";
import type { CodingCheckpoint } from "./model-canary-coding-checkpoint.js";

const exec = promisify(execFile);
type CommandResult = { exitCode: number; stdout: string; stderr: string };
export interface CodingExecutorPorts {
  admission(): Promise<{ admitted: boolean; reason: string }>;
  command(args: string[], cwd: string, timeoutMs: number): Promise<CommandResult>;
  /** A real owned bridge persists this before operations; standalone test mechanics may omit it. */
  checkpoint?(event: CodingCheckpoint): Promise<void>;
}

/** Actual CLI child, bounded independently for every control operation. No inherited
 * credential/provider/Docker context environment and no shell interpolation.
 */
export async function codingContainerCommand(binary: string, args: string[], cwd: string, timeoutMs: number): Promise<CommandResult> {
  if (!isAbsolute(binary) || !isAbsolute(cwd) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000)
    throw new TypeError("coding CLI scope and timeout invalid");
  const options = { cwd, timeout: timeoutMs, killSignal: "SIGKILL" as const, maxBuffer: CODING_ISOLATION_LIMITS.outputBytes,
    env: { PATH: dirname(binary) + ":/usr/local/bin:/usr/bin:/bin", HOME: cwd, TMPDIR: cwd, TZ: "UTC" } };
  try {
    const r = await exec(binary, args, options);
    if (Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr) > CODING_ISOLATION_LIMITS.outputBytes)
      throw new Error("coding CLI combined output exceeded bound");
    return { exitCode: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (error) {
    const r = error as { code?: unknown; stdout?: unknown; stderr?: unknown; killed?: unknown };
    if (typeof r.code === "number" && typeof r.stdout === "string" && typeof r.stderr === "string" && !r.killed
        && Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr) <= CODING_ISOLATION_LIMITS.outputBytes)
      return { exitCode: r.code, stdout: r.stdout, stderr: r.stderr };
    throw error;
  }
}

export function codingExecutorDefaultPorts(): CodingExecutorPorts {
  return {
    admission: async () => ({ admitted: false, reason: "coding-native-runtime-and-owner-unqualified" }),
    command: async () => { throw new Error("coding-native-runtime-and-owner-unqualified"); },
  };
}

/** Fixed behavior samples; expected values stay in the host. These samples are not
 * secret tests and printed results never attest that the container was contained.
 */
export function codingBehaviorChallenge(id: CodingCaseId, nonce: string) {
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw new TypeError("coding challenge nonce invalid");
  const expected = new Map<string, unknown>();
  let body: string;
  if (id === "coding-parser") {
    const inputs: unknown[] = ["0", "42", "9999", "", "12x", "01", "-1", "10000", " 2", 2, null];
    inputs.forEach((_, i) => expected.set(String(i), i < 3 ? { value: [0, 42, 9999][i] } : { error: "TypeError" }));
    body = `const inputs=${JSON.stringify(inputs)}; for(let i=0;i<inputs.length;i++) { let value;
      try { value={value:s.parseCount(inputs[i])}; } catch(e) { value={error:e?.name}; }
      results.push({id:String(i),value}); }`;
  } else if (id === "coding-cleanup") {
    for (const mode of ["success", "sync", "async"]) expected.set(mode, { cleared: [17], early: false,
      value: mode === "success" ? 7 : null, sameError: mode !== "success" });
    body = `for(const mode of ['success','sync','async']) { const cleared=[]; let early=false,value=null,sameError=false;
      const error=new Error('owned-task-error'); const scheduler={set:()=>17,clear:h=>cleared.push(h)};
      try { value=await s.withDeadline(()=>{early=cleared.length!==0;if(mode==='sync')throw error;
        return mode==='async'?Promise.reject(error):7;},scheduler); } catch(e) { const failed=e===error; sameError=failed; }
      results.push({id:mode,value:{cleared,early,value,sameError}}); }`;
  } else if (id === "coding-accounting") {
    const a = { id: "A", cents: 7 }, b = { id: "A", cents: 8 };
    const inputs = [[], [a, a], [a, b], [b, a], [{ id: "", cents: 1 }], [{ id: "A", cents: -1 }],
      [{ id: "A", cents: 0.5 }], [{ id: "A" }], [{ id: "A", cents: Number.MAX_SAFE_INTEGER }, { id: "B", cents: 1 }]];
    inputs.forEach((_, i) => expected.set(String(i), i < 2 ? { state: "known", total: i === 0 ? 0 : 7 } : { state: "unknown", total: null }));
    body = `const inputs=${JSON.stringify(inputs)}; for(let i=0;i<inputs.length;i++) results.push({id:String(i),value:s.totalCharges(inputs[i])});`;
  } else throw new TypeError("coding challenge case invalid");
  const harness = `import * as s from './solution.mjs';\nconst results=[];\n${body}\nprocess.stdout.write(JSON.stringify({protocol:'coding-values-v1',nonce:${JSON.stringify(nonce)},results}));\n`;
  return { harness, expected };
}

/** Candidate executor, deliberately absent from live dispatch. A default call refuses
 * before scratch allocation or a Docker operation. A test-supplied admission proves
 * only lifecycle mechanics; live qualification must be provided by the owned host.
 */
export async function executeCodingIsolated(id: CodingCaseId, value: unknown, image: string, ports = codingExecutorDefaultPorts()) {
  const outcome: { state: "complete" | "refused" | "unavailable"; passed: boolean | null; reason: string;
    executorQualified: false; resourceEvidence: null; containerExit?: number; cleanup?: "confirmed" | "unknown";
    retainedScratch?: string; errorType?: string; cleanupFailure?: string } = { state: "unavailable", passed: null, reason: "coding-execution-unproven",
      executorQualified: false, resourceEvidence: null };
  const submission = prepareCodingSubmission(id, value);
  if (submission.state !== "prepared") return { ...outcome, state: "refused" as const, reason: submission.reason };
  const admission = await ports.admission();
  if (admission.admitted !== true) return { ...outcome, state: "refused" as const, reason: admission.reason };
  const nonce = randomBytes(16).toString("hex");
  const scratch = await mkdtemp(join(tmpdir(), "rmd-coding-executor-"));
  let container: string | undefined, createAttempted = false, clean = false;
  const directory = join(scratch, "rmd-coding-isolated-" + nonce);
  const checkpoint = async (phase: CodingCheckpoint["phase"]) => {
    if (ports.checkpoint) await ports.checkpoint({ version: "canary-coding-checkpoint-v1", phase,
      nonce, image, directory, containerId: container ?? null });
  };
  try {
    await chmod(scratch, 0o700); await mkdir(directory, { mode: 0o700 });
    const plan = codingIsolationPlan(image, directory, nonce), challenge = codingBehaviorChallenge(id, nonce);
    // Read-only files must be readable by container uid65534. The host directory stays
    // private0700 and is never mounted: only these two individual files are exposed.
    await writeFile(plan.solution, submission.file.text, { flag: "wx", mode: 0o444 });
    await writeFile(plan.harness, challenge.harness, { flag: "wx", mode: 0o444 });
    await checkpoint("prepared");
    const command = async (args: string[], timeout = 5_000) => {
      const r = await ports.command(args, scratch, timeout);
      if (r.exitCode !== 0) throw new Error("coding container operation failed: " + args[0]);
      return r.stdout;
    };
    await checkpoint("create-intent"); createAttempted = true;
    const created = (await command([...plan.create])).trim();
    if (!/^[a-f0-9]{64}$/.test(created)) throw new Error("coding container identity unavailable");
    container = created;
    await checkpoint("created");
    const inspected: unknown = JSON.parse(await command(["inspect", container]));
    if (!Array.isArray(inspected) || inspected.length !== 1 || inspected[0]?.Id !== container
        || inspected[0]?.State?.Status !== "created" || !codingIsolationInspectionMatches(plan, inspected[0]))
      throw new Error("coding actual container policy refused");
    await checkpoint("execution-intent");
    const r = await ports.command(["start", "--attach", container], scratch, CODING_ISOLATION_LIMITS.wallMs);
    const terminal: unknown = JSON.parse(await command(["inspect", container]));
    const row = Array.isArray(terminal) && terminal.length === 1 ? terminal[0] as { Id?: unknown; State?: Record<string, unknown> } : undefined;
    const state = row?.State;
    if (row?.Id !== container || !state || state.Status !== "exited" || state.Running !== false
        || state.Dead !== false || state.OOMKilled !== false || state.Error !== "" || !Number.isInteger(state.ExitCode))
      throw new Error("coding actual terminal state unavailable");
    outcome.containerExit = state.ExitCode as number;
    if (r.exitCode !== 0 || state.ExitCode !== 0 || r.stderr !== "") {
      outcome.reason = "coding-container-execution-failed"; return outcome;
    }
    const grade = gradeCodingSandboxValues(nonce, challenge.expected, r.stdout);
    Object.assign(outcome, { state: grade.state, passed: grade.passed, reason: grade.reason });
  } catch (error) {
    const reason = "coding-executor-operation-unavailable";
    Object.assign(outcome, { reason, errorType: error instanceof Error ? error.name : "non-error" });
  } finally {
    // Remove only the exact ID returned by this successful create. An uncertain create
    // never guesses a name or deletes another owner's container; retain its scratch.
    if (container) {
      try {
        await checkpoint("cleanup-intent");
        const r = await ports.command(["rm", "--force", container], scratch, 5_000);
        clean = r.exitCode === 0 && r.stdout.trim() === container;
      } catch (error) {
        const reason = "coding-container-removal-unavailable";
        clean = false; Object.assign(outcome, { reason, cleanupFailure: error instanceof Error ? error.name : "non-error" });
      }
    } else clean = !createAttempted;
    if (clean) {
      try { await rm(scratch, { recursive: true, force: true }); await checkpoint("cleanup-confirmed"); outcome.cleanup = "confirmed"; }
      catch (error) {
        const reason = "coding-scratch-removal-unavailable";
        clean = false; Object.assign(outcome, { reason, cleanupFailure: error instanceof Error ? error.name : "non-error" });
      }
    }
    if (!clean) Object.assign(outcome, { state: "unavailable", passed: null, reason: "coding-executor-cleanup-unknown",
      cleanup: "unknown", retainedScratch: scratch });
  }
  return outcome;
}
