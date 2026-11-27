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

/** A failing check's log as report lines; each error annotation is decoded, and its first line is kept apart. */
function reportLines(logTail: string): { lines: string[]; annotationHeads: string[] } {
  const lines: string[] = [], annotationHeads: string[] = [];
  for (const raw of logTail.split(/\r?\n/)) {
    const line = raw.replace(LOG_PREFIX, "");
    const annotation = ERROR_ANNOTATION.exec(line);
    if (!annotation) { lines.push(line); continue; }
    const decoded = decodeAnnotation(annotation[1]!).split(/\r?\n/);
    annotationHeads.push(decoded[0]!);
    lines.push(...decoded);
  }
  return { lines, annotationHeads };
}

/** True when one failing check's log is the census's crossing report and the base owns every line of it. */
function censusReportIsInherited(logTail: string): boolean {
  const { lines, annotationHeads } = reportLines(logTail);
  const headlines = lines.filter((line) => CENSUS_HEADLINE.test(line));
  const crossings = lines.filter((line) => CROSSING_LINE.test(line));
  // The headline states how many crossings the report lists. A log that holds fewer distinct crossing lines was cut
  // (the CI log region keeps only a few lines before each error), so what it lost is unknown, and unknown is not
  // inherited.
  const counts = new Set(headlines.map((line) => Number(INHERITABLE_HEADLINE.exec(line)?.[1])));
  return headlines.length > 0 && headlines.every((line) => INHERITABLE_HEADLINE.test(line))
    && counts.size === 1 && new Set(crossings.map((line) => line.trim())).size === [...counts][0]
    && crossings.length > 0 && crossings.every((line) => line.includes(BASE_INHERITED_MARKER))
    && !lines.some((line) => POPULATION_DROP_LINE.test(line) || OTHER_RED.test(line))
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
    if (failure.jobId !== undefined && failure.logTail.includes("expiring-fixture-census:")) {
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
const sliceOf = (text: string, tokens: readonly SourceToken[], from: number, to: number) =>
  text.slice(tokens[from]!.start, tokens[to]!.end).replace(/\s+/g, " ");

/** Each assertion in the file: `assert(...)`, `assert.x(...)` or `expect(...)` with its chained matchers, whole,
 *  whitespace collapsed, with the names its arguments read. */
function assertionsOf(text: string, tokens = sourceTokens(text)): Array<{ call: string; reads: Set<string> }> {
  const found: Array<{ call: string; reads: Set<string> }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const head = tokens[i]!;
    if (!isName(head) || (head.text !== "assert" && head.text !== "expect") || tokens[i - 1]?.text === ".") continue;
    let at = i + 1;
    while (tokens[at]?.text === "." && isName(tokens[at + 1])) at += 2;
    if (tokens[at]?.text !== "(") continue;
    let end = closing(tokens, at);
    while (tokens[end + 1]?.text === "." && isName(tokens[end + 2]) && tokens[end + 3]?.text === "(") end = closing(tokens, end + 3);
    const reads = new Set<string>();
    for (let k = at + 1; k < end; k++) if (isName(tokens[k]) && tokens[k - 1]?.text !== ".") reads.add(tokens[k]!.text);
    found.push({ call: sliceOf(text, tokens, i, end), reads });
    i = end;
  }
  return found;
}

/** An assertion's own text, without the note naming the declarations it reads. */
const assertionKey = (changed: string) => changed.replace(/ \(reads changed [^)]*\)$/, "");

/** A line break after one of these continues the statement. */
const CONTINUES = /^(?:=|,|\?|:|\+|-|\*|\/|%|&&|\|\||\?\?|=>|\.|===|!==|==|!=|<|>|<=|>=|\||&|in|of|instanceof)$/;

/** Each `const`/`let`/`var` declaration in the file, by every name it binds: the whole statement, whitespace collapsed.
 *  A name declared twice in different scopes keeps both texts. */
function declarationsOf(text: string, tokens = sourceTokens(text)): Map<string, string[]> {
  const declarations = new Map<string, string[]>();
  for (let i = 0; i < tokens.length; i++) {
    if (!["const", "let", "var"].includes(tokens[i]!.text) || !(isName(tokens[i + 1]) || OPENERS.has(tokens[i + 1]?.text ?? ""))) continue;
    const names = isName(tokens[i + 1]) ? [tokens[i + 1]!.text]
      : tokens.slice(i + 2, closing(tokens, i + 1)).filter((token) => isName(token)).map((token) => token.text);
    let end = i + 1, depth = 0;
    for (let k = i + 1; k < tokens.length; k++) {
      const token = tokens[k]!;
      if (depth === 0 && k > i + 1 && (token.text === ";" || (token.lineBreak && !CONTINUES.test(tokens[k - 1]!.text)
        && !CONTINUES.test(token.text)))) break;
      if (OPENERS.has(token.text)) depth++;
      else if (CLOSERS.has(token.text) && --depth < 0) break;
      end = k;
    }
    const statement = sliceOf(text, tokens, i, end);
    for (const name of names) declarations.set(name, [...(declarations.get(name) ?? []), statement]);
  }
  return declarations;
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

/** W1-T15064: the assertions of an existing test file the round's diff removed or changed, per file. An assertion
 *  also counts as changed when a declaration its arguments read changed, such as `const expected = false`. */
export function rewrittenTestExpectations(changes: ReadonlyArray<{ path: string; base: string; head: string }>):
  Array<{ path: string; changed: string[] }> {
  return changes.flatMap(({ path, base, head }) => {
    const baseTokens = sourceTokens(base), headTokens = sourceTokens(head);
    const moved = changedDeclarations(declarationsOf(base, baseTokens), declarationsOf(head, headTokens));
    const left = new Map<string, number>();
    for (const { call } of assertionsOf(head, headTokens)) left.set(call, (left.get(call) ?? 0) + 1);
    const changed = assertionsOf(base, baseTokens).flatMap(({ call, reads }) => {
      const n = left.get(call) ?? 0;
      if (n > 0) left.set(call, n - 1);
      if (n === 0) return [call];
      const read = [...reads].filter((name) => moved.has(name)).sort();
      return read.length > 0 ? [`${call} (reads changed ${read.join(", ")})`] : [];
    });
    return changed.length > 0 ? [{ path, changed }] : [];
  });
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
    (evidence.ciFailures ?? []).map(({ name, logTail, title, annotations }) => [name, title, logTail,
      (annotations ?? []).map((annotation) => annotation.message)]),
    evidence.planGateFindings ?? [], evidence.actionableGateFailures ?? [],
    (evidence.mergeConflict?.files ?? []).map((file) => file.path),
  ]);
}

const TEST_FILE = /\.test\.[cm]?[jt]s$/;

/** W1-T15064: the expectations the commits `base..head` rewrote in existing test files, read through `git`. A renamed
 *  test is compared with its old path. An assertion a merged parent also dropped came from that parent, not from the
 *  round, so a merge round is charged only for what it changed beyond the branch it merged. */
export async function readExpectationRewrites(git: (args: string[]) => Promise<string>, base: string, head: string):
  Promise<Array<{ path: string; changed: string[] }>> {
  const status = (await git(["diff", "--name-status", "-z", "-M", "--diff-filter=MR", base, head, "--", "test/"])).split("\0");
  const pairs: Array<{ from: string; path: string }> = [];
  for (let i = 0; i + 1 < status.length;) {
    const renamed = status[i]!.startsWith("R");
    const pair = renamed ? { from: status[i + 1]!, path: status[i + 2]! } : { from: status[i + 1]!, path: status[i + 1]! };
    i += renamed ? 3 : 2;
    if (TEST_FILE.test(pair.path)) pairs.push(pair);
  }
  const mergedParents = (await git(["rev-list", "--merges", "--parents", `${base}..${head}`]))
    .split("\n").filter((line) => line.trim() !== "").flatMap((line) => line.trim().split(" ").slice(2));
  const rewrites: Array<{ path: string; changed: string[] }> = [];
  for (const { from, path } of pairs) {
    const [rewrite] = rewrittenTestExpectations([{ path, base: await git(["show", `${base}:${from}`]),
      head: await git(["show", `${head}:${path}`]) }]);
    if (!rewrite) continue;
    let changed = rewrite.changed;
    const headText = await git(["show", `${head}:${path}`]);
    for (const parent of mergedParents) {
      for (const candidate of [...new Set([path, from])]) {
        if ((await git(["ls-tree", "--name-only", parent, "--", candidate])).trim() === "") continue;
        // Charged only for what the round also changed against the branch it merged.
        const [againstParent] = rewrittenTestExpectations([{ path, base: await git(["show", `${parent}:${candidate}`]), head: headText }]);
        const alsoChanged = new Set((againstParent?.changed ?? []).map(assertionKey));
        changed = changed.filter((call) => alsoChanged.has(assertionKey(call)));
        break;
      }
    }
    if (changed.length > 0) rewrites.push({ path, changed });
  }
  return rewrites;
}

/** W1-T15064: a rewritten expectation stands only in a test the answered finding names, by path or file name. */
export function unaskedExpectationRewrites(rewrites: ReadonlyArray<{ path: string; changed: string[] }>, findingText: string):
  Array<{ path: string; changed: string[] }> {
  return rewrites.filter(({ path }) => !findingText.includes(path) && !findingText.includes(path.split("/").pop()!));
}
