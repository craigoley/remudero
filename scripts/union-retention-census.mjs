#!/usr/bin/env node
// union-retention-census — refuse a ledger read that pays for the archives to recover a row
// retention was told to throw away.
//
// WHY THIS IS A GATE AND NOT A CLAUDE.md BULLET (W1-T3360). On 2026-09-10 the fleet daemon
// OOM-crash-looped for eight hours: 66 restarts, exit 134, no build dispatched. The cause was a
// 4.0 GB `resolveLedgerUnion` scan against an 8 GB heap. `sweep.fix.uncreditable_head` — the row
// the sweep reads to decide NOT to re-dispatch a permanently uncreditable PR head — is written,
// then classified as pure noise by `rotateLedger` (it is absent from
// `DECISION_RELEVANT_LEDGER_STEPS`), then archived wholesale, and then read back out of 954
// archives on every daemon cycle. MEASURED that night: 0 of its 324 rows were in the live ledger.
// All 324 were in archives, including one written ninety minutes earlier.
//
// So the outage's root cause was a step name missing from a list, and finding it took a person
// reading two files and noticing they disagreed. That is what a gate is for.
//
// THE RULE, AND WHY IT HAS ALMOST NO FALSE POSITIVES. Calling `resolveLedgerUnion` is a DECLARATION
// that you need history: it requires archives and refuses an incomplete corpus. Leaving a step out
// of the retention sets is the OPPOSITE declaration — that losing old rows is acceptable. Holding
// both about the same step is a contradiction, and the repo pays for it in gigabytes.
//
// MEASURED on the tree that shipped this: 122 step names are read somewhere in `src/`, and 74 of
// them are not retained — so a naive "every read step must be retained" check would name 74 rows
// and get reverted in a week (the shape `expiring-fixture-census` was written to avoid). Narrowing
// to steps read THROUGH THE UNION cuts that to 8, across 3 call sites, and two of those three are
// named in #5017's own measured OOM table. The narrowing is the whole design.
//
// IT NAMES, IT DOES NOT PRESCRIBE. Two fixes are legitimate and the census cannot tell them apart:
// retain the step (right when the population is small and bounded), or keep a PROJECTION and stop
// scanning (right when it is large, e.g. 76,131 `followup.harvested` rows). So a row is cleared by
// an ACKNOWLEDGEMENT carrying a reason, and a NEW contradiction fails closed.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Retention sets `rotateLedger` consults, in the order it consults them. A step in any of these
 *  survives rotation (bounded to {@link MAX_RETAINED_LINES_PER_STEP} newest); a step in none of
 *  them is archived in full. */
export const RETENTION_SET_NAMES = ["DECISION_RELEVANT_LEDGER_STEPS", "RENDER_RELEVANT_LEDGER_STEPS"];

/**
 * The contradictions that existed when this gate shipped, each with the reason it is not simply
 * fixed here. THIS IS NOT AN ALLOWLIST TO GROW. Adding a row means a NEW union read of a
 * NON-RETAINED step was introduced, which is the defect; the entry must say which of the two
 * legitimate fixes applies and name the task that will apply it.
 */
export const ACKNOWLEDGED = new Map([
  // MEASURED on the live fleet corpus 2026-09-11, `union` = rows across archives+live,
  // `live` = rows in the live ledger. EVERY ONE READS live=0. That is the finding, not a detail:
  // retention contributes NOTHING to any of these reads, so the union is doing 100% of the work
  // for all of them, which is why the corpus size became a fleet outage.
  [
    "sweep.fix.uncreditable_head",
    "W1-T3352 — union=324 live=0, naming 49 distinct head shas. THE OUTAGE ROW. Small and bounded, " +
      "so the fix is a projection keyed by head sha; a retention entry alone is insufficient because " +
      "200 newest ROWS need not cover all 49 HEADS.",
  ],
  [
    "sweep.fix.uncreditable_head_escalated",
    "W1-T3352 — union=0 live=0 today; the escalation half of the row above, written only when the " +
      "uncreditable head is escalated, and read through the SAME pattern so it shares that scan.",
  ],
  [
    "report.followups",
    "W1-T3352 — +3,804 MB in #5017's own measured OOM table. Its sibling `followup.harvested` is " +
      "76,131 rows: far too many to retain, so this call site needs a dedupe projection and must " +
      "NEVER get a retention entry.",
  ],
  ["followup.harvested", "W1-T3352 — union=76,131 rows, live=0. Same call site as report.followups; projection, not retention."],
  [
    "followup.deduped",
    "W1-T3352 — shares the followup.harvested scan (76,131 rows) at the same call site; its own row " +
      "count was not measured separately because the scan cost belongs to the pattern, not this step.",
  ],
  [
    "recon.done",
    "W1-T3352 — union=746 live=0. Read through RUN_LEDGER_STEP_PATTERN beside three steps that ARE " +
      "retained, which is what makes this one look accidental. Small enough that a retention entry is " +
      "the likely fix, but it must be priced against the 4 MiB rotation ceiling rather than assumed.",
  ],
  ["implement.done", "W1-T3352 — union=738 rows, live=0. Same call site as recon.done."],
  ["implement.resumed", "W1-T3352 — union=6 rows, live=0. Same call site as recon.done."],
  [
    "fix.exhausted",
    "W1-T3352 — union=166 live=0. INVISIBLE TO THE FIRST DRAFT OF THIS GATE: autonomy.ts writes its " +
      "pattern as a regex ALTERNATION, and the extractor could not see inside it. Found only after " +
      "`stepsInPatternText` was taught to split alternations.",
  ],
  ["fix.stood_down", "W1-T3352 — union=434 rows, live=0. Same alternation pattern as fix.exhausted."],
  [
    "panel.operator_note_added",
    "W1-T3352 — union=0 live=0. THE ROW HAS NEVER BEEN WRITTEN AT ALL, so this is a full-corpus scan " +
      "for a step that does not exist. Its fix is not retention or a projection: it is deleting the " +
      "read, or finding the producer that was never wired. Same alternation pattern as fix.exhausted.",
  ],
]);

/**
 * Union call sites whose pattern cannot be resolved statically, each acknowledged with why.
 *
 * A RUNTIME-BUILT PATTERN IS A BLIND SPOT, AND A BLIND SPOT MUST BE LOUD. Without this map a caller
 * could move its steps into a `new RegExp(someVariable)` and the census would report "not step-keyed"
 * — passing while seeing nothing, which is the exact vacuous-pass shape this repo keeps getting bitten
 * by. A NEW unresolved call site fails closed.
 */
export const ACKNOWLEDGED_UNRESOLVED = new Map([
  [
    "src/lib/rule-efficacy.ts",
    "Builds its pattern at runtime from `MeasurableRuleSignature.stepPatterns` (`new RegExp(combinedSource)`), " +
      "so no literal step name exists in the source to check. The signatures it composes are data, and " +
      "checking them belongs to whatever validates that data, not to a source scan.",
  ],
]);

/** `git ls-files` over the source tree. Tracked files only, so an untracked scratch copy of a
 *  reader cannot make the census answer differently than CI's checkout would. */
export function trackedSourceFiles(repoRoot, exec = execFileSync) {
  return exec("git", ["-C", repoRoot, "ls-files", "src/*.ts", "src/**/*.ts"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

/** Parse one `new Set([...])` retention block out of ledger.ts by name. Returns an empty set when
 *  the name is absent, which {@link assertRetentionSetsResolved} turns into a refusal rather than a
 *  silent pass — a renamed set must redden this gate, not empty it. */
export function retentionSetFrom(ledgerSource, name) {
  const start = ledgerSource.indexOf(`export const ${name}`);
  if (start === -1) return new Set();
  const end = ledgerSource.indexOf("]);", start);
  if (end === -1) return new Set();
  return new Set([...ledgerSource.slice(start, end).matchAll(/"([a-z0-9_.]+)"/g)].map((m) => m[1]));
}

/** POSITIVE CONTROL ON THE GATE'S OWN INPUT. A zero here means the sets were renamed or moved, and
 *  every step would then read "not retained" — 8 contradictions would become dozens and the census
 *  would look like a catastrophe instead of a broken query. */
export function assertRetentionSetsResolved(sets) {
  const empty = [...sets.entries()].filter(([, v]) => v.size === 0).map(([k]) => k);
  if (empty.length > 0) {
    throw new Error(
      `union-retention-census: retention set(s) ${empty.join(", ")} resolved to ZERO members — ` +
        "renamed or moved in src/lib/ledger.ts. Refusing to report contradictions against an empty " +
        "set, because every step would falsely read as unretained.",
    );
  }
}

const UNION_CALL_RE =
  /resolveLedgerUnion\(\s*[^,]+,\s*(new RegExp\([\s\S]{0,300}?\)|[A-Za-z_][A-Za-z0-9_]*|'[^']*'|"[^"]*")/g;

/** Every `"step":"…"` occurrence in a pattern, INCLUDING an alternation group.
 *
 * A first draft matched only the direct `"step":"name"` shape and reported ZERO steps for
 * `src/lib/autonomy.ts`, whose pattern is
 * `/"step":"(?:automerge\.armed|review\.posted|…)"/` — EIGHT step names the census could not see.
 * A gate blind to the most compact way of writing the thing it checks is worse than no gate, so the
 * extractor reads the whole quoted body and splits it on regex alternation. */
export function stepsInPatternText(patternText) {
  const steps = [];
  const marker = '"step":';
  let i = patternText.indexOf(marker);
  while (i !== -1) {
    // skip the marker, then any escaping before the opening quote of the VALUE
    let j = i + marker.length;
    while (j < patternText.length && patternText[j] === "\\") j++;
    if (patternText[j] !== '"') {
      i = patternText.indexOf(marker, i + marker.length);
      continue;
    }
    j++;
    // read to the closing quote, tolerating backslash escapes
    let body = "";
    while (j < patternText.length) {
      if (patternText[j] === "\\") {
        j++;
        continue;
      }
      if (patternText[j] === '"') break;
      body += patternText[j];
      j++;
    }
    for (const raw of body.replace(/^\(\?:/, "").replace(/\)$/, "").split("|")) {
      const step = raw.trim();
      if (/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(step)) steps.push(step);
    }
    i = patternText.indexOf(marker, j);
  }
  return steps;
}

/** Resolve the pattern argument of a union call to its literal text: either the literal passed
 *  inline, or the same-file `const` it names. An unresolvable identifier yields `undefined`, which
 *  {@link censusFindings} reports as UNRESOLVED rather than as "no steps" — the difference between
 *  "this read is not step-keyed" and "the census could not read it". */
export function resolvePatternText(source, arg) {
  if (!/^[A-Za-z_]/.test(arg)) return arg;
  const decl = new RegExp(`const ${arg}\\s*(?::[^=]+)?=\\s*([\\s\\S]{0,400}?);\\n`).exec(source);
  return decl ? decl[1] : undefined;
}

/** Every union call site paired with the step names its pattern names, and whether each survives
 *  rotation. `steps: []` means the read is not keyed on step literals at all (a caller passing a
 *  runtime pattern), which this gate has no opinion about. */
export function censusFindings(files, readFile, retention) {
  const findings = [];
  for (const file of files) {
    const source = readFile(file);
    if (!source.includes("resolveLedgerUnion")) continue;
    UNION_CALL_RE.lastIndex = 0;
    let call;
    while ((call = UNION_CALL_RE.exec(source))) {
      const arg = call[1];
      const patternText = resolvePatternText(source, arg);
      if (patternText === undefined) {
        findings.push({ file, arg, unresolved: true, steps: [] });
        continue;
      }
      const steps = stepsInPatternText(patternText);
      findings.push({
        file,
        arg,
        unresolved: false,
        steps: steps.map((step) => ({
          step,
          retainedBy: [...retention.entries()].find(([, set]) => set.has(step))?.[0],
        })),
      });
    }
  }
  return findings;
}

/** The contradictions: a step read through the union that no retention set keeps AND that carries
 *  no acknowledgement. */
export function contradictions(findings, acknowledged = ACKNOWLEDGED) {
  const out = [];
  for (const f of findings) {
    for (const s of f.steps) {
      if (s.retainedBy !== undefined) continue;
      if (acknowledged.has(s.step)) continue;
      out.push({ file: f.file, pattern: f.arg, step: s.step });
    }
  }
  return out;
}

/** An acknowledgement whose step is no longer read through the union, or is now retained, is STALE
 *  and must be deleted — otherwise the map only ever grows and stops meaning anything. */
export function staleAcknowledgements(findings, acknowledged = ACKNOWLEDGED) {
  const live = new Set();
  for (const f of findings) for (const s of f.steps) if (s.retainedBy === undefined) live.add(s.step);
  return [...acknowledged.keys()].filter((step) => !live.has(step));
}

export function main(argv = [], deps = {}) {
  const repoRoot = deps.repoRoot ?? process.cwd();
  const log = deps.log ?? console.log;
  // INJECTABLE, because the stale-acknowledgement rule makes the real map wrong for any fixture:
  // a synthetic tree has none of these steps, so every entry would read STALE and no fixture could
  // ever exercise the gate. The default is the committed map, so the live run is unchanged.
  const acknowledged = deps.acknowledged ?? ACKNOWLEDGED;
  const acknowledgedUnresolved = deps.acknowledgedUnresolved ?? ACKNOWLEDGED_UNRESOLVED;
  const readFile = deps.readFile ?? ((rel) => readFileSync(join(repoRoot, rel), "utf8"));
  const files = deps.files ?? trackedSourceFiles(repoRoot, deps.exec);

  const ledgerSource = readFile("src/lib/ledger.ts");
  const retention = new Map(RETENTION_SET_NAMES.map((n) => [n, retentionSetFrom(ledgerSource, n)]));
  assertRetentionSetsResolved(retention);

  // `ledger-union.ts` DEFINES resolveLedgerUnion and forwards its own `pattern` parameter; it is
  // the declaration, never a caller, so scanning it for step literals is a category error.
  const findings = censusFindings(
    files.filter((f) => f !== "src/lib/ledger-union.ts"),
    readFile,
    retention,
  );
  const unresolved = findings.filter((f) => f.unresolved);
  const unexplainedBlindSpots = unresolved.filter((f) => !acknowledgedUnresolved.has(f.file));
  const stepKeyed = findings.filter((f) => !f.unresolved && f.steps.length > 0);

  // CONTROL: the census must SEE its corpus. Counting CALL SITES, not step-keyed ones — an
  // unresolved pattern means the corpus IS visible and merely unreadable, and it has its own louder
  // report below. Counting only step-keyed reads here let a runtime-built pattern trip this branch
  // and hide the blind-spot message behind a "found nothing" one.
  if (findings.length === 0) {
    log(
      "union-retention-census: REFUSED — no resolveLedgerUnion call site found at all. " +
        "The call shape changed; this gate would pass vacuously.",
    );
    return 1;
  }

  const bad = contradictions(findings, acknowledged);
  const stale = staleAcknowledgements(findings, acknowledged);

  log(
    `union-retention-census: ${stepKeyed.length} step-keyed union read(s), ` +
      `${stepKeyed.reduce((n, f) => n + f.steps.length, 0)} step(s) named, ` +
      `${acknowledged.size} acknowledged contradiction(s)` +
      (unresolved.length > 0 ? `, ${unresolved.length} unresolved pattern(s)` : ""),
  );

  for (const s of stale) {
    log(
      `union-retention-census: STALE acknowledgement for "${s}" — it is no longer read through the ` +
        "union as an unretained step. Delete the entry; an acknowledgement that covers nothing is a " +
        "gate that only grows.",
    );
  }

  for (const c of bad) {
    log(
      `union-retention-census: CONTRADICTION — ${c.file} reads "${c.step}" through the union ` +
        `(pattern ${c.pattern}), but no retention set keeps it. The union REQUIRES archives, so this ` +
        "pays a full-corpus scan to recover a row rotation was told to discard. Either add the step " +
        `to one of ${RETENTION_SET_NAMES.join("/")} in src/lib/ledger.ts, keep a projection and stop ` +
        "scanning, or add an ACKNOWLEDGED entry naming which fix applies and the task that will do it.",
    );
  }

  for (const f of unexplainedBlindSpots) {
    log(
      `union-retention-census: UNRESOLVED PATTERN — ${f.file} passes ${f.arg} to the union, and no ` +
        "literal step name can be read from it. The census cannot see what this reads, so it cannot " +
        "clear it. Name the file in ACKNOWLEDGED_UNRESOLVED with why the pattern is built at runtime, " +
        "or pass a pattern whose step names are literals.",
    );
  }

  if (bad.length > 0 || stale.length > 0 || unexplainedBlindSpots.length > 0) return 1;
  log("union-retention-census: OK -- every step-keyed union read is retained or acknowledged.");
  return 0;
}

// diff-cov: process-boundary — the CLI entry only translates main()'s tested return into an exit code.
if (process.argv[1] && process.argv[1].endsWith("union-retention-census.mjs")) process.exit(main(process.argv.slice(2)));
