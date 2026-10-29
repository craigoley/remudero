import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { resolveProjectPreflight } from "./ci-project-preflight.js";
import { MAX_RETAINED_SUCCESS_OUTPUT_CHARS } from "./ci-parity.js";
import { localQualificationSchema, type LocalQualification } from "./product-intent.js";
import { resolveOwnerRepoAt } from "./owner-repo.js";
import { hostWorktreeGit } from "./worktree-git.js";

/** BACKSTOP: bound receipt reads and immutable snapshots independently of child output. */
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const unknown = (reason: string): LocalQualification => ({ producer: "unavailable", verdict: "unknown", tests: 0, suites: 0, reason: reason.slice(0, 500) });
const snapshotSchema = z.object({ version: z.literal(1), repository: z.string().max(140), taskId: z.string().max(120),
  runId: z.string().max(160), head: sha, qualification: localQualificationSchema,
  producer: z.unknown(),
}).strict();
export interface QualificationIdentity { stateRoot: string; repository: string; taskId: string; runId: string }

/** Only fixed producer artifacts and their in-tree capture files are readable. */
function boundedRead(root: string, path: string): string {
  if (isAbsolute(path) || path.split(/[\\/]/).some(part => part === "..")) throw new Error("foreign receipt path");
  const base = realpathSync(root);
  const full = realpathSync(join(base, path));
  if (!full.startsWith(base + sep)) throw new Error("receipt escapes its owned root");
  const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) throw new Error("receipt is not a bounded regular file");
    const buffer = Buffer.alloc(stat.size + 1);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes !== stat.size) throw new Error("receipt changed during bounded read");
    return buffer.subarray(0, bytes).toString("utf8");
  } finally { closeSync(fd); }
}

/** A single complete measured summary; successful steps or zero exits are never test counts. */
export function measuredTestSummary(raw: string): { tests: number; suites: number; passed: number; failed: number; skipped: number } | undefined {
  const output = raw.replace(/\u001b\[[0-9;]*m/g, "");
  const node = (field: string) => [...output.matchAll(new RegExp(`^# ${field} ([0-9]+)$`, "gm"))];
  if (node("tests").length) {
    const fields = ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"];
    if (fields.some(field => node(field).length !== 1)) return undefined;
    const [tests, suites, passed, failed, cancelled, skipped, todo] = fields.map(field => Number(node(field)[0]![1]));
    if (tests !== passed! + failed! + cancelled! + skipped! + todo!) return undefined;
    return { tests: tests!, suites: suites!, passed: passed!, failed: failed! + cancelled!, skipped: skipped! + todo! };
  }
  const lines = output.split(/\r?\n/);
  const tests = lines.filter(line => /^\s*Tests\s+/.test(line));
  const files = lines.filter(line => /^\s*Test Files\s+/.test(line));
  if (tests.length !== 1 || files.length !== 1) return undefined;
  const parse = (line: string) => {
    const match = /^\s*(?:Tests|Test Files)\s+(.+?)\s+\((\d+)\)\s*$/.exec(line);
    if (!match) return undefined;
    const parts = match[1]!.split(/\s*\|\s*/);
    const values: Record<string, number> = {};
    for (const part of parts) {
      const term = /^(\d+) (passed|failed|skipped|todo)$/.exec(part.trim());
      if (!term || Object.hasOwn(values, term[2]!)) return undefined;
      values[term[2]!] = Number(term[1]);
    }
    const total = Number(match[2]);
    return Object.values(values).reduce((a, b) => a + b, 0) === total ? { total, values } : undefined;
  };
  const test = parse(tests[0]!); const file = parse(files[0]!);
  if (!test || !file) return undefined;
  return { tests: test.total, suites: file.total, passed: test.values.passed ?? 0,
    failed: (test.values.failed ?? 0) + (file.values.failed ?? 0), skipped: (test.values.skipped ?? 0) + (test.values.todo ?? 0) };
}

const sourceSchema = z.object({ head: sha.or(z.literal("unknown")), clean: z.boolean(), error: z.string().max(500).optional() }).strict();
const observationSchema = z.object({ command: z.object({ file: z.string(), args: z.array(z.string()).max(100) }).strict(),
  output: z.string().max(MAX_RETAINED_SUCCESS_OUTPUT_CHARS), complete: z.boolean(), exitCode: z.number().int().nullable(),
  provenance: z.literal("default-subprocess"), profile: z.string(), sourceBefore: sourceSchema, sourceAfter: sourceSchema,
}).strict();

function consumerQualification(root: string, repository: string, head: string) {
  const producer = JSON.parse(boundedRead(root, "coverage/preflight-summary.json")) as unknown;
  const args = z.object({ args: z.array(z.string()).max(100) }).passthrough().parse(producer).args;
  const project = resolveProjectPreflight(root, { ciParity: args.includes("--ci-parity"), coverage: args.includes("--coverage") });
  if (project.kind !== "consumer" || project.repository !== repository) throw new Error("unverified consumer profile");
  const summary = z.object({ ok: z.boolean(), qualityProfile: z.literal(repository), headSha: sha,
    steps: z.array(z.object({ name: z.string(), ok: z.boolean(), qualification: observationSchema.optional() }).passthrough()).max(100),
  }).passthrough().parse(producer);
  if (summary.headSha !== head) throw new Error("consumer summary is for another source head");
  let tests = 0, suites = 0, complete = true, measured = false;
  const commands = project.commands;
  for (const command of commands) {
    const steps = summary.steps.filter(step => step.name === `project:${command.name}`);
    const step = steps[0]; const observation = step?.qualification;
    if (steps.length !== 1 || !observation || observation.profile !== repository || observation.provenance !== "default-subprocess" ||
      observation.command.file !== command.file || JSON.stringify(observation.command.args) !== JSON.stringify(command.args) ||
      !observation.sourceBefore.clean || !observation.sourceAfter.clean || observation.sourceBefore.head !== head || observation.sourceAfter.head !== head) {
      complete = false; continue;
    }
    if (!observation.complete || observation.exitCode === null) complete = false;
    if (command.name === "test" || command.name === "test:coverage" || command.name === "test:unit") {
      const counts = measuredTestSummary(observation.output);
      if (!counts || counts.tests <= 0 || counts.passed <= 0 || counts.failed || counts.skipped) complete = false;
      if (counts) { tests += counts.tests; suites += counts.suites; measured = true; }
    }
  }
  const failed = !summary.ok || summary.steps.some(step => !step.ok || (step.qualification && step.qualification.exitCode !== 0));
  const verdict = failed ? "failed" : complete && measured && tests > 0 ? "passed" : "partial";
  return { producer, qualification: { producer: "consumer" as const, verdict, tests, suites,
    originalVerdict: summary.ok ? "ok" : "failed", reason: failed ? "consumer quality failed" : verdict === "passed" ? "complete measured consumer qualification" : "consumer observations incomplete" } };
}

function authorQualification(root: string, head: string) {
  const producer = JSON.parse(boundedRead(root, "coverage/preflight-author.json")) as unknown;
  const summary = z.object({ version: z.literal(1), assurance: z.literal("author-only"), headSha: sha,
    verdict: z.string().max(80), dryRun: z.boolean(), suites: z.array(z.string()).max(20000),
    selection: z.string().optional(), error: z.string().optional(),
    steps: z.array(z.object({ name: z.string(), ok: z.boolean(), exitCode: z.number().int().nullable(),
      signal: z.string().nullable(), error: z.unknown(),
      judge: z.object({ complete: z.boolean(), given: count, reported: count }).passthrough().optional(),
      testSummary: z.unknown().optional(),
      diagnostics: z.object({ stdout: z.string(), stderr: z.string(), stdoutBytes: count, stderrBytes: count,
        nativeResult: z.string().optional(), mayBeIncomplete: z.boolean() }).passthrough(),
    }).passthrough()).max(100),
  }).passthrough().parse(producer);
  if (summary.headSha !== head) throw new Error("author receipt is for another source head");
  let complete = !summary.dryRun && summary.verdict === "passed" && !summary.error && summary.selection !== "over-capacity" && summary.suites.length > 0;
  let tests = 0, suites = 0;
  const captures: unknown[] = [];
  for (const step of summary.steps.filter(step => step.name.startsWith("affected-tests"))) {
    const diagnostic = step.diagnostics;
    if (!diagnostic.nativeResult || !/^coverage\/rmd-author-[^/]+\/affected-tests(?:-subset)?\.native-result\.json$/.test(diagnostic.nativeResult)) { complete = false; continue; }
    const prefix = diagnostic.nativeResult.replace(/\.native-result\.json$/, "");
    if (diagnostic.stdout !== `${prefix}.stdout.log` || diagnostic.stderr !== `${prefix}.stderr.log`) { complete = false; continue; }
    const native = z.object({ version: z.literal(1), status: z.number().int().nullable(), signal: z.string().nullable(),
      error: z.object({ message: z.string(), code: z.string().nullable().optional() }).passthrough().nullable(),
      startedAt: z.string().datetime(), finishedAt: z.string().datetime(), durationMs: count, spawnCloseCode: z.number().int().nullable(),
      parentTracking: z.object({ ownerPid: count.positive(), helperPid: count.positive(), childPid: count.positive().nullable(), ownerLost: z.boolean() }).strict(),
      outputComplete: z.boolean(), storedBytes: count, observedBytes: count }).passthrough()
      .parse(JSON.parse(boundedRead(root, diagnostic.nativeResult)));
    const stdout = boundedRead(root, diagnostic.stdout), stderr = boundedRead(root, diagnostic.stderr);
    const counts = measuredTestSummary(`${stdout}\n${stderr}`);
    const reported = z.object({ tests: count, pass: count, fail: count, cancelled: count, skipped: count, todo: count, suites: count }).strict().safeParse(step.testSummary);
    captures.push({ native, stdout, stderr });
    if (!step.ok || step.exitCode !== 0 || step.signal || step.error || diagnostic.mayBeIncomplete || !native.outputComplete || native.status !== 0 || native.signal || native.error ||
      Buffer.byteLength(stdout) !== diagnostic.stdoutBytes || Buffer.byteLength(stderr) !== diagnostic.stderrBytes ||
      native.parentTracking?.ownerLost || native.storedBytes !== native.observedBytes || native.storedBytes !== diagnostic.stdoutBytes + diagnostic.stderrBytes ||
      step.judge === undefined || !step.judge.complete || step.judge.given !== summary.suites.length || step.judge.reported !== summary.suites.length ||
      !counts || counts.tests <= 0 || counts.passed <= 0 || counts.failed || counts.skipped || !reported.success ||
      reported.data.tests !== counts.tests || reported.data.pass !== counts.passed || reported.data.fail + reported.data.cancelled !== counts.failed ||
      reported.data.skipped + reported.data.todo !== counts.skipped || reported.data.suites !== counts.suites) complete = false;
    if (counts) { tests += counts.tests; suites += counts.suites; }
  }
  const failed = summary.verdict === "failed" || summary.steps.some(step => !step.ok || step.exitCode !== 0 || step.signal || step.error) || Boolean(summary.error);
  const verdict = failed ? "failed" : complete && tests > 0 ? "passed" : "partial";
  return { producer: { summary: producer, captures }, qualification: { producer: "core-author" as const, verdict, tests, suites,
    originalVerdict: summary.verdict, reason: failed ? "author qualification failed or refused" : verdict === "passed" ? "complete measured author qualification" : "author qualification incomplete" } };
}

/** Capture only: never launches qualification, never changes the native run's exit decision. */
export function captureLocalQualificationReceipt(input: QualificationIdentity & { worktreeRoot: string; log: (step: string, fields: Record<string, unknown>) => void }): LocalQualification {
  try {
    const identity = resolveOwnerRepoAt(input.worktreeRoot);
    if (`${identity.owner}/${identity.repo}` !== input.repository) throw new Error("qualification repository mismatch");
    const head = sha.parse(hostWorktreeGit(input.worktreeRoot, ["rev-parse", "HEAD"]).trim());
    let qualification: LocalQualification, producer: unknown;
    try {
      const read = input.repository === "craigoley/remudero" ? authorQualification(input.worktreeRoot, head) : consumerQualification(input.worktreeRoot, input.repository, head);
      qualification = localQualificationSchema.parse(read.qualification); producer = read.producer;
    } catch (error) {
      const reason = String(error);
      qualification = unknown(reason); producer = null;
    }
    const after = hostWorktreeGit(input.worktreeRoot, ["rev-parse", "HEAD"]).trim();
    const status = hostWorktreeGit(input.worktreeRoot, ["status", "--porcelain", "--untracked-files=normal"]).trim();
    if (after !== head || status) qualification = unknown("source tree changed or dirty at capture");
    const snapshot = snapshotSchema.parse({ version: 1, repository: input.repository, taskId: input.taskId, runId: input.runId, head, qualification, producer });
    const text = JSON.stringify(snapshot);
    if (Buffer.byteLength(text) > MAX_ARTIFACT_BYTES) throw new Error("qualification snapshot exceeds bound");
    const artifactDigest = digest(text), reference = `local-qualification/${artifactDigest}.json`;
    const path = join(input.stateRoot, "state", reference);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { writeFileSync(path, text, { flag: "wx", mode: 0o600, flush: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || boundedRead(join(input.stateRoot, "state"), reference) !== text) throw error;
    }
    for (const directory of [dirname(path), join(input.stateRoot, "state")]) {
      const fd = openSync(directory, constants.O_RDONLY);
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    input.log("local.qualification", { task_id: input.taskId, run_id: input.runId, repository: input.repository, head_sha: head,
      artifact_digest: artifactDigest, artifact_reference: reference, qualification_outcome: qualification.verdict });
    return { ...qualification, digest: artifactDigest, reference };
  } catch (error) {
    const result = unknown(String(error));
    try { input.log("local.qualification_unavailable", { task_id: input.taskId, run_id: input.runId, reason: result.reason }); }
    catch (logError) {
      const reason = `${result.reason}; qualification logging unavailable: ${String(logError)}`;
      return unknown(reason);
    }
    return result;
  }
}

/** The caller supplies a row from its complete, run-scoped ledger read, never an HTTP path. */
export function readLocalQualificationReceipt(input: QualificationIdentity & { head: string; row: Record<string, unknown> }): { outcome: "succeeded" | "failed" | "unknown"; qualification: LocalQualification } {
  try {
    const row = input.row;
    if (row.step !== "local.qualification" || row.run_id !== input.runId || row.task_id !== input.taskId || row.repository !== input.repository ||
      row.head_sha !== input.head || typeof row.artifact_digest !== "string" || !/^[a-f0-9]{64}$/.test(row.artifact_digest) ||
      row.artifact_reference !== `local-qualification/${row.artifact_digest}.json`) throw new Error("uncorrelated qualification row");
    const text = boundedRead(join(input.stateRoot, "state"), row.artifact_reference as string);
    if (digest(text) !== row.artifact_digest) throw new Error("qualification artifact digest mismatch");
    const snapshot = snapshotSchema.parse(JSON.parse(text));
    if (snapshot.repository !== input.repository || snapshot.taskId !== input.taskId || snapshot.runId !== input.runId || snapshot.head !== input.head) throw new Error("foreign qualification snapshot");
    const qualification = { ...snapshot.qualification, digest: row.artifact_digest, reference: row.artifact_reference as string };
    const outcome = qualification.verdict === "passed" && qualification.tests > 0 ? "succeeded" : qualification.verdict === "failed" ? "failed" : "unknown";
    return { outcome, qualification };
  } catch (error) {
    const reason = String(error);
    return { outcome: "unknown", qualification: unknown(reason) };
  }
}
