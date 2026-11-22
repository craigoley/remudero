#!/usr/bin/env node
// scripts/write-only-ledger-step-ratchet.mjs — W1-T14149 (rationale: this task's own plan shard).
//
// INVARIANT no-silent-loop: a ledger step newly written in src/ with no reader outside its writer
// file fails this check unless BASELINE_PATH declares it record-only with a reason. A decision row
// nothing reads is how a loop silently stops: `routing.experiment.result` was written daily and
// read only by its own writer.
//
// EMITTED: `log("a.b"` or a `step:` property holding a literal or a constant: lexically bound,
// imported, or destructured from a host by its exported name. An undotted literal counts on a
// ledger row only. Both operands of `a ?? "x.y"` and both branches of a conditional count, and a
// call to a function whose parameter reaches an emit (a step helper) emits its argument.
// READ: equality and switch cases on a step, step membership checks and Map lookups (`.has`,
// `.includes`, `.get`), read-step collections, step prefixes and suffixes, and raw JSON step
// patterns; `row.step ?? ""` reads `row.step`.
// Read evidence must be in a different file from the emission. Comments, console output and
// incidental literals do not read a step.
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
/**
 * A `step:` literal on an object that is not a ledger row must be dotted. The undotted ones off a
 * row are printed actions (`{ step: "copy" }` in src/lib/plan-task-move.ts), a run's phase table
 * (`{ step: "fix_rung", owner }` in src/run-task.ts) and a review exit (`{ step: "view" }`); on a
 * row an undotted step is as real as a dotted one (`step: "dispatch_wip_observed"`).
 */
const DOTTED_STEP_RE = /^(?=[^.]*\.)[a-z][a-z0-9_]*(?:[.:-][a-z0-9_]+)*$/;
/** LedgerLine (src/lib/ledger.ts) requires both: an object carrying either is shaped as a ledger row. */
const ROW_IDENTITY_KEYS = ["run_id", "task_id"];
/** A call that appends its object argument to a ledger: append, appendLedger, appendLine, writeLedger, `opts.ledger?.(row)`. */
const LEDGER_APPEND_RE = /^(?:append\w*|write\w*Ledger\w*|ledger)$/;
/** `a ?? b` and `a || b` evaluate to `a` whenever it is set: a read of `a` with a fallback. */
const FALLBACK_OPERATORS = new Set(["??", "||"]);
const RAW_STEP_RE = /"step"\s*:\s*"((?:[a-z0-9_.:-]|\\\.)+)"/g;
const RAW_STEP_ALTERNATIVES_RE = /"step"\s*:\s*"\((?:\?:)?((?:[a-z0-9_:|-]|\\\.)+)\)"/g;
const REGEX_PREFIX_RE = /^\^((?:[a-z0-9_:-]|\\\.)+)(\$)?$/;
const READ_STEPS_NAME_RE = /(?:^|_)READ_STEPS?$/;
const CONSTANT_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const EQUALITY = new Set(["===", "!==", "==", "!="]);
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
  for (;;) {
    if (node && (WRAPPERS.has(node.type) || node.type === "OptionalChainingExpression")) node = node.expression ?? node.base;
    else if (node?.type === "BinaryExpression" && FALLBACK_OPERATORS.has(node.operator)) node = node.left;
    else return node;
  }
}

/** The callee's own name: `appendLedger` for `appendLedger(...)`, `ledger` for `opts.ledger?.(...)`. */
function calleeName(callee) {
  const node = unwrap(callee);
  return node?.type === "Identifier" ? node.value : memberName(node);
}

function propertyName(node) {
  if (node?.type === "Computed") return node.expression.type === "StringLiteral" ? node.expression.value : undefined;
  return node?.value;
}

function memberName(node) {
  return node?.type === "MemberExpression" ? propertyName(node.property) : undefined;
}

/** `row.step`, `String(row.step)`, or either operand of a fallback (`row.step ?? ""`) or a conditional. */
function isStep(expr) {
  return alternatives(expr).some((node) => {
    if (node?.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.value === "String") {
      return isStep(node.arguments[0]?.expression);
    }
    return memberName(node) === "step" || (node?.type === "Identifier" && node.value === "step");
  });
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

/** The expressions a value can be: both operands of a fallback (`a ?? "x.y"`) and both branches of a conditional. */
function alternatives(expr) {
  let node = expr;
  while (node && WRAPPERS.has(node.type)) node = node.expression;
  if (node?.type === "BinaryExpression" && FALLBACK_OPERATORS.has(node.operator)) return [...alternatives(node.left), ...alternatives(node.right)];
  if (node?.type === "ConditionalExpression") return [...alternatives(node.consequent), ...alternatives(node.alternate)];
  return [unwrap(node)];
}

function isStatic(expr) {
  return alternatives(expr).some((node) => node && (node.type === "Identifier" || node.type === "StringLiteral" ||
    node.type === "RegExpLiteral" || (node.type === "TemplateLiteral" && node.expressions.length === 0) || collection(node) !== undefined));
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
    const identified = ROW_IDENTITY_KEYS.some((key) => keys.has(key));
    const query = !identified && [...keys].some((key) => READER_QUERY_KEYS.has(key));
    const row = identified || rec.appended.has(node);
    for (const prop of node.properties) {
      if (prop.type !== "KeyValueProperty" && prop.type !== "Identifier") continue;
      // `{ step }` is shorthand for `{ step: step }`.
      const [key, value] = prop.type === "Identifier" ? [prop.value, prop] : [propertyName(prop.key), prop.value];
      if (key === "step" && query) rec.reads.push(["exact", value]);
      else if (key === "step") rec.emits.push([row ? STEP_RE : DOTTED_STEP_RE, value]);
      else if (key === "pattern" || key === "markers") rec.reads.push(["raw", value]);
    }
  } else if (type === "CallExpression") {
    if (LEDGER_APPEND_RE.test(calleeName(node.callee) ?? "")) {
      // A parent is visited before its children, so the row argument is marked before it is read.
      for (const { expression } of node.arguments) if (unwrap(expression)?.type === "ObjectExpression") rec.appended.add(unwrap(expression));
    }
    const callee = unwrap(node.callee);
    const method = memberName(callee);
    if (callee?.type === "Identifier" && node.arguments.length > 0) rec.calls.push({ callee, args: node.arguments });
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

/** `[name, params]` of a function declaration or of a declarator bound to a function, else undefined. */
function functionOf(node) {
  if (node.type === "FunctionDeclaration") return [node.identifier, node.params];
  const init = node.type === "VariableDeclarator" && node.id.type === "Identifier" ? unwrap(node.init) : undefined;
  if (init?.type === "ArrowFunctionExpression" || init?.type === "FunctionExpression") return [node.id, init.params];
  return undefined;
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
    path, bindings: new Map(), exports: new Map(), imports: new Map(), destructured: new Map(), appended: new WeakSet(),
    functions: new Set(), topFunctions: new Map(), params: new Map(), calls: [],
    emits: [], reads: [], lits: new Set(), prefixes: new Set(), suffixes: new Set(),
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
    const declaration = stmt.type === "ExportDeclaration" ? stmt.declaration : stmt;
    for (const node of declaration.type === "VariableDeclaration" ? declaration.declarations : [declaration]) {
      const [id] = functionOf(node) ?? [];
      if (id) rec.topFunctions.set(id.value, bindingKey(id));
    }
  }
  visitNodes(tree, (node) => {
    const fn = functionOf(node);
    if (fn) {
      const [id, params] = fn;
      rec.functions.add(bindingKey(id));
      params.forEach((param, index) => {
        const pat = param.pat ?? param;
        const local = pat.type === "AssignmentPattern" ? pat.left : pat;
        if (local.type === "Identifier") rec.params.set(bindingKey(local), { fn: bindingKey(id), index });
      });
    }
    if (node.type === "VariableDeclaration" && node.kind === "const") {
      for (const { id, init } of node.declarations) {
        if (id.type !== "Identifier" || !isStatic(init)) continue;
        rec.bindings.set(bindingKey(id), init);
        if (READ_STEPS_NAME_RE.test(id.value) && collection(unwrap(init))) rec.reads.push(["exact", init]);
      }
    } else if (node.type === "ObjectPattern") {
      // `const { WORKER_STATE_LEDGER_STEP } = host` and `({ X_STEP }: Deps) => ...`: a host object
      // hands over the exported constant of the same name, so the local resolves through that name.
      for (const prop of node.properties) {
        const name = propertyName(prop.key);
        const local = prop.type === "AssignmentPatternProperty" ? prop.key : prop.value?.left ?? prop.value;
        if (local?.type === "Identifier" && CONSTANT_NAME_RE.test(name ?? "")) rec.destructured.set(bindingKey(local), name);
      }
    }
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
    const options = alternatives(expr);
    if (options.length > 1) return options.flatMap((option) => values(rec, option, emit, seen));
    const node = options[0];
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
    if (rec.destructured.has(key)) {
      return (declarers.get(rec.destructured.get(key)) ?? []).flatMap(([other, id]) => values(other, id, emit, next));
    }
    if (emit && node.ctxt === 1 && CONSTANT_NAME_RE.test(node.value)) {
      return (declarers.get(node.value) ?? []).flatMap(([other, id]) => values(other, id, true, next));
    }
    return [];
  }

  // A STEP HELPER is a function whose parameter reaches an emit, directly (`log(step)`, `{ step }`)
  // or through another helper's step argument; each call passes it the step, so the call emits it
  // and its writers are the caller's file and every file down the chain.
  const helpers = new Map();
  const paramOf = (rec, expr) => alternatives(expr).map((leaf) => leaf?.type === "Identifier" && rec.params.get(bindingKey(leaf))).find(Boolean);
  const mark = (rec, { fn, index }, shape, files) => {
    const key = `${rec.path}#${fn}`;
    const at = helpers.get(key) ?? new Map();
    helpers.set(key, at);
    if (at.has(index)) return false;
    at.set(index, { shape, files: new Set(files).add(rec.path) });
    return true;
  };
  function helperOf(rec, callee) {
    const key = bindingKey(callee);
    if (rec.functions.has(key)) return helpers.get(`${rec.path}#${key}`);
    const imported = rec.imports.get(key);
    const target = imported && byPath.get(resolveSpecifier(rec.path, imported.from, byPath));
    return target?.topFunctions.has(imported.name) ? helpers.get(`${target.path}#${target.topFunctions.get(imported.name)}`) : undefined;
  }
  for (const rec of recs) {
    for (const [shape, expr] of rec.emits) {
      const param = paramOf(rec, expr);
      if (param) mark(rec, param, shape, []);
    }
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const rec of recs) {
      for (const { callee, args } of rec.calls) {
        for (const [index, { shape, files }] of helperOf(rec, callee) ?? []) {
          const param = args[index] && !args[index].spread && paramOf(rec, args[index].expression);
          if (param && mark(rec, param, shape, files)) grew = true;
        }
      }
    }
  }
  for (const rec of recs) {
    for (const { callee, args } of rec.calls) {
      for (const [index, { shape, files }] of helperOf(rec, callee) ?? []) {
        const arg = args[index];
        if (arg && !arg.spread && isStatic(arg.expression)) rec.emits.push([shape, arg.expression, files]);
      }
    }
  }

  const writers = new Map();
  for (const rec of recs) {
    for (const [shape, expr, files = []] of rec.emits) {
      for (const step of values(rec, expr, true)) {
        const literal = unwrap(expr).type !== "Identifier";
        if (!(literal ? shape : STEP_RE).test(step)) continue;
        if (!writers.has(step)) writers.set(step, new Set());
        for (const path of [rec.path, ...files]) writers.get(step).add(path);
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
