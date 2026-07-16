import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadMounts, mountsPath, MountsError, resolveMount } from "../src/lib/mounts.js";
import { loadPlan, TASK_RISKS } from "../src/lib/plan.js";

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// ── The DEFECT is gone / the FIX is present (the W1-T6 root cause) ──────────

test("the spawn path INVOKES resolveMount — mounts owns the run's knobs (not a hardcoded literal)", () => {
  assert.match(runTaskSrc, /resolveMount\(/, "run-task.ts must call resolveMount on the spawn path");
  assert.match(runTaskSrc, /loadMounts\(mountsPath\(repoRoot\)\)/, "the mount is loaded from the committed repo table");
});

test("the literal `maxTurns: 60` is GONE from run-task.ts (the hardcoded implement ceiling)", () => {
  assert.doesNotMatch(runTaskSrc, /maxTurns:\s*60\b/, "the hardcoded maxTurns: 60 must be replaced by the mount");
  // the implement + resume spawns now take max_turns/model/effort FROM the mount.
  assert.match(runTaskSrc, /maxTurns:\s*mount\.maxTurns/);
  assert.match(runTaskSrc, /model:\s*mount\.model/);
  assert.match(runTaskSrc, /effort:\s*mount\.effort/);
});

// ── An implement task resolves its budget FROM the real mounts.yaml table ───

test("an implement task resolves its max_turns FROM .remudero/mounts.yaml (the flat tripwire re-base)", () => {
  const m = loadMounts(mountsPath(repoRoot));
  // §9 tripwire re-base: max_turns is a RUNAWAY CLIFF (a flat 400), not a work
  // limit — sizing is enforced pre-dispatch by the W1-T20c linter, not by a low
  // cap. (W1-T54b-1784149952116 walled at 81/80 mid-live-campaign under the old
  // medium=80 — a cap set near expected work is a work limit, not a safety limit.)
  assert.equal(resolveMount(m, "implement", "high").maxTurns, 400);
  assert.equal(resolveMount(m, "implement", "medium").maxTurns, 400);
  assert.equal(resolveMount(m, "implement", "low").maxTurns, 400);
  // The mount also carries the model + effort the spawn now passes.
  const hi = resolveMount(m, "implement", "high");
  assert.equal(typeof hi.model, "string");
  assert.equal(typeof hi.effort, "string");
});

// ── W1-T63/P10: reviewer/fix/diagnose are MOUNT-GOVERNED, not hardcoded ─────

test("resolveMount('reviewer'|'fix'|'diagnose', risk) each resolve a real mount whose max_turns >> the old 12", () => {
  const m = loadMounts(mountsPath(repoRoot));
  for (const type of ["reviewer", "fix", "diagnose"]) {
    for (const risk of TASK_RISKS) {
      const mount = resolveMount(m, type, risk);
      assert.ok(mount.maxTurns > 12, `${type}.${risk}.maxTurns (${mount.maxTurns}) must exceed the old hardcoded 12`);
      assert.equal(typeof mount.model, "string");
      assert.equal(typeof mount.effort, "string");
    }
  }
});

test("the reviewer spawn path reads its mount from resolveMount(..., 'reviewer', ...), not a hardcoded literal", () => {
  assert.doesNotMatch(runTaskSrc, /maxTurns:\s*12\b/, "the hardcoded reviewer maxTurns: 12 must be gone");
  assert.match(runTaskSrc, /resolveMount\(mountsTable,\s*"reviewer",\s*task\.risk\)/, "the reviewer mount must resolve from the (task_type='reviewer' × risk) table");
  assert.match(runTaskSrc, /maxTurns:\s*args\.reviewerMount\.maxTurns/);
  assert.match(runTaskSrc, /model:\s*args\.reviewerMount\.model/);
  assert.match(runTaskSrc, /effort:\s*args\.reviewerMount\.effort/);
});

// ── A mount miss FAILS LOUD — a routing gap is never a silent fallback ──────

test("a mount miss FAILS LOUD (unknown risk / unknown type both throw MountsError)", () => {
  const m = loadMounts(mountsPath(repoRoot));
  assert.throws(() => resolveMount(m, "implement", "extreme"), MountsError);
  assert.throws(() => resolveMount(m, "nonesuch", "medium"), MountsError);
});

test("loadMounts on a MISSING table FAILS LOUD (config gap, never a default number)", () => {
  assert.throws(() => loadMounts("/no/such/.remudero/mounts.yaml"), MountsError);
});

// ── Every task carries a valid risk (0 missing) so resolveMount can key ─────

test("every task in the real plan carries a valid risk (0 missing) and W1-T6 is high", () => {
  const plan = loadPlan(fileURLToPath(new URL("../plan/tasks.yaml", import.meta.url)));
  const bad = plan.tasks.filter((t) => !TASK_RISKS.includes(t.risk));
  assert.equal(bad.length, 0, `tasks with an invalid/missing risk: ${bad.map((t) => t.id).join(", ")}`);
  assert.equal(plan.byId.get("W1-T6")?.risk, "high"); // the cross-cutting task that died
  // A task that omits risk in yaml defaults to medium (loadPlan).
  assert.ok(TASK_RISKS.includes(plan.byId.get("W1-T1")!.risk));
});

// ── W1-T64: the retro/architect spawn is MOUNT-GOVERNED (the maxTurns:40 W1-T63 missed) ─

test("the retro/architect spawn is GONE of its hardcoded maxTurns: 40 literal", () => {
  assert.doesNotMatch(runTaskSrc, /maxTurns:\s*40\b/, "the hardcoded retro maxTurns: 40 must be replaced by the mount");
  assert.match(runTaskSrc, /maxTurns:\s*mountsTable\.architect\.maxTurns/, "the retro spawn must read its turn budget from the mounts.yaml architect row");
});

test("the retro Architect's turn budget, resolved from the real mounts.yaml, is the flat-400 tripwire (NOT the old hardcoded 40)", () => {
  const m = loadMounts(mountsPath(repoRoot));
  // §9 tripwire re-base (#90): every mount is a flat 400 — a runaway cliff, not a work limit. The retro
  // spawn reads THIS row (mountsTable.architect.maxTurns), so its budget is 400, an order of magnitude
  // above any observed retro cost — never the 40 that walled the dense retro before W1-T64.
  assert.equal(m.architect.maxTurns, 400, `architect.maxTurns (${m.architect.maxTurns}) must be the flat-400 tripwire, not 40`);
  assert.ok(m.architect.maxTurns > 40, "and it must exceed the old hardcoded 40 (the wall this fix removes)");
  assert.equal(typeof m.architect.model, "string");
  assert.equal(typeof m.architect.effort, "string");
});

// ── W1-T64: gh pr create is GUARDED by commitsAhead — never PR'd on an empty branch ─────

test("the retro's gh-pr-create fallback is guarded by commitsAhead — an empty branch takes the no-op path, never the PR call", () => {
  // Isolate the retroCommand function body so the assertion can't accidentally match the
  // OTHER commitsAhead guard (the implement no-op path, elsewhere in this file).
  const start = runTaskSrc.indexOf("async function retroCommand(");
  assert.ok(start >= 0, "retroCommand must exist in run-task.ts");
  const body = runTaskSrc.slice(start, runTaskSrc.indexOf("\nasync function", start + 1));

  const guardIdx = body.search(/if\s*\(\s*commitsAhead\(worktreePath,\s*"origin\/main"\)\s*===\s*0\s*\)/);
  const prCreateIdx = body.indexOf('"pr", "create"');
  assert.ok(guardIdx >= 0, "retroCommand must guard on commitsAhead(worktreePath, \"origin/main\") === 0");
  assert.ok(prCreateIdx >= 0, "retroCommand must still call gh pr create on the non-empty-branch path");
  assert.ok(guardIdx < prCreateIdx, "the commitsAhead guard must run BEFORE the gh pr create fallback, never after");
  // The no-op path must never fall through to the PR call — it returns straight away.
  assert.match(body, /commitsAhead\(worktreePath, "origin\/main"\) === 0\) \{\s*\n\s*log\("retro\.no_op"/);
});
