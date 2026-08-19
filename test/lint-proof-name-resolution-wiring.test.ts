import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { lintTask, proofNameResolutionViolations } from "../src/lib/task-linter.js";
import { resolveNameFilteredCandidates } from "../src/lib/review.js";
import type { NameFilterResolution } from "../src/lib/review.js";
import type { Task } from "../src/lib/plan.js";

// ── W1-T492: proofNameResolutionViolations (W1-T488) is CALLED unconditionally by lintTask, but
// its resolver is an injected dependency (opts.resolveNameFilteredCandidates) with a
// "no predicate ⇒ no opinion" contract — absent it, the check is silent everywhere lintTask runs.
// W1-T497 (#1842) wired that dependency into lintPlanCommand's --base (changed-tasks) pass; this
// file is the acceptance suite W1-T492 itself names, proving the four claims directly rather than
// by cross-referencing test/task-linter-wiring.test.ts (the --base CLI integration) and
// test/lint-proof-name-resolution.test.ts (the check's own pure-function behavior).

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");
const taskLinterSrc = readFileSync(fileURLToPath(new URL("../src/lib/task-linter.ts", import.meta.url)), "utf8");
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: over.id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "architect",
    acceptance: [{ claim: "does the thing", proof: "unit test: test/foo.test.ts" }],
    ...over,
  };
}

// ── CLAIM 1: the check produces a violation on a real plan rather than an empty array ────────

test("CLAIM 1: bound to the REAL resolveNameFilteredCandidates (a real grep over this checkout), a zero-resolving name-filtered proof produces a violation, not []", () => {
  // Built from concatenated fragments so the FULL literal never appears contiguous anywhere in
  // this checkout's source text (including this file) — grep -F would otherwise find its own
  // fixture and turn this into a false "resolved" instead of exercising the zero-match path.
  const neverRealTitle = ["ZzQwertyNeverRealSymbolW1T492", "(unmatched anywhere)"].join("");
  const t = task({
    id: "W1-T492-REAL-RESOLVER",
    acceptance: [
      {
        claim: "a symbol that has never existed in this repo resolves cleanly",
        proof: `unit test: ${neverRealTitle}`,
      },
    ],
  });
  // The SAME resolver lintPlanCommand wires in (design (i)) — never a stub — shelling out to grep
  // against the real test/ corpus of this checkout.
  const violations = proofNameResolutionViolations(t, {
    resolveNameFilteredCandidates: (rawName) => resolveNameFilteredCandidates(REPO_ROOT, rawName),
  });
  assert.notDeepEqual(violations, [], "a real, unresolvable name-filtered proof must not fall back to []");
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.check, "proof-name-resolution");
  assert.match(violations[0]!.message, /resolves to ZERO tests today/);
});

// ── CLAIM 2: the resolver is supplied by the SAME call site that already supplies moduleExists ──

test("CLAIM 2: lintPlanCommand assigns opts.resolveNameFilteredCandidates in the SAME function body as opts.moduleExists — one call site, not a second one", () => {
  const lintPlanIdx = runTaskSrc.indexOf("export async function lintPlanCommand(");
  assert.ok(lintPlanIdx >= 0, "lintPlanCommand must exist in run-task.ts");
  const nextExportedFnIdx = runTaskSrc.indexOf("export async function preflightCommand(");
  assert.ok(nextExportedFnIdx > lintPlanIdx, "preflightCommand must follow lintPlanCommand in source order");

  const moduleExistsIdx = runTaskSrc.indexOf("opts.moduleExists = ", lintPlanIdx);
  const resolverIdx = runTaskSrc.indexOf("opts.resolveNameFilteredCandidates = ", lintPlanIdx);

  assert.ok(
    moduleExistsIdx > lintPlanIdx && moduleExistsIdx < nextExportedFnIdx,
    "opts.moduleExists must be assigned inside lintPlanCommand",
  );
  assert.ok(
    resolverIdx > lintPlanIdx && resolverIdx < nextExportedFnIdx,
    "opts.resolveNameFilteredCandidates must be assigned inside lintPlanCommand — the same call site, not a new one",
  );
});

// ── CLAIM 3: a proof whose title resolves cleanly still produces no violation once wired ─────

test("CLAIM 3: a name-filtered proof that resolves to exactly one real test file is silent once the resolver is wired", () => {
  const t = task({
    id: "W1-T492-CLEAN-RESOLVE",
    acceptance: [{ claim: "the retry loop halts", proof: "unit test: retry loop halts at N attempts" }],
  });
  const resolve = (): NameFilterResolution => ({ status: "resolved", files: ["test/retry.test.ts"] });
  assert.deepEqual(proofNameResolutionViolations(t, { resolveNameFilteredCandidates: resolve }), []);
});

// ── CLAIM 4: wiring the check cannot make a task fail — severity stays "warn" on every path ──

test("CLAIM 4: both push sites inside proofNameResolutionViolations hardcode severity: \"warn\", with no opts-driven override path", () => {
  const fnStart = taskLinterSrc.indexOf("export function proofNameResolutionViolations(");
  assert.ok(fnStart >= 0, "proofNameResolutionViolations must exist in task-linter.ts");
  const fnEnd = taskLinterSrc.indexOf("// ── POST-MERGE-AMENDMENT", fnStart);
  assert.ok(fnEnd > fnStart, "the next section boundary must follow the function");
  const fnBody = taskLinterSrc.slice(fnStart, fnEnd);

  const hardcodedWarns = fnBody.match(/severity:\s*"warn"/g) ?? [];
  assert.equal(hardcodedWarns.length, 2, "both violation push sites must hardcode severity: \"warn\"");
  assert.doesNotMatch(fnBody, /severity:\s*severity\b/, "no local `severity` variable may be interpolated");
  assert.doesNotMatch(fnBody, /severity:\s*opts\./, "no opts field may override this check's severity");
});

test("CLAIM 4 (behavioral): a task whose ONLY violation is proof-name-resolution still passes lintTask (ok === true)", () => {
  const t = task({
    id: "W1-T492-NEVER-BLOCKS",
    files: ["src/lib/example.ts"],
    acceptance: [{ claim: "x", proof: "unit test: a title. with (metachars)" }],
  });
  const resolve = (): NameFilterResolution => ({ status: "absent" });
  const res = lintTask(t, { resolveNameFilteredCandidates: resolve });
  assert.equal(res.ok, true);
  assert.ok(res.violations.some((v) => v.check === "proof-name-resolution" && v.severity === "warn"));
});
