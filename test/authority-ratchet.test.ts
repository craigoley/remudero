// test/authority-ratchet.test.ts — W1-T2695: a new external write that names no gate fails CI
// by name.
//
// THE POPULATION, re-derived from source rather than carried from the filing rationale (which
// names src/lib/open-prs-rest.ts + src/lib/github-app.ts as "the gateway modules" — measured at
// this task's own HEAD, open-prs-rest.ts is REST-read-only by its own module header and contains
// zero write-verb argv, and github-app.ts contains exactly one, an internal token-exchange POST;
// neither is where armAutoMerge/openPlanPr/postReviewStatus/the escalation issue-filer/any push
// actually live). The real, mechanically-enumerable surface, run over every tracked
// `src/**/*.ts` file (excluding this ratchet's own two production modules) is FOUR detectable
// shapes:
//   (a) `assertLiveWriteAllowed("<boundary>", ...)` — the live-write guard's own closed
//       enumeration (lib/live-write-guard.ts), covering git-push/gh-pr-create/gh-pr-merge/
//       gh-pr-update-branch/gh-issue-create.
//   (b) a `gh api` REST call carrying an explicit non-GET verb: `"-X", "POST"|"PATCH"|"PUT"|
//       "DELETE"`.
//   (c) a `gh` subcommand argv literal known to write: `["pr"|"issue", "create"|"merge"|
//       "comment"|"review"|"close"]`.
//   (d) a raw `git push` argv literal: `["push", ...]`.
// Measured at this task's own HEAD: 14 files. AUTHORITY_TABLE (src/lib/authority.ts) names all
// 14 by `module`. The baseline is empty — this ratchet requires every detected file to be NAMED,
// never counted against an allowance, so a file entering the tree tomorrow with a brand-new
// write and no table row fails immediately, by name.
//
// GRANULARITY: per FILE, not per call site or boundary. A second write added to an
// ALREADY-tabled file does not independently trip this gate (same trade-off
// test/negative-reachability-ratchet.test.ts's own doc makes for its two surfaces: a named,
// mechanical, file-level census, not a parser). AUTHORITY_TABLE itself carries multiple rows per
// rich file for the report's own sake; this ratchet only requires at least one.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { AUTHORITY_TABLE, authorityTableModules, buildAuthorityReport, renderAuthorityReport } from "../src/lib/authority.js";
import { PLAN_MOVE_JANITOR_STEP, PLAN_MOVE_STAND_DOWN, PLAN_TASK_MOVE_ACTION, runPlanTaskMoveTick } from "#src/lib/plan-task-move-janitor.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// This ratchet's own two production modules are excluded: authority.ts's `AUTHORITY_TABLE`
// literal itself contains the strings this detector scans for (as data, in row `action`/`note`
// fields, e.g. "gh pr create"), and live-write-guard.ts is the guard's OWN definition site
// (`assertLiveWriteAllowed(` appears there as the function declaration, not a call).
const EXCLUDED_MODULES = new Set(["src/lib/authority.ts", "src/lib/live-write-guard.ts"]);

const SRC_TS_RE = /^src\/.*\.ts$/;

function trackedSrcFiles(): string[] {
  return execFileSync("git", ["-C", REPO_ROOT, "ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((p) => SRC_TS_RE.test(p) && !EXCLUDED_MODULES.has(p));
}

const ASSERT_LIVE_WRITE_RE = /assertLiveWriteAllowed\(\s*"([a-z-]+)"/g;
const GH_VERB_RE = /"-X"\s*,\s*"(POST|PATCH|PUT|DELETE)"/;
const GH_SUBCOMMAND_RE = /\[\s*"(pr|issue)"\s*,\s*"(create|merge|comment|close|review)"/;
const GIT_PUSH_ARGV_RE = /\[\s*"push"/;

/** Every reason this ratchet flagged `file`, e.g. `["assertLiveWriteAllowed:git-push", "gh-subcommand:pr:create"]`. */
function detectExternalWrites(file: string): string[] {
  const text = readFileSync(join(REPO_ROOT, file), "utf8");
  const reasons: string[] = [];
  for (const m of text.matchAll(ASSERT_LIVE_WRITE_RE)) reasons.push(`assertLiveWriteAllowed:${m[1]}`);
  const verbMatch = GH_VERB_RE.exec(text);
  if (verbMatch) reasons.push(`gh-verb:${verbMatch[1]}`);
  const subMatch = GH_SUBCOMMAND_RE.exec(text);
  if (subMatch) reasons.push(`gh-subcommand:${subMatch[1]}:${subMatch[2]}`);
  if (GIT_PUSH_ARGV_RE.test(text)) reasons.push("git-push-argv");
  return reasons;
}

function filesWithExternalWrites(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of trackedSrcFiles()) {
    const reasons = detectExternalWrites(file);
    if (reasons.length > 0) found.set(file, reasons);
  }
  return found;
}

// ── non-vacuity, first (the census pattern this house's other ratchets pin) ────────────────────

test("the detector is non-vacuous: it finds a real, known population at this HEAD", () => {
  const detected = filesWithExternalWrites();
  assert.ok(detected.size >= 10, `expected at least 10 files with a detectable external write, found ${detected.size}`);
  for (const known of ["src/run-task.ts", "src/lib/git-push.ts", "src/lib/escalate.ts", "src/lib/review.ts"]) {
    assert.ok(detected.has(known), `expected the detector to flag ${known}`);
  }
});

// ── the ratchet itself ───────────────────────────────────────────────────────────────────────

test("every tracked src file with a detectable external write is named in AUTHORITY_TABLE by module", () => {
  const detected = filesWithExternalWrites();
  const tabled = authorityTableModules();
  const missing = [...detected.keys()].filter((f) => !tabled.has(f));
  assert.deepEqual(
    missing,
    [],
    `AUTHORITY_TABLE (src/lib/authority.ts) is missing a row for: ${missing
      .map((f) => `${f} (${JSON.stringify(detected.get(f))})`)
      .join(", ")} — a new external write must name its gate before it can merge`,
  );
});

test("every AUTHORITY_TABLE row's module is a real tracked src file, not a stale or mistyped path", () => {
  const tracked = new Set(trackedSrcFiles().concat([...EXCLUDED_MODULES]));
  for (const row of AUTHORITY_TABLE) {
    assert.ok(tracked.has(row.module), `AUTHORITY_TABLE row "${row.id}" names module "${row.module}", which is not a tracked src file`);
  }
});

// ── the falsifier: prove the detector actually catches an ungated write, not merely that it is
// silent today (the same "prove the unhealthy arm" discipline
// test/negative-reachability-ratchet.test.ts's own header names as the defect five prior
// instruments shared) ────────────────────────────────────────────────────────────────────────

test("FALSIFIER: each detector shape matches its own known-write fixture text", () => {
  assert.match('assertLiveWriteAllowed("git-push", "pushing the run branch");', ASSERT_LIVE_WRITE_RE);
  assert.match('["api", "-X", "POST", `repos/${owner}/${repo}/pulls`]', GH_VERB_RE);
  assert.match('["pr", "create", "--fill"]', GH_SUBCOMMAND_RE);
  assert.match('["pr", "review", "--comment"]', GH_SUBCOMMAND_RE);
  assert.match('["issue", "close", issueUrl]', GH_SUBCOMMAND_RE);
  assert.match('deps.run(["push", "origin", `${anchor}:${ref}`])', GIT_PUSH_ARGV_RE);
});

test("FALSIFIER: a synthetic new external write with no AUTHORITY_TABLE entry is caught, never silently accepted", () => {
  const syntheticFile = "src/lib/a-file-that-does-not-exist-in-authority-table.ts";
  const syntheticText = 'export function doSomething() {\n  assertLiveWriteAllowed("gh-pr-merge", "merging without a table row");\n}\n';
  const reasons: string[] = [];
  for (const m of syntheticText.matchAll(new RegExp(ASSERT_LIVE_WRITE_RE, "g"))) reasons.push(`assertLiveWriteAllowed:${m[1]}`);
  assert.ok(reasons.length > 0, "the detector must flag the synthetic write");
  const tabled = authorityTableModules();
  assert.ok(!tabled.has(syntheticFile), "the synthetic file must genuinely be absent from AUTHORITY_TABLE for this to be a real falsifier");
  // The shape a real CI failure would take: this file, once real, would fail the ratchet test
  // above exactly the way `missing` names it there — asserted here directly, over the synthetic
  // pair, so the falsifier does not depend on mutating the real tree.
  const wouldFail = reasons.length > 0 && !tabled.has(syntheticFile);
  assert.ok(wouldFail, "a new ungated write with no table row must be a ratchet failure, not a pass");
});

// ── AUTHORITY_TABLE self-consistency: the baseline is EMPTY (a hand-added allowance defeats the
// point of this ratchet, unlike the count-baseline ratchets this repo also carries) ────────────

test("AUTHORITY_TABLE carries no unused rows for files the detector no longer finds (drift in the other direction)", () => {
  const detected = filesWithExternalWrites();
  const tabledModules = [...authorityTableModules()];
  const stale = tabledModules.filter((m) => !detected.has(m));
  assert.deepEqual(
    stale,
    [],
    `AUTHORITY_TABLE names ${JSON.stringify(stale)}, which the detector no longer finds any external write in — ` +
      "either the write was removed (the row is now stale prose) or the detector's shapes need widening",
  );
});

// ── W1-T13773: the fifth shape — a child-process caller of a tabled write ────────────────────
//
// A row whose verb is `rmd <verb> --<flag>` (a verb that writes only with that explicit flag) can
// be reached from ANOTHER module that spawns the CLI as a child: the daemon's move janitor runs
// `move-task ... --apply` (src/lib/plan-task-move-janitor.ts), the gate gardener runs
// `next-task-id --reserve` (src/lib/gate-gardener.ts). None of shapes (a)-(d) sees such a file,
// since the push happens in the child. The fifth shape: a tracked src file, other than the row's
// own module and src/run-task.ts (the CLI's own verb registration), that holds BOTH string
// literals — the verb and the flag — must be named by module among that row's `callers`. Same
// per-file granularity and the same empty baseline as shapes (a)-(d), which are unchanged.

/** The `rmd <verb> --<flag>` pairs a row's verb string names; a row with none takes no part in the fifth shape. */
const ROW_VERB_FLAG_RE = /\brmd ([a-z][a-z0-9-]*) (--[a-z][a-z0-9-]*)/g;
/** The CLI's own verb registration carries every verb and flag literal; it is the verb, never a child caller of it. */
const CLI_REGISTRATION = "src/run-task.ts";

interface CallerRowShape {
  id: string;
  module: string;
  verb: string;
  callers?: readonly { module: string }[];
}

function rowVerbFlags(verb: string): { verb: string; flag: string }[] {
  return [...verb.matchAll(ROW_VERB_FLAG_RE)].map((m) => ({ verb: m[1]!, flag: m[2]! }));
}

/** A string literal spelling exactly `word`, in any of the three quote styles. */
function holdsLiteral(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`["'\`]${escaped}["'\`]`).test(text);
}

/** Every file holding both literals of a row's verb and write flag that the row's callers do not name. */
function undeclaredChildCallers(rows: readonly CallerRowShape[], files: readonly { path: string; text: string }[]): string[] {
  const found: string[] = [];
  for (const row of rows) {
    const named = new Set((row.callers ?? []).map((c) => c.module));
    for (const { verb, flag } of rowVerbFlags(row.verb)) {
      for (const file of files) {
        if (file.path === row.module || file.path === CLI_REGISTRATION || named.has(file.path)) continue;
        if (holdsLiteral(file.text, verb) && holdsLiteral(file.text, flag)) found.push(`${row.id}: ${file.path} (rmd ${verb} ${flag})`);
      }
    }
  }
  return found;
}

function trackedSrcTexts(): { path: string; text: string }[] {
  return trackedSrcFiles().map((path) => ({ path, text: readFileSync(join(REPO_ROOT, path), "utf8") }));
}

test("W1-T13773 criterion 2: a tracked src file that spawns a row's rmd <verb> --<flag> as a child is named among that row's callers", () => {
  const files = trackedSrcTexts();
  const flagged = AUTHORITY_TABLE.filter((row) => rowVerbFlags(row.verb).length > 0);
  // Non-vacuous: the move rows take part, and the janitor really holds both literals at this HEAD.
  assert.ok(flagged.some((row) => row.id === "push-plan-move-branch"), "the fifth shape must read the push-plan-move-branch row's verb");
  const janitor = files.find((f) => f.path === "src/lib/plan-task-move-janitor.ts");
  assert.ok(janitor && holdsLiteral(janitor.text, "move-task") && holdsLiteral(janitor.text, "--apply"), "the janitor must hold both literals");
  const missing = undeclaredChildCallers(AUTHORITY_TABLE as readonly CallerRowShape[], files);
  assert.deepEqual(
    missing,
    [],
    `AUTHORITY_TABLE (src/lib/authority.ts) does not name these child-process callers among the row's callers: ${missing.join(", ")}` +
      " — a module that runs a tabled write through a child rmd process must name its own gate before it can merge",
  );
});

test("W1-T13773 criterion 2: every caller a row names still holds both literals of that row's verb and write flag (drift in the other direction)", () => {
  const files = new Map(trackedSrcTexts().map((f) => [f.path, f.text]));
  for (const row of AUTHORITY_TABLE as readonly CallerRowShape[]) {
    for (const caller of row.callers ?? []) {
      const text = files.get(caller.module);
      assert.ok(text !== undefined, `${row.id}: caller module ${caller.module} is not a tracked src file`);
      assert.ok(
        rowVerbFlags(row.verb).some(({ verb, flag }) => holdsLiteral(text, verb) && holdsLiteral(text, flag)),
        `${row.id}: caller ${caller.module} no longer holds the literals of ${JSON.stringify(row.verb)} — the caller entry is stale`,
      );
    }
  }
});

test("W1-T13773 criterion 2 FALSIFIER: a synthetic child caller missing from callers is caught by name; a bare verb mention and the CLI's registration are not", () => {
  const row: CallerRowShape = { id: "synthetic-move-row", module: "src/lib/synthetic-mover.ts", verb: "rmd move-task --apply", callers: [] };
  const childArgv = 'const args = [entry, "move-task", "--public-root", root, ...(apply ? ["--apply"] : [])];\n';
  const files = [
    { path: "src/lib/synthetic-janitor.ts", text: childArgv },
    // The lane label shape of src/lib/plan-task-move.ts:262: the verb alone, no write flag.
    { path: "src/lib/synthetic-lane-label.ts", text: 'planPrPreflightAllows(verdict, { lane: "move-task", branch });\n' },
    // The CLI's own verb registration, and the row's own module, carry both literals and are never callers.
    { path: CLI_REGISTRATION, text: 'case "move-task": return moveTaskCommand(args); // "--apply"\n' },
    { path: row.module, text: 'const apply = args.includes("--apply"); lane: "move-task";\n' },
  ];
  assert.deepEqual(undeclaredChildCallers([row], files), ["synthetic-move-row: src/lib/synthetic-janitor.ts (rmd move-task --apply)"]);
  // Naming the caller clears it: the ratchet asks for the entry, never an allowance.
  assert.deepEqual(undeclaredChildCallers([{ ...row, callers: [{ module: "src/lib/synthetic-janitor.ts" }] }], files), []);
  // The real janitor, against the real move row stripped of its callers, is caught by name.
  const realRow = AUTHORITY_TABLE.find((r) => r.id === "push-plan-move-branch") as CallerRowShape | undefined;
  assert.ok(realRow, "the push-plan-move-branch row must exist");
  const real = trackedSrcTexts().filter((f) => f.path === "src/lib/plan-task-move-janitor.ts" || f.path === "src/lib/plan-task-move.ts");
  assert.deepEqual(undeclaredChildCallers([{ ...realRow, callers: [] }], real), [
    "push-plan-move-branch: src/lib/plan-task-move-janitor.ts (rmd move-task --apply)",
  ]);
});

test("W1-T13773 criterion 1: the two plan-move rows name the operator verb and the daemon's plan-task-move action, each with its gate, and rmd authority prints a line for each", () => {
  // The caller's names are the janitor's own exports, never carried from prose.
  assert.equal(typeof runPlanTaskMoveTick, "function");
  const ledger = { stateDir: "/fake-state-dir", archiveFiles: [], archiveCount: 1, liveFileRead: true, unread: [], unclassified: [], ok: true, matches: [] };
  const lines = renderAuthorityReport(buildAuthorityReport({ ledger })).split("\n");
  for (const id of ["push-plan-move-branch", "open-plan-move-pr"]) {
    const row = AUTHORITY_TABLE.find((r) => r.id === id);
    assert.ok(row, `${id} must exist`);
    // Caller one: the operator verb, the row's own gate, verb and ledger steps, as before.
    assert.equal(row.module, "src/lib/plan-task-move.ts");
    assert.equal(row.gate, "operator-verb");
    assert.equal(row.verb, "rmd move-task --apply");
    assert.deepEqual(row.ledgerSteps, ["plan.move.step"]);
    // Caller two: the daemon's plan-task-move action, behind the host switch.
    assert.equal(row.callers?.length, 1, `${id} must name exactly one child-process caller`);
    const [caller] = row.callers!;
    assert.equal(caller.module, "src/lib/plan-task-move-janitor.ts");
    assert.match(caller.symbol, new RegExp(`^${runPlanTaskMoveTick.name}\\b`));
    assert.equal(caller.verb, `daemon ${PLAN_TASK_MOVE_ACTION} action`);
    assert.equal(caller.gate, "host-switch");
    assert.match(caller.hostSwitch ?? "", /^state\/plan-destination\.json move_public_tasks\b/);
    assert.match(caller.hostSwitch ?? "", /dispatch_ops_tasks/);
    assert.deepEqual(caller.ledgerSteps, [PLAN_MOVE_JANITOR_STEP, PLAN_MOVE_STAND_DOWN]);
    // The report: the row's own line carries operator-verb, the next line is the caller's, with its gate and switch.
    const at = lines.findIndex((l) => l.startsWith(`${id.padEnd(42)} `));
    assert.ok(at > 0, `rmd authority must print a line for ${id}`);
    assert.equal(lines[at].split(/\s+/)[1], "operator-verb");
    const callerLine = lines[at + 1] ?? "";
    assert.match(callerLine, /^\s+\S/, `the caller line under ${id} must be indented`);
    for (const part of ["daemon plan-task-move action", "host-switch", "state/plan-destination.json move_public_tasks", "src/lib/plan-task-move-janitor.ts"]) {
      assert.ok(callerLine.includes(part), `the caller line under ${id} must name ${part}: ${callerLine}`);
    }
  }
});

test("W1-T13773 criterion 4: the four detector shapes, the per-file granularity and the empty baseline of the ratchet are unchanged", () => {
  // The four shapes, exactly as origin/main carried them before the fifth was added.
  assert.equal(ASSERT_LIVE_WRITE_RE.source, String.raw`assertLiveWriteAllowed\(\s*"([a-z-]+)"`);
  assert.equal(GH_VERB_RE.source, String.raw`"-X"\s*,\s*"(POST|PATCH|PUT|DELETE)"`);
  assert.equal(GH_SUBCOMMAND_RE.source, String.raw`\[\s*"(pr|issue)"\s*,\s*"(create|merge|comment|close|review)"`);
  assert.equal(GIT_PUSH_ARGV_RE.source, String.raw`\[\s*"push"`);
  assert.deepEqual([...EXCLUDED_MODULES], ["src/lib/authority.ts", "src/lib/live-write-guard.ts"]);
  // Per file: one entry per detected file, however many writes it holds; and no allowance exists to absorb one.
  const detected = filesWithExternalWrites();
  assert.ok([...detected.keys()].every((f) => SRC_TS_RE.test(f) && !EXCLUDED_MODULES.has(f)));
  assert.ok((detected.get("src/run-task.ts")?.length ?? 0) > 1, "a rich file is still one entry carrying several reasons");
});
