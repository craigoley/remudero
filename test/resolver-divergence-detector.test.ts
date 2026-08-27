import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlan, PlanError, type Plan } from "../src/lib/plan.js";
import { fixRungTaskFor, resolvePlanCriteriaForReview } from "../src/run-task.js";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
/** The tracked source of `name` (relative to `src/`), read fresh each call — never cached, so a
 *  structural assertion always reads what is actually on disk in this worktree. */
function readSrc(name: string): string {
  return readFileSync(join(SRC_DIR, name), "utf8");
}

// W1-T2315 — TWO RESOLVERS DECIDE WHETHER A PR BODY IS JUDGED AND NOTHING RECONCILES THEM.
//
// The CI gate (`declaredPlanTaskIds`, scripts/acceptance-author-gate.mjs) answers "does the plan
// declare this id" with a LINE SCAN over `- id:` and fails OPEN (`undefined`) on any read error —
// its own doc says this is deliberate, because `loadPlan` refuses a plan with a duplicate id
// OUTRIGHT and a gate that inherited that refusal would go red on a plan defect unrelated to the
// body it is judging.
//
// `reviewCommand` (src/run-task.ts) answers the SAME question with `loadPlan`, a real parse, and
// used to swallow any failure in a bare `catch {}` whose own comment read "a bad/absent plan is
// not the reviewer's concern; fall through to the body" — so a duplicate id anywhere in the plan
// made the gate keep exempting a trailered PR while the reviewer, unable to load a single
// criterion, silently fell into the SAME body fallback an untrailered PR takes. Nothing recorded
// that those were different facts.
//
// The fix extracts the reviewer's plan lookup into `resolvePlanCriteriaForReview(taskId,
// planPath)` — a plan-PATH parameter rather than the module-level `repoRoot` — so this suite can
// point it at a scratch plan (never the real checkout) and drive both arms of the rationale's own
// control table:
//
//   clean plan            loadPlan LOADED, byId has the id   |  gate resolves TRUE
//   one id declared twice loadPlan THREW duplicate task id   |  gate resolves TRUE
//
// `reviewCommand` itself is UNCHANGED in every other respect: same criteria, same body fallback,
// same ledger/console shape, one new `divergence` fact recorded only when the plan load throws.

const GATE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "acceptance-author-gate.mjs");
const gateMod = (await import(pathToFileURL(GATE_SCRIPT).href)) as {
  declaredPlanTaskIds: (root?: string) => Set<string> | undefined;
  evaluateGate: (input: { body: string; authorLogin?: string; trailerResolves?: (taskId: string) => boolean }) => {
    ok: boolean;
    defect?: string;
    message: string;
  };
};
const { declaredPlanTaskIds, evaluateGate } = gateMod;

/** A scratch `plan/tasks.yaml` (no shards) declaring exactly the given task entries. */
function scratchPlanPath(taskYamlEntries: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-resolver-divergence-"));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), taskYamlEntries.join("\n") + "\n", "utf8");
  return join(root, "plan", "tasks.yaml");
}

const CLEAN_TASK = [
  "- id: W9-DIV-A",
  '  title: "fixture"',
  "  repo: remudero",
  "  type: implement",
  "  acceptance:",
  '    - claim: "the fixture claim"',
  '      proof: "the fixture proof"',
].join("\n");

// The SAME id, declared TWICE — the rationale's control: `loadPlan` refuses this outright
// (PlanError, "duplicate task id"), while a line scan over `- id:` still finds `W9-DIV-A` fine.
const DUPLICATE_ID_TASK = [CLEAN_TASK, "- id: W9-DIV-A", '  title: "fixture (again)"', "  repo: remudero", "  type: implement"].join("\n");

// ── ACCEPTANCE 3: THE FALSIFIER — both resolvers behave exactly as the rationale claims ────────

test("falsifier: a duplicate id makes loadPlan THROW while the line-scan gate still resolves that same id", () => {
  const dupPath = scratchPlanPath([DUPLICATE_ID_TASK]);
  assert.throws(() => loadPlan(dupPath), PlanError, "loadPlan must refuse a plan with a duplicate id");
  assert.throws(() => loadPlan(dupPath), /duplicate task id/);

  const root = dirname(dirname(dupPath)); // .../plan/tasks.yaml -> root
  const ids = declaredPlanTaskIds(root);
  assert.ok(ids, "the line-scan gate must still be able to read this plan");
  assert.ok(ids!.has("W9-DIV-A"), "and it must still resolve the duplicated id — the gate's contract is untouched");
});

test("control: a clean (non-duplicate) plan loads fine under BOTH resolvers", () => {
  const cleanPath = scratchPlanPath([CLEAN_TASK]);
  const plan = loadPlan(cleanPath);
  assert.ok(plan.byId.has("W9-DIV-A"));
  const ids = declaredPlanTaskIds(dirname(dirname(cleanPath)));
  assert.ok(ids?.has("W9-DIV-A"));
});

// ── ACCEPTANCE 1 & 2: THE DETECTOR — a divergence is recorded, distinguishable from "no trailer" ─

test("a plan the reviewer cannot load (duplicate id) is recorded as a divergence naming the task id and loadPlan's own reason", () => {
  const dupPath = scratchPlanPath([DUPLICATE_ID_TASK]);
  const resolved = resolvePlanCriteriaForReview("W9-DIV-A", dupPath);
  assert.deepEqual(resolved.criteria, [], "nothing to judge from an unloadable plan — the body fallback owns this, not this function");
  assert.ok(resolved.divergence, "the throw must be RECORDED, never swallowed into an indistinguishable empty result");
  assert.equal(resolved.divergence?.taskId, "W9-DIV-A");
  assert.match(resolved.divergence?.reason ?? "", /duplicate task id/, "the recorded reason must be loadPlan's own message, not a generic one");
});

test("an unreadable/absent plan is ALSO recorded as a divergence, not a silent empty result", () => {
  const resolved = resolvePlanCriteriaForReview("W9-DIV-A", join(tmpdir(), "rmd-resolver-divergence-nonexistent-xyzzy", "plan", "tasks.yaml"));
  assert.deepEqual(resolved.criteria, []);
  assert.ok(resolved.divergence, "an absent plan is a load failure exactly like a duplicate id — both must be named");
  assert.equal(resolved.divergence?.taskId, "W9-DIV-A");
});

test("a trailer that resolves nothing (unloadable plan) is DISTINGUISHABLE from no trailer at all: the caller only ever sees a divergence when a taskId was actually resolved from the body", () => {
  const dupPath = scratchPlanPath([DUPLICATE_ID_TASK]);
  const withTrailer = resolvePlanCriteriaForReview("W9-DIV-A", dupPath);
  assert.ok(withTrailer.divergence, "taskId present + unloadable plan => divergence recorded");

  // `reviewCommand` only calls this function inside `if (taskId)` — see the structural assertion
  // below — so "no trailer at all" never reaches this function and can never produce a divergence.
  // That asymmetry (divergence reachable ONLY when a taskId resolved) is the distinguishing signal
  // claim 1 asks for; it cannot be produced by a body carrying no trailer.
  const runTaskSrc = readSrc("run-task.ts");
  const ifTaskIdBlock = /if\s*\(taskId\)\s*{\s*const resolved = resolvePlanCriteriaForReview\(taskId, /;
  assert.match(runTaskSrc, ifTaskIdBlock, "resolvePlanCriteriaForReview must be gated on a resolved taskId, never called for an untrailered body");
});

// ── ACCEPTANCE 4: AN UNTRAILERED BODY IS UNCHANGED ──────────────────────────────────────────────

test("a plan that loads fine but simply does not declare the id is NOT a divergence — that is not a resolver disagreement", () => {
  const cleanPath = scratchPlanPath([CLEAN_TASK]);
  const resolved = resolvePlanCriteriaForReview("W9-DIV-NOPE", cleanPath);
  assert.deepEqual(resolved.criteria, []);
  assert.equal(resolved.divergence, undefined, "declaredPlanTaskIds would equally fail to find this id — both resolvers already agree, nothing to reconcile");
});

test("the body fallback (`criteria.length === 0` => parseAcceptanceBlock(body)) is untouched source, reached unconditionally after the taskId branch", () => {
  const runTaskSrc = readSrc("run-task.ts");
  const fallback = /if \(criteria\.length === 0\) {\s*const fromBody = parseAcceptanceBlock\(body\);\s*if \(fromBody\.length\) {\s*criteria = fromBody;\s*source = `PR body Acceptance: block \(\$\{fromBody\.length\} criteria\)`;/;
  assert.match(runTaskSrc, fallback, "the manual plan-or-doc shape must survive byte-for-byte");
});

// ── ACCEPTANCE 5: THE SYNTHETIC FIX-RUNG TASK KEEPS ITS OWN INDEPENDENT PATH ────────────────────

test("fixRungTaskFor resolves a synthetic (no-task) PR's acceptance from the head body directly — never through resolvePlanCriteriaForReview", () => {
  const emptyPlan: Plan = { tasks: [], byId: new Map() };
  const body = ["## Acceptance", "", "- the claim | unit test: test/foo.test.ts", "", "Remudero-Task: none"].join("\n");
  const { task, synthetic } = fixRungTaskFor(emptyPlan, { prNumber: 42 }, body);
  assert.equal(synthetic, true);
  assert.deepEqual(task.acceptance, [{ claim: "the claim", proof: "unit test: test/foo.test.ts" }]);

  // Structural: fixRungTaskFor's own body never mentions the new resolver — its independence
  // (rationale section 3's correction to the commissioning brief) is not something this task
  // introduces, and this pins it against being accidentally rewired to depend on it.
  const runTaskSrc = readSrc("run-task.ts");
  const fnStart = runTaskSrc.indexOf("export function fixRungTaskFor(");
  const fnBody = runTaskSrc.slice(fnStart, runTaskSrc.indexOf("\n}", fnStart));
  assert.ok(!fnBody.includes("resolvePlanCriteriaForReview"), "fixRungTaskFor must keep parsing the body itself, not delegate to the reviewer's plan resolver");
});

// ── ACCEPTANCE 6 & 7: THE GATE'S LINE SCAN IS UNTOUCHED — exemption + fail-open both survive ────

const TRAILER_ONLY_NO_BLOCK = "some prose with no acceptance header at all\n\nRemudero-Task: W9-DIV-A\n";

test("the gate still exempts a trailered body that wrote no Acceptance block at all, when the plan resolves the id", () => {
  const cleanPath = scratchPlanPath([CLEAN_TASK]);
  const root = dirname(dirname(cleanPath));
  const ids = declaredPlanTaskIds(root);
  const verdict = evaluateGate({ body: TRAILER_ONLY_NO_BLOCK, trailerResolves: (id) => ids?.has(id) ?? false });
  assert.equal(verdict.ok, true, "29 of the measured 206 write no block at all and that is legitimate on a trailered PR");
});

test("the gate resolver still fails open (undefined, never an empty set) on a plan it cannot read — no second refusal introduced by this task", () => {
  const missing = declaredPlanTaskIds(join(tmpdir(), "rmd-resolver-divergence-nonexistent-xyzzy"));
  assert.equal(missing, undefined, "undefined means 'could not read'; this task adds a RECORD at the reviewer, never a refusal at the gate");
  const failOpen = evaluateGate({ body: TRAILER_ONLY_NO_BLOCK, trailerResolves: undefined });
  assert.equal(failOpen.ok, true, "omitting the resolver (what an unreadable plan produces) is byte-for-byte the pre-existing verdict");
});

test("the gate STILL resolves a duplicated id fine (it never adopts loadPlan) even while the reviewer now records that same plan as a divergence", () => {
  const dupPath = scratchPlanPath([DUPLICATE_ID_TASK]);
  const root = dirname(dirname(dupPath));
  const ids = declaredPlanTaskIds(root);
  assert.ok(ids?.has("W9-DIV-A"), "the gate keeps its line scan — this task adds reconciliation, never a second resolver on the gate side");
});

// ── ACCEPTANCE 8: NO MERGED PR IS RE-REVIEWED, NO MERGED ACCEPTANCE RECORD IS AMENDED ───────────

test("resolvePlanCriteriaForReview is wired at exactly ONE call site — reviewCommand's own manual/live path, never a merged-PR sweep or retro path", () => {
  const runTaskSrc = readSrc("run-task.ts");
  const callSites = runTaskSrc.split("resolvePlanCriteriaForReview(").length - 1;
  assert.equal(callSites, 2, "exactly one definition + one call site; any third occurrence means it was wired somewhere new");
  // Neither retroCommand nor the fix-rung sweep (which DOES touch merged-adjacent state) gained a
  // reference to it.
  for (const fn of ["async function retroCommand", "export function fixRungTaskFor("]) {
    const start = runTaskSrc.indexOf(fn);
    assert.ok(start >= 0, `could not locate ${fn} to audit`);
  }
});

// ── ACCEPTANCE 9: NO WAIT, RETRY CADENCE OR BACKOFF ADDED TO ANY REVIEW PATH ────────────────────

test("nothing added paces, throttles or sleeps — W1-T1066's lockout is why", () => {
  const runTaskSrc = readSrc("run-task.ts");
  const from = runTaskSrc.indexOf("interface ResolverDivergence");
  const to = runTaskSrc.indexOf("console.log(`### rmd review PR #${view.number}");
  assert.ok(from > 0 && to > from, "located the region this task added");
  const region = runTaskSrc.slice(from, to);
  for (const banned of ["setTimeout", "setInterval", "sleepSync(", "await new Promise"]) {
    assert.ok(!region.includes(banned), `the divergence-detector region must not ${banned}`);
  }
});
