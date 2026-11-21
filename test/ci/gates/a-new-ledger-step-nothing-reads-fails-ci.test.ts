/**
 * W1-T14149 — a new ledger step that nothing reads fails CI unless it is a declared record.
 *
 * A decision row nothing reads is how a self-improvement loop silently stops: `routing.experiment.result`
 * was written daily and read only by its own writer. scripts/write-only-ledger-step-ratchet.mjs lists
 * every step src/ emits and every step src/ reads outside the step's writer file. A step with no such
 * reader is write-only; scripts/write-only-ledger-step-baseline.json records today's write-only set as
 * shrink-only debt beside a `recordOnly` map of step -> reason. Every fixture here is an in-memory
 * source tree or a throwaway git repository, never the live tree.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
// @ts-ignore the executable .mjs module has no declaration file.
import * as ratchet from "#scripts/write-only-ledger-step-ratchet.mjs";

type Baseline = { writeOnly: string[]; recordOnly: Record<string, string> };
type Scan = { emitted: Map<string, string[]>; readers: Map<string, string[]>; writeOnly: string[] };
type Verdict = {
  ok: boolean;
  unrecorded: string[];
  stale: string[];
  grown: string[];
  emptyReasons: string[];
  recordOnlyRead: string[];
};

const mod = ratchet as unknown as {
  GATE: string;
  BASELINE_PATH: string;
  scanLedgerSteps: (sources: Array<{ path: string; text: string }>) => Scan;
  ratchetVerdict: (input: { writeOnly: string[]; baseline: Baseline; baseBaseline: Baseline | null }) => Verdict;
  parseBaseline: (text: string, label: string) => Baseline;
  formatReport: (input: { scan: Scan; verdict: Verdict; baselinePath: string; base: string | null }) => string;
  main: (argv: string[], io?: { log?: (line: string) => void }) => number;
};

function scan(files: Record<string, string>): Scan {
  return mod.scanLedgerSteps(Object.entries(files).map(([path, text]) => ({ path, text })));
}

const EMPTY: Baseline = { writeOnly: [], recordOnly: {} };

/** A fixture's module clause, its specifier built from a variable so this file carries no relative import of its own. */
const clause = (head: string, spec: string): string => `${head} from ${JSON.stringify(spec)};`;

// ── criterion 1 ────────────────────────────────────────────────────────────────────────────────

const SELF_READ_WRITER = [
  'export function record(log: (step: string, fields: object) => void, rows: Array<{ step: string }>): void {',
  '  if (rows.some((row) => row.step === "fresh.step")) return; // its own writer reading it back',
  '  log("fresh.step", { ok: true });',
  "}",
].join("\n");

test("W1-T14149 criterion 1: a step newly written in src that no other file reads fails the check", () => {
  const result = scan({
    "src/lib/fresh.ts": SELF_READ_WRITER,
    "src/lib/other.ts": 'export const seen = (row: { step: string }) => row.step === "some.other_step";',
  });
  assert.deepEqual([...result.emitted.keys()], ["fresh.step"]);
  assert.deepEqual(result.emitted.get("fresh.step"), ["src/lib/fresh.ts"]);
  assert.deepEqual(result.writeOnly, ["fresh.step"], "a read inside the writer's own file is not a reader");

  const verdict = mod.ratchetVerdict({ writeOnly: result.writeOnly, baseline: EMPTY, baseBaseline: EMPTY });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.unrecorded, ["fresh.step"]);
  const report = mod.formatReport({ scan: result, verdict, baselinePath: mod.BASELINE_PATH, base: "abc123" });
  assert.match(report, /^write-only-ledger-step: BLOCKED/m);
  assert.match(report, /\n {2}fresh\.step\n/);
});

// ── criterion 2 ────────────────────────────────────────────────────────────────────────────────

const READ_FORMS_WRITER = [
  'export const EQ_CONST_STEP = "fixture.eq_const";',
  'export const SET_CONST_STEP = "fixture.set_const";',
  "export function write(log: (step: string, fields: object) => void): void {",
  '  log("fixture.eq", {});',
  "  log(EQ_CONST_STEP, {});",
  '  log("fixture.set", {});',
  "  log(SET_CONST_STEP, {});",
  '  log("fixture.array", {});',
  '  log("fixture.prefix.done", {});',
  '  log("fixture.unread", {});',
  "}",
].join("\n");

const READ_FORMS_READER = [
  clause("import { EQ_CONST_STEP, SET_CONST_STEP }", "./writer.js"),
  'const SEEN = new Set<string>(["fixture.set", SET_CONST_STEP]);',
  'export const FIXTURE_READ_STEPS = ["fixture.array"] as const;',
  "export function read(rows: Array<{ step: string }>): number {",
  "  return rows.filter((row) =>",
  '    row.step === "fixture.eq" || row.step === EQ_CONST_STEP || SEEN.has(row.step) || row.step.startsWith("fixture.prefix.")).length;',
  "}",
].join("\n");

test("W1-T14149 criterion 2: a step read in another file through an equality, a set, a read-steps array or a prefix passes", () => {
  const result = scan({ "src/lib/writer.ts": READ_FORMS_WRITER, "src/lib/reader.ts": READ_FORMS_READER });
  assert.deepEqual(
    [...result.emitted.keys()].sort(),
    ["fixture.array", "fixture.eq", "fixture.eq_const", "fixture.prefix.done", "fixture.set", "fixture.set_const", "fixture.unread"],
  );
  for (const step of ["fixture.eq", "fixture.eq_const", "fixture.set", "fixture.set_const", "fixture.array", "fixture.prefix.done"]) {
    assert.deepEqual(result.readers.get(step), ["src/lib/reader.ts"], `${step} has a reader outside its writer`);
  }
  assert.deepEqual(result.writeOnly, ["fixture.unread"], "the control step nobody reads is still write-only");
  const verdict = mod.ratchetVerdict({ writeOnly: result.writeOnly, baseline: { writeOnly: ["fixture.unread"], recordOnly: {} }, baseBaseline: { writeOnly: ["fixture.unread"], recordOnly: {} } });
  assert.equal(verdict.ok, true);
});

// ── criterion 3 ────────────────────────────────────────────────────────────────────────────────

test("W1-T14149 criterion 3: a step declared record-only with a reason passes, and one with an empty reason fails", () => {
  const { writeOnly } = scan({ "src/lib/fresh.ts": SELF_READ_WRITER });
  const declared = mod.ratchetVerdict({
    writeOnly,
    baseline: { writeOnly: [], recordOnly: { "fresh.step": "an audit row the operator greps by hand; no loop consumes it" } },
    baseBaseline: EMPTY,
  });
  assert.equal(declared.ok, true);
  assert.deepEqual(declared.unrecorded, []);

  for (const reason of ["", "   "]) {
    const empty = mod.ratchetVerdict({ writeOnly, baseline: { writeOnly: [], recordOnly: { "fresh.step": reason } }, baseBaseline: EMPTY });
    assert.equal(empty.ok, false, `reason ${JSON.stringify(reason)} must not declare a record`);
    assert.deepEqual(empty.emptyReasons, ["fresh.step"]);
  }
  assert.throws(() => mod.parseBaseline('{"writeOnly": [], "recordOnly": {"fresh.step": 7}}', "fixture"), /recordOnly.*fresh\.step.*string/);
});

// ── criterion 4 ────────────────────────────────────────────────────────────────────────────────

test("W1-T14149 criterion 4: a baseline entry that gained a reader must be removed, so the baseline only shrinks", () => {
  const files = {
    "src/lib/writer.ts": 'export const w = (log: (s: string) => void) => { log("old.debt"); log("still.debt"); };',
    "src/lib/reader.ts": 'export const r = (row: { step: string }) => row.step === "old.debt";',
  };
  const { writeOnly } = scan(files);
  assert.deepEqual(writeOnly, ["still.debt"]);

  const baseBaseline = { writeOnly: ["old.debt", "still.debt"], recordOnly: {} };
  const unremoved = mod.ratchetVerdict({ writeOnly, baseline: baseBaseline, baseBaseline });
  assert.equal(unremoved.ok, false);
  assert.deepEqual(unremoved.stale, ["old.debt"], "the entry that gained a reader must leave the baseline");

  const removed = mod.ratchetVerdict({ writeOnly, baseline: { writeOnly: ["still.debt"], recordOnly: {} }, baseBaseline });
  assert.equal(removed.ok, true);

  const grownFiles = { ...files, "src/lib/new.ts": 'export const n = (log: (s: string) => void) => log("new.unread");' };
  const grown = mod.ratchetVerdict({
    writeOnly: scan(grownFiles).writeOnly,
    baseline: { writeOnly: ["new.unread", "still.debt"], recordOnly: {} },
    baseBaseline: { writeOnly: ["still.debt"], recordOnly: {} },
  });
  assert.equal(grown.ok, false);
  assert.deepEqual(grown.grown, ["new.unread"], "a new write-only step cannot be laundered into the debt list");
  assert.deepEqual(grown.unrecorded, []);
});

// ── criterion 5 ────────────────────────────────────────────────────────────────────────────────

test("W1-T14149 criterion 5: a step emitted through a named constant is resolved and counted", () => {
  const result = scan({
    "src/lib/constants.ts": 'export const IMPORTED_STEP: string = "const.imported";\nexport const UNUSED = "const.never_logged";',
    "src/lib/writer.ts": [
      clause("import { IMPORTED_STEP }", "./constants.js"),
      'const LOCAL_STEP = "const.local" as const;',
      "export function write(log: (step: string) => void, append: (row: object) => void): void {",
      "  log(LOCAL_STEP);",
      '  append({ run_id: "r", task_id: "t", step: IMPORTED_STEP });',
      "}",
    ].join("\n"),
  });
  assert.deepEqual([...result.emitted.keys()].sort(), ["const.imported", "const.local"]);
  assert.deepEqual(result.emitted.get("const.imported"), ["src/lib/writer.ts"]);
  assert.deepEqual(result.writeOnly, ["const.imported", "const.local"], "a constant's own declaration is not a reader");
});

// ── precision of the emit and read positions ───────────────────────────────────────────────────

test("W1-T14149: console output, type annotations and reader queries are not emits", () => {
  const result = scan({
    "src/lib/noise.ts": [
      'console.log("not.a_step");',
      'log("A message with spaces, not a step");',
      'export function f(step: "typed.step" | "other.typed"): void {}',
      'interface Row { step: "iface.step"; }',
      "declare const read: (q: object) => void;",
      'read({ step: "query.only", refuseIncomplete: true });',
      'read({ "step": "quoted.key", run_id: "r", task_id: "t" });',
      'read({ ...ids, step: "spread.row" });',
      "const cond = true ? step : other;",
      'export const plan = { step: "rollback", id: "x" };',
    ].join("\n"),
  });
  assert.deepEqual([...result.emitted.keys()].sort(), ["quoted.key", "spread.row"]);
});

test("W1-T14149: a source cut off inside an open bracket is still scanned", () => {
  const result = scan({ "src/lib/cut.ts": 'export const w = (log: (s: string) => void) => log("cut.step");\nconst OPEN_STEPS = ["cut.step"' });
  assert.deepEqual(result.writeOnly, ["cut.step"]);
});

test("W1-T14149: the ledger-steps registry is neither a writer nor a reader", () => {
  const result = scan({
    "src/lib/writer.ts": 'export const w = (log: (s: string) => void) => log("registered.step");',
    "src/lib/ledger-steps.ts": 'export const LEDGER_STEPS = [{ step: "registered.step", meaning: "m", writer: ["w"] }];',
  });
  assert.deepEqual(result.emitted.get("registered.step"), ["src/lib/writer.ts"]);
  assert.deepEqual(result.writeOnly, ["registered.step"]);
});

test("W1-T14149: comments are not readers; raw patterns, switch cases, regexes and suffixes are", () => {
  const writer = [
    "export function w(log: (s: string) => void): void {",
    '  for (const s of ["x"]) void s;',
    '  log("commented.step"); log("raw.step"); log("case.step"); log("rx.exact"); log("rxp.prefixed");',
    '  log("job.scorecard"); log("wild.card"); log("tail.of_wild");',
    "}",
  ].join("\n");
  const reader = [
    '// "commented.step" is only mentioned here',
    '/* row.step === "commented.step" */',
    "const ratio = total / count / 2;",
    'export const raw = (line: string) => line.includes(\'"step":"raw.step"\');',
    "export function sw(row: { step: string }): number {",
    "  switch (row.step) {",
    '    case "case.step": return 1;',
    "    default: return /^rx\\.exact$/.test(row.step) || /^rxp\\./.test(row.step) ? 2 : 0;",
    "  }",
    "}",
    'export const t = (row: { step: string }) => `${row.step}-${`nested ${"x"}`}` && row.step.endsWith(".scorecard");',
    'const PATTERNS = ["wild.*", "*.of_wild"];',
    'export const wild = (step: string) => PATTERNS.some((p) => p === step);',
  ].join("\n");
  const result = scan({ "src/lib/writer.ts": writer, "src/lib/reader.ts": reader });
  assert.deepEqual(result.writeOnly, ["commented.step"]);
  for (const step of ["raw.step", "case.step", "rx.exact", "rxp.prefixed", "job.scorecard", "wild.card", "tail.of_wild"]) {
    assert.deepEqual(result.readers.get(step), ["src/lib/reader.ts"], step);
  }
});

test("W1-T14149: an identifier in an import or export clause is not a read, and collections resolve through spreads", () => {
  const result = scan({
    "src/lib/steps.ts": [
      'export const A_STEP = "coll.a";',
      'export const B_STEP = "coll.b";',
      "export const BASE_STEPS = [A_STEP];",
      "export const ALL_STEPS = Object.freeze([...BASE_STEPS, B_STEP]);",
    ].join("\n"),
    "src/lib/writer.ts": [
      clause("import { A_STEP, B_STEP as RENAMED }", "./steps.js"),
      clause("import * as ns", "./steps.js"),
      clause("import type { Thing }", "./types.js"),
      clause("export { A_STEP }", "./steps.js"),
      "export const w = (log: (s: string) => void) => { log(A_STEP); log(RENAMED); log(ns.UNKNOWN); };",
    ].join("\n"),
    "src/lib/reexport.ts": `${clause("export { A_STEP, B_STEP }", "./steps.js")}\n${clause("export *", "./steps.js")}`,
  });
  assert.deepEqual([...result.emitted.keys()].sort(), ["coll.a", "coll.b"]);
  assert.deepEqual(result.writeOnly, ["coll.a", "coll.b"], "a re-export and the constants' own declarations are not readers");

  const read = scan({
    "src/lib/steps.ts": 'export const A_STEP = "coll.a";\nexport const ALL_STEPS = new Set([...[A_STEP]]);',
    "src/lib/writer.ts": `${clause("import { A_STEP }", "./steps.js")}\nexport const w = (log: (s: string) => void) => log(A_STEP);`,
    "src/lib/reader.ts": `${clause("import { ALL_STEPS }", "./steps.js")}\nexport const r = (row: { step: string }) => ALL_STEPS.has(row.step);`,
  });
  assert.deepEqual(read.readers.get("coll.a"), ["src/lib/reader.ts"], "a collection is read where it is used, not where it is declared");
  assert.deepEqual(read.writeOnly, []);
});

test("W1-T14149: a constant resolves locally first, then through its import, then by name across the tree", () => {
  const result = scan({
    "src/lib/a.ts": 'export const SHARED_STEP = "shared.a";',
    "src/lib/b.ts": 'export const SHARED_STEP = "shared.b";',
    "src/lib/local.ts": 'const SHARED_STEP = "shared.local";\nexport const w = (log: (s: string) => void) => log(SHARED_STEP);',
    "src/lib/imported.ts": `${clause("import { SHARED_STEP }", "./a.js")}\nexport const w = (log: (s: string) => void) => log(SHARED_STEP);`,
    "src/lib/global.ts": "export const w = (log: (s: string) => void) => { log(SHARED_STEP); log(NOT_DECLARED_STEP); };",
    "src/lib/loop.ts": `${clause("import { LOOP }", "#src/lib/loop.js")}\nexport const w = (log: (s: string) => void) => log(LOOP);`,
  });
  assert.deepEqual(result.emitted.get("shared.local"), ["src/lib/local.ts"]);
  assert.deepEqual(result.emitted.get("shared.a"), ["src/lib/global.ts", "src/lib/imported.ts"]);
  assert.deepEqual(result.emitted.get("shared.b"), ["src/lib/global.ts"]);
  assert.equal(result.emitted.size, 3, "an unresolvable identifier and an import cycle emit nothing");
});

test("W1-T14149: a baseline that lists one step twice, or carries no lists, cannot be read", () => {
  assert.throws(() => mod.parseBaseline("{", "fixture"), /fixture is not valid JSON/);
  assert.throws(() => mod.parseBaseline("[]", "fixture"), /writeOnly/);
  assert.throws(() => mod.parseBaseline('{"writeOnly": [1], "recordOnly": {}}', "fixture"), /writeOnly/);
  assert.throws(() => mod.parseBaseline('{"writeOnly": ["a.b"], "recordOnly": []}', "fixture"), /recordOnly/);
  assert.throws(() => mod.parseBaseline('{"writeOnly": ["a.b", "a.b"], "recordOnly": {}}', "fixture"), /a\.b.*twice/);
  assert.throws(() => mod.parseBaseline('{"writeOnly": ["a.b"], "recordOnly": {"a.b": "why"}}', "fixture"), /a\.b.*twice/);
  assert.deepEqual(mod.parseBaseline('{"_comment": "c", "writeOnly": ["a.b"], "recordOnly": {"c.d": "why"}}', "fixture"), {
    writeOnly: ["a.b"],
    recordOnly: { "c.d": "why" },
  });
});

test("W1-T14149: a record-only step that gained a reader is reported, and a clean run says OK", () => {
  const result = scan({
    "src/lib/writer.ts": 'export const w = (log: (s: string) => void) => { log("rec.step"); log("debt.step"); };',
    "src/lib/reader.ts": 'export const r = (row: { step: string }) => row.step === "rec.step";',
  });
  const verdict = mod.ratchetVerdict({
    writeOnly: result.writeOnly,
    baseline: { writeOnly: ["debt.step"], recordOnly: { "rec.step": "kept for audits" } },
    baseBaseline: null,
  });
  assert.equal(verdict.ok, true, "a record that gained a reader is a recordable shrink, not a refusal");
  assert.deepEqual(verdict.recordOnlyRead, ["rec.step"]);
  const report = mod.formatReport({ scan: result, verdict, baselinePath: mod.BASELINE_PATH, base: null });
  assert.match(report, /^write-only-ledger-step: 2 step\(s\) emitted in src\/, 1 read outside their writer, 1 write-only/);
  assert.match(report, /no baseline at the merge base/);
  assert.match(report, /rec\.step/);
  assert.match(report, /^OK/m);
  assert.doesNotMatch(report, /BLOCKED/);

  const blocked = mod.formatReport({
    scan: result,
    verdict: { ok: false, unrecorded: [], stale: ["s.one"], grown: ["g.one"], emptyReasons: ["e.one"], recordOnlyRead: [] },
    baselinePath: mod.BASELINE_PATH,
    base: "f00",
  });
  for (const needle of [/BLOCKED/, /s\.one/, /g\.one/, /e\.one/, /merge base f00/]) assert.match(blocked, needle);
});

// ── the CLI over a real git repository ─────────────────────────────────────────────────────────

function put(repo: GitRepo, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  }
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "fixture");
}

function baselineText(writeOnly: string[], recordOnly: Record<string, string> = {}): string {
  return `${JSON.stringify({ _comment: "fixture", writeOnly, recordOnly }, null, 2)}\n`;
}

function run(argv: string[]): { code: number; out: string } {
  const lines: string[] = [];
  const code = mod.main(argv, { log: (line) => lines.push(line) });
  return { code, out: lines.join("\n") };
}

test("W1-T14149: the CLI measures the checkout against the merge base's baseline", (t) => {
  const repo = gitRepo({ scope: t, kind: "w1t14149" });
  put(repo, {
    "src/lib/writer.ts": 'export const w = (log: (s: string) => void) => { log("cli.debt"); log("cli.read"); };',
    "src/lib/reader.ts": 'export const r = (row: { step: string }) => row.step === "cli.read";',
    [mod.BASELINE_PATH]: baselineText(["cli.debt"]),
  });
  const clean = run(["--root", repo.dir, "--base", "main"]);
  assert.equal(clean.code, 0, clean.out);
  assert.match(clean.out, /OK/);

  repo.git("checkout", "--quiet", "-b", "feature");
  put(repo, { "src/lib/new.ts": 'export const n = (log: (s: string) => void) => log("cli.new");' });
  const unrecorded = run(["--root", repo.dir, "--base", "main"]);
  assert.equal(unrecorded.code, 1);
  assert.match(unrecorded.out, /write-only-ledger-step: BLOCKED/);
  assert.match(unrecorded.out, /cli\.new/);

  put(repo, { [mod.BASELINE_PATH]: baselineText(["cli.debt", "cli.new"]) });
  const grown = run(["--root", repo.dir, "--base", "main"]);
  assert.equal(grown.code, 1, "the debt list may not grow past the merge base's");
  assert.match(grown.out, /cli\.new/);

  put(repo, { [mod.BASELINE_PATH]: baselineText(["cli.debt"], { "cli.new": "an audit trail no loop reads" }) });
  assert.equal(run(["--root", repo.dir, "--base", "main"]).code, 0);
});

test("W1-T14149: the CLI refuses to report OK when it cannot measure", (t) => {
  const repo = gitRepo({ scope: t, kind: "w1t14149" });
  const empty = run(["--root", repo.dir, "--base", "main"]);
  assert.equal(empty.code, 2, "no emitted step is a census that saw no corpus");
  assert.match(empty.out, /REFUSING/);

  put(repo, { "src/lib/writer.ts": 'export const w = (log: (s: string) => void) => log("m.step");' });
  const missing = run(["--root", repo.dir, "--base", "main"]);
  assert.equal(missing.code, 2);
  assert.match(missing.out, /cannot read/);

  put(repo, { [mod.BASELINE_PATH]: baselineText(["m.step"]) });
  const noBase = run(["--root", repo.dir, "--base", "no-such-ref"]);
  assert.equal(noBase.code, 2);
  assert.match(noBase.out, /merge base/);

  const absent = run(["--root", repo.dir, "--base", "main", "--baseline", "scripts/elsewhere.json"]);
  assert.equal(absent.code, 2, "an explicit baseline path that is absent cannot be read");

  assert.equal(run(["--no-such-flag"]).code, 2);
});

test("W1-T14149: a baseline absent at the merge base is a first landing, with no shrink to check", (t) => {
  const repo = gitRepo({ scope: t, kind: "w1t14149" });
  repo.git("checkout", "--quiet", "-b", "feature");
  put(repo, {
    "src/lib/writer.ts": 'export const w = (log: (s: string) => void) => log("first.step");',
    [mod.BASELINE_PATH]: baselineText(["first.step"]),
  });
  const first = run(["--root", repo.dir, "--base", "main"]);
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /no baseline at the merge base/);
});
