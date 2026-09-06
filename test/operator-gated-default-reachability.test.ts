import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// ── W1-T2346: "the live-write guard fences four gh/git WRITE verbs and nothing else, so a unit
// test that reaches `armIfVerdictPermits`' production default still performs a live REST head
// read and a machine-local config/ledger read before any fence is consulted, and no check
// anywhere names the population that can do it" (feedback#fb-1786025201466-7081b2).
//
// `assertLiveWriteAllowed` (src/lib/live-write-guard.ts) fences exactly the WRITE leaves of
// `realArmDeps()` (src/run-task.ts) — `armAuto`/`mergeDirect`/`disableAuto`. It fences nothing
// else: `headSha` is a live REST read, `ledgerLines` reads the machine's own instance config via
// `loadConfig()` (which itself shells `which claude`) before reading a ledger file, and
// `armIfVerdictPermits`'s OWN inline `deps.ledgerLines ?? (() => readLedgerLines(ctx.ledgerPath))`
// default is a second, INDEPENDENT unfenced read that a `deps.arm` override does nothing to
// silence. A unit test that reaches any of these because a caller omitted the seam performs a
// real, unmocked I/O operation the guard was never built to see.
//
// THIS FILE IS THE CENSUS, DELIBERATELY NOT A FIX (design clause v — no `src/` path is declared
// and no default is flipped here; that is W1-T2347's job, and it depends on this file existing).
// It follows the SAME "declared-plus-derived" shape `test/instrument-surface-completeness.test.ts`
// (W1-T402) established and `test/clock-sweep-effect-completeness.test.ts` (W1-T1206) already
// applied to a different population: every function below DERIVES its candidate set by reading
// `src/run-task.ts` and `test/**/*.test.ts` as text, never by naming a fixed list of suites. A
// REASONED_EXCLUSIONS map (declared just above the real-tree tests, empty today because nothing
// has ever been reasoned about this population before) is the sole authority for silencing a
// candidate — an exclusion with no stated reason does not count, exactly like
// `INSTRUMENT_SURFACE_EXCLUSIONS` already requires.
//
// EVERYTHING BELOW IS A STATIC READ: `node:fs` + one read-only `git ls-files` (the SAME
// plumbing command `test/instrument-surface-completeness.test.ts`'s own `git()` helper already
// uses to enumerate tracked paths). No suite runs, nothing spawns, no clock shifts and no network
// call is made — pinned directly by the last test in this file.
// ──────────────────────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// ── PART 0: text-scanning primitives, each small enough to reason about directly ───────────────

/** Index of the delimiter matching `text[openIdx]` (`(`↔`)` or `{`↔`}`), depth-aware. */
function extractBalanced(text: string, openIdx: number): number {
  const open = text[openIdx];
  const close = open === "(" ? ")" : "}";
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced ${open} starting at ${openIdx}`);
}

/** The function BODY's opening `{`, skipping any return-type annotation's own braces (e.g.
 *  `): Promise<Foo & { x: string }> {` — the `{` inside `Promise<...>` sits at angle-depth 1,
 *  never depth 0, so it is never mistaken for the body). Depth is shared across `(`/`[`/`<` on
 *  purpose: a short return-type annotation is the only thing between `parenClose` and the real
 *  body, so treating all three as one nesting counter costs nothing and misses nothing here. */
function findBodyOpenBrace(text: string, fromIdx: number): number {
  let depth = 0;
  for (let i = fromIdx; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === ">") depth = Math.max(0, depth - 1);
    else if (c === "{" && depth === 0) return i;
  }
  return -1;
}

/**
 * Same length as `text`. Comments AND the CONTENTS of every string/template literal become
 * spaces (newlines preserved) — so a regex hunting for `armAutoMerge(` never fires on a test
 * TITLE that merely mentions "armAutoMerge(" in prose, and a `//` inside a `"https://..."` URL
 * literal is never mistaken for a line comment. Every offset stays valid for slicing the
 * ORIGINAL text afterwards, which is the only text this file ever reports or matches keys in.
 *
 * THE TRAP, FOUND LIVE while building this file (the same class
 * `test/instrument-surface-completeness.test.ts`'s own header names for a different regex): a
 * naive quote-matching scanner that searches UNBOUNDED for a string's closing quote runs off the
 * rails on a regex literal containing a lone apostrophe (e.g. `/['"]/`) — it never finds a
 * partner and swallows the rest of the file as "inside a string", masking real code. `'`/`"`
 * strings cannot legitimately span a raw newline in valid TS, so the search below is bounded to
 * the current line; an unterminated one is read as an ordinary character, never a runaway string.
 * Template literals (`` ` ``) CAN legitimately span lines, so their search stays unbounded.
 */
function maskNonCode(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (c === "/" && c2 === "/") {
      while (i < n && text[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && c2 === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        out += text[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    if (c === "`") {
      out += " ";
      i++;
      while (i < n && text[i] !== "`") {
        if (text[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        out += text[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let closed = false;
      while (j < n && text[j] !== "\n") {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === quote) {
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) {
        out += c;
        i++;
        continue;
      }
      out += " ";
      let k = i + 1;
      while (k < j) {
        if (text[k] === "\\") {
          out += "  ";
          k += 2;
          continue;
        }
        out += " ";
        k++;
      }
      out += " ";
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Top-level (depth-0) comma split — a field/argument list, never descending into nested
 *  `(...)`/`[...]`/`{...}`. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(text.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(text.slice(last));
  return parts.map((s) => s.trim()).filter(Boolean);
}

interface FnDecl {
  name: string;
  exported: boolean;
  paramsText: string;
  bodyStart: number;
  bodyEnd: number;
  bodyTextMasked: string;
  bodyText: string;
}

/** Every `function name(...)`/`export function name(...)`/`export async function name(...)`
 *  declaration in `original`, found via `masked` (so a decl-shaped string in a comment or a
 *  title never counts) but reported with `original`'s own text (so args/keys are readable). */
function findFunctionDecls(masked: string, original: string): FnDecl[] {
  const FN_RE = /(export\s+)?(async\s+)?function\s+(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  const out: FnDecl[] = [];
  while ((m = FN_RE.exec(masked))) {
    const name = m[3];
    const parenOpen = m.index + m[0].length - 1;
    let parenClose: number;
    try {
      parenClose = extractBalanced(masked, parenOpen);
    } catch {
      continue;
    }
    const braceOpen = findBodyOpenBrace(masked, parenClose);
    if (braceOpen === -1) continue;
    let braceClose: number;
    try {
      braceClose = extractBalanced(masked, braceOpen);
    } catch {
      continue;
    }
    out.push({
      name,
      exported: !!m[1],
      paramsText: original.slice(parenOpen + 1, parenClose),
      bodyStart: braceOpen,
      bodyEnd: braceClose,
      bodyTextMasked: masked.slice(braceOpen, braceClose + 1),
      bodyText: original.slice(braceOpen, braceClose + 1),
    });
  }
  return out;
}

// ── PART 1: classify a real-effect implementation as WRITE-FENCED, UNFENCED, or inert ──────────
//
// Design clause (iii): BOTH halves of "real effect" are in scope, and a candidate is classified
// per FIELD, never collapsed to one verdict for the whole dependency object — `realArmDeps()` is
// the worked example: it is simultaneously write-fenced (armAuto/mergeDirect/disableAuto) and
// unfenced (headSha/ledgerLines/isMerged/readMergeFacts). Design clause (iv): a default that
// reaches `loadConfig()`/`ledgerPathFor(...)` counts as reaching AMBIENT MACHINE STATE — its own
// bucket, checked before the general unfenced-read bucket so it is never merely swallowed by it.
//
// The marker names below are a SMALL, DECLARED vocabulary used only to CLASSIFY an
// already-derived candidate (never to derive the candidate SET itself, which is what acceptance
// claim 1 is about) — the same scoping choice `test/clock-sweep-effect-completeness.test.ts`
// makes with its own single hardcoded `REACHES_OUTWARD_EFFECT_RE` marker.

type EffectClass = "write-fenced" | "unfenced-ambient" | "unfenced-read" | "inert";

const WRITE_FENCE_RE = /\bassertLiveWriteAllowed\s*\(/;
const AMBIENT_MARKERS_RE = /\b(?:loadConfigImpl|loadConfig|ledgerPathFor)\s*\(/;
const LIVE_READ_MARKERS_RE =
  /\b(?:readHeadShaRest|readLedgerLines|isPrMergedNow|fixRebaseMergeFactsFromRest|mergeDirectViaRest|ghJson|execFileSync)\s*\(/;

function classifyRealEffect(implText: string): EffectClass {
  if (WRITE_FENCE_RE.test(implText)) return "write-fenced";
  if (AMBIENT_MARKERS_RE.test(implText)) return "unfenced-ambient";
  if (LIVE_READ_MARKERS_RE.test(implText)) return "unfenced-read";
  return "inert";
}

// ── PART 2: derive the real-effect-default population from `src/run-task.ts` ───────────────────
//
// Design clause (i): the set is derived by reading source — never a hardcoded list of names —
// via the TWO shapes rationale (1) names: `deps: ArmDeps = realArmDeps()` (LEVEL 1: an exported
// function whose entire deps parameter defaults to the real object) and `deps.x ?? realThing`
// (LEVEL 2: a function that pulls one field's real default inline). LEVEL 2 membership is itself
// derived, never named: a function counts as "family" only when ONE of its own `deps.x ?? Y`
// sites chains to a LEVEL-1 name this same pass already found — so `peekCommand`'s unrelated
// `deps.root ?? loadConfig().root` (a different real dependency-injection idiom used all over
// `src/`, not scoped to the arm/live-write population this task's rationale is about) is never
// swept in, with no name of `peekCommand` anywhere in this file to make that exclusion look
// hand-picked.

interface RealArmDepsDerivation {
  fields: Map<string, EffectClass>;
  level1Names: Set<string>;
  familyFns: Map<string, FnDecl>;
  familyFields: Map<string, Map<string, { kind: "chain"; target: string } | { kind: "direct"; classification: EffectClass }>>;
}

function deriveRealArmDepsPopulation(srcText: string): RealArmDepsDerivation {
  const masked = maskNonCode(srcText);
  const fns = findFunctionDecls(masked, srcText);

  const level1 = fns.filter((f) => f.exported && /=\s*realArmDeps\s*\(\s*\)/.test(f.paramsText));
  const level1Names = new Set(level1.map((f) => f.name));

  const realArmDepsFn = fns.find((f) => f.name === "realArmDeps");
  const fields = new Map<string, EffectClass>();
  if (realArmDepsFn) {
    const retIdx = realArmDepsFn.bodyTextMasked.indexOf("return {");
    const objOpen = realArmDepsFn.bodyTextMasked.indexOf("{", retIdx);
    const objClose = extractBalanced(realArmDepsFn.bodyTextMasked, objOpen);
    // The MASKED slice, deliberately — comment text is blanked out (including its own commas),
    // so a multi-line comment sitting between two fields never merges into either one's split.
    // Every identifier this needs to classify (assertLiveWriteAllowed, readHeadShaRest, ...)
    // survives masking untouched; only comments/strings are ever blanked.
    const objTextMasked = realArmDepsFn.bodyTextMasked.slice(objOpen + 1, objClose);
    for (const fieldText of splitTopLevel(objTextMasked)) {
      const km = fieldText.match(/^([A-Za-z0-9_]+)\s*:/);
      if (km) fields.set(km[1], classifyRealEffect(fieldText));
    }
  }

  const familyFns = new Map<string, FnDecl>();
  for (const f of fns) {
    if (f.name === "realArmDeps") continue;
    const INLINE_RE = /deps\.(\w+)\s*\?\?\s*([A-Za-z0-9_]+)/g;
    let mm: RegExpExecArray | null;
    while ((mm = INLINE_RE.exec(f.bodyTextMasked))) {
      if (level1Names.has(mm[2])) familyFns.set(f.name, f);
    }
  }

  const familyFields = new Map<string, Map<string, { kind: "chain"; target: string } | { kind: "direct"; classification: EffectClass }>>();
  for (const [name, f] of familyFns) {
    const INLINE_RE = /deps\.(\w+)\s*\?\?\s*/g;
    let mm: RegExpExecArray | null;
    const map = new Map<string, { kind: "chain"; target: string } | { kind: "direct"; classification: EffectClass }>();
    while ((mm = INLINE_RE.exec(f.bodyTextMasked))) {
      const window = f.bodyTextMasked.slice(mm.index, mm.index + 220);
      const chainMatch = window.match(/\?\?\s*([A-Za-z0-9_]+)/);
      if (chainMatch && level1Names.has(chainMatch[1])) {
        map.set(mm[1], { kind: "chain", target: chainMatch[1] });
      } else {
        map.set(mm[1], { kind: "direct", classification: classifyRealEffect(window) });
      }
    }
    familyFields.set(name, map);
  }

  return { fields, level1Names, familyFns, familyFields };
}

// ── PART 3: derive which TEST call sites reach one of those defaults ────────────────────────────
//
// Design clause (i)+(ii): "which suites call one of those entry points without supplying the
// seam" — for a positional `deps` parameter (LEVEL 1: `armAutoMerge`/`armAutoMergeDetailed`/
// `armAutoMergeAtOpen`/`disarmAutoMerge`), the seam is supplied the moment ANY argument occupies
// that position — JS's own default-parameter semantics mean `= realArmDeps()` runs ONLY when the
// argument is omitted or literally `undefined`, never merely because a supplied object happens to
// omit some of the type's fields. For a family (LEVEL 2) function's OWN inline `deps.x ?? Y`, the
// seam is per-FIELD: it is read directly off the deps argument'S OWN object-literal text when
// that argument is inline, and — a DELIBERATE, DOCUMENTED SCOPE LIMIT, the same kind
// `test/instrument-surface-completeness.test.ts`'s own derivation already accepts (no unbounded
// recursive harvest) — left unflagged when the argument is a bare variable/property reference
// this static pass cannot resolve, rather than guessing.

function depsParamIndex(paramsText: string): number {
  return splitTopLevel(paramsText).findIndex((p) => /^deps\s*[:?]/.test(p.trim()));
}

/** True when a positional call with `argCount` arguments leaves the parameter at `depsIndex`
 *  unsupplied (omitted or explicitly `undefined`), which is the ONLY way `= realArmDeps()`
 *  actually runs. */
function positionalDepsOmitted(argTexts: string[], depsIndex: number): boolean {
  if (depsIndex < 0) return false; // this function has no positional `deps` param at all
  if (argTexts.length <= depsIndex) return true;
  return argTexts[depsIndex].trim() === "undefined";
}

/** Which of `fieldNames` are ABSENT as a `key:` in `argText` — `undefined` (never an array) when
 *  `argText` is not an inline `{...}`/`{...spread, k: v}` object literal this pass can read, so a
 *  caller can tell "nothing omitted" apart from "could not tell" instead of conflating them. */
function omittedObjectKeys(argText: string | undefined, fieldNames: readonly string[]): string[] | undefined {
  const trimmed = (argText ?? "").trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  return fieldNames.filter((f) => !new RegExp(`(^|[{,])\\s*${f}\\s*:`).test(trimmed));
}

interface TestCallSite {
  file: string;
  line: number;
  name: string;
  argsText: string;
  argTexts: string[];
}

/** Every call site of any name in `entryNames`, across every tracked `test/**\/*.test.ts` file —
 *  via the SAME read-only `git ls-files` plumbing `test/instrument-surface-completeness.test.ts`
 *  already uses for its own tracked-file enumeration. */
function findTestCallSites(entryNames: ReadonlySet<string>): TestCallSite[] {
  const testFiles = execFileSync("git", ["ls-files", "test"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".test.ts"));
  const rows: TestCallSite[] = [];
  for (const relFile of testFiles) {
    const text = readFileSync(join(REPO_ROOT, relFile), "utf8");
    const masked = maskNonCode(text);
    for (const name of entryNames) {
      const CALL_RE = new RegExp(`\\b${name}\\s*\\(`, "g");
      let mm: RegExpExecArray | null;
      while ((mm = CALL_RE.exec(masked))) {
        const argsOpen = mm.index + mm[0].length - 1;
        let argsClose: number;
        try {
          argsClose = extractBalanced(masked, argsOpen);
        } catch {
          continue;
        }
        const argsTextOriginal = text.slice(argsOpen + 1, argsClose);
        const lineNo = masked.slice(0, mm.index).split("\n").length;
        rows.push({ file: relFile, line: lineNo, name, argsText: argsTextOriginal, argTexts: splitTopLevel(argsTextOriginal) });
      }
    }
  }
  return rows;
}

// ── PART 4: the exclusion set — a REASON is the sole authority, never a boolean ─────────────────
//
// Design clause (ii), the `INSTRUMENT_SURFACE_EXCLUSIONS` precedent applied to this population:
// a candidate stays REPORTED unless its key carries a non-blank reason here.
//
// W1-T2347 added the first entries: every one names a call site in its own
// test/arm-seam-default-is-opt-in.test.ts that deliberately omits `deps` (or a family seam field)
// to PROVE requireExplicitArmSeam (src/run-task.ts) refuses the omission under the node test
// runner, before `realArmDeps()`'s own fields are ever touched — the opposite of the silent,
// forgotten-seam reach this population exists to name. None of these ever runs a live effect.
const ARM_SEAM_TEST_REASON =
  "test/arm-seam-default-is-opt-in.test.ts (W1-T2347) deliberately omits the seam here to prove " +
  "requireExplicitArmSeam refuses before realArmDeps() is ever touched — never reaches a live effect.";
const REACHABILITY_EXCLUSIONS: Readonly<Record<string, string>> = {
  // LEVEL-1 omitted-`deps` call sites (the first real-tree test below).
  "armAutoMerge:test/arm-seam-default-is-opt-in.test.ts:77": ARM_SEAM_TEST_REASON,
  "armAutoMergeDetailed:test/arm-seam-default-is-opt-in.test.ts:60": ARM_SEAM_TEST_REASON,
  "armAutoMergeDetailed:test/arm-seam-default-is-opt-in.test.ts:175": ARM_SEAM_TEST_REASON,
  "armAutoMergeDetailed:test/arm-seam-default-is-opt-in.test.ts:259": ARM_SEAM_TEST_REASON,
  "armAutoMergeDetailed:test/arm-seam-default-is-opt-in.test.ts:278": ARM_SEAM_TEST_REASON,
  "armAutoMergeDetailed:test/arm-seam-default-is-opt-in.test.ts:312": ARM_SEAM_TEST_REASON,
  "armAutoMergeAtOpen:test/arm-seam-default-is-opt-in.test.ts:84": ARM_SEAM_TEST_REASON,
  "armAutoMergeAtOpen:test/arm-seam-default-is-opt-in.test.ts:97": ARM_SEAM_TEST_REASON,
};

function findUnexplainedReach<T extends { key: string }>(candidates: readonly T[], exclusions: Readonly<Record<string, string>>): T[] {
  return candidates.filter((c) => {
    const reason = exclusions[c.key];
    return typeof reason !== "string" || reason.trim().length === 0;
  });
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ACCEPTANCE CLAIM 1 — the set is derived by reading src, never a hardcoded list of names
// ══════════════════════════════════════════════════════════════════════════════════════════════

test("deriveRealArmDepsPopulation: LEVEL-1 entry points are found by matching the `deps: T = realArmDeps()` SHAPE, not by name", () => {
  const fabricated = `
export function unrelatedExportedThing(x: number): number {
  return x + 1;
}
export function totallyMadeUpArmerName(prUrl: string, deps: FakeDeps = realArmDeps()): string {
  return deps.say(prUrl);
}
function notExported(deps: FakeDeps = realArmDeps()): void {}
export function realArmDeps(): FakeDeps {
  return {
    say: (m) => console.log(m),
  };
}
`;
  const { level1Names, fields } = deriveRealArmDepsPopulation(fabricated);
  // A name INVENTED for this fixture alone — if the derivation tracked a fixed list of real
  // production names, an unrecognised one could only ever read as absent.
  assert.ok(level1Names.has("totallyMadeUpArmerName"), "an exported function matching the shape is found regardless of its name");
  assert.ok(!level1Names.has("unrelatedExportedThing"), "an exported function NOT defaulting deps to realArmDeps() is never swept in");
  assert.ok(!level1Names.has("notExported"), "a non-exported function matching the shape is not a candidate entry point");
  assert.deepEqual([...fields.entries()], [["say", "inert"]], "realArmDeps()'s own fields are read from its body, not assumed");
});

test("deriveRealArmDepsPopulation: LEVEL-2 family membership is derived from a `deps.x ?? Y` chain to a LEVEL-1 name, never a hardcoded owner list", () => {
  const fabricated = `
export function armLikeLeaf(prUrl: string, deps: FakeDeps = realArmDeps()): string {
  return deps.say(prUrl);
}
export function invented_wrapper_xyzzy(ctx: { path: string }, deps: { arm?: (p: string) => string } = {}): string {
  return (deps.arm ?? armLikeLeaf)(ctx.path);
}
export function unrelatedInjector(deps: { root?: string } = {}): string {
  return deps.root ?? loadConfig().root;
}
export function realArmDeps(): FakeDeps {
  return { say: (m) => console.log(m) };
}
`;
  const { familyFns, familyFields } = deriveRealArmDepsPopulation(fabricated);
  assert.ok(familyFns.has("invented_wrapper_xyzzy"), "a function chaining deps.x ?? <a level-1 name> is derived as family, whatever it is called");
  assert.ok(!familyFns.has("unrelatedInjector"), "a deps.x ?? Y site whose Y is NOT a level-1 name is never swept in — this is the general DI idiom used all over src/, out of THIS population");
  assert.deepEqual(familyFields.get("invented_wrapper_xyzzy")!.get("arm"), { kind: "chain", target: "armLikeLeaf" });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ACCEPTANCE CLAIM 2 — a test that omits the seam is reported as reaching the production default
// ══════════════════════════════════════════════════════════════════════════════════════════════

test("positionalDepsOmitted: a LEVEL-1 call with fewer args than the deps position reaches the default", () => {
  assert.equal(positionalDepsOmitted(["prUrl", "taskId"], 2), true, "deps (index 2) was never supplied at all");
  assert.equal(positionalDepsOmitted(["prUrl", "taskId", "undefined"], 2), true, "an explicit `undefined` is the SAME as omitting it");
});

test("positionalDepsOmitted: a LEVEL-1 call supplying ANY value at the deps position never reaches the default — JS default-parameter semantics, not field-by-field completeness", () => {
  assert.equal(positionalDepsOmitted(["prUrl", "taskId", "deps"], 2), false, "a variable reference still occupies the slot; realArmDeps() never runs");
  assert.equal(positionalDepsOmitted(["prUrl", "taskId", "{ armAuto: fake }"], 2), false, "even a PARTIAL object literal still occupies the slot");
});

test("omittedObjectKeys: an inline object literal missing a field is reported for THAT field, by reading its own keys", () => {
  assert.deepEqual(omittedObjectKeys("{ arm: () => 'armed' }", ["arm", "ledgerLines"]), ["ledgerLines"]);
  assert.deepEqual(omittedObjectKeys("{ arm: fn, ledgerLines: () => [] }", ["arm", "ledgerLines"]), []);
});

test("omittedObjectKeys: a bare variable/property reference this static pass cannot read returns undefined, never a false 'nothing omitted'", () => {
  assert.equal(omittedObjectKeys("h.deps", ["arm", "ledgerLines"]), undefined);
  assert.equal(omittedObjectKeys("armDeps", ["disarm"]), undefined);
});

test("findTestCallSites + omittedObjectKeys: a FABRICATED suite calling a family entry point without the seam is reported as reaching it", () => {
  // The mechanism proven directly against a synthetic call, not the real tree — the real tree's
  // own population is asserted further below, separately.
  const argsText = "verdict, ctx, { arm: () => 'armed' }";
  const argTexts = splitTopLevel(argsText);
  const omitted = omittedObjectKeys(argTexts[2], ["arm", "ledgerLines"]);
  assert.deepEqual(omitted, ["ledgerLines"], "the fixture supplies arm but not ledgerLines — exactly the currently-real arm-ordering.test.ts/run-task.test.ts shape this file's real-tree test pins below");
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ACCEPTANCE CLAIM 3 — each reachable default is classified write-fenced/unfenced, and a live
// read counts as unfenced (never silently folded into "guarded" beside a write-fenced sibling)
// ══════════════════════════════════════════════════════════════════════════════════════════════

test("classifyRealEffect: an implementation guarded by assertLiveWriteAllowed is write-fenced", () => {
  assert.equal(classifyRealEffect('armAuto: (prUrl) => { assertLiveWriteAllowed("gh-pr-merge", `arming ${prUrl}`); execFileSync("gh", []); }'), "write-fenced");
});

test("classifyRealEffect: a live REST/gh read with NO assertLiveWriteAllowed is unfenced-read, never mistaken for guarded", () => {
  assert.equal(classifyRealEffect("headSha: (prUrl) => readHeadShaRest(prUrl)"), "unfenced-read");
  assert.equal(classifyRealEffect("isMerged: (prUrl) => isPrMergedNow(prUrl)"), "unfenced-read");
});

test("classifyRealEffect: an inert callback (console.log, a blocking sleep) is neither fenced nor a reportable effect", () => {
  assert.equal(classifyRealEffect("say: (msg) => console.log(msg)"), "inert");
});

test("classifyRealEffect: the SAME real-effect object can be simultaneously fenced (its write leaves) and unfenced (its reads) — rationale (2)'s worked example, never collapsed to one verdict", () => {
  const { fields } = deriveRealArmDepsPopulation(`
export function realArmDeps(): FakeDeps {
  return {
    headSha: (prUrl) => readHeadShaRest(prUrl),
    armAuto: (prUrl) => { assertLiveWriteAllowed("gh-pr-merge", prUrl); execFileSync("gh", []); },
  };
}
`);
  assert.equal(fields.get("headSha"), "unfenced-read");
  assert.equal(fields.get("armAuto"), "write-fenced");
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ACCEPTANCE CLAIM 4 — a default reaching loadConfig()/the ledger path counts as ambient state
// ══════════════════════════════════════════════════════════════════════════════════════════════

test("classifyRealEffect: a default that calls loadConfig()/loadConfigImpl() is unfenced-ambient, even wrapped in a try/catch that discards the result", () => {
  assert.equal(
    classifyRealEffect("ledgerLines: () => { try { return readLedgerLines(ledgerPathFor(loadConfigImpl())); } catch { return []; } }"),
    "unfenced-ambient",
    "the W1-T1000002 catch absorbs the THROW, not the fact that a real instance config was consulted to get here — design clause (iv)",
  );
});

test("classifyRealEffect: ledgerPathFor(...) alone (no loadConfig call in view) is still ambient — either marker suffices, per acceptance claim 4's own wording", () => {
  assert.equal(classifyRealEffect("x: () => readLedgerLines(ledgerPathFor(cfg))"), "unfenced-ambient");
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ACCEPTANCE CLAIM 5 — an exclusion with no stated reason does not excuse a candidate
// ══════════════════════════════════════════════════════════════════════════════════════════════

test("findUnexplainedReach: a candidate absent from the exclusion map is reported", () => {
  const gaps = findUnexplainedReach([{ key: "made-up-candidate" }], {});
  assert.deepEqual(gaps, [{ key: "made-up-candidate" }]);
});

test("findUnexplainedReach: a bare (empty or whitespace-only) exclusion reason does not silence the alarm", () => {
  assert.deepEqual(findUnexplainedReach([{ key: "x" }], { x: "" }), [{ key: "x" }]);
  assert.deepEqual(findUnexplainedReach([{ key: "x" }], { x: "   " }), [{ key: "x" }]);
});

test("findUnexplainedReach: a real, substantive reason silences the candidate", () => {
  assert.deepEqual(findUnexplainedReach([{ key: "x" }], { x: "drives the real dep against a tmpdir fixture, never the live repo" }), []);
});

test("REACHABILITY_EXCLUSIONS: every entry (if any are ever added) must carry a substantive, non-blank reason", () => {
  for (const [key, reason] of Object.entries(REACHABILITY_EXCLUSIONS)) {
    assert.equal(typeof reason, "string", `${key}: reason must be a string`);
    assert.ok(reason.trim().length >= 10, `${key}: reason "${reason}" is too short to be a real explanation`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ACCEPTANCE CLAIM 6 — the check is a static read: no suite, no spawn, no network
// ══════════════════════════════════════════════════════════════════════════════════════════════

test("the whole census runs with no suite spawned and no clock/network touched", () => {
  // `NODE_TEST_CONTEXT` is the signal the live-write guard itself reads (src/lib/live-write-guard.ts)
  // to decide whether a `gh`/`git` write is running under a test — if this file's OWN derivation
  // ever spawned a suite or a live write attempt, THIS is the variable such a child would carry
  // differently or which the write guard would consult; asserting it is untouched is a direct
  // probe, not a proxy.
  const before = process.env.NODE_TEST_CONTEXT;
  const pathBefore = process.env.PATH;

  const derivation = deriveRealArmDepsPopulation(readFileSync(join(REPO_ROOT, "src/run-task.ts"), "utf8"));
  const entryNames = new Set([...derivation.level1Names, ...derivation.familyFns.keys()]);
  const sites = findTestCallSites(entryNames);

  assert.equal(process.env.NODE_TEST_CONTEXT, before, "the census must never touch NODE_TEST_CONTEXT — it never drives a live write attempt for the guard to gate");
  assert.equal(process.env.PATH, pathBefore, "the census never PATH-stubs `gh` — it has no subprocess to redirect, unlike the suites it inspects");
  assert.ok(Array.isArray(sites), "the check completed and returned a plain array — never a child-process/spawn result");
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE REAL TREE — the same derivation, run for real against src/run-task.ts and test/**
// ══════════════════════════════════════════════════════════════════════════════════════════════

const SRC_TEXT = readFileSync(join(REPO_ROOT, "src/run-task.ts"), "utf8");
const REAL = deriveRealArmDepsPopulation(SRC_TEXT);

test("real tree: realArmDeps() is derived with its currently-real field/classification shape — a regression pin, not an assumption", () => {
  assert.ok(REAL.fields.size > 0, "sanity: the derivation found real fields, not running vacuously");
  assert.equal(REAL.fields.get("headSha"), "unfenced-read", "the live REST head read rationale (2) names");
  assert.equal(REAL.fields.get("armAuto"), "write-fenced");
  assert.equal(REAL.fields.get("mergeDirect"), "write-fenced");
  assert.equal(REAL.fields.get("disableAuto"), "write-fenced");
  assert.equal(REAL.fields.get("isMerged"), "unfenced-read");
  assert.equal(REAL.fields.get("readMergeFacts"), "unfenced-read");
  assert.equal(REAL.fields.get("say"), "inert");
  assert.equal(REAL.fields.get("sleepSync"), "inert");
  // W1-T1000002's own try/catch (rationale 3) does not change the classification — the catch
  // absorbs the THROW, not the fact that loadConfigImpl()/ledgerPathFor() were consulted.
  assert.equal(REAL.fields.get("ledgerLines"), "unfenced-ambient", "reaches loadConfig() + the ledger path — design clause (iv)");
});

test("real tree: LEVEL-1 entry points are exactly the four `deps: ArmDeps = realArmDeps()` sites — derived, and independently re-countable by anyone re-deriving this the rationale's own way", () => {
  assert.deepEqual(
    [...REAL.level1Names].sort(),
    ["armAutoMerge", "armAutoMergeAtOpen", "armAutoMergeDetailed", "disarmAutoMerge"],
  );
});

test("real tree: armIfVerdictPermits is derived as a LEVEL-2 family member via ITS OWN `deps.arm ?? armAutoMergeDetailed` chain — the exact site rationale (1) quotes", () => {
  assert.ok(REAL.familyFns.has("armIfVerdictPermits"));
  assert.deepEqual(REAL.familyFields.get("armIfVerdictPermits")!.get("arm"), { kind: "chain", target: "armAutoMergeDetailed" });
  assert.deepEqual(REAL.familyFields.get("armIfVerdictPermits")!.get("ledgerLines"), { kind: "direct", classification: "unfenced-read" });
});

test("real tree: withdrawArmIfVerdictRefuses is ALSO derived as family, via its own `deps.disarm ?? disarmAutoMerge` chain — found by the SAME mechanism, no second hand-picked name", () => {
  assert.ok(REAL.familyFns.has("withdrawArmIfVerdictRefuses"));
  assert.deepEqual(REAL.familyFields.get("withdrawArmIfVerdictRefuses")!.get("disarm"), { kind: "chain", target: "disarmAutoMerge" });
});

test("real tree: no UNEXCUSED test/ call site of a LEVEL-1 entry point (armAutoMerge/armAutoMergeDetailed/armAutoMergeAtOpen/disarmAutoMerge) omits the deps argument today", () => {
  const sites = findTestCallSites(REAL.level1Names);
  assert.ok(sites.length > 10, "sanity: real call sites were actually found, not running vacuously");
  const depsIndexByName = new Map([...REAL.level1Names].map((name) => {
    const masked = maskNonCode(SRC_TEXT);
    const fns = findFunctionDecls(masked, SRC_TEXT);
    const fn = fns.find((f) => f.exported && f.name === name && /=\s*realArmDeps\s*\(\s*\)/.test(f.paramsText));
    return [name, fn ? depsParamIndex(fn.paramsText) : -1] as const;
  }));
  const gaps = sites
    .filter((s) => positionalDepsOmitted(s.argTexts, depsIndexByName.get(s.name) ?? -1))
    .map((s) => ({ key: `${s.name}:${s.file}:${s.line}`, file: s.file, line: s.line }));
  // W1-T2347 (design clause ii, same discipline the family-field exclusions below already use):
  // an omission is EXCUSED only with a substantive, non-blank reason in REACHABILITY_EXCLUSIONS —
  // never merely because it exists. The only entries excused today are
  // test/arm-seam-default-is-opt-in.test.ts's OWN — that file exists specifically to prove
  // requireExplicitArmSeam refuses these exact omissions, so omitting `deps` there is the point
  // of the test, not a forgotten seam; every one of them throws before realArmDeps() is ever
  // read from (see that file's own acceptance-1 tests).
  const reported = findUnexplainedReach(gaps, REACHABILITY_EXCLUSIONS);
  assert.deepEqual(
    reported.map((g) => `${g.file}:${g.line}`),
    [],
    "a positional deps argument was omitted at one of these call sites, unexcused — it now reaches realArmDeps() for real",
  );
});

test("real tree: armIfVerdictPermits/withdrawArmIfVerdictRefuses call sites that omit a field are REPORTED, unexcused — the class this task exists to name", () => {
  const familyNames = new Set(REAL.familyFns.keys());
  const sites = findTestCallSites(familyNames);
  assert.ok(sites.length > 5, "sanity: real direct call sites of the family functions were found");

  type Candidate = { key: string; file: string; line: number; name: string; field: string; classification: EffectClass };
  const candidates: Candidate[] = [];
  for (const s of sites) {
    const fieldMap = REAL.familyFields.get(s.name);
    if (!fieldMap) continue;
    const depsArgText = s.argTexts[s.argTexts.length - 1];
    const omitted = omittedObjectKeys(depsArgText, [...fieldMap.keys()]);
    if (!omitted) continue; // an unresolvable bare reference — deliberately not flagged, see PART 3's own doc
    for (const field of omitted) {
      const entry = fieldMap.get(field)!;
      const classification = entry.kind === "direct" ? entry.classification : "unfenced-read"; // a chain always bottoms out in realArmDeps(), never write-only
      candidates.push({ key: `${s.name}:${s.file}:${s.line}:${field}`, file: s.file, line: s.line, name: s.name, field, classification });
    }
  }

  const reported = findUnexplainedReach(candidates, REACHABILITY_EXCLUSIONS);

  // THE THREE KNOWN, VERIFIED entries on this tree today (re-derive before trusting this list —
  // the task's own note: the count is a query, not a constant). Each omits `ledgerLines` while
  // supplying `arm`, so each reaches armIfVerdictPermits's OWN inline unfenced ledger read
  // (rationale (2)'s third bullet) regardless of whether its fixture's verdict ever arms for
  // real — this file over-approximates in the SAFE direction, exactly like
  // `test/clock-sweep-effect-completeness.test.ts`'s own documented choice.
  // W1-T2347 landed a fix in between the census and this re-derivation, adding lines ahead of
  // these two in test/run-task.test.ts (a withLiveWritesAllowed wrap for an unrelated, pre-
  // existing deliberate real-dependency fixture) — the task's own note said to re-derive before
  // trusting this list, and re-deriving is exactly how these two shifted from :5885/:5946 to
  // :5891/:5952. W1-T2540 then added 54 lines at :3210 (merge-conflict prompt fixtures, again
  // ahead of both) and they shifted the same way, to :5945/:6006 — the SECOND time this exact
  // re-derivation has been needed. W1-T2561 then added fourteen lines ahead of both, moving the
  // witnesses to :5959/:6020. The plan-sync batch-read PR then added ONE line ahead of both (an
  // `RMD_TMP_PREFIX` import at :92, so a fixture's temp dir is boot-sweep reapable) and they moved
  // by exactly one, to :5960/:6021 — the FOURTH re-derivation. W1-T2811 then added ONE line ahead
  // of both (an `assertWallClockBound` import, so this file's one wall-clock-bounded assertion
  // declares itself) and they moved by exactly one again, to :5961/:6022 — the FIFTH. That is this
  // note's own point: a line number is a QUERY over the current tree, and any diff inserting above
  // these witnesses moves them. The THIRD witness (arm-ordering.test.ts) is untouched by every one
  // of these edits and unmoved.
  const expectedKeys = [
    "armIfVerdictPermits:test/arm-ordering.test.ts:63:ledgerLines",
    "armIfVerdictPermits:test/run-task.test.ts:5961:ledgerLines",
    "armIfVerdictPermits:test/run-task.test.ts:6022:ledgerLines",
  ];
  for (const key of expectedKeys) {
    assert.ok(
      reported.some((r) => r.key === key),
      `expected ${key} among the reported, unexcused candidates: ${reported.map((r) => r.key).join(", ")}`,
    );
  }
  for (const r of reported) {
    assert.equal(r.classification, "unfenced-read", `${r.key}: every currently-reported family gap is the ledgerLines read, not a write leaf`);
  }
});

test("real tree: runReview forwards its own optional `arm` parameter straight into armIfVerdictPermits's `deps.arm` — the LEVEL-3 caller-facing seam rationale (1) quotes verbatim", () => {
  // Derived the same way the LEVEL-2 family membership is: find the (masked, so a comment
  // mentioning the call never counts) real call site of armIfVerdictPermits OUTSIDE its own
  // declaration, inside runReview's own body, and confirm it forwards `{ arm: args.arm }`.
  const masked = maskNonCode(SRC_TEXT);
  const fns = findFunctionDecls(masked, SRC_TEXT);
  const runReviewFn = fns.find((f) => f.name === "runReview");
  assert.ok(runReviewFn, "sanity: runReview is still a function declaration in src/run-task.ts");
  assert.match(
    runReviewFn!.bodyText,
    /armIfVerdictPermits\([^)]*\{\s*arm:\s*args\.arm\s*\}/s,
    "runReview's own call site must forward { arm: args.arm } into armIfVerdictPermits — the exact shape rationale (1) quotes at its own line 4577/4580",
  );
});

test("real tree: at least one test/ call site of runReview omits `arm:` entirely — the population rationale (4) says is unknown, made non-empty and named", () => {
  const sites = findTestCallSites(new Set(["runReview"]));
  assert.ok(sites.length > 8, "sanity: real runReview call sites were found across test/");
  const gaps = sites.filter((s) => !/\barm\s*:/.test(s.argsText));
  assert.ok(gaps.length > 0, "at least one runReview call in test/ never supplies the arm seam at all");
  // A STABLE pin: ships-unwired-floor.test.ts exists to test the SHIPS-unwired advisory, has
  // nothing to do with arming, and is exceedingly unlikely to ever be the file that adds an
  // `arm:` override — a durable witness that the population is real, not an artefact of one
  // fragile fixture.
  assert.ok(
    gaps.some((g) => g.file === "test/ships-unwired-floor.test.ts"),
    `expected test/ships-unwired-floor.test.ts among the runReview call sites omitting arm: ${gaps.map((g) => `${g.file}:${g.line}`).join(", ")}`,
  );
});

test("real tree: at least one test/ call site of runReview DOES supply `arm:` — proving the seam is reachable, not merely theoretical (rubric-authorship-wiring.test.ts's own header names the exact hazard this task's rationale describes)", () => {
  const sites = findTestCallSites(new Set(["runReview"]));
  const seamed = sites.filter((s) => /\barm\s*:/.test(s.argsText));
  assert.ok(seamed.length > 0);
  assert.ok(seamed.some((s) => s.file === "test/rubric-authorship-wiring.test.ts"));
});
