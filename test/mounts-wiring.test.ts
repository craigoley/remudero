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
