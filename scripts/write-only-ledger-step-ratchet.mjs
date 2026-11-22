#!/usr/bin/env node
// scripts/write-only-ledger-step-ratchet.mjs — W1-T14149 (rationale: this task's own plan shard).
//
// INVARIANT no-silent-loop: a ledger step newly written in src/ with no reader outside its writer
// file fails this check unless BASELINE_PATH declares it record-only with a reason. A decision row
// nothing reads is how a loop silently stops: `routing.experiment.result` was written daily and
// read only by its own writer.
//
// EMITTED: `log("a.b"`, a `step:` property holding a dotted literal or a bound constant, and the `step` of
// any object handed to a ledger append call (`appendLedger`, `appendLine`, `ledger(...)`), dotted or not.
// A constant resolves through its declaration, an import, or a destructured binding of the host object
// that carries it (`const { X_STEP } = host`).
// READ: equality and switch cases on a step, step membership and Map lookups (`.has` / `.includes` /
// `.get`, the step possibly behind a `?? ""` or `|| ""` fallback), read-step collections, step prefixes
// and suffixes, and raw JSON step patterns. Read evidence must be in a different file from the emission.
// Comments, console output and incidental literals do not read a step.
//
// THE RATCHET: the baseline's `writeOnly` list is today's debt and only shrinks against the merge
// base; an entry that gained a reader must leave it. A new write-only step needs a reader, or a
// `recordOnly` row with a non-empty reason. A step, not a job: it rides ci.yml's light gates beside
// console-parity and reports under the required comment-load-ratchet check.
//
// FALSIFIER: test/ci/gates/a-new-ledger-step-nothing-reads-fails-ci.test.ts.

import { readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseSync } from "@swc/core";
import { createScanner, SyntaxKind as K } from "typescript/unstable/ast";
import { isMainModule } from "./lib/argv.mjs";
import { git } from "./lib/git.mjs";

export const GATE = "write-only-ledger-step";
export const BASELINE_PATH = "scripts/write-only-ledger-step-baseline.json";
export const DEFAULT_BASE_REF = "origin/main";
/** The step decoder (W1-T2764): its rows describe a step's meaning and writer, and nothing reads them to decide. */
export const REGISTRY_FILES = new Set(["src/lib/ledger-steps.ts"]);

const SOURCE_RE = /^src\/.+\.(?:ts|mts|mjs)$/;
const STEP_RE = /^[a-z][a-z0-9_]*(?:[.:-][a-z0-9_]+)*$/;
/** A `step:` property literal must be dotted: `{ step: "copy" }` is far more often a plain object than a ledger row. */
const DOTTED_STEP_RE = /^(?=[^.]*\.)[a-z][a-z0-9_]*(?:[.:-][a-z0-9_]+)*$/;
const RAW_STEP_RE = /"step"\s*:\s*"((?:[a-z0-9_.:-]|\\\.)+)"/g;
const RAW_STEP_ALTERNATIVES_RE = /"step"\s*:\s*"\((?:\?:)?((?:[a-z0-9_:|-]|\\\.)+)\)"/g;
const REGEX_PREFIX_RE = /^\^((?:[a-z0-9_:-]|\\\.)+)(\$)?$/;
const READ_STEPS_NAME_RE = /(?:^|_)READ_STEPS?$/;
const CONSTANT_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const EQUALITY = new Set(["===", "!==", "==", "!="]);
/** `row.step ?? ""` and `row.step || ""` still hand the step to whatever consumes the expression. */
const FALLBACK = new Set(["??", "||"]);
/**
 * A ledger append site: `appendLedger(path, { step })`, `appendLine(...)`, `append(...)`, `opts.ledger?.({ step })`.
 * An object handed to one is a ledger row, so its `step` is written whether or not the name carries a dot;
 * a helper such as `queueGovernorGateFor` writes through the append call inside it.
 */
const APPEND_CALLEE_RE = /^(?:append[A-Za-z]*|ledger)$/;
const MATCH_METHODS = new Set(["includes", "startsWith", "endsWith", "indexOf", "match", "matchAll", "search"]);
const PREDICATE_METHODS = new Set(["some", "every", "find", "findIndex", "filter"]);
const READER_QUERY_KEYS = new Set([
  "refuseIncomplete", "requireArchives", "rotationRecords", "rotationWindowMs", "minRotations", "maxRotations",
  "liveFirst", "readLiveRecords", "liveRecords", "dedupe", "dedupeSeed", "dedupeWindowPerStep", "exactDedupe",
  "onUnreadArchive", "onUnreadLive", "onUnreadDirectory", "onMalformedRow", "onAcceptedRecord", "onRecord",
  "onTorn", "onLiveRead", "onSourceRead", "satisfied", "since", "sinceTs", "where", "stopAfterRotation",
  "throughRotation", "selectRotation", "includeLive", "afterRotation", "strictMalformed", "corpusSnapshot",
]);
const WRAPPERS = new Set([
  "ParenthesisExpression", "TsAsExpression", "TsConstAssertion", "TsNonNullExpression",
  "TsSatisfiesExpression", "TsTypeAssertion",
]);

function parseSource(path, text) {
  const options = { syntax: "typescript", target: "es2022" };
  try {
    return parseSync(text, options);
  } catch (error) {
    if (!error.message.includes("got '<eof>'")) throw new Error(`cannot parse ${path}: ${error.message}`, { cause: error });
    // A truncated source can still have complete expressions before its missing closing delimiters.
    const closing = new Map([[K.OpenParenToken, ")"], [K.OpenBracketToken, "]"], [K.OpenBraceToken, "}"]]);
    const enders = new Set([K.CloseParenToken, K.CloseBracketToken, K.CloseBraceToken]);
    const open = [];
    const scanner = createScanner(true, undefined, text);
    for (let kind = scanner.scan(); kind !== K.EndOfFile; kind = scanner.scan()) {
      if (closing.has(kind)) open.push(closing.get(kind));
      else if (enders.has(kind)) open.pop();
    }
    return parseSync(`${text}\n${open.reverse().join("")}`, options);
  }
}

function visitNodes(node, visit) {
  if (node.type) visit(node);
  for (const key in node) {
    const child = node[key];
    if (key !== "span" && child && typeof child === "object") visitNodes(child, visit);
  }
}

function unwrap(node) {
  while (node && (WRAPPERS.has(node.type) || node.type === "OptionalChainingExpression")) {
    node = node.expression ?? node.base;
  }
  return node;
}

function propertyName(node) {
  if (node?.type === "Computed") return node.expression.type === "StringLiteral" ? node.expression.value : undefined;
  return node?.value;
}

function memberName(node) {
  return node?.type === "MemberExpression" ? propertyName(node.property) : undefined;
}

function isStep(node) {
  node = unwrap(node);
  if (node?.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.value === "String") {
    return isStep(node.arguments[0]?.expression);
  }
  if (node?.type === "BinaryExpression" && FALLBACK.has(node.operator)) return isStep(node.left) || isStep(node.right);
  return memberName(node) === "step" || (node?.type === "Identifier" && node.value === "step");
}

// SWC assigns a syntax context to each binding and its references. The context is local to a file;
// context 1 is the resolver's unresolved context, so it cannot be a shadowing local binding.
const bindingKey = (node) => `${node.ctxt}:${node.value}`;

function collection(node) {
  if (node.type === "ArrayExpression") return node.elements;
  if (node.type === "NewExpression" && node.callee.type === "Identifier" && node.callee.value === "Set") {
    return node.arguments?.slice(0, 1) ?? [];
  }
  if (node.type === "NewExpression" && node.callee.type === "Identifier" && node.callee.value === "Map") {
    // A Map's members are its keys: the first element of each `[key, value]` entry.
    const entries = unwrap(node.arguments?.[0]?.expression);
    if (entries?.type !== "ArrayExpression") return [];
    return entries.elements.flatMap((entry) => {
      const tuple = unwrap(entry?.expression);
      return tuple?.type === "ArrayExpression" && tuple.elements[0] ? [tuple.elements[0]] : [];
    });
  }
  if (node.type === "CallExpression" && memberName(node.callee) === "freeze" && node.callee.object.value === "Object") {
    return node.arguments.slice(0, 1);
  }
  return undefined;
}

function isStatic(expr) {
  const node = unwrap(expr);
  return node && (node.type === "Identifier" || node.type === "StringLiteral" || node.type === "RegExpLiteral" ||
    (node.type === "TemplateLiteral" && node.expressions.length === 0) || collection(node) !== undefined);
}

function collectEvidence(node, rec) {
  const { type } = node;
  if (type === "BinaryExpression" && EQUALITY.has(node.operator)) {
    if (isStep(node.left)) rec.reads.push(["exact", node.right]);
    if (isStep(node.right)) rec.reads.push(["exact", node.left]);
  } else if (type === "SwitchStatement" && isStep(node.discriminant)) {
    for (const { test } of node.cases) if (test) rec.reads.push(["exact", test]);
  } else if (type === "ObjectExpression") {
    const keys = new Set(node.properties.map((prop) => propertyName(prop.key ?? prop)));
    const query = !keys.has("run_id") && !keys.has("task_id") && [...keys].some((key) => READER_QUERY_KEYS.has(key));
    for (const prop of node.properties) {
      if (prop.type !== "KeyValueProperty") continue;
      const key = propertyName(prop.key);
      if (key === "step" && query) rec.reads.push(["exact", prop.value]);
      else if (key === "step") rec.emits.push([DOTTED_STEP_RE, prop.value]);
      else if (key === "pattern" || key === "markers") rec.reads.push(["raw", prop.value]);
    }
  } else if (type === "CallExpression") {
    const callee = unwrap(node.callee);
    const method = memberName(callee);
    const calleeName = callee.type === "Identifier" ? callee.value : method;
    if (calleeName !== undefined && APPEND_CALLEE_RE.test(calleeName)) {
      for (const { expression } of node.arguments) {
        const row = unwrap(expression);
        if (row?.type !== "ObjectExpression") continue;
        for (const prop of row.properties) {
          if (prop.type === "KeyValueProperty" && propertyName(prop.key) === "step") rec.emits.push([STEP_RE, prop.value]);
        }
      }
    }
    const arg = node.arguments[0];
    if (!arg || arg.spread) return;
    const value = arg.expression;
    if (callee.type === "Identifier" && callee.value === "log") rec.emits.push([STEP_RE, value]);
    if (!method) return;
    const receiver = unwrap(callee.object);
    if (method === "log" && receiver.value !== "console" && memberName(receiver) !== "console") rec.emits.push([STEP_RE, value]);
    if ((method === "has" || method === "includes" || method === "get") && isStep(value)) rec.reads.push(["exact", receiver]);
    if (node.arguments.length === 1 && isStep(receiver)) {
      if (method === "startsWith") rec.reads.push(["prefix", value]);
      if (method === "endsWith") rec.reads.push(["suffix", value]);
    }
    if (method === "test" || method === "exec") rec.reads.push([isStep(value) ? "regex" : "raw", receiver]);
    if (MATCH_METHODS.has(method)) rec.reads.push(["raw", value]);
    if (PREDICATE_METHODS.has(method)) readPredicate(receiver, unwrap(value), rec);
  }
}

function readPredicate(receiver, predicate, rec) {
  if (predicate.type !== "ArrowFunctionExpression" && predicate.type !== "FunctionExpression") return;
  const param = predicate.params[0]?.pat ?? predicate.params[0];
  if (param?.type !== "Identifier") return;
  const isParam = (expr) => {
    const node = unwrap(expr);
    return node?.type === "Identifier" && bindingKey(node) === bindingKey(param);
  };
  visitNodes(predicate.body, (node) => {
    if (node.type === "BinaryExpression" && EQUALITY.has(node.operator) &&
      ((isParam(node.left) && isStep(node.right)) || (isParam(node.right) && isStep(node.left)))) {
      rec.reads.push(["exact", receiver]);
    } else if (node.type === "CallExpression" && node.arguments.length === 1 && isParam(node.arguments[0].expression)) {
      const callee = unwrap(node.callee);
      if (!isStep(callee.object)) return;
      const method = memberName(callee);
      if (method === "startsWith") rec.reads.push(["prefix", receiver]);
      if (method === "endsWith") rec.reads.push(["suffix", receiver]);
    }
  });
}

/**
 * `const { WORKER_STATE_LEDGER_STEP } = host` and `({ X_STEP: local }) =>` bind a local to a property of a host
 * object. The property name is the constant's name, so the local resolves as that exported constant would.
 * Recorded by binding and by bare name: the name alone resolves the binding when its syntax context differs.
 */
function collectDestructured(pattern, rec) {
  for (const prop of pattern.properties) {
    let local;
    let source;
    if (prop.type === "AssignmentPatternProperty") {
      local = prop.key;
      source = prop.key.value;
    } else if (prop.type === "KeyValuePatternProperty") {
      const target = prop.value.type === "AssignmentPattern" ? prop.value.left : prop.value;
      if (target.type === "Identifier") {
        local = target;
        source = propertyName(prop.key);
      }
    }
    if (local === undefined || typeof source !== "string") continue;
    rec.destructured.set(bindingKey(local), source);
    rec.destructuredNames.set(local.value, source);
  }
}

/** A module specifier resolved to a source path, or undefined for a package or an unknown file. */
function resolveSpecifier(from, specifier, known) {
  const base = specifier.startsWith("#src/") ? `src/${specifier.slice(5)}` :
    specifier.startsWith(".") ? posix.join(posix.dirname(from), specifier) : undefined;
  if (base === undefined) return undefined;
  return [base, base.replace(/\.js$/, ".ts"), base.replace(/\.mjs$/, ".mts"), `${base}.ts`, `${base}/index.ts`].find((p) => known.has(p));
}

function analyzeFile({ path, text }) {
  const tree = parseSource(path, text);
  const rec = {
    path, bindings: new Map(), exports: new Map(), imports: new Map(), emits: [], reads: [],
    destructured: new Map(), destructuredNames: new Map(),
    lits: new Set(), prefixes: new Set(), suffixes: new Set(),
  };
  for (const stmt of tree.body) {
    if (stmt.type === "ImportDeclaration" && !stmt.typeOnly) {
      for (const spec of stmt.specifiers) {
        if (spec.type === "ImportSpecifier" && !spec.isTypeOnly) {
          rec.imports.set(bindingKey(spec.local), { name: spec.imported?.value ?? spec.local.value, from: stmt.source.value });
        }
      }
    } else if (stmt.type === "ExportDeclaration" && stmt.declaration.type === "VariableDeclaration") {
      for (const { id } of stmt.declaration.declarations) {
        if (id.type === "Identifier") rec.exports.set(id.value, id);
      }
    }
  }
  visitNodes(tree, (node) => {
    if (node.type === "VariableDeclaration" && node.kind === "const") {
      for (const { id, init } of node.declarations) {
        if (id.type !== "Identifier" || !isStatic(init)) continue;
        rec.bindings.set(bindingKey(id), init);
        if (READ_STEPS_NAME_RE.test(id.value) && collection(unwrap(init))) rec.reads.push(["exact", init]);
      }
    }
    if (node.type === "ObjectPattern") collectDestructured(node, rec);
    collectEvidence(node, rec);
  });
  rec.reads = rec.reads.filter(([, expr]) => isStatic(expr));
  rec.emits = rec.emits.filter(([, expr]) => isStatic(expr));
  return rec;
}

function readValue(mode, value, rec) {
  if (mode === "raw") {
    const text = typeof value === "string" ? value : value.pattern;
    for (const match of text.matchAll(RAW_STEP_RE)) rec.lits.add(match[1].replaceAll("\\.", "."));
    if (typeof value === "string") return;
    for (const match of text.matchAll(RAW_STEP_ALTERNATIVES_RE)) {
      for (const step of match[1].split("|")) rec.lits.add(step.replaceAll("\\.", "."));
    }
  } else if (mode === "regex" && typeof value !== "string") {
    const match = REGEX_PREFIX_RE.exec(value.pattern);
    if (match) {
      const step = match[1].replaceAll("\\.", ".");
      if (match[2]) rec.lits.add(step);
      else rec.prefixes.add(step);
    }
  } else if (typeof value === "string") {
    if (mode === "prefix") rec.prefixes.add(value);
    else if (mode === "suffix") rec.suffixes.add(value);
    else if (mode === "exact") rec.lits.add(value);
  }
}

/**
 * Every step `sources` emit, each one's readers outside its writer files, and the write-only steps.
 * `sources` is `[{ path, text }]` and the ledger step registry is excluded.
 */
export function scanLedgerSteps(sources) {
  const recs = sources.filter(({ path }) => !REGISTRY_FILES.has(path)).map(analyzeFile);
  const byPath = new Map(recs.map((rec) => [rec.path, rec]));
  const declarers = new Map();
  for (const rec of recs) {
    for (const [name, id] of rec.exports) declarers.set(name, [...(declarers.get(name) ?? []), [rec, id]]);
  }

  function values(rec, expr, emit = false, seen = new Set()) {
    const node = unwrap(expr);
    if (!node || seen.has(node)) return [];
    const next = new Set(seen).add(node);
    if (node.type === "StringLiteral") return [node.value];
    if (node.type === "TemplateLiteral" && node.expressions.length === 0) return [node.quasis[0].cooked];
    if (node.type === "RegExpLiteral" && !emit) return [node];
    if (node.type !== "Identifier") {
      return emit ? [] : (collection(node) ?? []).flatMap((member) => values(rec, member?.expression, false, next));
    }
    const key = bindingKey(node);
    if (rec.bindings.has(key)) return values(rec, rec.bindings.get(key), emit, next);
    const imported = rec.imports.get(key);
    if (imported) {
      const target = byPath.get(resolveSpecifier(rec.path, imported.from, byPath));
      return target ? values(target, target.exports.get(imported.name), emit, next) : [];
    }
    const source = rec.destructured.get(key) ?? rec.destructuredNames.get(node.value);
    if (source !== undefined && CONSTANT_NAME_RE.test(source)) {
      return (declarers.get(source) ?? []).flatMap(([other, id]) => values(other, id, emit, next));
    }
    if (emit && node.ctxt === 1 && CONSTANT_NAME_RE.test(node.value)) {
      return (declarers.get(node.value) ?? []).flatMap(([other, id]) => values(other, id, true, next));
    }
    return [];
  }

  const writers = new Map();
  for (const rec of recs) {
    for (const [shape, expr] of rec.emits) {
      for (const step of values(rec, expr, true)) {
        const literal = unwrap(expr).type !== "Identifier";
        if (!(literal ? shape : STEP_RE).test(step)) continue;
        if (!writers.has(step)) writers.set(step, new Set());
        writers.get(step).add(rec.path);
      }
    }
    for (const [mode, expr] of rec.reads) {
      for (const value of values(rec, expr)) readValue(mode, value, rec);
    }
  }
  const emitted = new Map();
  const readers = new Map();
  for (const step of [...writers.keys()].sort()) {
    const own = writers.get(step);
    emitted.set(step, [...own].sort());
    readers.set(step, recs.filter((rec) => !own.has(rec.path) && (rec.lits.has(step) ||
      [...rec.prefixes].some((p) => step.startsWith(p)) || [...rec.suffixes].some((s) => step.endsWith(s)))).map((rec) => rec.path).sort());
  }
  const writeOnly = [...readers].filter(([, files]) => files.length === 0).map(([step]) => step);
  return { emitted, readers, writeOnly };
}

/** Parse and validate the baseline document: `writeOnly` step names and `recordOnly` step -> reason, no step twice. */
export function parseBaseline(text, label) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`${label} is not valid JSON: ${e.message}`);
  }
  const { writeOnly, recordOnly } = doc ?? {};
  if (!Array.isArray(writeOnly) || !writeOnly.every((s) => typeof s === "string")) throw new Error(`${label}: "writeOnly" must be an array of step names`);
  if (recordOnly === null || typeof recordOnly !== "object" || Array.isArray(recordOnly)) throw new Error(`${label}: "recordOnly" must be an object of step -> reason`);
  for (const [step, reason] of Object.entries(recordOnly)) if (typeof reason !== "string") throw new Error(`${label}: recordOnly "${step}" needs a string reason`);
  const seen = new Set();
  for (const step of [...writeOnly, ...Object.keys(recordOnly)]) {
    if (seen.has(step)) throw new Error(`${label}: "${step}" is listed twice`);
    seen.add(step);
  }
  return { writeOnly, recordOnly };
}

/**
 * The ratchet. Refuses a write-only step recorded nowhere, a debt entry that is no longer write-only,
 * a debt entry the merge base's list lacks (`baseBaseline` null: no baseline there, nothing to
 * shrink against) and a record-only entry with an empty reason. `recordOnlyRead` is reported only.
 */
export function ratchetVerdict({ writeOnly, baseline, baseBaseline }) {
  const current = new Set(writeOnly);
  const debt = new Set(baseline.writeOnly);
  const recorded = Object.keys(baseline.recordOnly);
  const unrecorded = writeOnly.filter((step) => !debt.has(step) && !Object.hasOwn(baseline.recordOnly, step));
  const stale = baseline.writeOnly.filter((step) => !current.has(step)).sort();
  const grown = baseBaseline === null ? [] : baseline.writeOnly.filter((step) => !baseBaseline.writeOnly.includes(step)).sort();
  const emptyReasons = recorded.filter((step) => baseline.recordOnly[step].trim() === "").sort();
  const recordOnlyRead = recorded.filter((step) => !current.has(step)).sort();
  const ok = unrecorded.length + stale.length + grown.length + emptyReasons.length === 0;
  return { ok, unrecorded, stale, grown, emptyReasons, recordOnlyRead };
}

export function formatReport({ scan, verdict, baselinePath, base }) {
  const { unrecorded, stale, grown, emptyReasons, recordOnlyRead } = verdict;
  const out = [
    `${GATE}: ${scan.emitted.size} step(s) emitted in src/, ${scan.emitted.size - scan.writeOnly.length} read outside their writer, ` +
      `${scan.writeOnly.length} write-only.`,
    base === null ? `${baselinePath}: no baseline at the merge base, so this first landing has no shrink to check.` :
      `${baselinePath}: "writeOnly" is shrink-only against the merge base ${base}.`,
  ];
  if (!verdict.ok) {
    out.push(`${GATE}: BLOCKED — ${unrecorded.length} unrecorded, ${stale.length} stale, ${grown.length} grown, ${emptyReasons.length} empty reason(s).`);
  }
  const section = (steps, heading, advice) => {
    if (steps.length > 0) out.push("", heading, ...steps.map((step) => `  ${step}`), ...(advice ? [advice] : []));
  };
  section(unrecorded, `WRITE-ONLY — emitted in src/, read by no other src/ file, and absent from ${baselinePath}:`,
    'Give each a reader outside its writer, or add it to "recordOnly" with the reason nothing needs to read it.');
  section(stale, `STALE — listed in "writeOnly" but no longer write-only (it gained a reader, or nothing emits it):`,
    `Remove each from ${baselinePath}'s "writeOnly"; the debt list only shrinks.`);
  section(grown, `GROWN — listed in "writeOnly" but absent from the merge base's list:`,
    'A new write-only step is declared in "recordOnly" with a reason, never added to the debt list.');
  section(emptyReasons, 'EMPTY REASON — a "recordOnly" entry must say why nothing reads it:');
  section(recordOnlyRead, 'FELL — declared record-only but now read, or no longer emitted; its "recordOnly" row can go:');
  if (verdict.ok) out.push(recordOnlyRead.length > 0 ? "OK (with a recordable shrink above)." : "OK — unchanged.");
  return out.join("\n");
}

function gitText(root, args, what) {
  const res = git(args, { cwd: root });
  if (res.status !== 0) throw new Error(`${what}: ${String(res.stderr).trim()}`);
  return res.stdout;
}

function readText(path, label) {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`cannot read ${label}: ${e.message}`);
  }
}

/** The CLI: 0 clean, 1 refused, 2 could not measure. A run that cannot measure never reports OK. */
export function main(argv, { log = console.log } = {}) {
  try {
    const { values } = parseArgs({
      args: argv,
      options: { root: { type: "string", default: "." }, base: { type: "string", default: DEFAULT_BASE_REF }, baseline: { type: "string", default: BASELINE_PATH } },
    });
    const root = resolve(values.root);
    const paths = gitText(root, ["ls-files", "-z", "--", "src"], "cannot list src/").split("\0").filter((p) => SOURCE_RE.test(p));
    const scan = scanLedgerSteps(paths.map((path) => ({ path, text: readText(join(root, path), path) })));
    if (scan.emitted.size === 0) {
      log(`${GATE}: REFUSING — the scan found no emitted ledger step in src/; a zero is a census that stopped seeing its corpus, not a clean sheet.`);
      return 2;
    }
    const baseline = parseBaseline(readText(join(root, values.baseline), values.baseline), values.baseline);
    const mergeBase = gitText(root, ["merge-base", values.base, "HEAD"], `cannot resolve the merge base against ${values.base}`).trim();
    const shown = git(["show", `${mergeBase}:${values.baseline}`], { cwd: root });
    const baseBaseline = shown.status === 0 ? parseBaseline(shown.stdout, `${mergeBase}:${values.baseline}`) : null;
    const verdict = ratchetVerdict({ writeOnly: scan.writeOnly, baseline, baseBaseline });
    log(formatReport({ scan, verdict, baselinePath: values.baseline, base: baseBaseline === null ? null : mergeBase }));
    return verdict.ok ? 0 : 1;
  } catch (e) {
    log(`${GATE}: MEASUREMENT FAILED — ${e.message}`);
    return 2;
  }
}

if (isMainModule(import.meta.url)) process.exit(main(process.argv.slice(2)));
