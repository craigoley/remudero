/** Private component execution, separate from whole-fix adoption and causal efficacy. */
import { createHash, randomUUID } from "node:crypto";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";
import { systemClock } from "./clock.js";
import { captureImportedModule, importedModuleOf, type ImportedModuleEvidence } from "./prevention-source-evidence.js";
import { fileURLToPath } from "node:url";
import type { RepairCostContext } from "./repair-cost-evidence.js";
import type { FixRoundCommentInput, FixRoundCommentResult, FixRoundCommentWriter } from "./fix-round-comment.js";

const COMPONENT = "ci-log-named-source-paths";
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const time = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const token = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const object = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const hashFunction = (fn: Function) => createHash("sha256").update(Function.prototype.toString.call(fn)).digest("hex");
const processInstanceId = randomUUID();

export interface CiRemedyComponent {
  caller: ImportedModuleEvidence;
  recorder: ImportedModuleEvidence;
  functionSha256: string;
  dependencies: { existsSyncSha256: string; joinSha256: string; importedModuleSha256: string; clockSha256: string; nodeVersion: string };
}
/** Capture the exact lexical function and imported dependencies once with the caller's source pin.
 * These hashes identify JS function representations; nodeVersion is not a binary attestation. */
export function captureCiRemedyComponent(caller: ImportedModuleEvidence | undefined,
  guard: Function, exists: Function, join: Function,
  recorder: ImportedModuleEvidence = captureImportedModule(fileURLToPath(import.meta.url),
    caller?.state === "observed" ? { source: "executing-module-git", revision: caller.revision } : undefined),
): CiRemedyComponent {
  return { caller: importedModuleOf(caller), recorder: importedModuleOf(recorder), functionSha256: hashFunction(guard),
    dependencies: { existsSyncSha256: hashFunction(exists), joinSha256: hashFunction(join),
      importedModuleSha256: hashFunction(importedModuleOf), clockSha256: hashFunction(systemClock.iso), nodeVersion: process.version } };
}

type Unavailable = { state: "unavailable"; reason: string };
export type CiRemedyExecution = { state: "observed"; version: "ci-remedy-execution-v1";
  component: typeof COMPONENT; lineageTask: "W1-T5801"; invocationId: string; at: string;
  processInstanceId: string; pid: number; callerRunId: string; identity: CiRemedyComponent;
  inputs: { failingChecks: number; matchedPaths: number; reachablePaths: number;
    ownership: "compared" | "no-base" | "unreadable" } } | Unavailable;

/** Call only after the real guard and main-ownership filter return, using their actual counts.
 * No log text, repository directory or named remedy path enters the evidence. */
export function recordCiRemedyExecution(identity: CiRemedyComponent, callerRunId: string,
  inputs: Extract<CiRemedyExecution, { state: "observed" }>["inputs"]): CiRemedyExecution {
  return ciRemedyExecutionOf({ state: "observed", version: "ci-remedy-execution-v1", component: COMPONENT,
    lineageTask: "W1-T5801", invocationId: randomUUID(), at: systemClock.iso(),
    processInstanceId, pid: process.pid, callerRunId, identity, inputs });
}

/** Strict projection: a name, a loaded function object or a missing field is not an execution. */
export function ciRemedyExecutionOf(value: unknown): CiRemedyExecution {
  const r = object(value), identity = object(r?.identity), dependencies = object(identity?.dependencies), inputs = object(r?.inputs);
  if (!r || !identity || !dependencies || !inputs) return { state: "unavailable", reason: "qualifying-component-execution-not-recorded" };
  const caller = importedModuleOf(identity.caller), recorder = importedModuleOf(identity.recorder);
  if (r?.state !== "observed" || r.version !== "ci-remedy-execution-v1" || r.component !== COMPONENT
    || r.lineageTask !== "W1-T5801" || !UUID.test(String(r.invocationId)) || !UUID.test(String(r.processInstanceId))
    || !count(r.pid) || r.pid === 0 || !token(r.callerRunId) || !time(r.at)
    || caller.state !== "observed" || caller.path !== "src/run-task.ts" || Date.parse(caller.capturedAt) > Date.parse(r.at)
    || recorder.state !== "observed" || recorder.path !== "src/lib/ci-remedy-execution.ts"
    || recorder.revision !== caller.revision || Date.parse(recorder.capturedAt) > Date.parse(r.at)
    || !SHA256.test(String(identity.functionSha256)) || !SHA256.test(String(dependencies.existsSyncSha256))
    || !SHA256.test(String(dependencies.joinSha256)) || !SHA256.test(String(dependencies.importedModuleSha256))
    || !SHA256.test(String(dependencies.clockSha256)) || typeof dependencies.nodeVersion !== "string"
    || !/^v\d+\.\d+\.\d+$/.test(dependencies.nodeVersion)
    || !count(inputs.failingChecks) || !count(inputs.matchedPaths) || !count(inputs.reachablePaths)
    || inputs.matchedPaths > 5 || inputs.reachablePaths > inputs.matchedPaths
    || (inputs.failingChecks === 0 && inputs.matchedPaths !== 0)
    || !["compared", "no-base", "unreadable"].includes(String(inputs.ownership))
    || (inputs.ownership === "unreadable" && inputs.reachablePaths !== 0))
    return { state: "unavailable", reason: "qualifying-component-execution-not-recorded" };
  return { state: "observed", version: "ci-remedy-execution-v1", component: COMPONENT, lineageTask: "W1-T5801",
    invocationId: String(r.invocationId), at: r.at, processInstanceId: String(r.processInstanceId), pid: r.pid,
    callerRunId: r.callerRunId, identity: { caller, recorder, functionSha256: String(identity!.functionSha256),
      dependencies: { existsSyncSha256: String(dependencies.existsSyncSha256), joinSha256: String(dependencies.joinSha256), importedModuleSha256: String(dependencies.importedModuleSha256), clockSha256: String(dependencies.clockSha256), nodeVersion: dependencies.nodeVersion } },
    inputs: { failingChecks: inputs.failingChecks, matchedPaths: inputs.matchedPaths, reachablePaths: inputs.reachablePaths,
      ownership: inputs.ownership as "compared" | "no-base" | "unreadable" } };
}

/** W1-T14628: a strike that answered red CI checks, through this component, reports its landed push on the PR's one
 *  fix-round comment. The site names the component, and each row the writer logs carries this execution's invocation
 *  id (or why none was recorded), so the comment row joins the `fix.remedy_path_execution` row of the same round.
 *  The fix round calls this once per landed push in place of its plain call, with the writer it was handed; the
 *  writer never throws. */
export function upsertCiRemedyRoundComment(execution: CiRemedyExecution, input: FixRoundCommentInput,
  log: (step: string, extra?: Record<string, unknown>) => void, upsertFixRoundComment: FixRoundCommentWriter): Promise<FixRoundCommentResult> {
  const remedy = execution.state === "observed" ? { remedy_invocation_id: execution.invocationId } : { remedy_execution: execution.reason };
  return upsertFixRoundComment({ ...input, round: { ...input.round, site: `${input.round.site} (${COMPONENT})` } },
    (step, extra) => log(step, { ...extra, ...remedy }));
}

interface ExecutionRow { step: string; ts: string | null; host: string | null; runId?: string | null;
  assignmentId: string | null; success: boolean | null; repair?: RepairCostContext; remedyExecution?: CiRemedyExecution }
/** BACKSTOP: per-pass retained component invocations. Overflow is explicit, never a fleet denominator. */
export const CI_REMEDY_EXECUTIONS_MAX = 128;

/** Uses the existing bounded ledger corpus. The registration's older whole-file identity remains
 * untouched. lineageTask is a historical reference, not certification that all of W1-T5801 runs. */
export function ciRemedyExecutionReport(rows: readonly ExecutionRow[], asOf: string) {
  type Work = { at: string; workerRunId: string; assignmentId: string; roundId: string; success: boolean };
  type Item = { host: string; execution: Extract<CiRemedyExecution, { state: "observed" }>; conflict: boolean;
    laterWork: { state: "observed"; outcomes: Work[] } | Unavailable };
  const records = new Map<string, Item>(), omitted = new Set<string>();
  const assignments = new Map<string, ExecutionRow[]>(), terminals = new Map<string, ExecutionRow[]>();
  const key = (row: ExecutionRow) => JSON.stringify([row.host, row.repair?.workerRunId, row.assignmentId,
    row.repair?.roundId, row.repair?.repo, row.repair?.number]);
  const validJoin = (row: ExecutionRow) => row.host !== null && row.assignmentId !== null && token(row.assignmentId)
    && row.repair?.rung === "fix" && token(row.repair.workerRunId) && token(row.repair.roundId)
    && row.repair.repo !== null && row.repair.number !== null && row.repair.assignmentObserved !== false;
  for (const row of rows) {
    if (!time(asOf) || !time(row.ts) || Date.parse(row.ts) > Date.parse(asOf) || row.host === null) continue;
    if (!["fix.remedy_path_execution", "worker.assignment"].includes(row.step)) continue;
    const execution = ciRemedyExecutionOf(row.remedyExecution);
    if (["fix.remedy_path_execution", "worker.assignment"].includes(row.step) && execution.state === "observed"
      && row.runId === execution.callerRunId && Date.parse(execution.at) <= Date.parse(row.ts)) {
      const id = JSON.stringify([row.host, execution.processInstanceId, execution.invocationId]);
      const old = records.get(id);
      if (old) old.conflict ||= JSON.stringify(old.execution) !== JSON.stringify(execution);
      else if (records.size < CI_REMEDY_EXECUTIONS_MAX) records.set(id, { host: row.host, execution, conflict: false,
        laterWork: { state: "unavailable", reason: "no-later-joined-worker-attempt" } });
      else omitted.add(id);
    }
  }
  // Index only assignments for the retained invocations, then only their terminals. Keeping
  // all fleet worker rows would duplicate the existing collector's largest join population.
  for (const row of rows) {
    if (row.step !== "worker.assignment" || !validJoin(row) || !time(row.ts) || Date.parse(row.ts) > Date.parse(asOf)) continue;
    const execution = ciRemedyExecutionOf(row.remedyExecution);
    if (execution.state !== "observed" || !records.has(JSON.stringify([row.host, execution.processInstanceId, execution.invocationId]))) continue;
    const group = assignments.get(key(row)) ?? []; group.push(row); assignments.set(key(row), group);
  }
  for (const row of rows) {
    if (row.step !== "worker.attempt" || !validJoin(row) || !time(row.ts) || Date.parse(row.ts) > Date.parse(asOf)
      || !assignments.has(key(row))) continue;
    const group = terminals.get(key(row)) ?? []; group.push(row); terminals.set(key(row), group);
  }
  for (const group of assignments.values()) {
    const assignment = group[0]!, execution = ciRemedyExecutionOf(assignment.remedyExecution);
    if (execution.state !== "observed" || assignment.runId !== execution.callerRunId
      || Date.parse(execution.at) > Date.parse(assignment.ts!)) continue;
    const item = records.get(JSON.stringify([assignment.host, execution.processInstanceId, execution.invocationId]));
    if (!item || item.conflict || execution.inputs.reachablePaths === 0) continue;
    if (group.some(row => row.ts !== assignment.ts || row.runId !== assignment.runId
      || JSON.stringify(ciRemedyExecutionOf(row.remedyExecution)) !== JSON.stringify(execution))) continue;
    const ends = terminals.get(key(assignment)) ?? [];
    if (new Set(ends.map(row => JSON.stringify([row.success, row.runId, Date.parse(row.ts!) >= Date.parse(assignment.ts!), ciRemedyExecutionOf(row.remedyExecution)]))).size !== 1) continue;
    const end = ends.find(row => row.runId === execution.callerRunId && typeof row.success === "boolean" && Date.parse(row.ts!) >= Date.parse(assignment.ts!)
      && JSON.stringify(ciRemedyExecutionOf(row.remedyExecution)) === JSON.stringify(execution));
    if (!end) continue;
    const outcome: Work = { at: end.ts!, workerRunId: end.repair!.workerRunId!, assignmentId: end.assignmentId!,
      roundId: end.repair!.roundId!, success: end.success! };
    if (item.laterWork.state !== "observed") item.laterWork = { state: "observed", outcomes: [] };
    item.laterWork.outcomes.push(outcome);
  }
  const items = [...records.values()].map(item => ({ host: item.host, execution: item.execution,
    eligible: item.execution.inputs.reachablePaths > 0, laterWork: item.conflict
      ? { state: "unavailable" as const, reason: "conflicting-component-execution-receipts" } : item.laterWork,
    basis: "named-component-invocation-and-joined-worker-attempt" as const, wholeFixAdoption: "not-certified" as const,
    efficacyClaim: "none" as const, history: "unavailable-retention-uncertified" as const }));
  return { state: items.length ? "observed-partial" : "unavailable", reason: !time(asOf) ? "invalid-observation-time"
    : items.length ? "component-execution-only-retention-uncertified" : "no-qualified-component-execution",
    omittedInvocations: omitted.size, records: items };
}

/** W1-T15064: the marker scripts/expiring-fixture-census.mjs prints on a crossing the base already carries. */
export const BASE_INHERITED_MARKER = "[inherited from the base -- NOT this diff]";
/** One census crossing line, as that script prints it: `  - <file>:<line>  ... goes red <day> (...)`. */
const CROSSING_LINE = /^\s*- \S+:\d+\s.*\sgoes red\s/;
/** The census's own headlines. Only the crossing headline can be inherited: formatReport attributes nothing else. */
const CENSUS_HEADLINE = /^expiring-fixture-census: (?:BLOCKED|CLEAR|OK) -- /;
const INHERITABLE_HEADLINE = /^expiring-fixture-census: BLOCKED -- (\d+) fixture\(s\) CROSS their threshold within /;
/** A population-drop line: formatReport never attributes a drop to the base. */
const POPULATION_DROP_LINE = /^\s*- \S+: measured \d+ stamp\(s\), recorded \d+ \(/;
/** A failure the log names that is not a census crossing: a failed test or a type error. */
const OTHER_RED = /^\s*not ok \d|^\s*✖ |\berror TS\d+/;
/** The `gh run view --log-failed` prefix (`<job>\t<step>\t<timestamp> `) or a job log's own timestamp. */
const LOG_PREFIX = /^[^\t\n]*\t[^\t\n]*\t\S+ ?|^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
/** An error annotation as the runner renders it (`##[error]...`) or as the step wrote it (`::error ...::...`). */
const ERROR_ANNOTATION = /^(?:##\[error\]|::error(?: [^:]*)?::)(.*)$/;
const decodeAnnotation = (text: string) => text.replace(/%0D/g, "\r").replace(/%0A/g, "\n").replace(/%25/g, "%");
/** An ANSI escape sequence: actions/runner echoes each Run-group script line as `ESC[36;1m<line>ESC[0m`. */
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
/** A log as plain text: the runner's colour codes, and any a tool wrote around its own output, stripped. */
const plainLog = (text: string) => text.replace(ANSI_ESCAPE, "");

/** A failing check's log as report lines, colour codes stripped; each error annotation is decoded, and its first line
 *  is kept apart. */
function reportLines(logTail: string): { lines: string[]; annotationHeads: string[]; failedExitSteps: string[] } {
  const lines: string[] = [], annotationHeads: string[] = [], failedExitSteps: string[] = [];
  let currentStep = "";
  let currentScript: string[] = [];
  let inRunGroup = false;
  for (const raw of logTail.split(/\r?\n/)) {
    const line = plainLog(raw).replace(LOG_PREFIX, "");
    const run = /^##\[group\]Run\s+(.+)$/.exec(line);
    if (run) { currentStep = run[1]!; currentScript = [run[1]!]; inRunGroup = true; }
    else if (line === "##[endgroup]") {
      currentStep = currentScript.join("\n");
      inRunGroup = false;
    } else if (inRunGroup) currentScript.push(line);
    const annotation = ERROR_ANNOTATION.exec(line);
    if (!annotation) { lines.push(line); continue; }
    const decoded = decodeAnnotation(annotation[1]!).split(/\r?\n/);
    annotationHeads.push(decoded[0]!);
    if (/^Process completed with exit code \d+\.?$/.test(decoded[0]!)) failedExitSteps.push(currentStep);
    lines.push(...decoded);
  }
  return { lines, annotationHeads, failedExitSteps };
}

/** True when one failing check's log is the census's crossing report and the base owns every line of it. */
function censusReportIsInherited(logTail: string): boolean {
  const { lines, annotationHeads, failedExitSteps } = reportLines(logTail);
  const headlines = lines.filter((line) => CENSUS_HEADLINE.test(line));
  const crossings = lines.filter((line) => CROSSING_LINE.test(line));
  const failedExitAnnotations = annotationHeads.filter((head) => /^Process completed with exit code \d+\.?$/.test(head));
  // The headline states how many crossings the report lists. A log that holds fewer distinct crossing lines was cut
  // (the CI log region keeps only a few lines before each error), so what it lost is unknown, and unknown is not
  // inherited.
  const counts = new Set(headlines.map((line) => Number(INHERITABLE_HEADLINE.exec(line)?.[1])));
  return headlines.length > 0 && headlines.every((line) => INHERITABLE_HEADLINE.test(line))
    && counts.size === 1 && new Set(crossings.map((line) => line.trim())).size === [...counts][0]
    && crossings.length > 0 && crossings.every((line) => line.includes(BASE_INHERITED_MARKER))
    && !lines.some((line) => POPULATION_DROP_LINE.test(line) || OTHER_RED.test(line))
    // A job log can include several failed steps. A generic exit annotation counts only when its preceding Actions
    // command is the census itself; an unknown or differently named step can hide an unmarked red in the same job.
    && failedExitAnnotations.length <= 1
    && (failedExitAnnotations.length === 0 || (failedExitSteps.length === 1
      && /(?:^|[\s/])node\s+scripts\/expiring-fixture-census\.mjs(?:\s|$)/m.test(failedExitSteps[0]!)))
    && annotationHeads.every((head) => INHERITABLE_HEADLINE.test(head) || /^Process completed with exit code \d+\.?$/.test(head));
}

/** W1-T15064: every red step a round would answer is base-inherited when each failing check's log is the census's
 *  crossing report, every crossing in it is marked inherited, and it names nothing else: no population drop, no other
 *  census verdict, no failed test, no error annotation but the census's own headline. An empty list, or any doubt,
 *  is not. */
export function baseInheritedRedSteps(failures: ReadonlyArray<{ name: string; logTail: string }>): { inherited: boolean; steps: string[] } {
  const steps = [...new Set(failures.map((failure) => failure.name))];
  return { inherited: failures.length > 0 && failures.every((failure) => censusReportIsInherited(failure.logTail)), steps };
}

/** W1-T15064: {@link baseInheritedRedSteps} over each census step's COMPLETE job log. A failure's `logTail` is the CI
 *  log region, which keeps only a few lines before each error, so a long census report arrives cut; the full log is
 *  read by the failure's job id. A log that cannot be read leaves the region, which then reads as unknown. */
export async function baseInheritedRedStepsFromJobLogs(failures: ReadonlyArray<{ name: string; logTail: string; jobId?: string }>,
  readJobLog: (jobId: string) => Promise<string>): Promise<{ inherited: boolean; steps: string[]; unread: string[] }> {
  const unread: string[] = [];
  const logs: Array<{ name: string; logTail: string }> = [];
  for (const failure of failures) {
    let logTail = failure.logTail;
    if (failure.jobId !== undefined && plainLog(failure.logTail).includes("expiring-fixture-census:")) {
      try {
        logTail = await readJobLog(failure.jobId);
      } catch (error) {
        const unreadable = String(error);
        unread.push(`${failure.name}: ${unreadable}`);
      }
    }
    logs.push({ name: failure.name, logTail });
  }
  return { ...baseInheritedRedSteps(logs), unread };
}

interface SourceToken { kind: SyntaxKind; text: string; start: number; end: number; lineBreak: boolean }

/** A `/` after one of these opens a regular expression, not a division: the repo's own scanner convention
 *  (src/lib/source-text-readers.ts), with `;` added for a literal that starts a statement. */
const REGEX_AFTER = /^(?:=|\(|\[|\{|,|:|\?|;|return|case|=>|!|&&|\|\||\?\?)$/;

/** The file's tokens, read by TypeScript's own scanner: strings, templates, comments and regular expressions are
 *  single tokens, so a quote or a paren inside one is never read as code. */
function sourceTokens(text: string): SourceToken[] {
  const scanner = createScanner(true, undefined, text);
  const tokens: SourceToken[] = [];
  const templateDepths: number[] = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if ((kind === SyntaxKind.SlashToken || kind === SyntaxKind.SlashEqualsToken) && REGEX_AFTER.test(tokens.at(-1)?.text ?? "=")) {
      kind = scanner.reScanSlashToken();
    }
    // A `#` the scanner could not read as a private name scans as an empty token; read it as `#` and move on.
    if (kind === SyntaxKind.PrivateIdentifier && scanner.getTokenEnd() === scanner.getTokenStart()) kind = scanner.reScanHashToken();
    if (scanner.getTokenEnd() <= scanner.getTokenStart() && tokens.at(-1)?.start === scanner.getTokenStart()) {
      throw new Error(`the scanner made no progress at offset ${scanner.getTokenStart()}`);
    }
    if (kind === SyntaxKind.TemplateHead) templateDepths.push(0);
    else if (kind === SyntaxKind.OpenBraceToken && templateDepths.length > 0) templateDepths[templateDepths.length - 1]!++;
    else if (kind === SyntaxKind.CloseBraceToken && templateDepths.length > 0) {
      if (templateDepths.at(-1) === 0) {
        kind = scanner.reScanTemplateToken(false);
        if (kind === SyntaxKind.TemplateTail) templateDepths.pop();
      } else templateDepths[templateDepths.length - 1]!--;
    }
    tokens.push({ kind, text: scanner.getTokenText(), start: scanner.getTokenStart(), end: scanner.getTokenEnd(),
      lineBreak: scanner.hasPrecedingLineBreak() });
  }
  return tokens;
}

const OPENERS = new Set(["(", "[", "{"]), CLOSERS = new Set([")", "]", "}"]);
/** The index of the token closing the bracket opened at `open`, or the last token when the file ends first. */
function closing(tokens: readonly SourceToken[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (OPENERS.has(tokens[i]!.text)) depth++;
    else if (CLOSERS.has(tokens[i]!.text) && --depth === 0) return i;
  }
  return tokens.length - 1;
}
/** A word token: an identifier, or a contextual keyword the scanner names (`assert` scans as AssertKeyword). */
const isName = (token: SourceToken | undefined) => token !== undefined && /^[A-Za-z_$][\w$]*$/.test(token.text);
/** A literal value: a string, template, number, regular expression, `true`, `false` or `null`. */
const isLiteral = ({ text }: SourceToken) => /^(?:["'`]|\.?\d|(?:true|false|null)$)/.test(text)
  || (text.length > 1 && text.startsWith("/") && text !== "/=");
const sliceOf = (text: string, tokens: readonly SourceToken[], from: number, to: number) =>
  text.slice(tokens[from]!.start, tokens[to]!.end).replace(/\s+/g, " ");

/** Each assertion in the file: `assert(...)`, `assert.x(...)` or `expect(...)` with its chained matchers, whole,
 *  whitespace collapsed, with the names its arguments read. */
const ASSERTION_IMPORTS = new Set(["ok", "equal", "strictEqual", "deepEqual", "deepStrictEqual", "notEqual", "notStrictEqual",
  "throws", "doesNotThrow", "match", "doesNotMatch", "fail", "ifError", "rejects", "doesNotReject"]);

/** Local names imported as individual assertion functions from Node's assert modules, including aliases. */
function namedAssertionImports(tokens: readonly SourceToken[]): Set<string> {
  const names = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.text !== "import") continue;
    let from = i + 1;
    while (from < tokens.length && tokens[from]!.text !== "from" && tokens[from]!.text !== ";") from++;
    if (tokens[from]?.text !== "from" || !/^['\"](?:node:)?assert(?:\/strict)?['\"]$/.test(tokens[from + 1]?.text ?? "")) continue;
    const open = tokens.findIndex((token, at) => at > i && at < from && token.text === "{");
    if (open < 0) continue;
    const close = closing(tokens, open);
    for (let at = open + 1; at < close; at++) {
      if (!ASSERTION_IMPORTS.has(tokens[at]!.text)) continue;
      const local = tokens[at + 1]?.text === "as" ? tokens[at + 2]?.text : tokens[at]!.text;
      if (isName(tokens[at]) && isName(tokens[tokens[at + 1]?.text === "as" ? at + 2 : at])) names.add(local!);
    }
    i = from;
  }
  return names;
}

/** A name the code reads: a word token that is not a property name after `.` or `?.`. */
const isRead = (tokens: readonly SourceToken[], at: number) =>
  isName(tokens[at]) && tokens[at - 1]?.text !== "." && tokens[at - 1]?.text !== "?.";
/** The names the tokens `from..to` (inclusive) read. */
function namesIn(tokens: readonly SourceToken[], from: number, to: number): string[] {
  const names: string[] = [];
  for (let k = Math.max(0, from); k <= to && k < tokens.length; k++) if (isRead(tokens, k)) names.push(tokens[k]!.text);
  return names;
}

/** Each bracket's partner, and each token's innermost enclosing opener (-1 at top level), read in one pass. */
function bracketsOf(tokens: readonly SourceToken[]): { partner: number[]; parent: number[] } {
  const partner = new Array<number>(tokens.length).fill(-1), parent = new Array<number>(tokens.length).fill(-1);
  const stack: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const text = tokens[i]!.text;
    if (CLOSERS.has(text) && stack.length > 0) { const open = stack.pop()!; partner[open] = i; partner[i] = open; }
    parent[i] = stack.at(-1) ?? -1;
    if (OPENERS.has(text)) stack.push(i);
  }
  return { partner, parent };
}

/** A line break after one of these continues the statement. */
const CONTINUES = /^(?:=|,|\?|:|\+|-|\*|\/|%|&&|\|\||\?\?|=>|\.|===|!==|==|!=|<|>|<=|>=|\||&|in|of|instanceof)$/;

/** The last token of the `const`/`let`/`var` statement starting at `i`. */
function statementEnd(tokens: readonly SourceToken[], i: number): number {
  let end = i + 1, depth = 0;
  for (let k = i + 1; k < tokens.length; k++) {
    const token = tokens[k]!;
    if (depth === 0 && k > i + 1 && (token.text === ";" || (token.lineBreak && !CONTINUES.test(tokens[k - 1]!.text)
      && !CONTINUES.test(token.text)))) break;
    if (OPENERS.has(token.text)) depth++;
    else if (CLOSERS.has(token.text) && --depth < 0) break;
    end = k;
  }
  return end;
}

/** After one of these, a return type's `{` opens an object type, not the body. */
const TYPE_CONTINUES = /^(?:[:|&,<?]|=>|keyof|typeof|infer|extends|is|asserts|readonly|unique|new)$/;

/** The body's `{` of a function whose parameter list closes at `close`, past a return type such as `: { ok: boolean }`
 *  or `: Promise<{ ok: boolean }>`; the `;` ending a signature with none (an overload, `declare function`); or -1. */
function functionBody(tokens: readonly SourceToken[], partner: readonly number[], close: number): number {
  const typed = tokens[close + 1]?.text === ":";
  let wantsType = false, angles = 0;
  for (let k = close + 1; k < tokens.length; k++) {
    const text = tokens[k]!.text;
    if (text === ";" && angles === 0) return k;
    if (text === "{" && !(typed && (wantsType || angles > 0))) return k;
    if (OPENERS.has(text) && partner[k]! >= 0) { k = partner[k]!; wantsType = false; continue; }
    if (text === "<") angles++;
    else if (text === ">" && angles > 0) angles--;
    wantsType = TYPE_CONTINUES.test(text);
  }
  return -1;
}

/** One declaration: the names it binds, the token range it spans, and whether it holds a function. */
interface Declaration { names: string[]; from: number; to: number; callable: boolean }

/** Every `const`/`let`/`var` statement and every `function NAME` declaration in the file. */
function declarationsIn(tokens: readonly SourceToken[], partner: readonly number[]): Declaration[] {
  const found: Declaration[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const text = tokens[i]!.text;
    if (text === "function" && isName(tokens[i + 1]) && tokens[i - 1]?.text !== ".") {
      let params = i + 2;
      while (params < tokens.length && tokens[params]!.text !== "(") params++;
      const close = partner[params] ?? -1;
      const body = close < 0 ? -1 : functionBody(tokens, partner, close);
      const to = body < 0 ? tokens.length - 1
        : tokens[body]!.text === ";" ? body : Math.max(partner[body]!, body);
      found.push({ names: [tokens[i + 1]!.text], from: i, to, callable: true });
      continue;
    }
    if (!["const", "let", "var"].includes(text) || !(isName(tokens[i + 1]) || OPENERS.has(tokens[i + 1]?.text ?? ""))) continue;
    const names = isName(tokens[i + 1]) ? [tokens[i + 1]!.text]
      : tokens.slice(i + 2, closing(tokens, i + 1)).filter((token) => isName(token)).map((token) => token.text);
    const to = statementEnd(tokens, i);
    const callable = tokens.slice(i, to + 1).some((token) => token.text === "=>" || token.text === "function");
    found.push({ names, from: i, to, callable });
  }
  return found;
}

/** What each name's value is computed from, file-wide: the names its declarations read, the names a `for…of`/`for…in`
 *  iterable reads (every one, so `Object.entries(TABLE)` binds to TABLE), and, for a callback's parameters, the
 *  names its call reads before it (`TABLE.forEach(([input, want]) => …)` binds both to TABLE). Scopes are not told
 *  apart, so a name declared twice reads from both. A table written inline, in a loop's iterable or a callback
 *  call's receiver (`[["a", 1]].forEach(([input, want]) => …)`), binds no name: it is kept as a declaration of its
 *  own, `inline(input, want)`, which those locals read. */
function dataSources(text: string, tokens: readonly SourceToken[], declarations: readonly Declaration[],
  { partner, parent }: { partner: readonly number[]; parent: readonly number[] }):
  { sources: Map<string, Set<string>>; inline: Map<string, string[]> } {
  const sources = new Map<string, Set<string>>(), inline = new Map<string, string[]>();
  const bind = (locals: readonly string[], read: readonly string[], from = 0, to = -1) => {
    const literal = tokens.slice(from, to + 1).some(isLiteral);
    const table = `inline(${locals.join(", ")})`;
    if (literal && locals.length > 0) inline.set(table, [...(inline.get(table) ?? []), sliceOf(text, tokens, from, to)]);
    for (const local of locals) {
      const bound = sources.get(local) ?? new Set<string>();
      for (const name of read) if (name !== local) bound.add(name);
      if (literal) bound.add(table);
      sources.set(local, bound);
    }
  };
  for (const { names, from, to } of declarations) bind(names, namesIn(tokens, from + 1, to));
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.text === "for") {
      const open = tokens[i + 1]?.text === "await" ? i + 2 : i + 1;
      if (tokens[open]?.text !== "(" || partner[open]! < 0) continue;
      const close = partner[open]!;
      let of = open + 1;
      while (of < close && !(parent[of] === open && (tokens[of]!.text === "of" || tokens[of]!.text === "in"))) of++;
      if (of >= close) continue;
      const first = ["const", "let", "var"].includes(tokens[open + 1]?.text ?? "") ? open + 2 : open + 1;
      bind(namesIn(tokens, first, of - 1), namesIn(tokens, of + 1, close - 1), of + 1, close - 1);
      continue;
    }
    // A callback: `(params) =>`, `name =>` or `function (params)`.
    let paramsFrom = -1, paramsTo = -1;
    if (tokens[i]!.text === "=>") {
      if (tokens[i - 1]?.text === ")" && partner[i - 1]! >= 0) { paramsFrom = partner[i - 1]!; paramsTo = i - 1; }
      else if (isName(tokens[i - 1])) { paramsFrom = i - 1; paramsTo = i - 1; }
      if (tokens[paramsFrom - 1]?.text === "async") paramsFrom--;
    } else if (tokens[i]!.text === "function" && tokens[i + 1]?.text === "(" && partner[i + 1]! >= 0) {
      paramsFrom = i; paramsTo = partner[i + 1]!;
    }
    if (paramsFrom < 0) continue;
    const call = parent[paramsFrom]!;
    if (call < 0 || tokens[call]!.text !== "(") continue;
    // The callee: names, `.name` steps and bracketed calls or indexes, read back from the call's `(`.
    let callee = call;
    for (;;) {
      const prior = tokens[callee - 1];
      if (prior === undefined) break;
      if ((prior.text === ")" || prior.text === "]") && partner[callee - 1]! >= 0) { callee = partner[callee - 1]!; continue; }
      if (isName(prior) && !["if", "while", "for", "switch", "catch", "return", "typeof", "await"].includes(prior.text)) {
        callee--;
        if (tokens[callee - 1]?.text === "." || tokens[callee - 1]?.text === "?.") { callee--; continue; }
      }
      break;
    }
    if (callee === call) continue;
    bind(namesIn(tokens, paramsFrom, paramsTo), [...namesIn(tokens, callee, call - 1), ...namesIn(tokens, call + 1, paramsFrom - 1)],
      callee, call - 1);
  }
  return { sources, inline };
}

/** The file's assertion heads: `assert`, `expect`, named node:assert imports, and every file-local function whose body
 *  makes an assertion, such as `const close = (actual, expected) => assert.ok(…)`, to any depth. */
const BUILTIN_HEADS = new Set(["assert", "expect"]);
function assertionHeads(tokens: readonly SourceToken[], declarations: readonly Declaration[]): Set<string> {
  const heads = new Set([...BUILTIN_HEADS, ...namedAssertionImports(tokens)]);
  const helpers = declarations.filter((declaration) => declaration.callable && declaration.names.length === 1);
  for (let grew = true; grew;) {
    grew = false;
    for (const { names: [name], from, to } of helpers) {
      if (heads.has(name!)) continue;
      for (let k = from + 2; k <= to; k++) {
        if (!heads.has(tokens[k]!.text) || !(isRead(tokens, k) || tokens[k]!.text === "assert")) continue;
        let at = k + 1;
        while (tokens[at]?.text === "." && isName(tokens[at + 1])) at += 2;
        if (tokens[at]?.text === "(") { heads.add(name!); grew = true; break; }
      }
    }
  }
  return heads;
}

/** The outermost block bodies, `{` to `}`, of the callbacks within tokens `from..to`: `() => { … }`, `function () { … }`. */
function blockBodies(tokens: readonly SourceToken[], partner: readonly number[], from: number, to: number): Array<[number, number]> {
  const blocks: Array<[number, number]> = [];
  for (let k = from; k <= to; k++) {
    let open = -1;
    if (tokens[k]!.text === "=>") open = k + 1;
    else if (tokens[k]!.text === "function") {
      let params = k + 1;
      while (params <= to && tokens[params]!.text !== "(") params++;
      if (params <= to && partner[params]! >= 0) open = functionBody(tokens, partner, partner[params]!);
    }
    if (open < 0 || open > to || tokens[open]!.text !== "{" || partner[open]! < 0 || partner[open]! > to) continue;
    blocks.push([open, partner[open]!]);
    k = partner[open]!;
  }
  return blocks;
}

/** Each assertion in the file, whole, whitespace collapsed, with the names its arguments read: a call to an assertion
 *  head with its chained matchers. `t.assert.equal(…)` counts as `assert.equal(…)`. */
function assertionsOf(text: string, tokens: readonly SourceToken[], heads: ReadonlySet<string>, partner: readonly number[]):
  Array<{ call: string; reads: Set<string> }> {
  const found: Array<{ call: string; reads: Set<string> }> = [];
  const namedImports = namedAssertionImports(tokens);
  for (let i = 0; i < tokens.length; i++) {
    const head = tokens[i]!;
    if (!isName(head) || !heads.has(head.text) || tokens[i - 1]?.text === "function") continue;
    if ((tokens[i - 1]?.text === "." || tokens[i - 1]?.text === "?.") && head.text !== "assert") continue;
    let at = i + 1;
    while (tokens[at]?.text === "." && isName(tokens[at + 1])) at += 2;
    if (tokens[at]?.text !== "(") continue;
    let end = closing(tokens, at);
    while (tokens[end + 1]?.text === "." && isName(tokens[end + 2]) && tokens[end + 3]?.text === "(") end = closing(tokens, end + 3);
    // A local helper handed a callback with a block body (`withRepo(() => { … })`) wraps test code: the call is
    // compared with each block elided, so its other arguments (`assertPolicyError(() => …, /regex/)`) are still an
    // expectation, and the assertions inside are read one by one, so a line added inside is not a rewrite.
    const blocks = BUILTIN_HEADS.has(head.text) || namedImports.has(head.text) ? [] : blockBodies(tokens, partner, at + 1, end - 1);
    if (blocks.length > 0) {
      const kept: Array<[number, number]> = [];
      let from = i;
      for (const [open, close] of blocks) { kept.push([from, open - 1]); from = close + 1; }
      kept.push([from, end]);
      found.push({ call: kept.map(([a, b]) => sliceOf(text, tokens, a, b)).join(" … "),
        reads: new Set(kept.flatMap(([a, b]) => namesIn(tokens, Math.max(a, at + 1), Math.min(b, end - 1)))) });
      continue;
    }
    found.push({ call: sliceOf(text, tokens, i, end), reads: new Set(namesIn(tokens, at + 1, end - 1)) });
    i = end;
  }
  return found;
}

/** Each declaration's text, by every name it binds, whitespace collapsed. A name declared twice in different scopes
 *  keeps both texts. */
function bindingDeclarationsOf(text: string, tokens: readonly SourceToken[], declarations: readonly Declaration[]): Map<string, string[]> {
  const texts = new Map<string, string[]>();
  for (const { names, from, to } of declarations) {
    const statement = sliceOf(text, tokens, from, to);
    for (const name of names) texts.set(name, [...(texts.get(name) ?? []), statement]);
  }
  return texts;
}

/** The names whose declarations in `base` are not all still present, word for word, in `head`. */
function changedDeclarations(base: Map<string, string[]>, head: Map<string, string[]>): Set<string> {
  const changed = new Set<string>();
  for (const [name, texts] of base) {
    const left = [...(head.get(name) ?? [])];
    for (const text of texts) {
      const at = left.indexOf(text);
      if (at < 0) { changed.add(name); break; }
      left.splice(at, 1);
    }
  }
  return changed;
}

/** A test file read once: its assertions, its declarations, and what each name's value is computed from. */
interface TestSource {
  assertions: Array<{ call: string; reads: Set<string> }>; declarations: Map<string, string[]>;
  /** What each name's value is computed from; `declarations` also holds each inline table it names. */
  sources: () => Map<string, Set<string>>;
}
const testSource = (text: string): TestSource => {
  const tokens = sourceTokens(text);
  const brackets = bracketsOf(tokens);
  const declared = declarationsIn(tokens, brackets.partner);
  const { sources, inline } = dataSources(text, tokens, declared, brackets);
  const declarations = bindingDeclarationsOf(text, tokens, declared);
  for (const [table, texts] of inline) declarations.set(table, texts);
  return { assertions: assertionsOf(text, tokens, assertionHeads(tokens, declared), brackets.partner), declarations,
    sources: () => sources };
};

/** One changed expectation: the assertion, and the changed declarations it reads (none when the assertion went). */
interface ExpectationChange { call: string; reads: string[] }
const describeChange = ({ call, reads }: ExpectationChange) => reads.length > 0 ? `${call} (reads changed ${reads.join(", ")})` : call;

/** The names in `moved` that `reads` reach, directly or through what each name's value is computed from. */
function movedReads(reads: Iterable<string>, sources: ReadonlyMap<string, ReadonlySet<string>>, moved: ReadonlySet<string>): string[] {
  const seen = new Set<string>(), queue = [...reads], reached: string[] = [];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    if (moved.has(name)) reached.push(name);
    queue.push(...(sources.get(name) ?? []));
  }
  return reached.sort();
}

function expectationChanges(base: TestSource, head: TestSource): ExpectationChange[] {
  const moved = changedDeclarations(base.declarations, head.declarations);
  const left = new Map<string, number>();
  for (const { call } of head.assertions) left.set(call, (left.get(call) ?? 0) + 1);
  return base.assertions.flatMap(({ call, reads }) => {
    const n = left.get(call) ?? 0;
    if (n > 0) left.set(call, n - 1);
    if (n === 0) return [{ call, reads: [] }];
    if (moved.size === 0) return [];
    const read = movedReads(reads, base.sources(), moved);
    return read.length > 0 ? [{ call, reads: read }] : [];
  });
}

/** W1-T15064: the assertions of an existing test file the round's diff removed or changed, per file. An assertion
 *  also counts as changed when a declaration its value is computed from changed, at any distance: `const expected =
 *  false`, a table a loop or callback reads, or a constant derived from one. A call to a local assertion helper is an
 *  assertion too. */
export function rewrittenTestExpectations(changes: ReadonlyArray<{ path: string; base: string; head: string }>):
  Array<{ path: string; changed: string[] }> {
  return changes.flatMap(({ path, base, head }) => {
    const changed = expectationChanges(testSource(base), testSource(head)).map(describeChange);
    return changed.length > 0 ? [{ path, changed }] : [];
  });
}

/** True when one side of a merge made `change` itself, in its own commits since the merge base `origin`, and the
 *  round's `result` kept that side's text: it dropped an assertion both sides started with, or it changed every
 *  declaration the assertion reads and the result holds that side's declaration. An assertion the side never had
 *  (one the other side added) is never the side's change. */
function sideMadeChange(change: ExpectationChange, origin: TestSource, side: TestSource, result: TestSource): boolean {
  if (change.reads.length === 0) {
    return origin.assertions.some(({ call }) => call === change.call) && !side.assertions.some(({ call }) => call === change.call);
  }
  const sideMoved = changedDeclarations(origin.declarations, side.declarations);
  const resultMoved = changedDeclarations(side.declarations, result.declarations);
  return change.reads.every((name) => sideMoved.has(name) && !resultMoved.has(name));
}

/** W1-T15064: the evidence a round answers. Met criteria, the review summary and the merge logs are not asked of it. */
export interface AnsweredEvidence {
  review?: {
    unmetCriteria: ReadonlyArray<{ claim: string; proof?: string; reason?: string }>;
    findings?: ReadonlyArray<{ path: string; line: number; mechanism: string; remedy: string | null }>;
  };
  ciFailures?: ReadonlyArray<{ name: string; logTail: string; title?: string; annotations?: ReadonlyArray<{ message: string }> }>;
  planGateFindings?: ReadonlyArray<{ check: string; firstLine: string }>;
  actionableGateFailures?: ReadonlyArray<{ reason: string }>;
  mergeConflict?: { files: ReadonlyArray<{ path: string }> };
}

/** W1-T15064: the text of what the round answers: unmet criteria, verified review findings, failing-check evidence,
 *  gate findings and the conflicted paths it resolves. */
export function answeredFindingText(evidence: AnsweredEvidence): string {
  return JSON.stringify([
    (evidence.review?.unmetCriteria ?? []).map(({ claim, proof, reason }) => [claim, proof, reason]),
    evidence.review?.findings ?? [],
    (evidence.ciFailures ?? []).map(({ name, logTail, title, annotations }) => [name, title, plainLog(logTail),
      (annotations ?? []).map((annotation) => plainLog(annotation.message))]),
    evidence.planGateFindings ?? [], evidence.actionableGateFailures ?? [],
    (evidence.mergeConflict?.files ?? []).map((file) => file.path),
  ]);
}

const TEST_FILE = /\.test\.[cm]?[jt]s$/;

/** W1-T15064: the expectations the commits `base..head` rewrote in existing test files, read through `git`. A renamed
 *  test is compared with its old path. A merge the round made is read three ways, against the fork point of its own
 *  side and each parent it merged: a change to the PR's text is the merged branch's only when that branch made it
 *  itself and the result kept it, and a change to the merged branch's text is the round's unless the PR had already
 *  made it. An assertion the PR added, which the merged branch never had, is the PR's own: rewriting it is the
 *  round's, though the parent lacks it. */
export async function readExpectationRewrites(git: (args: string[]) => Promise<string>, base: string, head: string):
  Promise<Array<{ path: string; changed: string[] }>> {
  const changedTests = async (rev: string) => {
    const status = (await git(["diff", "--name-status", "-z", "-M", "--diff-filter=MR", rev, head, "--", "test/"])).split("\0");
    const found: Array<{ from: string; path: string }> = [];
    for (let i = 0; i + 1 < status.length;) {
      const renamed = status[i]!.startsWith("R");
      const pair = renamed ? { from: status[i + 1]!, path: status[i + 2]! } : { from: status[i + 1]!, path: status[i + 1]! };
      i += renamed ? 3 : 2;
      if (TEST_FILE.test(pair.path)) found.push(pair);
    }
    return found;
  };
  // Each merge the round made on its own line: the side it was made on, and each parent it merged.
  const merges = (await git(["rev-list", "--merges", "--first-parent", "--parents", `${base}..${head}`]))
    .split("\n").filter((line) => line.trim() !== "").map((line) => line.trim().split(" ").slice(1))
    .flatMap(([ours, ...merged]) => merged.map((parent) => ({ ours: ours!, parent })));
  const forks = new Map<string, string>();
  for (const { ours, parent } of merges) forks.set(`${ours} ${parent}`, (await git(["merge-base", ours, parent])).trim());
  // A test file the head leaves differing from a merged parent is read too: a resolution that drops what main added
  // can leave the file exactly as it was at `base`.
  const pairs = new Map<string, string>();
  for (const rev of [base, ...new Set(merges.map(({ parent }) => parent))]) {
    for (const pair of await changedTests(rev)) if (!pairs.has(pair.path)) pairs.set(pair.path, pair.from);
  }
  const fileAt = async (rev: string, candidates: readonly string[]) => {
    for (const candidate of candidates) {
      if ((await git(["ls-tree", "--name-only", rev, "--", candidate])).trim() !== "") return git(["show", `${rev}:${candidate}`]);
    }
    return undefined;
  };
  const rewrites: Array<{ path: string; changed: string[] }> = [];
  for (const [path, from] of pairs) {
    const candidates = [...new Set([path, from])];
    const result = testSource(await git(["show", `${head}:${path}`]));
    // The PR's own text at round start; a file only a merged parent has starts empty on the PR's side.
    const ours = testSource(await fileAt(base, [...new Set([from, path])]) ?? "");
    const sides: Array<{ origin: TestSource; theirs: TestSource }> = [];
    for (const { ours: side, parent } of merges) {
      const theirs = await fileAt(parent, candidates);
      if (theirs === undefined) continue;
      sides.push({ origin: testSource(await fileAt(forks.get(`${side} ${parent}`)!, candidates) ?? ""), theirs: testSource(theirs) });
    }
    const changes = expectationChanges(ours, result)
      .filter((change) => !sides.some(({ origin, theirs }) => sideMadeChange(change, origin, theirs, result)));
    for (const { origin, theirs } of sides) {
      changes.push(...expectationChanges(theirs, result).filter((change) => !sideMadeChange(change, origin, ours, result)));
    }
    // One assertion both readings charge is named once, as the PR's text reads it.
    const byCall = new Map<string, ExpectationChange>();
    for (const change of changes) if (!byCall.has(change.call)) byCall.set(change.call, change);
    const changed = [...byCall.values()].map(describeChange);
    if (changed.length > 0) rewrites.push({ path, changed });
  }
  return rewrites;
}

/** W1-T15064: a rewritten expectation stands only in a test the answered finding names, by path or file name. */
export function unaskedExpectationRewrites(rewrites: ReadonlyArray<{ path: string; changed: string[] }>, findingText: string):
  Array<{ path: string; changed: string[] }> {
  const containsPathToken = (text: string, candidate: string) => {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_.-])`).test(text);
  };
  return rewrites.filter(({ path }) => !containsPathToken(findingText, path)
    && !containsPathToken(findingText, path.split("/").pop()!));
}
