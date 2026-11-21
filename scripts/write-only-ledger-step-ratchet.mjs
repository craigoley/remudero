#!/usr/bin/env node
// scripts/write-only-ledger-step-ratchet.mjs — W1-T14149 (rationale: this task's own plan shard).
//
// INVARIANT no-silent-loop: a ledger step newly written in src/ with no reader outside its writer
// file fails this check unless BASELINE_PATH declares it record-only with a reason. A decision row
// nothing reads is how a loop silently stops: `routing.experiment.result` was written daily and
// read only by its own writer.
//
// EMITTED: `log("a.b"`, or a `step:` property holding a literal or a string constant in an object
// literal that is not a ledger-union read query. READ, in a file that does not emit the step: any
// other occurrence of the literal (an equality, a switch case, an inline array, a raw
// `"step":"a.b"` pattern), a use of a string constant or of a collection holding it (by name, or
// any collection named *_READ_STEPS), a startsWith/endsWith argument, a `/^a\./` regex prefix and
// an `a.*` wildcard. Comments never read. Erring toward READ is deliberate: a false write-only
// refuses a pull request wrongly, while a false read only leaves one step's debt unmeasured.
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
const RAW_STEP_RE = /"step"\s*:\s*"([^"]+)"/g;
const REGEX_PREFIX_RE = /^\/\^((?:[a-z0-9_:-]|\\\.)+)(\$\/)?/;
const READ_STEPS_NAME_RE = /READ_STEPS?$/;
/** Option keys only a ledger-union read query carries (src/lib/ledger-union.ts's option interfaces). */
const READER_QUERY_KEYS = new Set([
  "refuseIncomplete", "requireArchives", "rotationRecords", "rotationWindowMs", "minRotations", "maxRotations",
  "liveFirst", "readLiveRecords", "liveRecords", "dedupe", "dedupeSeed", "dedupeWindowPerStep", "exactDedupe",
  "onUnreadArchive", "onUnreadLive", "onUnreadDirectory", "onMalformedRow", "onAcceptedRecord", "onRecord",
  "onTorn", "onLiveRead", "onSourceRead", "satisfied", "since", "sinceTs", "where", "stopAfterRotation",
  "throughRotation", "selectRotation", "includeLive", "afterRotation", "strictMalformed", "corpusSnapshot",
]);
const STRINGS = new Set([K.StringLiteral, K.NoSubstitutionTemplateLiteral]);
const VALUED = new Set([K.Identifier, K.StringLiteral, K.NoSubstitutionTemplateLiteral, K.RegularExpressionLiteral]);
/** A literal ending in a separator ("daemon.", "review.stale_") is a step prefix wherever it is read. */
const PREFIX_RE = /^[a-z][a-z0-9_.:-]*[._:]$/;
const STARTS_WITH_RE = /^[a-z][a-z0-9_.:-]{2,}$/;
const ENDS_WITH_RE = /^[._:-][a-z0-9_.:-]+$/;
/** Only a constant-shaped name resolves by name alone across files; `step` or `name` would match everything. */
const CONSTANT_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const OPENERS = new Set([K.OpenBraceToken, K.OpenParenToken, K.OpenBracketToken, K.TemplateHead]);
const CLOSERS = new Set([K.CloseBraceToken, K.CloseParenToken, K.CloseBracketToken, K.TemplateTail]);
/** A `/` after one of these is division; after anything else it opens a regular expression. */
const VALUE_END = new Set([
  K.Identifier, K.StringLiteral, K.NumericLiteral, K.NoSubstitutionTemplateLiteral, K.TemplateTail,
  K.RegularExpressionLiteral, K.CloseParenToken, K.CloseBracketToken, K.CloseBraceToken, K.ThisKeyword,
]);
/** A token after a declaration's initializer that makes it an expression rather than a plain value. */
const CONTINUES = new Set([
  K.PlusToken, K.DotToken, K.QuestionDotToken, K.OpenBracketToken, K.OpenParenToken, K.QuestionToken,
  K.BarBarToken, K.QuestionQuestionToken, K.AmpersandAmpersandToken,
]);

/** Every token of `text` as `{ kind, value }`, comments dropped, with regex and template tokens re-scanned. */
export function tokenize(text) {
  const scanner = createScanner(true, undefined, text);
  const tokens = [];
  const templateBraces = [];
  for (let kind = scanner.scan(); kind !== K.EndOfFile; kind = scanner.scan()) {
    if ((kind === K.SlashToken || kind === K.SlashEqualsToken) && !VALUE_END.has(tokens.at(-1)?.kind)) kind = scanner.reScanSlashToken();
    else if (kind === K.CloseBraceToken && templateBraces.pop()) kind = scanner.reScanTemplateToken(false);
    if (kind === K.OpenBraceToken) templateBraces.push(false);
    else if (kind === K.TemplateHead || kind === K.TemplateMiddle) templateBraces.push(true);
    tokens.push({ kind, value: VALUED.has(kind) ? scanner.getTokenValue() : undefined });
  }
  return tokens;
}

/** The index of the token closing the bracket opened at `open`. */
function matching(tokens, open) {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (OPENERS.has(tokens[i].kind)) depth++;
    else if (CLOSERS.has(tokens[i].kind) && --depth === 0) return i;
  }
  return tokens.length - 1;
}

/** The depth-0 keys of the object literal enclosing token `at`, or null when the nearest open bracket is not `{`. */
function enclosingObjectKeys(tokens, at) {
  let open = at - 1;
  for (let depth = 0; open >= 0; open--) {
    if (CLOSERS.has(tokens[open].kind)) depth++;
    else if (OPENERS.has(tokens[open].kind) && depth-- === 0) break;
  }
  if (tokens[open]?.kind !== K.OpenBraceToken) return null;
  const keys = new Set();
  const close = matching(tokens, open);
  for (let i = open + 1, depth = 0; i < close; i++) {
    const kind = tokens[i].kind;
    if (depth === 0 && (kind === K.Identifier || kind === K.StringLiteral) && [K.OpenBraceToken, K.CommaToken].includes(tokens[i - 1].kind)) keys.add(tokens[i].value);
    if (OPENERS.has(kind)) depth++;
    else if (CLOSERS.has(kind)) depth--;
  }
  return keys;
}

/** The last index of an import clause, or of an export list or `export *`, starting at `i`; its names are not reads. */
function moduleClause(tokens, i, imports) {
  const open = tokens[i + 1].kind === K.TypeKeyword ? i + 2 : i + 1;
  if (tokens[i].kind === K.ExportKeyword && tokens[open].kind === K.OpenBraceToken) {
    const close = matching(tokens, open);
    return tokens[close + 1]?.kind === K.FromKeyword ? close + 2 : close;
  }
  let j = i + 1;
  for (let braces = false; j < tokens.length && !STRINGS.has(tokens[j].kind) && tokens[j].kind !== K.SemicolonToken; j++) {
    const kind = tokens[j].kind;
    if (kind === K.OpenBraceToken || kind === K.CloseBraceToken) braces = kind === K.OpenBraceToken;
    else if (braces && kind === K.Identifier && tokens[j - 1].kind !== K.AsKeyword) {
      imports.push({ local: tokens[j + 1].kind === K.AsKeyword ? tokens[j + 2].value : tokens[j].value, name: tokens[j].value });
    }
  }
  return j;
}

/** A module specifier resolved to a source path, or undefined for a package or an unknown file. */
function resolveSpecifier(from, specifier, known) {
  const base = specifier.startsWith("#src/") ? `src/${specifier.slice(5)}` :
    specifier.startsWith(".") ? posix.join(posix.dirname(from), specifier) : undefined;
  if (base === undefined) return undefined;
  return [base, base.replace(/\.js$/, ".ts"), base.replace(/\.mjs$/, ".mts"), `${base}.ts`, `${base}/index.ts`].find((p) => known.has(p));
}

/** The token range `[start, end]` of a collection initializer at `k`, or null when it is not one. */
function collectionRange(tokens, k) {
  const t = tokens[k];
  if (t?.kind === K.OpenBracketToken) return [k, matching(tokens, k)];
  const call = t?.kind === K.NewKeyword && tokens[k + 1]?.value === "Set" ? k + 2 :
    t?.value === "Object" && tokens[k + 2]?.value === "freeze" ? k + 3 : -1;
  if (call === -1) return null;
  let open = call;
  while (open < tokens.length && tokens[open].kind !== K.OpenParenToken) open++;
  return [open, matching(tokens, open)];
}

/** One file's declarations, imports, emitted steps and read evidence, before any cross-file resolution. */
function analyzeFile(path, text) {
  const tokens = tokenize(text);
  const notRead = new Set();
  const rec = {
    path, consts: new Map(), collections: new Map(), exported: new Set(), imports: [], emits: [],
    lits: new Set(), ids: new Set(), prefixes: new Set(), suffixes: new Set(),
  };
  for (let i = 0; i < tokens.length; i++) {
    const { kind, value } = tokens[i];
    const next = tokens[i + 1]?.kind;
    if ((kind === K.ImportKeyword && next !== K.OpenParenToken && next !== K.DotToken) ||
      (kind === K.ExportKeyword && [K.OpenBraceToken, K.AsteriskToken].includes(next === K.TypeKeyword ? tokens[i + 2]?.kind : next))) {
      const imports = [];
      const end = moduleClause(tokens, i, imports);
      for (let j = i; j <= end; j++) notRead.add(j);
      const from = kind === K.ImportKeyword && STRINGS.has(tokens[end]?.kind) ? tokens[end].value : undefined;
      if (from !== undefined) for (const { local, name } of imports) rec.imports.push({ local, name, from });
      i = end;
      continue;
    }
    if ([K.ConstKeyword, K.LetKeyword, K.VarKeyword].includes(kind) && next === K.Identifier && [K.EqualsToken, K.ColonToken].includes(tokens[i + 2]?.kind)) {
      declaration(tokens, i + 1, rec, notRead);
      continue;
    }
    if (kind === K.Identifier && value === "log" && next === K.OpenParenToken && !(tokens[i - 1]?.kind === K.DotToken && tokens[i - 2]?.value === "console")) {
      emitArgument(tokens, i + 2, [K.CommaToken, K.CloseParenToken], STEP_RE, rec, notRead);
    } else if ((kind === K.Identifier || kind === K.StringLiteral) && value === "step" && next === K.ColonToken &&
      [K.OpenBraceToken, K.CommaToken].includes(tokens[i - 1]?.kind)) {
      const keys = enclosingObjectKeys(tokens, i);
      const query = keys !== null && !keys.has("run_id") && !keys.has("task_id") && [...keys].some((key) => READER_QUERY_KEYS.has(key));
      if (keys !== null && !query) emitArgument(tokens, i + 2, [K.CommaToken, K.CloseBraceToken], DOTTED_STEP_RE, rec, notRead);
    } else if (kind === K.Identifier && (value === "startsWith" || value === "endsWith") && next === K.OpenParenToken && STRINGS.has(tokens[i + 2]?.kind)) {
      const arg = tokens[i + 2].value;
      if (value === "startsWith" && STARTS_WITH_RE.test(arg)) rec.prefixes.add(arg);
      if (value === "endsWith" && ENDS_WITH_RE.test(arg)) rec.suffixes.add(arg);
    }
  }
  tokens.forEach((t, i) => { if (!notRead.has(i)) readEvidence(t, rec); });
  return rec;
}

/** Records `const NAME = <string>` or a collection initializer starting at the binding `name`. */
function declaration(tokens, name, rec, notRead) {
  notRead.add(name);
  if (tokens[name - 2]?.kind === K.ExportKeyword) rec.exported.add(tokens[name].value);
  let k = name + 1;
  for (let depth = 0; k < tokens.length && !(depth === 0 && [K.EqualsToken, K.SemicolonToken].includes(tokens[k].kind)); k++) {
    if (OPENERS.has(tokens[k].kind)) depth++;
    else if (CLOSERS.has(tokens[k].kind)) depth--;
  }
  if (tokens[k]?.kind !== K.EqualsToken) return;
  const init = k + 1;
  const range = collectionRange(tokens, init);
  const end = range ? range[1] : init;
  if (CONTINUES.has(tokens[end + 1]?.kind)) return;
  if (STRINGS.has(tokens[init]?.kind)) {
    rec.consts.set(tokens[name].value, tokens[init].value);
    notRead.add(init);
  } else if (range) {
    const members = [];
    for (let j = range[0]; j <= end; j++) {
      notRead.add(j);
      if (STRINGS.has(tokens[j].kind) || tokens[j].kind === K.RegularExpressionLiteral) members.push({ lit: tokens[j].value });
      else if (tokens[j].kind === K.Identifier) members.push({ id: tokens[j].value });
    }
    rec.collections.set(tokens[name].value, { members, readHere: READ_STEPS_NAME_RE.test(tokens[name].value) });
  }
}

/** Records the value at `at` as an emitted step when it is a literal matching `shape` or a lone identifier. */
function emitArgument(tokens, at, enders, shape, rec, notRead) {
  const t = tokens[at];
  if (!t || !enders.includes(tokens[at + 1]?.kind)) return;
  if (STRINGS.has(t.kind) && shape.test(t.value)) rec.emits.push({ lit: t.value });
  else if (t.kind === K.Identifier) rec.emits.push({ id: t.value });
  else return;
  notRead.add(at);
}

/** What one token that is not a declaration, emit or module binding says this file reads. */
function readEvidence({ kind, value }, rec) {
  if (kind === K.Identifier) rec.ids.add(value);
  else if (STRINGS.has(kind) || kind === K.RegularExpressionLiteral) readValue(value, rec);
}

/** A read value: a step literal, a raw `"step":"a.b"` pattern, a separator-ended prefix, an `a.*` / `*.b`
 *  wildcard, or a regular expression's text (`/^a\.b$/` reads one step, `/^a\./` a prefix). */
function readValue(value, rec) {
  for (const m of value.matchAll(RAW_STEP_RE)) rec.lits.add(m[1]);
  const regex = REGEX_PREFIX_RE.exec(value);
  const literal = regex?.[1].replaceAll("\\.", ".");
  if (regex?.[2]) rec.lits.add(literal);
  else if (regex && STARTS_WITH_RE.test(literal)) rec.prefixes.add(literal);
  else if (STEP_RE.test(value)) rec.lits.add(value);
  else if (PREFIX_RE.test(value)) rec.prefixes.add(value);
  else if (/^[a-z][a-z0-9_.:-]*\*$/.test(value)) rec.prefixes.add(value.slice(0, -1));
  else if (/^\*[._:-][a-z0-9_.:-]+$/.test(value)) rec.suffixes.add(value.slice(1));
}

/**
 * Every step `sources` emit, each one's readers outside its writer files, and the write-only steps
 * (emitted, read nowhere else). `sources` is `[{ path, text }]`; {@link REGISTRY_FILES} are skipped.
 */
export function scanLedgerSteps(sources) {
  const recs = sources.filter(({ path }) => !REGISTRY_FILES.has(path)).map(({ path, text }) => analyzeFile(path, text));
  const byPath = new Map(recs.map((rec) => [rec.path, rec]));
  const declarers = new Map();
  for (const rec of recs) {
    rec.importMap = new Map(rec.imports.map(({ local, name, from }) => [local, { name, path: resolveSpecifier(rec.path, from, byPath) }]));
    for (const name of rec.exported) declarers.set(name, [...(declarers.get(name) ?? []), rec]);
  }
  const resolveName = (rec, name, constsOnly, seen = new Set()) => {
    const key = `${rec.path}\0${name}`;
    if (seen.has(key)) return [];
    seen.add(key);
    if (rec.consts.has(name)) return [rec.consts.get(name)];
    const collection = rec.collections.get(name);
    if (collection) return constsOnly ? [] : collection.members.flatMap((m) => m.lit ?? resolveName(rec, m.id, false, seen));
    const imported = rec.importMap.get(name);
    if (imported) return imported.path ? resolveName(byPath.get(imported.path), imported.name, constsOnly, seen) : [];
    return CONSTANT_NAME_RE.test(name) ? (declarers.get(name) ?? []).flatMap((other) => resolveName(other, name, constsOnly, seen)) : [];
  };

  const writers = new Map();
  for (const rec of recs) {
    for (const emit of rec.emits) {
      const steps = emit.lit !== undefined ? [emit.lit] : resolveName(rec, emit.id, true);
      if (steps.length === 0) rec.ids.add(emit.id);
      for (const step of steps) writers.set(step, new Set([...(writers.get(step) ?? []), rec.path]));
    }
  }
  for (const rec of recs) {
    const named = [...rec.ids, ...[...rec.collections].filter(([, { readHere }]) => readHere).map(([name]) => name)];
    for (const name of named) for (const value of resolveName(rec, name, false)) readValue(value, rec);
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
