/**
 * test/plan-contract-no-worktree-install.test.ts — W1-T2314 (the third shard of a filing whose
 * first two are W1-T2312/W1-T2313; see plan/tasks.d/W1-T2314-*.yaml for the design this test
 * implements verbatim).
 *
 * THE INCIDENT THIS LOCKS: `plan/tasks.yaml`'s binding-rules header and W1-T65's `design:` body
 * both once told a worker "fresh worktrees have NO node_modules: npm ci in the worktree before
 * typecheck/test" — false since `linkWorktreeNodeModules` (src/lib/worker.ts) started symlinking
 * every worktree's node_modules to the canonical tree. A worker obeying that sentence installed
 * THROUGH the link and emptied the SHARED tree under every other live run (the 2026-07-29,
 * 2026-08-05 and 2026-08-11 outages). W1-T2313 hand-corrected the one live copy; this suite is
 * the gate that stops a FOURTH hand-correction from ever being needed — it fails on ANY record,
 * present or future, that carries the instruction in a field a worker's effective prompt renders.
 *
 * RENDERED FIELD SET (confirmed against the prompt builder in src/run-task.ts, not guessed):
 *   - `title`/`prompt`: `implementPromptParts` (run-task.ts) renders `task.prompt ?? task.title`
 *     verbatim as the `# TASK` body (measured: no live record carries `prompt:`, so effectively
 *     `title`).
 *   - `acceptance[].claim`/`.proof`: rendered verbatim by `taskRecordContextLine` (run-task.ts),
 *     unconditionally on the degraded-recon path and criteria-first on the artifact-reuse path.
 *     Checked WITHOUT filtering `holdout: true` out — `taskRecordContextLine` on the
 *     degraded-recon call site passes the raw `task.acceptance` array, not `visibleCriteria()`'s
 *     output, so a holdout criterion's text is NOT guaranteed hidden from a worker in practice.
 *   - `rationale`, `note`: not composed into any worker prompt STRING by src/ code (grep confirms
 *     zero call sites), but `design` is not a parsed `Task` field EITHER (parseTasksFromYaml,
 *     src/lib/plan.ts, drops it on load) and yet W1-T65's `design:` body is exactly how this
 *     sentence reached a worker historically. The mechanism is `taskRecordContextLine`'s own
 *     fixed pointer line, injected into EVERY worker's CONTEXT block regardless of recon outcome:
 *     "YOUR TASK'S OWN RECORD IS AT <path> — READ IT FIRST. It carries the design, rationale and
 *     acceptance criteria that recon would otherwise have relayed, and nothing else in this
 *     prompt contains them." A worker that complies (the whole reason the pointer exists) reads
 *     the record's FULL text off disk — every field, `note` included. So the effective rendered
 *     set this test checks is the record's whole narrative surface: `title`, `rationale`,
 *     `design`, `note`, and every `acceptance[]` claim/proof (visible or holdout).
 *
 * `design:` IS NOT ON THE PARSED `Task` TYPE, so this suite reads the plan RAW (the same "yaml"
 * package `loadPlan` itself uses, over the same two file locations — `plan/tasks.yaml` plus
 * sorted `plan/tasks.d/*.yaml|*.yml` — in the same order) rather than through `loadPlan`'s
 * `Task` objects alone. A self-check below cross-validates this raw loader's id set against
 * `loadPlan`'s, so a future change to the production merge/discovery logic cannot silently drift
 * out from under this test.
 *
 * A YAML `#` COMMENT IS NOT A RENDERED FIELD (design note (ii)) and is out of scope on purpose —
 * `plan/tasks.yaml`'s own binding-rules header carries the retired sentence as commentary
 * governed by review, and the "yaml" parser never surfaces comment text as a field value, so it
 * is structurally excluded here without any special-casing.
 *
 * THE PREDICATE (design note (iii)): a bare lexicon hit on `npm ci`/`npm i`/`npm install` (the
 * literal re-derivation grep W1-T2313 used) fails instantly against records that legitimately
 * DISCUSS it — W1-T151's own boot/build install path, the CI-runner-timing mentions in
 * W1-T1033/W1-T1060/W1-T452/W1-T499/W1-T1009/W1-T1041, the W1-T1B retirement gravestone, and
 * W1-T2312/W1-T2313/THIS TASK'S OWN body, all three of which quote the forbidden sentence in
 * order to forbid it. So the shape checked is narrower than mere co-occurrence anywhere in a
 * sentence: an installing verb IMMEDIATELY adjacent (only whitespace, or a one-word connector
 * on the reverse order) to an "in/inside/within (the/that/this/its/your) worktree(s)" locative —
 * the exact bigram the historical sentence used ("npm ci in the worktree") — checked in BOTH
 * word orders. That adjacency requirement alone is what keeps W1-T452 ("a real `npm ci` costs
 * 60-90s ... " with "worktree" a full clause away) and W1-T499 ("in a fresh worktree and shell
 * out to `npm ci`", a verb phrase apart) green without needing quote or negation cover at all —
 * MEASURED against the live corpus below, not assumed.
 *
 * On top of that adjacency shape, a hit is EXEMPT when it is quoted or code-formatted (a
 * citation, not a live instruction) or when a negation cue governs its clause (a prohibition,
 * not a command) — the same two content-shape signals `headlessFitnessViolations`
 * (src/lib/task-linter.ts) already uses (`isQuoted`, `isNegationScoped`), reproduced here as
 * fresh, test-local code per this task's `files:` scope (one new test file, nothing in `src/`
 * touched) rather than imported, since those helpers are module-private there. The quote span
 * additionally recognizes BACKTICK code-spans, not just `'`/`"` — required by the W1-T20c
 * self-reference this task's own record embodies: design (iv)'s synthetic-positive sentence is
 * reproduced verbatim in THIS record's `design:` body (see plan/tasks.d/W1-T2314-*.yaml, the
 * line right below "so this record does not trip its own lock"), wrapped in backticks rather
 * than quotes — a predicate that only recognizes `'`/`"` would flag the very record that carries
 * this lock.
 *
 * A quote/code span is checked over the field's text with embedded newlines FOLDED to spaces
 * first (design note (iii)'s warned seam: a `design: |` literal block scalar preserves the
 * author's line-wrapping as real `\n` characters, so a quoted phrase wrapped across two physical
 * lines must not read as an unterminated quote) — asserted directly below, not just assumed.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import { loadPlan } from "../src/lib/plan.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLAN_PATH = join(REPO_ROOT, "plan", "tasks.yaml");

// ── RAW RECORD LOADING ───────────────────────────────────────────────────────────────────────
//
// Mirrors `loadPlan`'s own file discovery (src/lib/plan.ts: `plan/tasks.yaml` PLUS every
// `plan/tasks.d/*.yaml`/`*.yml`, sorted) so this test sees the plan the way production merges
// it — but parses each file with the SAME "yaml" package directly, rather than through
// `parseTasksFromYaml`, because that function narrows each entry to the `Task` interface and
// `design` is not one of its fields (dropped silently on load). A raw parse retains every key
// the YAML actually carries, `design` included.

interface RawRecord {
  id?: unknown;
  title?: unknown;
  rationale?: unknown;
  design?: unknown;
  note?: unknown;
  acceptance?: unknown;
}

function listShardFiles(shardDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(shardDir);
  } catch {
    return [];
  }
  return entries.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort();
}

function rawRecordsFromFile(path: string): RawRecord[] {
  const parsed: unknown = parseYaml(readFileSync(path, "utf8"));
  return Array.isArray(parsed) ? (parsed as RawRecord[]) : [];
}

function loadRawRecords(planPath: string): RawRecord[] {
  const records = [...rawRecordsFromFile(planPath)];
  const shardDir = join(dirname(planPath), "tasks.d");
  for (const file of listShardFiles(shardDir)) {
    records.push(...rawRecordsFromFile(join(shardDir, file)));
  }
  return records;
}

// ── THE PREDICATE ────────────────────────────────────────────────────────────────────────────

/** Fold embedded newlines (a `design: |`/`rationale: |` literal block's preserved line-wraps)
 *  into single spaces so a quoted phrase or a co-occurrence pair that spans a wrapped line reads
 *  as continuous prose rather than two lines glued by a raw `\n`. */
function joinFolds(text: string): string {
  return text.replace(/[ \t]*\n[ \t]*/g, " ");
}

/** A `'...'`/`"..."` OR a `` `...` `` span — a citation/code-formatted excerpt, not live prose.
 *  Backticks matter: this record's own `design:` body reproduces the historical sentence
 *  verbatim inside backticks (see the header comment above), and a predicate blind to that
 *  quoting style would flag the very record that carries this lock. */
const QUOTE_SPAN = /(?<![\w])['"]([^'"]{2,400}?)['"](?![\w])/g;
const CODE_SPAN = /(?<![\w`])`([^`]{2,400}?)`(?![\w`])/g;

function isQuotedOrCoded(text: string, start: number, end: number): boolean {
  for (const spanRe of [QUOTE_SPAN, CODE_SPAN]) {
    spanRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = spanRe.exec(text))) {
      if (start >= m.index && end <= m.index + m[0].length) return true;
    }
  }
  return false;
}

/** A negation cue earlier in the SAME clause inverts the sense — "never install in the
 *  worktree" is a prohibition, not the instruction it forbids. Same clause-boundary shape as
 *  `task-linter.ts`'s `isNegationScoped`. */
const CLAUSE_BOUNDARY = /[.,;:()—]/;
const NEGATION_CUE = /\b(?:no|not|never|without|non|isn't|doesn't|won't|cannot|can't|nor)\b/i;

function isNegationScoped(text: string, start: number): boolean {
  let clauseStart = 0;
  for (let i = start - 1; i >= 0; i--) {
    if (CLAUSE_BOUNDARY.test(text[i])) {
      clauseStart = i + 1;
      break;
    }
  }
  return NEGATION_CUE.test(text.slice(clauseStart, start));
}

/** An installing verb — `npm ci`/`npm i`/`npm install` — the literal re-derivation grep
 *  W1-T2313 used (`git grep -nEi 'npm (ci|i|install)'`), not a generic "install" lexicon: the
 *  corrected W1-T65 sentence ("an install whose cwd is the worktree...") deliberately says
 *  "install" without "npm" precisely so a broader lexicon would not need to lean on negation
 *  scoping to stay green there, and this predicate matches that established scope. */
const INSTALL_VERB = "npm\\s+(?:ci|i|install)\\b";
const WORKTREE_LOCATIVE = "(?:in|inside|within)\\s+(?:the|that|this|its|your)?\\s*worktrees?\\b";

/** Verb-then-locative ("npm ci in the worktree") — the historical bigram, zero words between. */
const FORWARD_HIT = new RegExp(`\\b${INSTALL_VERB}\\s+${WORKTREE_LOCATIVE}`, "gi");
/** Locative-then-verb ("in the worktree, npm ci"/"in the worktree run npm ci") — the reverse
 *  order, with only a bare connector allowed so a real clause ("...worktree AND SHELL OUT TO
 *  npm ci") does not qualify — that gap is exactly what keeps W1-T499 green. */
const REVERSE_HIT = new RegExp(`\\b${WORKTREE_LOCATIVE}[,:\\-—]?\\s*(?:run\\s+|do\\s+|then\\s+)?${INSTALL_VERB}`, "gi");

interface Hit {
  start: number;
  end: number;
  matched: string;
}

/** Every co-occurrence of an installing verb with a worktree referent, in either order, that is
 *  NOT quoted/code-formatted and NOT negation-scoped. THE SAME function backs every assertion in
 *  this file — the live corpus, the synthetic positive, and the synthetic negative — per design
 *  note (iv)'s "assert BOTH halves against the SAME predicate". */
function findInstructionHits(rawText: string): Hit[] {
  const text = joinFolds(rawText);
  const hits: Hit[] = [];
  for (const re of [FORWARD_HIT, REVERSE_HIT]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      hits.push({ start: m.index, end: m.index + m[0].length, matched: m[0] });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return hits.filter((h) => !isQuotedOrCoded(text, h.start, h.end) && !isNegationScoped(text, h.start));
}

interface Violation {
  id: string;
  field: string;
  snippet: string;
}

const NARRATIVE_FIELDS = ["title", "rationale", "design", "note"] as const;

/** Every rendered field of ONE record that instructs a worker to install inside its worktree.
 *  Acceptance criteria are checked WITHOUT filtering `holdout: true` out — see the header
 *  comment on why that filter is not proven to apply on every worker-prompt path. */
function checkRecord(record: RawRecord): Violation[] {
  const id = typeof record.id === "string" ? record.id : String(record.id ?? "<unknown>");
  const violations: Violation[] = [];
  for (const field of NARRATIVE_FIELDS) {
    const value = record[field];
    if (typeof value === "string") {
      for (const hit of findInstructionHits(value)) {
        violations.push({ id, field, snippet: hit.matched });
      }
    }
  }
  const acceptance = record.acceptance;
  if (Array.isArray(acceptance)) {
    acceptance.forEach((c: unknown, i: number) => {
      if (typeof c !== "object" || c === null) return;
      const entry = c as Record<string, unknown>;
      for (const sub of ["claim", "proof"] as const) {
        const value = entry[sub];
        if (typeof value === "string") {
          for (const hit of findInstructionHits(value)) {
            violations.push({ id, field: `acceptance[${i}].${sub}`, snippet: hit.matched });
          }
        }
      }
    });
  }
  return violations;
}

/** design note (v): the failure message IS the deliverable — whoever trips this is filing a
 *  task and believes the sentence is true. */
function formatViolations(violations: Violation[]): string {
  const lines = violations.map((v) => `  - ${v.id} [${v.field}]: "${v.snippet}"`);
  return (
    `${violations.length} plan record field(s) instruct a worker to install inside its ` +
    `worktree:\n${lines.join("\n")}\n\n` +
    "This premise is FALSE: `linkWorktreeNodeModules` (src/lib/worker.ts) symlinks every " +
    "worker worktree's node_modules to the canonical tree, so the deps are already there. An " +
    "install whose cwd is the worktree follows that link and empties the SHARED tree under " +
    "every other live run (the 2026-07-29, 2026-08-05 and 2026-08-11 outages). Remove the " +
    "instruction; test proofs run with no install step at all."
  );
}

// ── FIXTURES (design note (iv) — constructed in-process; the live plan tree is never written) ─

/** The historical sentence, kept on one line, as a BARE instruction — no quoting at all. This
 *  is design (iv)'s synthetic positive, reproduced here as a plain field value (this record's
 *  OWN `design:` body already carries the same sentence in backticks, purely as a citation
 *  naming what the fixture below must contain — see the header comment). */
const HISTORICAL_SENTENCE =
  "Fresh worktrees have NO node_modules: npm ci in the worktree before typecheck/test.";

const SYNTHETIC_POSITIVE: RawRecord = {
  id: "SYN-W1-T2314-positive",
  title: "synthetic fixture — bare worktree-install instruction",
  design: HISTORICAL_SENTENCE,
};

/** The same sentence, quoted AND negated the way W1-T2312's rationale carries it: framed as a
 *  corrected citation, never as a live command. */
const SYNTHETIC_NEGATIVE: RawRecord = {
  id: "SYN-W1-T2314-negative",
  rationale:
    `The binding-rules header once read, verbatim: "${HISTORICAL_SENTENCE}" — that premise was ` +
    "never true once linkWorktreeNodeModules started symlinking every worktree's node_modules " +
    "to the canonical tree, so it was corrected and is not an instruction any worker follows.",
};

// ── THE LIVE CORPUS: NAMED RECORDS THAT MUST STAY GREEN (acceptance criterion 3) ──────────────
//
// Every id design note (iii) names as a live discussion/citation that must not trip this lock,
// plus the W1-T1B retirement gravestone the same sweep surfaced independently.
const MUST_STAY_GREEN_IDS = [
  "W1-T151", // rmd's OWN boot/build install path — SymlinkInstallRefusal guards it, and it is correct as written
  "W1-T1033", // CI-runner-timing discussion ("Its steps are `npm ci`, the ...")
  "W1-T1060", // CI-runner-timing discussion (step timings: checkout, setup-node, `npm ci`)
  "W1-T452", // "a real `npm ci` costs 60-90s warm" — a cost discussion, a full clause from "worktree"
  "W1-T499", // "in a fresh worktree and shell out to `npm ci`" — descriptive, a verb phrase apart
  "W1-T1009", // CI-runner-timing discussion (`actions/setup-node` and `npm ci` steps)
  "W1-T1041", // CI-runner-timing discussion (scratch worktree population; downstream job needs no `npm ci`)
  "W1-T1B", // retirement gravestone quoting the retired criterion as history, single-quoted
  "W1-T2312", // quotes the forbidden sentence, double-quoted, in order to forbid it
  "W1-T2313", // quotes the forbidden sentence, single-quoted, in order to forbid it
  "W1-T2314", // THIS TASK'S OWN record — backtick-quotes the sentence as its own fixture spec
] as const;

test("no rendered field of any plan record instructs a worker to install inside its worktree", () => {
  const records = loadRawRecords(PLAN_PATH);
  assert.ok(records.length > 0, "expected the shipped plan to contain at least one record");
  const violations = records.flatMap(checkRecord);
  assert.deepEqual(violations, [], formatViolations(violations));
});

test("the raw record loader mirrors loadPlan's own file discovery (same ids, same count)", () => {
  const raw = loadRawRecords(PLAN_PATH);
  const rawIds = new Set(raw.map((r) => String(r.id)));
  const plan = loadPlan(PLAN_PATH);
  assert.equal(raw.length, plan.tasks.length, "raw parse and loadPlan disagree on record count");
  for (const t of plan.tasks) {
    assert.ok(rawIds.has(t.id), `loadPlan's ${t.id} is missing from the raw parse — file discovery has drifted`);
  }
});

test("the named live records that discuss CI installs or quote the retired criterion as history stay green", () => {
  const byId = new Map(loadRawRecords(PLAN_PATH).map((r) => [String(r.id), r]));
  for (const id of MUST_STAY_GREEN_IDS) {
    const record = byId.get(id);
    assert.ok(record, `expected ${id} to still exist in the plan (corpus fixture drifted)`);
    const violations = checkRecord(record!);
    assert.deepEqual(violations, [], `${id} unexpectedly tripped the lock:\n${formatViolations(violations)}`);
  }
});

test("a synthetic record carrying the historical instruction as a bare sentence is reported", () => {
  const violations = checkRecord(SYNTHETIC_POSITIVE);
  assert.equal(violations.length, 1, formatViolations(violations));
  assert.equal(violations[0].id, "SYN-W1-T2314-positive");
  assert.equal(violations[0].field, "design");
  assert.match(violations[0].snippet, /npm\s+ci\s+in\s+the\s+worktree/i);
});

test("the same predicate does NOT report the historical sentence when quoted and negated", () => {
  const violations = checkRecord(SYNTHETIC_NEGATIVE);
  assert.deepEqual(violations, [], formatViolations(violations));
});

test("a quoted phrase wrapped across two physical lines of a literal block scalar is still recognized as quoted", () => {
  // design note (iii)'s warned seam: a `design: |` literal block preserves the author's
  // line-wrap as a real `\n` inside the quoted phrase. Constructed via the real YAML parser
  // (not a hand-built string) so the line break is authentically YAML's, not a stand-in.
  const wrappedYaml = [
    "- id: SYN-wrapped-quote",
    "  design: |",
    '    The header once read, verbatim: "Fresh worktrees have NO node_modules: npm ci',
    '    in the worktree before typecheck/test." That premise was corrected.',
    "",
  ].join("\n");
  const [record] = parseYaml(wrappedYaml) as RawRecord[];
  assert.ok(typeof record.design === "string" && record.design.includes("\n"), "fixture must carry a real embedded newline");
  assert.deepEqual(checkRecord(record), []);
});
