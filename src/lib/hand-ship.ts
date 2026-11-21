import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { appendFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parse, tokenizer, type CallExpression, type ConditionalExpression, type IfStatement, type Node, type ThrowStatement } from "acorn";
import { systemClock } from "./clock.js";
import { acquireDrainLock, defaultIsPidAlive, DrainLockError } from "./drain-lock.js";
import { gitPushRunBranchAsync, worktreePushExecAsync } from "./git-push.js";
import { ghJsonAsync } from "./github-transport.js";
import { parseOwnerRepoFromRemoteUrl } from "./onboard/inventory.js";
import { acceptanceBlockDiagnostics } from "./review.js";
import { proofTestRunnerArgs } from "./test-run-timeout.js";
import { hostWorktreeGitAsync } from "./worktree-git.js";

interface ShipHost {
  name: string;
  target: string;
  kind: "mac" | "linux";
  checkout?: string;
  pathPrefix?: string;
}

interface ShipSource { root: string; branch: string; head: string; origin: string }
interface FailingTest { file: string | null; title: string; location?: string | null; failed?: boolean; suite?: boolean;
  failureIdentity?: string; failureSite?: { location: string; code: string };
  /** The test's TAP ancestry, outermost first, each name as TAP wrote it: read from the report's subtest nesting,
   *  never from `title`, whose ` > ` separator a test's own name can contain. Empty for a whole-file row. */
  path?: string[];
  /** A `describe` row: Node's `# tests` and `# fail` count only the tests inside it, never the row itself. */
  describeRow?: boolean; fileLevel?: boolean; state?: string }
type Priority = "low" | "normal";
type FailureClass = "caused by the change" | "caused by the host" | "also failing on main";

export interface ShipReceipt {
  headSha: string;
  baseSha: string;
  verdict: string;
  selection?: string;
  steps: { name: string; ok: boolean; failedCheck?: string; suites?: string[]; signal?: string | null; error?: unknown;
    judge?: { given: number; reported: number }; diagnostics?: { mayBeIncomplete: boolean; stdout?: string };
    testSummary?: { pass: number; fail: number; cancelled: number; tests?: number } }[];
  failureAttribution?: { counts?: { failingAtHead?: number; unattributed?: number }; tests?: FailingTest[] };
}

interface AuthorTools {
  authorEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  authorPushEligibility(receipt: ShipReceipt): { pushEligible: boolean; pushEligibleReason: string };
  failingTestsFromTap(output: string, root: string): FailingTest[];
  testResultsFromTap(output: string, root: string): FailingTest[];
  pinnedNodeReexec(input: { pin: string; current: string; env: NodeJS.ProcessEnv }): { reexec?: string; refuse?: string };
  testSummary(output: string): { tests?: number; pass: number; fail: number; cancelled: number } | null;
}

const authorEntry = "scripts/preflight-author.mjs";

async function authorTools(): Promise<AuthorTools> {
  const installedEntry = new URL(authorEntry, new URL("../../", import.meta.url));
  return import(installedEntry.href);
}

async function readMacPressure(raw: string): Promise<string> {
  // @ts-expect-error The author host admission .mjs module has no declaration file.
  const { macPressureState } = await import("../../scripts/lib/mac-author-admission.mjs");
  return macPressureState(raw);
}

interface ShipRun {
  dir: string;
  signal: AbortSignal;
  log: (line: string) => void;
  spawn?: (file: string, args: string[], options: SpawnOptions) => ChildProcess;
  git?: typeof hostWorktreeGitAsync;
}

export interface HandShipEffects {
  readHost(host: ShipHost, run: ShipRun): Promise<string>;
  readSource(cwd: string, run: ShipRun): Promise<ShipSource>;
  prepare(host: ShipHost, source: ShipSource, run: ShipRun): Promise<{
    preflight(priority: Priority): Promise<ShipReceipt>;
    /** `path` is the target's TAP ancestry ({@link FailingTest.path}); without one the whole file reruns. */
    rerun(tree: "head" | "main", file: string, sha: string, path?: readonly string[], expectedCount?: number): Promise<FailingTest[]>;
    close(): Promise<void>;
  }>;
  push(source: ShipSource, run: ShipRun): Promise<void>;
  findPull(source: ShipSource, run: ShipRun): Promise<number | undefined>;
  publish(source: ShipSource, title: string, body: string, existing: number | undefined, run: ShipRun): Promise<{ url: string; body: string }>;
  checkBody(body: string, run: ShipRun): void;
}

interface ShipOptions { cwd: string; stateDir: string | (() => string); write?: (line: string) => void }
const runId = /^rmd-ship-\d{13}-[a-zA-Z0-9]{6}$/;
/** Whether `value` is exactly the id a ship run is given (`rmd-ship-<epochMs>-<6 chars>`). */
export function isHandShipRunId(value: string): boolean { return runId.test(value); }
const shaPattern = /^[0-9a-f]{40}$/;
const testPath = /^test\/(?:[^/\0\r\n]+\/)*[^/\0\r\n]+\.test\.ts$/;
const INIT_WINDOW_MS = 2_000;

function readHosts(path: string): ShipHost[] {
  const data: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(data) || !data.length || data.some((host: Partial<ShipHost> | null) => !host ||
    typeof host.name !== "string" || !host.name.trim() || /[\r\n]/.test(host.name) ||
    typeof host.target !== "string" || !/^[a-zA-Z0-9_][\w.@:-]*$/.test(host.target) ||
    (host.kind !== "mac" && host.kind !== "linux") ||
    (host.checkout !== undefined && (typeof host.checkout !== "string" || !isAbsolute(host.checkout))) ||
    (host.pathPrefix !== undefined && (typeof host.pathPrefix !== "string" || !isAbsolute(host.pathPrefix))))) {
    throw new Error(`${path}: expected hosts with name, target (SSH or local), kind (mac or linux), and optionally an absolute checkout`);
  }
  return data;
}

async function chooseHost(hosts: ShipHost[], effects: HandShipEffects, run: ShipRun): Promise<ShipHost> {
  for (const host of [...hosts.filter((item) => item.kind === "mac"), ...hosts.filter((item) => item.kind === "linux")]) {
    run.signal.throwIfAborted();
    let raw: string;
    try {
      raw = await effects.readHost(host, run);
    } catch (error) {
      run.signal.throwIfAborted();
      run.log(`${host.name}: reading unavailable (${(error as Error).message})`);
      continue;
    }
    const reading = host.kind === "mac" ? await readMacPressure(raw) : /^MemAvailable:[ \t]*(\d+ kB)[ \t]*$/m.exec(raw)?.[1];
    if (reading === "unknown" || reading === undefined) run.log(`${host.name}: unreadable memory reading`);
    else if (host.kind === "mac" && reading !== "normal") run.log(`${host.name}: memory pressure ${reading} (${raw.trim()})`);
    else {
      run.log(`selected ${host.name}: ${host.kind === "mac" ? `memory pressure ${reading} (${raw.trim()})` : `MemAvailable ${reading}`}`);
      return host;
    }
  }
  throw new Error("no configured host has a usable memory reading");
}

function testFailureStage(step: ShipReceipt["steps"][number]): boolean {
  return step.name === "affected-tests" || step.name === "affected-tests-subset" || step.name === "workflow-contract-precheck";
}

/** Parse complete TAP rows locally so the hand-ship comparison does not change the author-preflight contract. */
function tapResults(output: string, root: string, fallbackFile?: string): FailingTest[] {
  const clean = (path: string) => path.replace(/^\/private(?=\/)/, "");
  root = clean(root);
  const lines = String(output).split("\n"), rows: FailingTest[] = [], parents: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const header = /^( *)# Subtest: (.*)$/.exec(lines[i]!);
    if (header) { parents.splice(header[1]!.length / 4); parents.push(header[2]!); continue; }
    const result = /^( *)(not ok|ok) [0-9]+ - (.*)$/.exec(lines[i]!);
    if (!result) continue;
    const fields: Record<string, string> = {};
    let topFrame: string | undefined;
    for (let j = i + 1; j < lines.length && lines[j]!.startsWith(`${result[1]}  `) && !/^\s*\.\.\.$/.test(lines[j]!); j += 1) {
      const diagnostic = lines[j]!.slice(result[1]!.length + 2);
      const field = /^(type|location|failureType|code): '?(.*?)'?$/.exec(diagnostic);
      if (diagnostic === "stack: |-") topFrame = lines[j + 1]?.trim();
      if (field) fields[field[1]!] = field[2]!;
    }
    const locationMatch = /^(.*):([0-9]+):([0-9]+)$/.exec(clean(fields.location ?? ""));
    const absolute = locationMatch?.[1] ?? "";
    const relativePath = absolute && isAbsolute(absolute) ? relative(root, absolute).split(sep).join("/") : "";
    const file = relativePath && relativePath !== ".." && !relativePath.startsWith("../") && !isAbsolute(relativePath)
      ? relativePath : fields.location === undefined ? fallbackFile ?? null : null;
    const fileLevel = file !== null && result[3]!.replace(/\\/g, "/").endsWith(file);
    const path = fileLevel ? [] : [...parents.slice(0, result[1]!.length / 4), result[3]!];
    const frame = topFrame && /(?:^|\()(file:\/\/.*|\/.*):([0-9]+):([0-9]+)\)?$/.exec(topFrame);
    const failureSite = frame && absolute && fields.failureType === "testCodeFailure" && fields.code &&
      (clean(frame[1]!) === absolute || frame[1]!.replace(/^file:\/\/\/private(?=\/)/, "file://") === pathToFileURL(absolute).href)
      ? { location: `${frame[2]}:${frame[3]}`, code: fields.code } : undefined;
    rows.push({ file, title: fileLevel ? "(whole file)" : path.join(" > "), path,
      location: locationMatch ? `${locationMatch[2]}:${locationMatch[3]}` : null,
      failed: result[2] === "not ok", ...(fields.type === "suite" || fields.failureType === "subtestsFailed" ? { suite: true } : {}),
      ...(fields.type === "suite" ? { describeRow: true } : {}), ...(failureSite ? { failureSite } : {}), fileLevel });
  }
  return rows;
}

/** One TAP-escaped test name as Node registered it. Node's TAP reporter writes `\#` for `#` and `\\` for `\`,
 *  but it also writes a control character such as a newline as `\\n`, the same text as a literal backslash
 *  and `n`. Such a name cannot be told apart, so it cannot be selected exactly. */
function registeredName(escaped: string): string {
  return escaped.replace(/\\(\\[bfnrtv]?|#|[\s\S]?)/g, (sequence, rest: string) => {
    if (rest === "#") return "#";
    if (rest === "\\") return "\\";
    throw new Error(`hand-ship: the test name ${JSON.stringify(escaped)} has a TAP escape (${sequence}) that names more than one test`);
  });
}

const regexLiteral = (text: string) => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

/** Select exactly one named test and its ancestors with the documented public filters of `node --test`.
 *  Node runs a test only when both filters admit it. `--test-name-pattern` admits a test whose name, an ancestor's
 *  name, or its name joined to its ancestors' names by single spaces matches; a filtered `test()` never runs its
 *  body, so its subtests never register. The name pattern is therefore the target's TOP-LEVEL ancestor's own name,
 *  anchored: that admits the one top-level test the path starts from, and every test inside it, and no other
 *  top-level test, whatever its name joins to (a top-level `a b c` beside `a` > `b c` never runs). Inside that
 *  test, `--test-skip-pattern` skips each test whose own name or space-joined name is off the target's path. */
function isolatedTestArgs(path: readonly string[]): string[] {
  if (path.length === 0) throw new Error("hand-ship: an isolated rerun needs the target's TAP ancestry, and it was empty");
  const names = path.map(registeredName);
  const joined = names.map((_, index) => names.slice(0, index + 1).join(" ").trim());
  // Node also tests the skip pattern against each ancestor, up to its unnamed root (`<root>`, joined name "").
  const onPath = [...new Set([...names, ...joined, "<root>", ""])];
  return [`--test-name-pattern=^${regexLiteral(names[0]!)}$`,
    `--test-skip-pattern=^(?!(?:${onPath.map(regexLiteral).join("|")})$)`];
}

/** The rerun ran the target alone only when its TAP rows, read by their ancestry (`a > b c`), are the target and its
 *  ancestors. A test inside the target's top-level ancestor whose name and space-joined name both fall on the path
 *  can still pass the filters; its callback has then run, so the rerun was not isolated and is refused, never read. */
function pathRows(rows: FailingTest[], path: readonly string[], tree: string, file: string): FailingTest[] {
  for (const row of rows) {
    if (row.fileLevel || (row.path !== undefined && row.path.length <= path.length && startsWith(path, row.path))) continue;
    throw new Error(`${tree} ${file}: the isolated rerun of ${JSON.stringify(path.join(" > "))} also ran ${JSON.stringify(row.title)}, ` +
      "so it did not run the named test alone");
  }
  return rows;
}

/** Whether `path` begins with every name of `prefix`, compared name by name (never as joined text). */
function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((name, index) => path[index] === name);
}
const samePath = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
  a !== undefined && b !== undefined && a.length === b.length && startsWith(a, b);
/** `row` is a test nested strictly inside `parent`, by TAP ancestry. */
const nestedIn = (row: FailingTest, parent: FailingTest) => row.file === parent.file && row.path !== undefined &&
  parent.path !== undefined && row.path.length > parent.path.length && startsWith(row.path, parent.path);

/** The author receipt names each failure by file and a ` > `-joined title, text that cannot be split back into
 *  its nesting: a top-level test may itself be named `a > b`. Each named failure is matched here to the failing
 *  row of the preflight's own TAP report with that title, whose subtest nesting gives its ancestry. A title two
 *  differently nested failing rows share is ambiguous and gets no ancestry, so it is never rerun by a guess. */
export function withTapPaths(receipt: ShipReceipt, tap: string, root: string): ShipReceipt {
  const tests = receipt.failureAttribution?.tests;
  if (!tests) return receipt;
  const rows = tapResults(tap, root).filter((row) => row.failed && !row.fileLevel && row.file !== null);
  return { ...receipt, failureAttribution: { ...receipt.failureAttribution, tests: tests.map((test) => {
    const paths = new Map(rows.filter((row) => row.file === test.file && row.title === test.title)
      .map((row) => [JSON.stringify(row.path), row.path!]));
    const { path: _given, ...named } = test;
    return paths.size === 1 ? { ...named, path: [...paths.values()][0]! } : named;
  }) } };
}

const assertionOperands = new Map([
  ["fail", 0] as const,
  ...["assert", "ok"].map((name) => [name, 1] as const),
  ...["equal", "notEqual", "strictEqual", "notStrictEqual", "deepEqual", "notDeepEqual", "deepStrictEqual",
    "notDeepStrictEqual", "match", "doesNotMatch"].map((name) => [name, 2] as const),
]);

function locateFailures(text: string) {
  // Strip mode preserves the offsets reported by TAP and the original stack.
  const stripped = stripTypeScriptTypes(text);
  const source = parse(stripped, { ecmaVersion: "latest", sourceType: "module", locations: true });
  const assertions = new Map<string, string>();
  for (const node of source.body) {
    if (node.type !== "ImportDeclaration" || !/^(?:node:)?assert(?:\/strict)?$/.test(String(node.source.value))) continue;
    for (const specifier of node.specifiers) {
      assertions.set(specifier.local.name,
        specifier.type === "ImportSpecifier" ? stripped.slice(specifier.imported.start, specifier.imported.end) : "assert");
    }
  }
  const tokensOf = (node: Node, omit: readonly Node[] = []) => {
    let span = "", start = node.start;
    for (const part of omit) {
      span += stripped.slice(start, part.start) + " __omitted__ ";
      start = part.end;
    }
    span += stripped.slice(start, node.end);
    return JSON.stringify([...tokenizer(span, { ecmaVersion: "latest" })].map((token) =>
      token.type.label === "string" ? ["string", (token as { value?: unknown }).value] : span.slice(token.start, token.end)));
  };
  const registrations = new Map<string, string | null>();
  const sites: { start: number; end: number; key: string }[] = [];
  const counts = new Map<string, number>();
  const count = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  const remember = (node: Node, registration: string) => {
    const start = node.loc!.start;
    const location = `${start.line}:${start.column + 1}`;
    registrations.set(location, registrations.has(location) ? null : registration);
  };
  const recordSite = (node: Node, end: number, scope: readonly string[], message?: Node) => {
    const key = JSON.stringify(["site", scope, tokensOf(node, message ? [message] : [])]);
    count(key);
    sites.push({ start: node.start, end, key });
  };
  const visit = (value: unknown, scope: readonly string[]) => {
    if (Array.isArray(value)) { value.forEach((child) => visit(child, scope)); return; }
    if (!value || typeof value !== "object" || !("type" in value)) return;
    const node = value as Node;
    if (node.type === "CallExpression") {
      const call = node as CallExpression;
      const callbacks = call.arguments.flatMap((arg) =>
        arg.type === "ArrowFunctionExpression" || arg.type === "FunctionExpression" ? [arg.body] : []);
      const signature = tokensOf(call, callbacks);
      const registration = JSON.stringify(["registration", scope, signature]);
      count(registration);
      remember(call, registration);
      const callee = call.callee;
      if (callee.type === "MemberExpression") remember(callee.property, registration);
      const assertion = callee.type === "Identifier" ? assertions.get(callee.name)
        : callee.type === "MemberExpression" && callee.object.type === "Identifier" &&
          assertions.get(callee.object.name) === "assert" && !callee.computed && callee.property.type === "Identifier"
          ? callee.property.name : undefined;
      const arity = assertion === undefined ? undefined : assertionOperands.get(assertion);
      const message = arity !== undefined && call.arguments.length === arity + 1 ? call.arguments[arity] : undefined;
      recordSite(call, callee.end + 1, scope, message?.type === "Literal" && typeof message.value === "string" ? message : undefined);
      visit(callee, scope);
      visit(call.arguments, [...scope, signature]);
      return;
    }
    if (node.type === "ThrowStatement") {
      const statement = node as ThrowStatement;
      const error = statement.argument;
      const message = error.type === "NewExpression" && error.callee.type === "Identifier" && error.callee.name === "Error"
        ? error.arguments[0] : undefined;
      recordSite(statement, statement.end, scope, message?.type === "Literal" && typeof message.value === "string" ? message : undefined);
    }
    if (node.type === "IfStatement" || node.type === "ConditionalExpression") {
      const condition = node as IfStatement | ConditionalExpression;
      const branch = tokensOf(condition.test);
      visit(condition.test, scope);
      visit(condition.consequent, [...scope, branch, "then"]);
      visit(condition.alternate, [...scope, branch, "else"]);
      return;
    }
    for (const child of Object.values(value)) visit(child, scope);
  };
  visit(source, []);
  let offset = 0;
  const lines = stripped.split("\n").map((line) => {
    const start = offset;
    offset += line.length + 1;
    return start;
  });
  return ({ location, failureSite }: FailingTest) => {
    if (!location || !failureSite) return undefined;
    const registration = registrations.get(location);
    const [line, column] = failureSite.location.split(":").map(Number);
    const frame = lines[line! - 1]! + column! - 1;
    const site = sites.findLast(({ start, end }) => start <= frame && frame < end);
    return registration && counts.get(registration) === 1 && site && counts.get(site.key) === 1
      ? JSON.stringify([registration, site.key, failureSite.code]) : undefined;
  };
}

async function compareFailures(receipt: ShipReceipt, workspace: Awaited<ReturnType<HandShipEffects["prepare"]>>, run: ShipRun) {
  const failed = receipt.steps.find((step) => !step.ok);
  if (!failed || !testFailureStage(failed)) {
    if (failed?.name === "static-preflight" && failed.failedCheck) run.log(`caused by the change: ${failed.failedCheck}`);
    return receipt;
  }
  let tests: FailingTest[] = (receipt.failureAttribution?.tests ?? []).map((test) => ({ ...test, suite: false }));
  const summary = failed.testSummary;
  const withEvidence = { ...receipt, failureAttribution: undefined };
  let expectedFailureCount = 0;
  if (failed.signal || failed.error || failed.diagnostics?.mayBeIncomplete !== false || !summary || summary.fail === 0 ||
    tests.some(({ file, fileLevel }) => !file || fileLevel || !testPath.test(file) ||
      file.split("/").some((part) => part === "." || part === ".."))) {
    run.log("test failure comparison unavailable: the preflight did not completely name its failures");
    return withEvidence;
  }
  if (failed.name !== "workflow-contract-precheck") {
    const counts = receipt.failureAttribution?.counts;
    const namedUnattributed = tests.filter((test) => test.state === "unattributed").length;
    const unnamed = (counts?.unattributed ?? -1) - namedUnattributed;
    if (counts?.failingAtHead === undefined || Number.isSafeInteger(counts.failingAtHead) === false ||
      counts.failingAtHead > summary.fail || unnamed < 0 || tests.length + unnamed !== counts.failingAtHead) {
      run.log("test failure comparison unavailable: the preflight did not completely name its failures");
      return withEvidence;
    }
    expectedFailureCount = counts!.failingAtHead!;
  }
  if (failed.name === "workflow-contract-precheck" && tests.length === 0) {
    const suites = failed.suites ?? [];
    if (!suites.length || suites.some((file) => !testPath.test(file) || file.split("/").some((part) => part === "." || part === ".."))) {
      run.log("workflow contract failure comparison unavailable: the preflight did not name its test suites");
      return withEvidence;
    }
    let failedRows = 0;
    for (const file of [...new Set(suites)].sort()) {
      const rows = await workspace.rerun("head", file, receipt.headSha);
      failedRows += rows.filter((test) => test.failed && !test.describeRow).length;
      tests.push(...rows.filter((test) => test.failed && !test.suite));
    }
    if (failedRows !== summary.fail) {
      run.log("workflow contract failure comparison unavailable: isolated head reruns did not account for every failure");
      return withEvidence;
    }
    expectedFailureCount = tests.length;
  }
  if (tests.length === 0 || tests.length > expectedFailureCount) {
    run.log("test failure comparison unavailable: the preflight did not completely name its failures");
    return withEvidence;
  }
  // A test is selected and matched by its TAP ancestry; its joined title is only how it is named in the output.
  const unplaced = tests.find((test) => test.path === undefined || test.path.length === 0);
  if (unplaced) {
    run.log(`test failure comparison unavailable: the preflight's TAP report did not give the nesting of ${unplaced.file} :: ${unplaced.title}`);
    return withEvidence;
  }
  const groups = new Map<string, FailingTest[]>();
  for (const test of tests) {
    const key = `${test.file}\0${JSON.stringify(test.path)}`;
    groups.set(key, [...(groups.get(key) ?? []), test]);
  }
  // A failure is classified by its leaf. Node also reports `not ok` for a `test` whose subtest failed, and the
  // receipt names that parent too; rerun alone, with its failing child filtered out, it would read green. Such a
  // parent is never rerun on its own: its leaves' reruns must show it red only because a subtest failed.
  const aggregates = new Map<string, FailingTest[]>();
  for (const [key, group] of groups) {
    const parent = group[0]!;
    if (tests.some((other) => nestedIn(other, parent))) aggregates.set(key, group);
  }
  for (const key of aggregates.keys()) groups.delete(key);
  const descends = nestedIn;
  const unionRows = (runs: FailingTest[][]) => {
    const counts = new Map<string, { row: FailingTest; count: number }>();
    for (const rows of runs) {
      const perRun = new Map<string, { row: FailingTest; count: number }>();
      for (const row of rows) {
        if (row.file === null) continue;
        const key = `${row.file}\0${JSON.stringify(row.path)}\0${row.location ?? ""}\0${row.suite === true}\0${row.failed === true}`;
        const found = perRun.get(key);
        if (found) found.count += 1; else perRun.set(key, { row, count: 1 });
      }
      for (const [key, found] of perRun) {
        if ((counts.get(key)?.count ?? 0) < found.count) counts.set(key, found);
      }
    }
    return [...counts.values()].flatMap(({ row, count }) => Array.from({ length: count }, () => row));
  };
  const rerunGroups = async (tree: "head" | "main", sha: string) => {
    const runs: FailingTest[][] = [];
    for (const group of groups.values()) {
      const test = group[0]!;
      runs.push(await workspace.rerun(tree, test.file!, sha, test.path, group.length));
    }
    return unionRows(runs);
  };
  const headRows = await rerunGroups("head", receipt.headSha);
  let hostCaused = false;
  const exactHeadFailures: FailingTest[] = [];
  for (const group of groups.values()) {
    const target = group[0]!;
    const selected = headRows.filter((row) => row.file === target.file && samePath(row.path, target.path) && !row.suite && !row.fileLevel);
    const targetFailures = selected.filter((row) => row.failed === true);
    const targetPasses = selected.filter((row) => row.failed === false);
    if (selected.length === group.length && targetFailures.length === group.length &&
      targetFailures.every((row) => typeof row.location === "string" && /^\d+:\d+$/.test(row.location))) {
      exactHeadFailures.push(...targetFailures);
      continue;
    }
    if (selected.length === group.length && targetFailures.length === 0 && targetPasses.length === group.length) {
      hostCaused = true;
      for (const test of group) run.log(`caused by the host: ${test.file} :: ${test.title}`);
      continue;
    }
    run.log(`test failure comparison unavailable: isolated head rerun did not account for ${target.file} :: ${target.title}`);
    return withEvidence;
  }
  const aggregateHeadFailures: FailingTest[] = [];
  for (const group of aggregates.values()) {
    const parent = group[0]!;
    const selected = headRows.filter((row) => row.file === parent.file && samePath(row.path, parent.path) && !row.fileLevel);
    // `suite` marks a row whose failureType is subtestsFailed: red only because a subtest failed.
    if (selected.length === group.length && selected.every((row) => row.failed === true && row.suite === true &&
      typeof row.location === "string" && /^\d+:\d+$/.test(row.location)) && exactHeadFailures.some((row) => descends(row, parent))) {
      aggregateHeadFailures.push(...selected);
      continue;
    }
    if (selected.length === group.length && selected.every((row) => row.failed === false)) {
      hostCaused = true;
      for (const test of group) run.log(`caused by the host: ${test.file} :: ${test.title}`);
      continue;
    }
    run.log(`test failure comparison unavailable: isolated head reruns of its subtests did not account for ${parent.file} :: ${parent.title}`);
    return withEvidence;
  }
  const mainRows = await rerunGroups("main", receipt.baseSha);
  const mainFailures = [...groups.values()].flatMap((group) => {
    const target = group[0]!;
    return mainRows.filter((row) => row.file === target.file && samePath(row.path, target.path) &&
      !row.suite && !row.fileLevel && row.failed === true);
  });
  const remainingMain = [...mainFailures];
  const rows = [];
  for (const test of exactHeadFailures) {
    const index = remainingMain.findIndex((other) => other.file === test.file && samePath(other.path, test.path) &&
      test.failureIdentity !== undefined && test.failureIdentity === other.failureIdentity);
    const classification: FailureClass = index >= 0 ? "also failing on main" : "caused by the change";
    if (index >= 0) remainingMain.splice(index, 1);
    run.log(`${classification}: ${test.file} :: ${test.title}`);
    rows.push({ file: test.file, title: test.title, path: test.path, location: test.location,
      state: classification === "also failing on main" ? "also-red" : "only-head" });
  }
  const leafRows = [...rows];
  const remainingMainParents = mainRows.filter((row) => row.failed === true && row.suite === true && !row.fileLevel);
  for (const test of aggregateHeadFailures) {
    // A parent is also failing on main only when every failing leaf under it is, and main reports it red the same way.
    const index = remainingMainParents.findIndex((other) => other.file === test.file && samePath(other.path, test.path));
    const leaves = leafRows.filter((row) => descends(row as FailingTest, test));
    const classification: FailureClass = index >= 0 && leaves.length > 0 && leaves.every((row) => row.state === "also-red")
      ? "also failing on main" : "caused by the change";
    if (index >= 0) remainingMainParents.splice(index, 1);
    run.log(`${classification}: ${test.file} :: ${test.title}`);
    rows.push({ file: test.file, title: test.title, location: test.location,
      state: classification === "also failing on main" ? "also-red" : "only-head" });
  }
  if (hostCaused || rows.length !== expectedFailureCount || [...exactHeadFailures, ...aggregateHeadFailures].some((test) => typeof test.location !== "string" || !/^\d+:\d+$/.test(test.location))) {
    run.log("test failure comparison unavailable: the preflight did not completely name its failures");
    return withEvidence;
  }
  return { ...withEvidence, failureAttribution: {
    // The installed judge calls the comparison SHA mergeBase. Here it is the exact main SHA run above.
    base: { mergeBase: receipt.baseSha }, tests: rows.map(({ path: _path, ...row }) => row),
    counts: { failingAtHead: rows.length, alsoFailingAtBase: rows.filter((test) => test.state === "also-red").length,
      failingOnlyAtHead: rows.filter((test) => test.state === "only-head").length,
      unattributed: rows.filter((test) => test.state === "unattributed").length },
  } };
}

function queuedEarlier(queue: string, id: string): boolean {
  return readdirSync(queue).some((name) => {
    if (!runId.test(name) || name >= id) return false;
    const dir = join(queue, name);
    try {
      const pid = Number(readFileSync(join(dir, "queued"), "utf8"));
      if (pid > 0) return defaultIsPidAlive(pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return !existsSync(join(dir, "status.json")) && systemClock.now() - statSync(dir).mtimeMs < INIT_WINDOW_MS;
  });
}

async function enterQueue(queue: string, id: string, signal: AbortSignal) {
  for (;;) {
    signal.throwIfAborted();
    if (!queuedEarlier(queue, id)) {
      try {
        return acquireDrainLock(join(queue, "preflight.lock"));
      } catch (error) {
        if (!(error instanceof DrainLockError)) throw error;
      }
    }
    await delay(250, undefined, { signal });
  }
}

function stopRun(queue: string, id: string, write: (line: string) => void): number {
  const dir = join(queue, id);
  const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
  if (["shipped", "stopped", "failed"].includes(status.status) || !defaultIsPidAlive(status.pid)) {
    write(`${id}: no active run (${status.status})`);
    return 1;
  }
  writeFileSync(join(dir, "stop"), "stop requested\n", { mode: 0o600 });
  write(`${id}: stop requested`);
  return 0;
}

export async function runHandShip(args: string[], options: ShipOptions, effects: HandShipEffects): Promise<number> {
  const write = options.write ?? console.log;
  const stateDir = () => typeof options.stateDir === "function" ? options.stateDir() : options.stateDir;
  if (args[0] === "stop") {
    if (args.length !== 2 || !runId.test(args[1])) { write("usage: rmd hand-worktree ship stop <run-id>"); return 2; }
    try { return stopRun(join(stateDir(), "hand-ship"), args[1], write); }
    catch (error) {
      const reason = (error as Error).message;
      write(`${args[1]}: ${reason}`);
      return 1;
    }
  }
  let values;
  try {
    ({ values } = parseArgs({ args, options: { title: { type: "string" }, "body-file": { type: "string" } } }));
  } catch (error) {
    const reason = (error as Error).message;
    write(reason);
    return 2;
  }
  const title = values.title?.trim();
  if (!title || !values["body-file"]) {
    write("usage: rmd hand-worktree ship --title <title> --body-file <path>");
    return 2;
  }
  const body = readFileSync(resolve(options.cwd, values["body-file"]), "utf8");
  const state = stateDir();
  const hosts = readHosts(join(state, "hand-ship-hosts.json"));
  const queue = join(state, "hand-ship");
  mkdirSync(queue, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(queue, `rmd-ship-${systemClock.now()}-`));
  const id = basename(dir);
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("stop requested"));
  const checkStop = () => { if (existsSync(join(dir, "stop"))) stop(); };
  const run: ShipRun = { dir, signal: controller.signal, log: (line) => {
    appendFileSync(join(dir, "run.log"), `${line}\n`, { mode: 0o600 });
    write(`${id}: ${line}`);
  } };
  const status = (state: string, detail?: string) => {
    const data = JSON.stringify({ id, pid: process.pid, status: state, detail, at: systemClock.iso() }) + "\n";
    writeFileSync(join(dir, "status.next"), data, { mode: 0o600 });
    renameSync(join(dir, "status.next"), join(dir, "status.json"));
    appendFileSync(join(dir, "history.ndjson"), data, { mode: 0o600 });
  };
  writeFileSync(join(dir, "queued"), String(process.pid), { mode: 0o600 });
  status("queued");
  run.log(`queued (${dir})`);
  const watch = setInterval(checkStop, 100);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const continueRun = () => { checkStop(); run.signal.throwIfAborted(); };
  try {
    const source = await effects.readSource(options.cwd, run);
    const lock = await enterQueue(queue, id, run.signal);
    try {
      rmSync(join(dir, "queued"));
      const host = await chooseHost(hosts, effects, run);
      status("preflight", `${host.name} ${source.head}`);
      const workspace = await effects.prepare(host, source, run);
      try {
        const receipt = await workspace.preflight(host.kind === "mac" ? "low" : "normal");
        continueRun();
        if (receipt.headSha !== source.head || !shaPattern.test(receipt.baseSha)) throw new Error("receipt does not identify the requested head and main");
        const verified = await compareFailures(receipt, workspace, run);
        const decision = (await authorTools()).authorPushEligibility(verified);
        run.log(decision.pushEligibleReason);
        if (!decision.pushEligible) throw new Error("preflight withheld publication");
      } finally {
        await workspace.close();
      }
    } finally {
      lock.release();
    }
    continueRun();
    const existing = await effects.findPull(source, run);
    const block = acceptanceBlockDiagnostics(body);
    if (existing !== undefined && (block.defective || block.criteriaParsed === 0)) {
      throw new Error("an amendment pull request requires a valid Acceptance: block");
    }
    continueRun();
    status("publishing", source.branch);
    await effects.push(source, run);
    continueRun();
    const pr = await effects.publish(source, title, body, existing, run);
    continueRun();
    run.log(`pull request ${pr.url}`);
    effects.checkBody(pr.body, run);
    continueRun();
    status("shipped", pr.url);
    return 0;
  } catch (error) {
    const detail = (error as Error).message;
    status(run.signal.aborted ? "stopped" : "failed", detail);
    run.log(detail);
    return 1;
  } finally {
    rmSync(join(dir, "queued"), { force: true });
    clearInterval(watch);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

interface CommandResult { code: number | null; stdout: string; stderr: string; truncated: boolean }
interface ChildOptions { cwd?: string; input?: string; control?: boolean; capture?: boolean; record?: boolean;
  env?: NodeJS.ProcessEnv; signal?: AbortSignal }
const outputLimit = 32 * 1024 * 1024;

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try { process.kill(-pid, signal); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; return false; }
}

/** A cancelled child's leader can exit while another member of its group ignores SIGTERM. The run is not
 *  stopped until the whole group is gone: wait out the grace period, then kill what is left. */
async function reapGroup(pid: number, deadline: number): Promise<void> {
  while (signalGroup(pid, 0) && systemClock.now() < deadline) await delay(50);
  signalGroup(pid, "SIGKILL");
}

async function runChild(run: ShipRun, file: string, args: string[], opts: ChildOptions = {}): Promise<CommandResult> {
  const signal = opts.signal ?? run.signal;
  const env = opts.env ?? (await authorTools()).authorEnvironment(process.env);
  signal.throwIfAborted();
  return await new Promise((resolveChild, reject) => {
    const child = (run.spawn ?? spawn)(file, args, { cwd: opts.cwd, env, detached: true,
      stdio: [opts.input || opts.control ? "pipe" : "ignore", "pipe", "pipe"] });
    const buffers = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    let length = 0;
    let truncated = false;
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream]!.on("data", (chunk: Buffer) => {
        if (opts.record) {
          try { appendFileSync(join(run.dir, "commands.log"), chunk, { mode: 0o600 }); }
          catch (error) { recordError(error); }
        }
        if (opts.capture === false) return;
        length += chunk.length;
        if (length <= outputLimit) buffers[stream].push(chunk);
        else truncated = true;
      });
    }
    let force: NodeJS.Timeout | undefined;
    let deadline: number | undefined;
    const abort = () => {
      if (child.pid === undefined || force !== undefined) return;
      const pid = child.pid;
      if (opts.control) child.stdin!.end();
      else signalGroup(pid, "SIGTERM");
      const grace = opts.control ? 10_000 : 2_000;
      deadline = systemClock.now() + grace;
      force = setTimeout(() => signalGroup(pid, "SIGKILL"), grace);
    };
    let failure: unknown;
    const recordError = (error: unknown) => { failure ??= error; abort(); };
    const input = opts.input ? createReadStream(opts.input) : undefined;
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      // A remote command can close stdin before it reports its exit; keep its actual exit status.
      if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") recordError(error);
    });
    input?.on("error", recordError);
    if (input) input.pipe(child.stdin!);
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", recordError);
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      input?.destroy();
      const settle = () => {
        clearTimeout(force);
        if (signal.aborted) reject(signal.reason);
        else if (failure !== undefined) reject(failure);
        else resolveChild({ code, stdout: Buffer.concat(buffers.stdout).toString("utf8"),
          stderr: Buffer.concat(buffers.stderr).toString("utf8"), truncated });
      };
      if (deadline === undefined || child.pid === undefined) settle();
      else reapGroup(child.pid, deadline).then(settle, (error: unknown) => { failure ??= error; settle(); });
    });
  });
}

function checked(result: CommandResult, label: string): string {
  if (result.code !== 0 || result.truncated) throw new Error(`${label} failed (${result.code ?? "signal"})${result.stderr.trim() ? `: ${result.stderr.trim().slice(-500)}` : ""}`);
  return result.stdout;
}

const shellWord = (word: string) => "'" + word.replaceAll("'", "'\\''") + "'";
const shellCommand = (args: string[]) => args.map(shellWord).join(" ");

// Job control gives the checked command its own process group. The SSH client's stdin stays
// open for the run, and EOF cancels that group even if the local coordinator disappears.
const sshSupervise = 'set -m; exec 3<&0; (exec "$@") 3<&- </dev/null & child=$!; ' +
  '(IFS= read -r _ <&3; kill -TERM -- "-$child" 2>/dev/null; sleep 2; kill -KILL -- "-$child" 2>/dev/null) >/dev/null 2>&1 & watcher=$!; ' +
  'wait "$child"; result=$?; kill "$watcher" 2>/dev/null; wait "$watcher" 2>/dev/null; ' +
  'kill -KILL -- "-$child" 2>/dev/null; exit "$result"';
const launchInDir = 'if [ -n "$1" ]; then PATH="$1:$PATH"; export PATH; fi; ' +
  'if [ -n "$2" ]; then cd "$2" || exit; fi; shift 2; exec "$@"';

async function hostCommand(host: ShipHost, run: ShipRun, args: string[], opts: ChildOptions = {}): Promise<CommandResult> {
  if (host.target === "local") {
    // A caller's environment (the preflight's, with the pinned Node's directory first on PATH) is kept;
    // pathPrefix still goes in front of it, added to PATH and never replacing it.
    const env = { ...(opts.env ?? (await authorTools()).authorEnvironment(process.env)) };
    if (host.pathPrefix) env.PATH = `${host.pathPrefix}:${env.PATH ?? "/usr/bin:/bin"}`;
    return runChild(run, args[0], args.slice(1), { ...opts, env });
  }
  const command = ["bash", "-c", launchInDir, "hand-ship", host.pathPrefix ?? "", opts.cwd ?? "", ...args];
  const remote = opts.input ? command : ["bash", "-c", sshSupervise, "hand-ship", ...command];
  return runChild(run, "ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2", "--", host.target, shellCommand(remote)], { ...opts, cwd: undefined, control: !opts.input });
}

async function gitAt(run: ShipRun, cwd: string, args: string[]): Promise<string> {
  run.signal.throwIfAborted();
  const output = await (run.git ?? hostWorktreeGitAsync)(cwd, args, { signal: run.signal });
  run.signal.throwIfAborted();
  return output.trim();
}

function githubRepo(url: string) {
  const repo = /^(https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)[\w.-]+\/[\w.-]+$/.test(url)
    ? parseOwnerRepoFromRemoteUrl(url) : undefined;
  if (!repo) throw new Error("origin must point to a GitHub repository");
  return repo;
}

async function defaultSource(cwd: string, run: ShipRun): Promise<ShipSource> {
  const root = checked(await runChild(run, "git", ["rev-parse", "--show-toplevel"], { cwd }), "git show-toplevel").trim();
  const branch = (await gitAt(run, root, ["symbolic-ref", "HEAD"])).replace(/^refs\/heads\//, "");
  const head = await gitAt(run, root, ["rev-parse", "HEAD"]);
  if (branch === "main" || branch.startsWith("refs/") || !shaPattern.test(head)) throw new Error("check out a committed branch other than main");
  if (await gitAt(run, root, ["status", "--porcelain", "--untracked-files=normal"])) throw new Error("commit or remove working tree changes before shipping");
  const origin = await gitAt(run, root, ["remote", "get-url", "origin"]);
  const pushOrigin = githubRepo(await gitAt(run, root, ["remote", "get-url", "--all", "--push", "origin"]));
  const fetchOrigin = githubRepo(origin);
  if (pushOrigin.owner !== fetchOrigin.owner || pushOrigin.repo !== fetchOrigin.repo) throw new Error("origin fetch and push name different repositories");
  return { root, branch, head, origin };
}

async function prepareWorkspace(host: ShipHost, source: ShipSource, run: ShipRun): ReturnType<HandShipEffects["prepare"]> {
  const command = async (args: string[], opts: ChildOptions = {}) => checked(await hostCommand(host, run, args, opts), args.slice(0, 2).join(" "));
  run.signal.throwIfAborted();
  const scratch = (await command(["mktemp", "-d", "/tmp/rmd-hand-ship.XXXXXXXX"], { signal: AbortSignal.timeout(30_000) })).trim();
  if (!/^\/tmp\/rmd-hand-ship\.[a-zA-Z0-9]{8}$/.test(scratch)) throw new Error("host returned an invalid temporary directory");
  const bundle = join(run.dir, "head.bundle");
  // A host entry needs only a name, a target and a kind. Without a configured checkout, a remote host
  // installs the head's locked dependencies in its private scratch tree instead of borrowing a donor's.
  const donor = host.checkout ?? (host.target === "local" ? source.root : undefined);
  const close = async () => {
    rmSync(bundle, { force: true });
    if (host.target === "local") rmSync(scratch, { recursive: true, force: true });
    else await command(["rm", "-rf", "--", scratch], { signal: AbortSignal.timeout(30_000) });
  };
  try {
    // TAP reports real paths, including /private/tmp on macOS.
    const physical = (await command(["pwd", "-P"], { cwd: scratch })).trim();
    if (physical !== scratch && physical !== `/private${scratch}`) throw new Error("host temporary path could not be verified");
    const hostBundle = host.target === "local" ? bundle : join(physical, "head.bundle");
    const headDir = join(physical, "head");
    const mainDir = join(physical, "main");
    await gitAt(run, source.root, ["bundle", "create", bundle, "HEAD"]);
    if (host.target !== "local") await command(["sh", "-c", 'cat > "$1"', "hand-ship", hostBundle], { input: bundle });
    await command(["git", "clone", "--no-checkout", "--", hostBundle, headDir]);
    const git = (args: string[], opts: ChildOptions = {}) => command(["git", ...args], { cwd: headDir, ...opts });
    await git(["checkout", "--detach", source.head]);
    await git(["remote", "set-url", "origin", source.origin]);
    if (donor === undefined) await command(["npm", "ci", "--no-audit", "--no-fund"], { cwd: headDir, record: true });
    else {
      await command(["cmp", "-s", join(headDir, "package-lock.json"), join(donor, "package-lock.json")]);
      await command(["ln", "-s", join(donor, "node_modules"), join(headDir, "node_modules")]);
    }
    let priority: Priority = "normal";
    let nodeExecutable = "node";
    if (host.target === "local" && host.kind === "mac") {
      const pin = readFileSync(join(source.root, ".nvmrc"), "utf8").trim().replace(/^v/, "");
      if (process.versions.node === pin) nodeExecutable = process.execPath;
      else {
        const located = (await authorTools()).pinnedNodeReexec({ pin, current: process.versions.node, env: process.env });
        if (!located.reexec) throw new Error(located.refuse ?? `the pinned Node ${pin} could not be located`);
        nodeExecutable = located.reexec;
      }
    }
    // Children that resolve `node` through PATH find the pinned Node first: its directory is added to PATH, never replacing it.
    const pinnedEnv = async () => {
      const env = (await authorTools()).authorEnvironment(process.env);
      if (isAbsolute(nodeExecutable)) env.PATH = `${dirname(nodeExecutable)}${delimiter}${env.PATH ?? ""}`;
      return env;
    };
    const node = (args: string[]) => priority === "low" ? ["/usr/bin/nice", "-n", "10", nodeExecutable, ...args] : [nodeExecutable, ...args];
    let baseCut = false;
    const failureSites = new Map<string, ReturnType<typeof locateFailures>>();
    return {
      async preflight(requested) {
        priority = requested;
        run.log(`running author preflight at ${priority} priority`);
        const result = await hostCommand(host, run, node(["--import", "tsx", authorEntry,
          "--head-ref", source.branch, "--head-sha", source.head]), { cwd: headDir, capture: false, record: true, env: await pinnedEnv() });
        if (result.code === null || result.code > 3) throw new Error(`author preflight did not finish (exit ${result.code ?? "signal"})`);
        const raw = await command(["cat", "coverage/preflight-author.json"], { cwd: headDir });
        writeFileSync(join(run.dir, "receipt.json"), raw, { mode: 0o600 });
        const receipt = JSON.parse(raw);
        if (receipt.version !== 1 || receipt.dryRun !== false || !Array.isArray(receipt.steps) ||
          receipt.publicationIdentity?.state !== "passed" || receipt.publicationIdentity?.headRef !== source.branch) {
          throw new Error(receipt.error ?? "author preflight did not issue a receipt for this branch");
        }
        // The failed test step's own TAP report gives each named failure its nesting; its joined title cannot.
        const failed = (receipt as ShipReceipt).steps.find((step) => !step.ok);
        const log = failed && testFailureStage(failed) ? failed.diagnostics?.stdout : undefined;
        const named = (receipt as ShipReceipt).failureAttribution?.tests;
        if (!Array.isArray(named) || named.length === 0 || typeof log !== "string" || !/^coverage\/rmd-author-[\w.-]+\/[\w.-]+\.stdout\.log$/.test(log)) {
          return receipt;
        }
        return withTapPaths(receipt, await command(["cat", log], { cwd: headDir }), headDir);
      },
      rerun,
      close,
    };
    async function rerun(tree: "head" | "main", file: string, sha: string, path?: readonly string[], expectedCount?: number): Promise<FailingTest[]> {
        const title = path?.join(" > ");
        run.log(`isolated rerun on ${tree} ${sha}: ${file}${title === undefined ? "" : ` :: ${title}`}`);
        if (tree === "main" && !baseCut) {
          // `git diff --quiet` exits 1 when the lockfile differs: that is an answer, not a failure.
          const lockfile = await hostCommand(host, run, ["git", "diff", "--quiet", source.head, sha, "--", "package-lock.json"], { cwd: headDir });
          if (lockfile.code !== 0 && lockfile.code !== 1) checked(lockfile, "git diff package-lock.json");
          await command(["git", "clone", "--shared", "--no-checkout", "--", headDir, mainDir]);
          await git(["checkout", "--detach", sha], { cwd: mainDir });
          // An unchanged lockfile lets main reuse head's dependencies. A changed one installs main's own locked
          // dependencies in its private checkout, so main's tests run against what main declares.
          if (lockfile.code === 0) await command(["ln", "-s", join(donor ?? headDir, "node_modules"), join(mainDir, "node_modules")]);
          else await command(["npm", "ci", "--no-audit", "--no-fund"], { cwd: mainDir, record: true });
          baseCut = true;
        }
        const cwd = tree === "main" ? mainDir : headDir;
        if ((await git(["rev-parse", "HEAD"], { cwd })).trim() !== sha || (await git(["status", "--porcelain"], { cwd })).trim()) {
          throw new Error(`${tree} changed before the isolated rerun`);
        }
        const available = await hostCommand(host, run, ["test", "-f", file], { cwd });
        if (available.code === 1 && tree === "main") return [];
        checked(available, `${tree} test ${file}`);
        await command(["test", "!", "-L", file], { cwd });
        const selection = path === undefined ? [] : isolatedTestArgs(path);
        const args = proofTestRunnerArgs(["--test", "--test-reporter=tap", "--test-concurrency=1", "--enable-source-maps", ...selection,
          "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts", file], source.root, [file]);
        const result = await hostCommand(host, run, node(args), { cwd, record: true, env: await pinnedEnv() });
        const { testSummary } = await authorTools();
        const summary = testSummary(result.stdout);
        const results = tapResults(result.stdout, cwd, file);
        // A failing `it` in a `describe` reports two rows, but the summary counts one test: suites are not tests.
        const testRows = results.filter((test) => !test.describeRow);
        const targets = results.filter((test) => !test.suite && !test.fileLevel && test.file === file && samePath(test.path, path));
        // Node reports a file whose filters admitted no test as one passing row for the file itself, so a run that
        // selected nothing has no row but the file's own.
        if (path !== undefined && !result.truncated && result.code === 0 && summary?.fail === 0 && results.every((test) => test.fileLevel)) {
          // A filter that ran nothing is never read as a result. On main the test may simply not exist yet: only the
          // whole file, rerun unfiltered, can show that no test there starts the target's path.
          const present = tree === "head" ||
            (await rerun(tree, file, sha)).some((row) => !row.fileLevel && row.path?.[0] === path[0]);
          if (present) {
            throw new Error(`${tree} ${file}: the rerun filter for ${JSON.stringify(title)} ran 0 tests ` +
              `(${selection.join(" ")}), so it selected nothing; a filter that runs no test is an error, never a result`);
          }
          return [];
        }
        if (result.truncated || !summary || summary.cancelled !== 0 || testRows.length !== summary.tests ||
          testRows.filter((test) => test.failed).length !== summary.fail ||
          result.code !== (summary.fail === 0 ? 0 : 1) ||
          (path === undefined && result.code === 0 && summary.pass === 0) ||
          (path !== undefined && tree === "head" && targets.length !== (expectedCount ?? 1)) ||
          results.some((test) => (test.fileLevel && test.failed) || (test.file !== null && test.file !== file))) {
          throw new Error(`${tree} ${file}: isolated rerun had no complete test result ` +
            `(exit=${result.code}, summary=${JSON.stringify(summary)}, rows=${JSON.stringify(results)})`);
        }
        const redTargets = targets.filter((row) => row.failed);
        const ambiguous = targets.length > 1 && (redTargets.length !== targets.length ||
          new Set(redTargets.map((row) => row.location)).size !== redTargets.length);
        if (redTargets.length > 0 && !ambiguous) {
          const path = join(cwd, file);
          let identify = failureSites.get(path);
          if (!identify) {
            identify = locateFailures(await git(["show", `${sha}:${file}`], { cwd }));
            failureSites.set(path, identify);
          }
          for (const row of redTargets) row.failureIdentity = identify(row);
        }
        return path === undefined ? results : pathRows(results, path, tree, file);
    }
  } catch (error) {
    await close();
    throw error;
  }
}

interface PullResponse { number: number; html_url: string; body: string }

/** The required pre-push gate's open-PR body check runs with no GitHub credential, so it reads the body its
 *  clone caches: `cacheFile` in scripts/open-pr-body-proof-precheck.mjs, under the Git common directory. This
 *  process has the operator's login, reads the stored body fresh just before the push, and writes that cache. A
 *  branch with no open PR has no stored body proofs, which an empty body states. A body this cannot read refuses
 *  the push: the gate would otherwise report it UNCHECKED. */
async function cacheStoredBody(source: ShipSource, run: ShipRun,
  github: (args: string[], fresh?: true, signal?: AbortSignal) => Promise<unknown>): Promise<void> {
  const { owner, path } = pullEndpoint(source);
  const query = new URLSearchParams({ state: "open", head: `${owner}:${source.branch}` });
  let pulls: unknown;
  try {
    pulls = await github(["api", `${path}?${query}`], true, run.signal);
  } catch (error) {
    run.signal.throwIfAborted();
    throw new Error(`the open PR's stored body could not be read before the push (${(error as Error).message})`);
  }
  run.signal.throwIfAborted();
  const open = Array.isArray(pulls) ? pulls as Partial<PullResponse>[] : undefined;
  if (!open || open.length > 1 || open.some((pull) => typeof (pull.body ?? "") !== "string")) {
    throw new Error("the open PR's stored body could not be read before the push (GitHub did not name at most one open PR)");
  }
  const common = resolve(source.root, await gitAt(run, source.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const cache = join(common, "rmd-open-pr-body", `${encodeURIComponent(source.branch)}.json`);
  mkdirSync(dirname(cache), { recursive: true });
  writeFileSync(cache, JSON.stringify({ body: open[0]?.body ?? "", readAt: systemClock.iso() }));
}
const pullEndpoint = (source: ShipSource) => {
  const { owner, repo } = githubRepo(source.origin);
  return { owner, path: `repos/${owner}/${repo}/pulls` };
};

export function handShipEffects(checkAcceptance: (bodyFile: string) => number,
  github: (args: string[], fresh?: true, signal?: AbortSignal) => Promise<unknown> = (args, fresh, signal) => ghJsonAsync(args, undefined, undefined, { fresh, signal }),
  pushGit = hostWorktreeGitAsync,
): HandShipEffects {
  return {
    async readHost(host, run) {
      const args = host.kind === "mac" ? ["/usr/sbin/sysctl", "-n", "kern.memorystatus_vm_pressure_level"] : ["cat", "/proc/meminfo"];
      return checked(await hostCommand(host, run, args, { signal: AbortSignal.any([run.signal, AbortSignal.timeout(15_000)]) }), "memory reading");
    },
    readSource: defaultSource,
    prepare: prepareWorkspace,
    async push(source, run) {
      const current = await defaultSource(source.root, run);
      if (current.head !== source.head) {
        throw new Error(`HEAD moved during verification: the checks ran on ${source.head} but HEAD now reads ${current.head}; nothing was pushed`);
      }
      if (current.branch !== source.branch || current.origin !== source.origin) {
        throw new Error("source branch, head or origin changed during verification");
      }
      await cacheStoredBody(source, run, github);
      const execute = worktreePushExecAsync(source.root, { prGates: true, requireGate: true, signal: run.signal, git: run.git, push: (worktree, args, opts) => {
        run.signal.throwIfAborted();
        return pushGit(worktree, args, opts);
      } });
      await gitPushRunBranchAsync(source.root, { expectedHeadSha: source.head, destination: source.branch,
        capture: (_file, args) => gitAt(run, source.root, args.slice(2)),
        exec: (file, args, opts) => execute(file, [...args.slice(0, -1), `${source.head}:refs/heads/${source.branch}`], opts) });
    },
    async findPull(source, run) {
      run.signal.throwIfAborted();
      const { owner, path } = pullEndpoint(source);
      const query = new URLSearchParams({ state: "open", head: `${owner}:${source.branch}` });
      const existing = await github(["api", `${path}?${query}`], true, run.signal) as PullResponse[];
      run.signal.throwIfAborted();
      if (Array.isArray(existing) && existing.length === 0) return undefined;
      const pull = Array.isArray(existing) && existing.length === 1 ? existing[0] : undefined;
      if (!pull || !Number.isSafeInteger(pull.number)) {
        throw new Error("GitHub did not identify a unique pull request for the branch");
      }
      return pull.number;
    },
    async publish(source, title, body, existing, run) {
      run.signal.throwIfAborted();
      const { path } = pullEndpoint(source);
      const fields = ["-f", `title=${title}`, "-f", `body=${body}`];
      const written = await github(existing === undefined
        ? ["api", "-X", "POST", path, "-f", `head=${source.branch}`, "-f", "base=main", ...fields]
        : ["api", "-X", "PATCH", `${path}/${existing}`, ...fields], undefined, run.signal) as PullResponse;
      run.signal.throwIfAborted();
      if (!written || !Number.isSafeInteger(written.number)) throw new Error("GitHub did not return a pull request number");
      const stored = await github(["api", `${path}/${written.number}`], true, run.signal) as PullResponse;
      run.signal.throwIfAborted();
      if (stored.body?.trimEnd() !== body.trimEnd()) throw new Error(`stored pull request body differs at ${stored.html_url}`);
      return { url: stored.html_url, body: stored.body };
    },
    checkBody(body, run) {
      const path = join(run.dir, "stored-pr-body.md");
      writeFileSync(path, body, { mode: 0o600 });
      if (checkAcceptance(path) !== 0) throw new Error(`stored pull request body failed check-acceptance (${path})`);
    },
  };
}
