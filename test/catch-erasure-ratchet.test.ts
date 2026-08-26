// test/catch-erasure-ratchet.test.ts — W1-T2295: stop the ERASURE population from growing back.
//
// THE CENSUS (2026-08-25, 135 src files, brace-matched extraction of every catch body): 755 catch
// sites. 110 rethrow, 154 record, 172 carry the distinction in their return shape (the house
// vocabulary -- `unreadable`, `{kind: "corrupt"}`, `ok: false`, `status: "measured" | "refused"`),
// 92 are commented deliberate skips, and 227 (30.1%) return a bare null/[]/{}/""/false/0 with no
// record, no reason and no marker -- a FAILURE and an ABSENCE arriving as the same value. Beside
// them, 11 negated optional-chain conflators across 7 files fold "no row" and "row says false"
// into one boolean the same way (`!ctx.services.find(...)?.running` in src/lib/status-board.ts is
// the named example).
//
// WHY A TEST, NOT A CLAUDE.md RULE. CLAUDE.md is capped and injected every session; a prose rule
// there costs a fold the file's own baseline cannot carry, and a same-day draft rule wrote the
// very literal it was prohibiting. What actually stopped a burned id was
// test/task-id-existence-check.test.ts; the no-raw-NUL gate (test/no-raw-nul.test.ts, W1-T438)
// holds ITS population at zero the same way. This file is one more car on that train: a per-file
// RATCHET, not a target. It does not outlaw erasure -- it prices it at one in-place sentence. A
// catch whose absence and failure genuinely coincide for every consumer writes that sentence (or
// carries the distinction in its return shape, or records, or rethrows) and passes.
//
// WHAT THIS RATCHET CANNOT SEE (residue, not a gap to close here -- see W1-T2295's design notes):
// semantic erasure -- one step name for a whole read path, a channel-less return type that cannot
// render "empty" and "unreadable" differently no matter what the catch does -- is invisible to any
// regex and stays in review. This file covers exactly two operators: bare erasing catches, and
// negated optional-chain conflators (sibling family: W1-T2266 owns the ORPHAN half; W1-T2260 is
// why a required result type across all 227 seams is refused as a migration, not attempted here).
//
// THE BASELINE TABLES BELOW are today's measured population (this detector's own count, run over
// this repo's own tracked src/**/*.ts at HEAD) -- not a hand-picked target. A file entering the
// tree for the first time, or renamed, has no row and so starts at an allowance of zero. A file
// that improves needs no edit here: bareCatchViolations() only fires when actual > baseline.

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

const SRC_TS_RE = /^src\/.*\.ts$/;

function trackedSrcFiles(root: string): string[] {
  const listing = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" });
  return listing
    .split("\n")
    .filter(Boolean)
    .filter((p) => SRC_TS_RE.test(p));
}

// ─────────────────────────────── detector (a): bare erasing catches ───────────────────────────

/** Every `try { } catch (...) { }` and `.catch((e) => ...)` body in `source`, brace/paren-matched
 *  (not a full parser -- same trade-off the census itself made, and the one no-raw-nul.test.ts and
 *  the awareness-surface tests already make on this codebase's diffs). */
function extractCatchBlocks(source: string): string[] {
  const bodies: string[] = [];

  // `(?<!\.)` keeps this off `.catch(...)` calls -- those are handled below, where the param can
  // be a bare identifier (`err => ...`) instead of a parenthesized binding.
  const tryCatchRe = /(?<!\.)\bcatch\b\s*(\([^)]*\))?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = tryCatchRe.exec(source))) {
    const braceStart = source.indexOf("{", m.index);
    let depth = 1;
    let i = braceStart + 1;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
    }
    bodies.push(source.slice(braceStart + 1, i - 1));
  }

  const dotCatchRe = /\.catch\(\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*/g;
  while ((m = dotCatchRe.exec(source))) {
    const after = m.index + m[0].length;
    if (source[after] === "{") {
      let depth = 1;
      let i = after + 1;
      for (; i < source.length && depth > 0; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") depth--;
      }
      bodies.push(source.slice(after + 1, i - 1));
    } else {
      // Expression-arrow form, e.g. `.catch(() => null)` / `.catch(() => ({ entries: [] }))` --
      // read to the paren that closes the OUTER `.catch(`, tracking depth from 1 (that paren is
      // already open at `after`).
      let depth = 1;
      let i = after;
      for (; i < source.length && depth > 0; i++) {
        if (source[i] === "(") depth++;
        else if (source[i] === ")") depth--;
      }
      bodies.push(source.slice(after, i - 1));
    }
  }
  return bodies;
}

const RETHROW_RE = /\bthrow\b/;
const RECORD_RE =
  /\b(console\.(error|warn|log|info|debug)|logger\.\w+|log\.\w+|process\.stderr\.write|recordError|captureException|reportError)\s*\(/;
// The house's own present/absent-with-reason vocabulary, carried in the RETURN SHAPE:
// `ok: false`, `{kind: "corrupt"}`, `status: "measured" | "refused"`, `reason: ...`, etc.
const DISTINCTION_KEY_RE =
  /\b(ok|kind|status|reason|error|corrupt|unreadable|refused|measured|failed|success)\s*:/i;
const COMMENT_RE = /\/\/[^\n]*|\/\*[\s\S]*?\*\//;

/** A catch body passes by ANY of the four routes design (i) names: rethrow, record, carry the
 *  distinction in its return shape, or state the reason in a comment. Anything else erases a
 *  failure into the same bare value an absence would produce. */
function isBareErasingCatch(body: string): boolean {
  if (RETHROW_RE.test(body)) return false;
  if (RECORD_RE.test(body)) return false;
  if (DISTINCTION_KEY_RE.test(body)) return false;
  if (COMMENT_RE.test(body)) return false;
  return true;
}

function bareCatchCountForSource(source: string): number {
  return extractCatchBlocks(source).filter(isBareErasingCatch).length;
}

interface BareCatchViolation {
  file: string;
  actual: number;
  baseline: number;
}

/** A file with no row in `baseline` enters at an allowance of zero -- true for a brand-new file
 *  and, since lookup is purely by current path, for a renamed one too. */
function bareCatchViolations(root: string, baseline: Record<string, number>): BareCatchViolation[] {
  const violations: BareCatchViolation[] = [];
  for (const file of trackedSrcFiles(root)) {
    const actual = bareCatchCountForSource(readFileSync(join(root, file), "utf8"));
    const allowed = baseline[file] ?? 0;
    if (actual > allowed) violations.push({ file, actual, baseline: allowed });
  }
  return violations;
}

// ─────────────────────── detector (b): negated optional-chain conflators ──────────────────────

function stripCommentsPreserveOffsets(source: string): string {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  out = out.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
  return out;
}

const IDENT = "[A-Za-z_$][A-Za-z0-9_$]*";
const ARGS = "\\((?:[^()]|\\([^()]*\\))*\\)"; // one level of nested parens, e.g. `.find((s) => ...)`
const INDEX = "\\[(?:[^\\[\\]]|\\[[^\\[\\]]*\\])*\\]";
const TAIL = `(?:${ARGS}|${INDEX}|\\??\\.${IDENT})*`;

/** Every `!<chain>` / `!!<chain>` in `source` where `<chain>` contains a `?.` -- the shape that
 *  folds "no row" and "row says false" (or "" / 0 / undefined) into the same boolean, the same
 *  way a bare erasing catch folds a failure and an absence into the same return value. Comments
 *  are stripped first so a prose mention of the pattern (as directly above, in drain.ts) is never
 *  itself flagged as a site. */
function findConflatorSites(source: string): string[] {
  const clean = stripCommentsPreserveOffsets(source);
  const re = new RegExp(`(!{1,2})(${IDENT}${TAIL})`, "g");
  const sites: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const chain = m[2];
    if (chain.includes("?.")) sites.push((m[1] + chain).replace(/\s+/g, " ").trim());
  }
  return sites;
}

interface ConflatorSite {
  file: string;
  text: string;
}

/** Multiset comparison against the reviewed baseline: a site already accounted for (by file AND
 *  exact text, including duplicate occurrences) never re-trips the gate; anything beyond that is
 *  NEW and fails, naming the file and the site's own text. */
function conflatorViolations(root: string, baseline: ConflatorSite[]): ConflatorSite[] {
  const remaining = new Map<string, number>();
  for (const site of baseline) {
    const key = `${site.file}\u0000${site.text}`;
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const violations: ConflatorSite[] = [];
  for (const file of trackedSrcFiles(root)) {
    for (const text of findConflatorSites(readFileSync(join(root, file), "utf8"))) {
      const key = `${file}\u0000${text}`;
      const left = remaining.get(key) ?? 0;
      if (left > 0) remaining.set(key, left - 1);
      else violations.push({ file, text });
    }
  }
  return violations;
}

// ──────────────────────────────────── the baseline tables ─────────────────────────────────────
// Both generated by running the two detectors above over `git ls-files`-tracked src/**/*.ts at
// this task's HEAD. Reducing any number, or dropping any row, is a one-line reviewed diff -- the
// ratchet only ever tightens. Growing one, or adding a row for a file not already here, is what
// this gate exists to refuse.

const BASELINE_BARE_CATCH_COUNTS: Record<string, number> = {
  "src/lib/analytics-route.ts": 1,
  "src/lib/autonomy.ts": 1,
  "src/lib/board.ts": 3,
  "src/lib/ci-parity.ts": 3,
  "src/lib/clone-reaper.ts": 5,
  "src/lib/console-url.ts": 2,
  "src/lib/containment.ts": 2,
  "src/lib/coverage-improvement.ts": 1,
  "src/lib/daemon-health.ts": 3,
  "src/lib/daemon.ts": 1,
  "src/lib/deployer.ts": 5,
  "src/lib/digest.ts": 1,
  "src/lib/doctor.ts": 2,
  "src/lib/drain-lock.ts": 2,
  "src/lib/drain.ts": 1,
  "src/lib/escalate.ts": 2,
  "src/lib/feedback-docket.ts": 1,
  "src/lib/feedback-landing.ts": 4,
  "src/lib/feedback.ts": 5,
  "src/lib/fleet-control.ts": 2,
  "src/lib/fs-race-safe.ts": 1,
  "src/lib/github-posture.ts": 2,
  "src/lib/grep-zero-cause.ts": 1,
  "src/lib/image-drift.ts": 1,
  "src/lib/inbox.ts": 4,
  "src/lib/inflight-lock.ts": 1,
  "src/lib/init.ts": 1,
  "src/lib/install-root.ts": 2,
  "src/lib/issues-intake.ts": 1,
  "src/lib/last-seen.ts": 1,
  "src/lib/learnings.ts": 5,
  "src/lib/ledger.ts": 1,
  "src/lib/measurement-cadence.ts": 7,
  "src/lib/onboard/inventory.ts": 3,
  "src/lib/onboard/recon.ts": 1,
  "src/lib/onboard/synthesize.ts": 1,
  "src/lib/open-prs-rest.ts": 1,
  "src/lib/operator-notes.ts": 1,
  "src/lib/operator-sync.ts": 7,
  "src/lib/ops.ts": 1,
  "src/lib/panel-actions.ts": 2,
  "src/lib/panel-graph.ts": 4,
  "src/lib/panel-skill-run.ts": 1,
  "src/lib/plan-index.ts": 2,
  "src/lib/plan-pr-emitter.ts": 1,
  "src/lib/plan.ts": 3,
  "src/lib/reachability.ts": 1,
  "src/lib/relay-client.ts": 1,
  "src/lib/relint.ts": 2,
  "src/lib/retro.ts": 2,
  "src/lib/review.ts": 4,
  "src/lib/risk-judge.ts": 1,
  "src/lib/self-sync.ts": 2,
  "src/lib/serve.ts": 20,
  "src/lib/skill.ts": 4,
  "src/lib/status-board.ts": 5,
  "src/lib/status.ts": 8,
  "src/lib/task-id-reservation.ts": 1,
  "src/lib/task-linter.ts": 1,
  "src/lib/trace.ts": 1,
  "src/lib/verdict-calibration.ts": 1,
  "src/lib/worker-containment.ts": 5,
  "src/lib/worker-home.ts": 3,
  "src/lib/worker.ts": 13,
  "src/run-task.ts": 64,
  "src/spike.ts": 1,
};

const BASELINE_CONFLATOR_SITES: ConflatorSite[] = [
  { file: "src/lib/drain.ts", text: "!closedUnmergedRunBranches?.has(id)" },
  { file: "src/lib/drain.ts", text: "!closedUnmergedRunBranches?.has(id)" },
  {
    file: "src/lib/escalate.ts",
    text: "!matchesOptionalDimension(e.headSha, HEAD_SHA_LINE_RE.exec(body)?.[1])",
  },
  {
    file: "src/lib/escalate.ts",
    text: "!matchesOptionalDimension(e.cause, CAUSE_LINE_RE.exec(body)?.[1])",
  },
  { file: "src/lib/github-posture.ts", text: "!entry.cost?.trim()" },
  { file: "src/lib/plan-pr-emitter.ts", text: "!row?.html_url" },
  { file: "src/lib/plan-pr-emitter.ts", text: "!row?.html_url" },
  {
    file: "src/lib/status-board.ts",
    text: '!ctx.services.find((s) => s.service === "daemon")?.running',
  },
  { file: "src/lib/task-linter.ts", text: "!entry?.qualifier" },
  { file: "src/lib/task-linter.ts", text: "!opts.newMonolithIds?.has(task.id)" },
  { file: "src/run-task.ts", text: "!v?.headRefOid" },
  { file: "src/run-task.ts", text: "!parseReport(fullText(impl))?.prUrl" },
  { file: "src/spike.ts", text: "!!report?.prUrl" },
];

// ──────────────────────────────────────── fixture helpers ─────────────────────────────────────

function initFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "catch-erasure-ratchet-fixture-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", dir], { encoding: "utf8", env: GIT_ENV });
  return dir;
}

function commitFixture(dir: string): void {
  execFileSync("git", ["-C", dir, "add", "-A"], { encoding: "utf8", env: GIT_ENV });
  execFileSync("git", ["-C", dir, "commit", "--quiet", "-m", "fixture"], {
    encoding: "utf8",
    env: GIT_ENV,
  });
}

// ─────────────────────────────────────────────── tests ────────────────────────────────────────

// ── pure classification: the four passing routes, and the bare failure they're compared against

test("catch-erasure-ratchet: a catch stating its reason inside the braces passes the gate (acceptance criterion 3)", () => {
  const reasoned = `
    try {
      return readState();
    } catch {
      // deliberate: no consumer reads this state before the daemon boots, so a miss here is not
      // distinguishable from "not yet written" and is intentionally left silent.
      return null;
    }
  `;
  assert.equal(bareCatchCountForSource(reasoned), 0);
});

test("catch-erasure-ratchet: a catch carrying the distinction in its return shape passes the gate (acceptance criterion 4)", () => {
  const distinguishing = `
    try {
      return { ok: true, value: readState() };
    } catch (err) {
      return { ok: false, reason: String(err) };
    }
  `;
  assert.equal(bareCatchCountForSource(distinguishing), 0);
});

test("catch-erasure-ratchet: a catch that rethrows passes the gate", () => {
  const rethrowing = `
    try {
      return readState();
    } catch (err) {
      throw err;
    }
  `;
  assert.equal(bareCatchCountForSource(rethrowing), 0);
});

test("catch-erasure-ratchet: a catch that records the failure passes the gate", () => {
  const recording = `
    try {
      return readState();
    } catch (err) {
      console.error("readState failed", err);
      return null;
    }
  `;
  assert.equal(bareCatchCountForSource(recording), 0);
});

test("catch-erasure-ratchet: a catch with none of the four routes is counted as a bare erasure", () => {
  const bare = `
    try {
      return readState();
    } catch {
      return null;
    }
  `;
  assert.equal(bareCatchCountForSource(bare), 1);
});

test("catch-erasure-ratchet: a `.catch(() => null)` promise-chain erasure is counted the same as try/catch", () => {
  assert.equal(bareCatchCountForSource(`main().catch(() => null);`), 1);
  assert.equal(bareCatchCountForSource(`getJson("/x").catch(() => ({ entries: [] }));`), 1);
  assert.equal(
    bareCatchCountForSource(`getJson("/x").catch((e) => { console.error(e); return null; });`),
    0,
  );
});

// ── negated optional-chain conflator: pure detection

test("catch-erasure-ratchet: findConflatorSites finds a negated optional chain through a call with nested parens (the daemon-liveness shape)", () => {
  const src = 'applies: (ctx) => !ctx.services.find((s) => s.service === "daemon")?.running,';
  assert.deepEqual(findConflatorSites(src), [
    '!ctx.services.find((s) => s.service === "daemon")?.running',
  ]);
});

test("catch-erasure-ratchet: findConflatorSites ignores !== / != and ordinary negation with no optional chain", () => {
  const src = `if (value !== undefined && !value.trim()) { return; }`;
  assert.deepEqual(findConflatorSites(src), []);
});

test("catch-erasure-ratchet: findConflatorSites ignores a conflator-shaped string that appears only inside a comment", () => {
  const src = `// example: !closedUnmergedRunBranches?.has(id) is the whole fix\nconst x = 1;`;
  assert.deepEqual(findConflatorSites(src), []);
});

// ── wiring: the git-ls-files-driven violation functions, on isolated fixture repos

test("catch-erasure-ratchet: a file whose bare-catch count exceeds its baseline fails naming file and count (acceptance criterion 2)", () => {
  const dir = initFixtureRepo();
  try {
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
    writeFileSync(
      join(dir, "src", "lib", "erasing.ts"),
      [
        "export function a() {",
        "  try { return f(); } catch { return null; }",
        "}",
        "export function b() {",
        "  try { return g(); } catch { return []; }",
        "}",
        "",
      ].join("\n"),
    );
    commitFixture(dir);

    const violations = bareCatchViolations(dir, { "src/lib/erasing.ts": 1 });
    assert.deepEqual(violations, [{ file: "src/lib/erasing.ts", actual: 2, baseline: 1 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catch-erasure-ratchet: a brand-new file with any bare catch enters at zero baseline and fails immediately -- no allowlist to add it to", () => {
  const dir = initFixtureRepo();
  try {
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
    writeFileSync(join(dir, "src", "lib", "brand-new.ts"), `try { f(); } catch { return null; }\n`);
    commitFixture(dir);

    const violations = bareCatchViolations(dir, {});
    assert.deepEqual(violations, [{ file: "src/lib/brand-new.ts", actual: 1, baseline: 0 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catch-erasure-ratchet: a file dropping below its baseline passes with no edit to the gate (acceptance criterion 5)", () => {
  const dir = initFixtureRepo();
  try {
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
    writeFileSync(join(dir, "src", "lib", "improved.ts"), `try { return f(); } catch { return null; }\n`);
    commitFixture(dir);

    // Baseline still says 3, as if this file used to carry three bare catches -- the SAME table,
    // unedited, accepts the improvement; the ratchet never demands the table be lowered to pass.
    const violations = bareCatchViolations(dir, { "src/lib/improved.ts": 3 });
    assert.deepEqual(violations, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catch-erasure-ratchet: a new negated optional-chain conflator fails the gate naming its site (acceptance criterion 1)", () => {
  const dir = initFixtureRepo();
  try {
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
    writeFileSync(join(dir, "src", "lib", "conflator.ts"), `export const missing = !ctx.thing?.present;\n`);
    commitFixture(dir);

    const violations = conflatorViolations(dir, []);
    assert.deepEqual(violations, [{ file: "src/lib/conflator.ts", text: "!ctx.thing?.present" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catch-erasure-ratchet: a conflator site already in the reviewed baseline does not re-trip the gate", () => {
  const dir = initFixtureRepo();
  try {
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
    writeFileSync(join(dir, "src", "lib", "reviewed.ts"), `export const missing = !ctx.thing?.present;\n`);
    commitFixture(dir);

    const violations = conflatorViolations(dir, [
      { file: "src/lib/reviewed.ts", text: "!ctx.thing?.present" },
    ]);
    assert.deepEqual(violations, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the real gate, as it runs against this repo's own tracked src/**/*.ts

test("PROPERTY no tracked src/**/*.ts file's bare-catch count exceeds its baseline", () => {
  const violations = bareCatchViolations(REPO_ROOT, BASELINE_BARE_CATCH_COUNTS);
  assert.deepEqual(
    violations,
    [],
    violations.map((v) => `${v.file}: ${v.actual} bare catch(es) > baseline ${v.baseline}`).join("\n"),
  );
});

test("PROPERTY no negated optional-chain conflator exists beyond the reviewed baseline", () => {
  const violations = conflatorViolations(REPO_ROOT, BASELINE_CONFLATOR_SITES);
  assert.deepEqual(
    violations,
    [],
    violations.map((v) => `${v.file}: ${v.text}`).join("\n"),
  );
});

test("catch-erasure-ratchet: every row in both baseline tables names a currently-tracked src/**/*.ts file (no stale allowance left behind by a rename)", () => {
  const tracked = new Set(trackedSrcFiles(REPO_ROOT));
  for (const file of Object.keys(BASELINE_BARE_CATCH_COUNTS)) {
    assert.equal(tracked.has(file), true, `${file} in the bare-catch baseline is no longer tracked`);
  }
  for (const site of BASELINE_CONFLATOR_SITES) {
    assert.equal(tracked.has(site.file), true, `${site.file} in the conflator baseline is no longer tracked`);
  }
});
