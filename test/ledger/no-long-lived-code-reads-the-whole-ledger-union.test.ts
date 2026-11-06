/**
 * W1-T11423 — no long-lived code materialises the whole ledger union.
 *
 * OBSERVED 2026-11-05: dep-review's proposalProgress called `readLedgerUnionRecordsSync(dir, { refuseIncomplete:
 * true }).rows` — every row of ~394 archives — to filter a dozen by task_id, and core hit its heap limit every
 * ~25 min. It was the third keyed question answered by a whole-ledger scan in two days, and the class had
 * aborted core twice before (09-10, 09-23). A keyed question asks `ledgerRowsFor`; every other union read must
 * carry a bound the union honours, or a written reason on the allowlist below. W1-T11424 empties it.
 */
// @source-text-subject: the census parses reader calls in the complete src tree.
// @census-reads: src/ — every non-test source file's union reader calls.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { parseSync } from "@swc/core";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const READERS = ["readLedgerUnionRecordsSync", "readLedgerUnionRecords", "readLedgerUnionRawLinesSync", "readLedgerUnionRawLinesAsync",
  "readLedgerUnionRawLines", "openLedgerUnion", "readLedgerCorpus"];
const PLANTED_UNION_MODULE = [".", "ledger-union.js"].join("/");
/** Only design-approved bounds honoured by the particular reader can discharge the census. */
const COMMON_BOUNDS = ["step", "since", "sinceTs"];
const RAW_BOUNDS = [...COMMON_BOUNDS, "pattern", "keep", "maxRotations", "rotationWindowMs"];
const BOUNDS: Record<string, readonly string[]> = {
  readLedgerUnionRecordsSync: [...RAW_BOUNDS, "rotationRecords"],
  readLedgerUnionRawLinesSync: RAW_BOUNDS,
  readLedgerUnionRawLinesAsync: RAW_BOUNDS,
  readLedgerUnionRecords: [...COMMON_BOUNDS, "afterRotation"],
  openLedgerUnion: [...COMMON_BOUNDS, "afterRotation"],
};
/** The union's own module defines these readers and `ledgerRowsFor`; it is not a caller. */
const DEFINING = new Set(["src/lib/ledger-union.ts", "src/lib/ledger-key-manifest.ts"]);

/** file#function → why the read is unbounded today. Every entry is W1-T11424's to remove. */
const ALLOWLIST: Record<string, string> = {
  "src/lib/analytics-route.ts#deriveAnalyticsSnapshotFromLedger": "whole-history analytics snapshot, no key; W1-T11424 gives it a per-archive digest",
  "src/lib/analytics-route.ts#scanAnalyticsLedger": "initial analytics scan has no afterRotation checkpoint and streams whole history; W1-T11424",
  "src/lib/dep-review.ts#proposalTaskLedgerRows": "unknown proposal capture time omits afterRotation and scans whole history for task ids; W1-T11424 moves it to ledgerRowsFor",
  "src/lib/field-trials-flow.ts#readFieldTrialsLedger": "field-trials ledger stream, whole history; W1-T11424",
  "src/lib/field-trials-flow.ts#readControlledLedgerRows": "field-trials materialises every row with no filter; W1-T11424 moves it to ledgerRowsFor",
  "src/lib/human-gate.ts#measureFeedbackAge": "live-file-only read: its fsDeps list no archives, so it never opens a rotation; W1-T11424 states that bound",
  "src/lib/impossible-canary.ts#impossibleCanaryCommand": "impossible-canary CLI materialises every row with no filter; W1-T11424",
  "src/lib/pr-owner-ledger.ts#readPrOwnerLedgerProjection": "pr-owner projection streams whole history, no key; W1-T11424",
  "src/lib/pr-state.ts#<module>": "pr-state's injectable reader passes its caller's options through; W1-T11424",
  "src/lib/retro.ts#readRetroLedgerNdjson": "retro without sinceTs streams whole history into its caller-owned byte and row window; W1-T11424",
  "src/lib/routing-experiments.ts#routingAbCommand": "routing-experiments CLI materialises every row with no filter; W1-T11424",
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|mjs|js)$/.test(name) && !/\.test\.|\.d\.ts$/.test(name)) out.push(path);
  }
  return out;
}

type Ast = { type?: string; [key: string]: unknown };
const ast = (value: unknown): Ast | undefined => value !== null && typeof value === "object" ? value as Ast : undefined;
const identifierKey = (node: Ast): string => `${node.ctxt}:${node.value}`;
const propertyName = (value: unknown): string | undefined => {
  const node = ast(value);
  return node?.type === "Identifier" || node?.type === "StringLiteral" ? String(node.value)
    : node?.type === "Computed" && ast(node.expression)?.type === "StringLiteral" ? String(ast(node.expression)!.value) : undefined;
};

function walk(value: unknown, visit: (node: Ast, fn: string) => void, fn = "<module>"): void {
  if (Array.isArray(value)) { value.forEach((child) => walk(child, visit, fn)); return; }
  const node = ast(value);
  if (!node) return;
  if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") {
    fn = propertyName(node.identifier) ?? fn;
  } else if (node.type === "VariableDeclarator" && ["ArrowFunctionExpression", "FunctionExpression"].includes(ast(node.init)?.type ?? "")) {
    fn = propertyName(node.id) ?? fn;
  } else if (node.type === "ClassMethod" || node.type === "MethodProperty") fn = propertyName(node.key) ?? fn;
  visit(node, fn);
  Object.values(node).forEach((child) => walk(child, visit, fn));
}

export interface UnionCall { site: string; file: string; fn: string; bounded: boolean }

export function censusUnionCalls(files: Array<{ file: string; text: string }>): UnionCall[] {
  const calls: UnionCall[] = [];
  for (const { file, text } of files) {
    if (DEFINING.has(file) || !READERS.some((name) => text.includes(name))) continue;
    const tree = parseSync(text, { syntax: "typescript", target: "es2022" });
    // SWC resolves each identifier's syntax context, so equal local names in different scopes do not alias.
    const bindings = new Map<string, Ast | undefined>();
    function bind(pattern: unknown, value?: Ast): void {
      const node = ast(pattern);
      if (node?.type === "Identifier") bindings.set(identifierKey(node), value);
      else if (node?.type === "ObjectPattern") {
        for (const prop of node.properties as Ast[]) {
          const key = prop.key;
          const target = prop.type === "AssignmentPatternProperty" ? prop.key : prop.value;
          bind(target, { type: "MemberExpression", object: value, property: key });
        }
      } else if (node?.type === "AssignmentPattern") bind(node.left, value);
    }
    walk(tree, (node) => {
      if (node.type === "ImportSpecifier") {
        const name = propertyName(node.imported ?? node.local);
        bind(node.local, name && READERS.includes(name) ? { type: "UnionReader", name } : undefined);
      } else if (node.type === "VariableDeclarator") bind(node.id, ast(node.init));
      else if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") bind(node.identifier);
      if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type ?? "")) {
        for (const param of node.params as Ast[]) bind(param.pat ?? param);
      }
    });
    function unwrap(node: Ast): Ast {
      return ["ParenthesisExpression", "TsAsExpression", "TsConstAssertion", "TsSatisfiesExpression", "TsNonNullExpression", "TsTypeAssertion"].includes(node.type ?? "")
        ? unwrap(ast(node.expression)!) : node;
    }
    function reader(value: unknown, seen = new Set<string>()): string | undefined {
      const raw = ast(value);
      if (!raw) return undefined;
      const node = unwrap(raw);
      if (node.type === "UnionReader") return String(node.name);
      if (node.type === "MemberExpression") {
        const name = propertyName(node.property);
        return name && READERS.includes(name) ? name : undefined;
      }
      if (node.type !== "Identifier") return undefined;
      const key = identifierKey(node);
      if (!bindings.has(key)) return READERS.includes(String(node.value)) ? String(node.value) : undefined;
      if (seen.has(key)) return undefined;
      return reader(bindings.get(key), new Set([...seen, key]));
    }
    function bounded(value: unknown, bounds: readonly string[], seen = new Set<string>()): boolean {
      const raw = ast(value);
      if (!raw) return false;
      const node = unwrap(raw);
      if (node.type === "Identifier") {
        const key = identifierKey(node);
        return !seen.has(key) && bounded(bindings.get(key), bounds, new Set([...seen, key]));
      }
      if (node.type === "ConditionalExpression") return bounded(node.consequent, bounds, seen) && bounded(node.alternate, bounds, seen);
      if (node.type !== "ObjectExpression") return false;
      return (node.properties as Ast[]).some((prop) => prop.type === "SpreadElement" ? bounded(prop.arguments, bounds, seen)
        : bounds.includes(propertyName(prop.type === "Identifier" ? prop : prop.key) ?? ""));
    }
    const bytes = Buffer.from(text);
    walk(tree, (node, fn) => {
      if (node.type !== "CallExpression") return;
      const name = reader(node.callee);
      if (!name) return;
      const args = node.arguments as Ast[];
      const line = bytes.subarray(0, Number(ast(node.span)!.start) - 1).toString().split("\n").length;
      calls.push({ site: `${file}:${line}`, file, fn, bounded: bounded(args[1]?.expression, BOUNDS[name] ?? []) });
    });
  }
  return calls;
}

function repoFiles(): Array<{ file: string; text: string }> {
  return sourceFiles(join(REPO_ROOT, "src")).map((path) => ({ file: relative(REPO_ROOT, path), text: readFileSync(path, "utf8") }));
}

test("W1-T11423 criterion 3: every non-test union read carries a bound or a written allowlist reason", { timeout: 120_000 }, () => {
  const calls = censusUnionCalls(repoFiles());
  const bounded = calls.filter((c) => c.bounded).length;
  // Population floor: the walk must find real calls of BOTH kinds, so an empty or mis-matching walk cannot pass.
  assert.ok(bounded > Object.keys(ALLOWLIST).length, `census saw ${calls.length} calls, ${bounded} bounded — the walk found too few to judge`);
  const offenders = calls.filter((c) => !c.bounded && !ALLOWLIST[`${c.file}#${c.fn}`]);
  assert.deepEqual(offenders.map((c) => `${c.site} (${c.fn})`), [],
    "an unbounded union read materialises or decompresses the whole ledger: ask ledgerRowsFor, pass a bound, or add a reasoned allowlist entry");
  const used = new Set(calls.filter((c) => !c.bounded).map((c) => `${c.file}#${c.fn}`));
  const stale = Object.keys(ALLOWLIST).filter((key) => !used.has(key));
  assert.deepEqual(stale, [], "an allowlist entry no unbounded call needs any more must be removed");
});

test("W1-T11423 criterion 3: a planted unbounded union read reddens the census, and a bounded one does not", () => {
  const planted = [{ file: "src/lib/planted.ts", text: [
    "export function leak(dir: string) {",
    "  return readLedgerUnionRecordsSync(dir, { refuseIncomplete: true }).rows;",
    "}",
    "export async function keyed(dir: string) {",
    "  return readLedgerUnionRecords(dir, { since: \"2026-11-05T00:00:00Z\", step: [\"x\"] });",
    "}",
    "// readLedgerUnionRecordsSync(dir, {}) in a comment is not a call",
  ].join("\n") }];
  const calls = censusUnionCalls(planted);
  assert.deepEqual(calls.map((c) => [c.fn, c.bounded]), [["leak", false], ["keyed", true]]);
});

test("W1-T11423 criterion 3: callback properties cannot bound a call, including imported and local reader aliases", () => {
  const calls = censusUnionCalls([{ file: "src/lib/planted.ts", text: `
    import { readLedgerUnionRecords as scan } from "${PLANTED_UNION_MODULE}";
    import * as union from "${PLANTED_UNION_MODULE}";
    const again = scan;
    const chained = again;
    const { openLedgerUnion: opened } = union;
    export function leak(dir: string) {
      readLedgerUnionRecords(dir, { onRecord: row => report({ step: row.step }) });
      scan(dir, { onRecord: row => report({ since: row.ts }) });
      again(dir, { onRecord: row => report({ keep: row }) });
      chained(dir, { onRecord: row => report({ maxRotations: 3 }) });
      opened(dir, { onRecord: row => report({ pattern: row.step }) });
      union.openLedgerUnion(dir, {}, { step: "third argument is not options" });
      readLedgerUnionRecords({ step: "first argument is not options" }, {});
      const metadata = { step: "nested metadata is not a bound" };
      scan(dir, { metadata });
      scan(dir, { onRecord: row => report({ step: row.step }), "since": "2026-10-05" });
      const options = { since: "2026-10-05", onRecord: row => report({ step: row.step }) };
      scan(dir, options);
      scan(dir, { ...options });
      const description = "scan(dir, { step: 'text is not a call' })";
      // scan(dir, {}) is not a call either.
    }
  ` }]);
  assert.equal(calls.length, 11, "all direct, namespace, imported and chained aliases must be counted");
  assert.deepEqual(calls.map((c) => c.bounded), [...Array(8).fill(false), true, true, true]);
  const offenders = calls.filter((c) => !c.bounded && !ALLOWLIST[`${c.file}#${c.fn}`]);
  assert.equal(offenders.length, 8, "every planted unbounded call must refuse the census");
});

test("W1-T11423 criterion 3: option and reader aliases keep their lexical scope", () => {
  const calls = censusUnionCalls([{ file: "src/lib/planted.ts", text: `
    import { readLedgerUnionRecords as scan } from "${PLANTED_UNION_MODULE}";
    export function bounded(dir: string) {
      const options = { "step": "café" } as const;
      return scan(dir, options);
    }
    export function unbounded(dir: string) {
      const options = { onRecord: row => report({ step: row.step }) };
      return scan(dir, options);
    }
    export function unrelated(dir: string) {
      const scan = report;
      return scan(dir, {});
    }
  ` }]);
  assert.deepEqual(calls.map((c) => [c.site, c.fn, c.bounded]), [
    ["src/lib/planted.ts:5", "bounded", true],
    ["src/lib/planted.ts:9", "unbounded", false],
  ]);
});

test("W1-T11423 criterion 3: every conditional options branch must carry an honoured bound", () => {
  const calls = censusUnionCalls([{ file: "src/lib/planted.ts", text: `
    export function leak(dir: string, flag: boolean, other: boolean) {
      readLedgerUnionRecordsSync(dir, flag ? { step: "x" } : {});
      readLedgerUnionRecordsSync(dir, flag ? {} : { step: "x" });
      const maybe = flag ? { since: "2026-10-05" } : {};
      readLedgerUnionRecordsSync(dir, maybe);
      readLedgerUnionRecordsSync(dir, { ...maybe });
      readLedgerUnionRecordsSync(dir, flag ? { step: "x" } : other ? { keep: row => true } : {});
      readLedgerUnionRecordsSync(dir, flag ? { step: "x" } : { since: "2026-10-05" });
      readLedgerUnionRecordsSync(dir, { ...maybe, step: "x" });
    }
  ` }]);
  assert.equal(calls.length, 7, "all planted conditional calls must be counted");
  assert.deepEqual(calls.map((c) => c.bounded), [false, false, false, false, false, true, true]);
});

test("W1-T11423 criterion 3: ignored options cannot bound raw or streaming readers, including aliases", () => {
  const calls = censusUnionCalls([{ file: "src/lib/planted.ts", text: `
    import { readLedgerUnionRawLinesSync as raw, readLedgerUnionRecords as records } from "${PLANTED_UNION_MODULE}";
    import * as union from "${PLANTED_UNION_MODULE}";
    const again = raw;
    const { readLedgerUnionRawLinesAsync: rawAsync } = union;
    export function leak(dir: string) {
      raw(dir, { where: row => row.step === "x" });
      again(dir, { selectRotation: entry => false });
      rawAsync(dir, { where: row => false, selectRotation: entry => false });
      union.readLedgerUnionRawLinesSync(dir, { rotationRecords: () => [] });
      raw(dir, { afterRotation: "archive" });
      records(dir, { pattern: /x/ });
      records(dir, { keep: row => false });
      union.openLedgerUnion(dir, { maxRotations: 1, rotationWindowMs: 1 });
      readLedgerUnionRecordsSync(dir, { afterRotation: "archive" });
      union.openLedgerUnion(dir, { throughRotation: "archive", where: row => false, selectRotation: entry => false });
      raw(dir, { pattern: /x/ });
      rawAsync(dir, { keep: row => false });
      again(dir, { maxRotations: 1 });
      records(dir, { afterRotation: "archive" });
      readLedgerUnionRecordsSync(dir, { rotationRecords: () => [] });
    }
  ` }]);
  assert.equal(calls.length, 15, "reader identity must survive namespace, imported and chained aliases");
  assert.deepEqual(calls.map((c) => c.bounded), [...Array(10).fill(false), ...Array(5).fill(true)]);
});
