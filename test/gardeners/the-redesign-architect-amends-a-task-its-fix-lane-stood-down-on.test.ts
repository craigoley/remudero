import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Clock } from "#src/lib/clock.js";
import { gardenStatePath, readGardenState, runGardenAsync, type GardenerDeps } from "#src/lib/gardener.js";
import type { PlanInventory } from "#src/lib/plan-gardener.js";
import { machineShardFilingRefusal, machineShardLandingRefusal } from "#src/lib/machine-filing.js";
import { parseTasksFromYaml } from "#src/lib/plan.js";
import { taskRulingPin } from "#src/lib/task-linter.js";
import {
  applyRedesignEdit, buildRedesignSources, parseRedesignAnswer, POINTER_STAMP_RE, REDESIGN_AFTER_MS, REDESIGN_JUDGED_STEP, REDESIGN_MARKER_RE, redesignCandidates, redesignEditRefusal, redesignGardenSpec,
  type RedesignSources,
} from "#src/lib/redesign-gardener.js";
import { MACHINE_LANE_HEAD_RE } from "#src/lib/sweep.js";
import { REGISTERED_GARDEN_NAMES } from "#src/lib/garden-registry.js";

// 2026-10-29: #15404 (W1-T10661) read "fix needs design at this exact head" for hours and its shard carried a
// refusal-amendment pointer ("an Architect must make the change above"), but no Architect existed to make it.

const NOW = Date.parse("2026-10-30T03:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const ID = "W1-T10661";
const REL = `plan/tasks.d/${ID}-check-body-coverage.yaml`;
const CLAIM = "a recorded check:body-coverage round, replayed through the real code path in src/lib/prompt-render.ts, is prevented or self-healed without dispatching a fix round";
const HEAD = "f4a25ce82040a489db41686f92b9c233cc6eaf94";
type Row = Record<string, unknown>;

const STAMP = "2026-10-29T11:03:31.670Z";
const shard = (pointer = true, stamp = STAMP) => [
  `- id: ${ID}`,
  '  title: "THE CI FRICTION GARDENER\'S COSTLIEST OPEN CAUSE: check:body-coverage"',
  "  repo: remudero", "  depends_on: []", "  type: implement", "  verify: human", "  risk: low", "  priority: 1.3",
  ...(pointer ? [
    `  # refusal-amendment (W1-T10661, run DAEMON-1@f4a25ce, ${stamp}): the worker refused criterion 1 [outside-declared-files] — proposed widen-files`,
    "  #   worker evidence: The declared renderer cannot enforce report publication or prevent fix dispatch when proofs are omitted.",
    "  #   this task is held from dispatch until its record changes; an Architect must make the change above",
  ] : []),
  "  status: queued", "  attempts: 0",
  "  files:", "    - src/lib/prompt-render.ts", "    - test/worker/check-body-coverage.test.ts",
  "  acceptance:", `    - claim: "${CLAIM}"`, '      proof: "unit test: test/worker/check-body-coverage.test.ts"',
  '  note: "Filed by the ci-friction gardener."', "",
].join("\n");

const heldRow = (atMs: number): Row => ({
  step: "sweep.disposed", pr_number: 15404, task_id: ID, head_sha: HEAD, disposition: "refused-escalate", ts: iso(atMs),
  reason: "fix needs design at this exact head (round R:1:1) — the declared renderer cannot enforce report publication",
});

const AMEND = `REDESIGN: ${JSON.stringify({
  verdict: "amend", reason: "the fix needs the renderer's own suite, which files: did not declare",
  files_add: ["test/worker/prompt-render.test.ts"], proofs: [{ criterion: 1, proof: "unit test: test/worker/check-body-coverage.test.ts" }],
  amendment: "Prevent the round in src/lib/prompt-render.ts and replay the recorded round in test/worker/prompt-render.test.ts.",
})}`;

function world(t: { after: (fn: () => void) => void }, opts: { rows?: Row[]; pointer?: boolean; stamp?: string; answers?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-redesign-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, "src", "cli", "commands"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "src", "cli", "commands", "fix.ts"), "export {};\n");
  writeFileSync(join(root, REL), shard(opts.pointer ?? true, opts.stamp));
  const rows: Row[] = [...(opts.rows ?? [])];
  const prompts: string[] = [];
  const answers = [...(opts.answers ?? [AMEND])];
  const landed: Array<{ paths: string[]; title: string; body: string }> = [];
  const clock: Clock = { now: () => NOW, date: () => new Date(NOW), iso: () => iso(NOW) };
  const plan = (): PlanInventory => {
    const tasks = parseTasksFromYaml(readFileSync(join(root, REL), "utf8"), REL);
    return { open: tasks, all: tasks, shards: new Map([[ID, REL]]) };
  };
  const sources: Partial<RedesignSources> = {
    clock, plan,
    readShard: (rel) => readFileSync(join(root, rel), "utf8"),
    ledger: (steps, since) => rows.filter((r) => steps.includes(String(r.step)) && String(r.ts) >= since),
    pathKind: (rel) => { const st = statSync(join(root, rel), { throwIfNoEntry: false }); return st === undefined ? "none" : st.isFile() ? "file" : "dir"; },
    judgeText: async (prompt) => { prompts.push(prompt); return answers.shift() ?? 'REDESIGN: {"verdict":"grill","reason":"no answer"}'; },
    // The production reader of this garden's state file, which every pass in these tests writes.
    settled: () => buildRedesignSources(deps, { ledger: sources.ledger }).settled(),
  };
  const deps: GardenerDeps = {
    stateDir: join(root, "state"), repoRoot: root, clock, seed: 1,
    log: (step, extra = {}) => { rows.push({ task_id: "DAEMON", ...extra, step, ts: iso(NOW) }); },
    mergedPlanLint: () => undefined,
    openWorkspace: () => ({ root, land: (p) => { landed.push(p); return "https://example.test/pull/901"; }, dispose: () => {} }),
  };
  return { root, rows, prompts, landed, sources, deps, read: () => readFileSync(join(root, REL), "utf8") };
}

test("the redesign Architect amends a task its fix lane stood down on, keeping every claim and growing files only", async (t) => {
  const w = world(t, { rows: [heldRow(NOW - 3 * 60 * MIN), heldRow(NOW - 5 * MIN)] });
  await runGardenAsync(redesignGardenSpec(w.deps, w.sources), w.deps);
  assert.equal(w.prompts.length, 1, "one Architect spawn for the one held task");
  assert.match(w.prompts[0]!, /Standing rule 16/);
  assert.match(w.prompts[0]!, /refusal-amendment pointer in the shard/);
  assert.match(w.prompts[0]!, /PR #15404 at head f4a25ce is held: fix needs design at this exact head/);
  assert.equal(w.landed.length, 1);
  assert.match(w.landed[0]!.title, /the Architect amends W1-T10661 after its fix lane stood down/);
  const [after] = parseTasksFromYaml(w.read(), REL);
  assert.deepEqual(after!.acceptance!.map((c) => c.claim), [CLAIM], "the claim is untouched");
  assert.deepEqual(after!.files, ["src/lib/prompt-render.ts", "test/worker/check-body-coverage.test.ts", "test/worker/prompt-render.test.ts"]);
  assert.match(after!.amendment!, /by the redesign Architect \(machine, rule 16\): the fix needs the renderer's own suite/);
  assert.match(after!.amendment!, /Prevent the round in src\/lib\/prompt-render\.ts/);
  const marker = w.read().split("\n").map((line) => REDESIGN_MARKER_RE.exec(line)).find((m) => m !== null);
  assert.ok(marker, "the shard carries the marker its PR's proof greps");
  assert.ok(w.landed[0]!.body.includes(`proof: "grep: # redesign: signature=${marker[1]} in ${REL}"`));
  assert.ok(!w.rows.some((r) => r.step === REDESIGN_JUDGED_STEP && r.outcome === "amend"), "an answer is not a landing");
  assert.deepEqual(readGardenState(gardenStatePath(w.deps.stateDir, "redesign"), ["amend"]).pending?.targets,
    [{ class: "amend", target: marker[1] }], "the open PR carries the signature it amends");
  // The same evidence is never asked about again.
  assert.equal(redesignCandidates({ ...(w.sources as RedesignSources) }).length, 0);
});

test("a hold younger than an hour, or one the sweep no longer disposes, is left to the fix lane", (t) => {
  const young = world(t, { pointer: false, rows: [heldRow(NOW - (REDESIGN_AFTER_MS - MIN)), heldRow(NOW - MIN)] });
  assert.equal(redesignCandidates(young.sources as RedesignSources).length, 0);
  const gone = world(t, { pointer: false, rows: [heldRow(NOW - 10 * 60 * MIN), heldRow(NOW - 3 * 60 * MIN)] });
  assert.equal(redesignCandidates(gone.sources as RedesignSources).length, 0, "no disposition in two hours: the PR left the sweep");
  const held = world(t, { pointer: false, rows: [heldRow(NOW - 2 * 60 * MIN), heldRow(NOW - MIN)] });
  assert.equal(redesignCandidates(held.sources as RedesignSources).length, 1);
  // An interrupted hold restarts its hour, and an unrelated refusal before it does not age it.
  const interrupted = world(t, { pointer: false, rows: [heldRow(NOW - 3 * 60 * MIN),
    { ...heldRow(NOW - 50 * MIN), disposition: "blocked-fixable", reason: "fix round dispatched" }, heldRow(NOW - 40 * MIN), heldRow(NOW - MIN)] });
  assert.equal(redesignCandidates(interrupted.sources as RedesignSources).length, 0, "a fix round between holds restarts the hour");
  const unrelated = world(t, { pointer: false, rows: [{ ...heldRow(NOW - 3 * 60 * MIN), reason: "instrument edit only the operator can grant" },
    heldRow(NOW - 30 * MIN), heldRow(NOW - MIN)] });
  assert.equal(redesignCandidates(unrelated.sources as RedesignSources).length, 0, "an unrelated refusal does not age a design hold");
  const otherHead = world(t, { pointer: false, rows: [{ ...heldRow(NOW - 3 * 60 * MIN), head_sha: "0".repeat(40) },
    heldRow(NOW - 30 * MIN), heldRow(NOW - MIN)] });
  assert.equal(redesignCandidates(otherHead.sources as RedesignSources).length, 0, "a hold on an older head does not age this one");
});

test("a refusal pointer is the Architect's once no live PR of its task is inside its fix lane's hour", (t) => {
  // A task whose PR the sweep still disposes is that PR's to judge, so an aged pointer does not overrule a young hold.
  const youngWithPointer = world(t, { rows: [heldRow(NOW - 30 * MIN), heldRow(NOW - MIN)] });
  assert.equal(redesignCandidates(youngWithPointer.sources as RedesignSources).length, 0, "an aged pointer waits on a young hold");
  const movingWithPointer = world(t, { rows: [{ ...heldRow(NOW - MIN), disposition: "blocked-fixable", reason: "fix round dispatched" }] });
  assert.equal(redesignCandidates(movingWithPointer.sources as RedesignSources).length, 0, "an aged pointer waits on a PR that moves");
  // A refusal-amendment pointer is aged by its own stamp, and a pointer with no stamp to age is never the Architect's.
  const fresh = world(t, { stamp: iso(NOW - (REDESIGN_AFTER_MS - MIN)) });
  assert.equal(redesignCandidates(fresh.sources as RedesignSources).length, 0, "a pointer younger than an hour waits");
  const unstamped = world(t, { stamp: "sometime" });
  assert.equal(redesignCandidates(unstamped.sources as RedesignSources).length, 0, "an unstamped pointer is not aged as old");
  const aged = world(t, { stamp: iso(NOW - REDESIGN_AFTER_MS) });
  assert.equal(redesignCandidates(aged.sources as RedesignSources).length, 1);
  // The pointer holds its task from dispatch until the record changes, so a PR that left the sweep leaves a frozen
  // task: hours or a week later, nothing but an amendment moves it, and the answer is the same at both ages.
  for (const lastSweptMs of [3 * 60 * MIN, 8 * 24 * 60 * MIN]) {
    const gone = world(t, { rows: [heldRow(NOW - lastSweptMs - 60 * MIN), heldRow(NOW - lastSweptMs)] });
    assert.equal(redesignCandidates(gone.sources as RedesignSources).length, 1, `a PR last swept ${lastSweptMs / MIN} min ago owns nothing`);
  }
  // The sweep writes no row when a PR closes, so a PR is live while it was disposed in the last two hours: a closed PR's
  // task waits out that window, and no longer.
  const justClosed = world(t, { rows: [{ ...heldRow(NOW - 90 * MIN), disposition: "blocked-fixable", reason: "fix round dispatched" }] });
  assert.equal(redesignCandidates(justClosed.sources as RedesignSources).length, 0, "a PR disposed 90 min ago may still be open");
  const closed = world(t, { rows: [{ ...heldRow(NOW - 121 * MIN), disposition: "blocked-fixable", reason: "fix round dispatched" }] });
  assert.equal(redesignCandidates(closed.sources as RedesignSources).length, 1, "past the window, the closed PR owns nothing");
  // Each run appends its own pointer above status:, so the newest stamp ages the set and every pointer is evidence.
  const second = (stamp: string) => (w2: ReturnType<typeof world>) => writeFileSync(join(w2.root, REL), w2.read().replace("  status: queued",
    `  # refusal-amendment (W1-T10661, run W1-T10661-1793330000000, ${stamp}): the worker refused criterion 1 [outside-declared-files] — proposed widen-files\n  #   this task is held from dispatch until its record changes; an Architect must make the change above\n  status: queued`));
  const restacked = world(t);
  second(iso(NOW - 10 * MIN))(restacked);
  assert.equal(redesignCandidates(restacked.sources as RedesignSources).length, 0, "a fresh stand-down restarts the hour");
  const stacked = world(t);
  second(iso(NOW - 2 * 60 * MIN))(stacked);
  const [both2] = redesignCandidates(stacked.sources as RedesignSources);
  assert.match(both2!.evidence.join("\n"), /run DAEMON-1@f4a25ce[\s\S]*run W1-T10661-1793330000000/, "every pointer is evidence");
  // Every live PR of the task must qualify: an older PR's long hold does not speak for a younger PR's young one.
  const twoPrs = world(t, { rows: [heldRow(NOW - 3 * 60 * MIN), heldRow(NOW - MIN),
    { ...heldRow(NOW - 20 * MIN), pr_number: 15405 }, { ...heldRow(NOW - MIN), pr_number: 15405 }] });
  const [both] = redesignCandidates(twoPrs.sources as RedesignSources);
  assert.ok(both!.evidence.some((e) => e.startsWith("PR #15404")), "the qualifying hold is still evidence");
  assert.ok(!both!.evidence.some((e) => e.includes("refusal-amendment pointer")), "the pointer waits on the younger PR's hour");
});

test("an amend is recorded by its landing: a failed filing re-asks, an open PR holds it, and a close declines it", async (t) => {
  const w = world(t, { answers: [AMEND, AMEND] });
  // The landing edits a disposable checkout, as production's does, so only a merge marks the live shard.
  const ws = mkdtempSync(join(tmpdir(), "rmd-redesign-ws-"));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  cpSync(join(w.root, "plan"), join(ws, "plan"), { recursive: true });
  let land = (): string => { throw new Error("gh pr create died"); };
  let state: "open" | "closed" = "open";
  const deps: GardenerDeps = { ...w.deps, openWorkspace: () => ({ root: ws, land: () => land(), dispose: () => {} }), prState: () => state };
  await runGardenAsync(redesignGardenSpec(deps, w.sources), deps);
  assert.equal(w.prompts.length, 1);
  assert.ok(!w.rows.some((r) => r.step === REDESIGN_JUDGED_STEP), "a filing that failed records no verdict");
  assert.equal(redesignCandidates(buildRedesignSources(deps, w.sources)).length, 1, "the signature is asked again after the backoff");
  cpSync(join(w.root, "plan"), join(ws, "plan"), { recursive: true });
  land = () => "https://example.test/pull/902";
  const later = { ...deps, clock: { now: () => NOW + 60 * MIN, date: () => new Date(NOW + 60 * MIN), iso: () => iso(NOW + 60 * MIN) } };
  await runGardenAsync(redesignGardenSpec(later, w.sources), later);
  assert.equal(w.prompts.length, 2, "the retry asks once more");
  assert.equal(w.landed.length, 0, "the landing went to the disposable checkout's port, not the fixture's");
  assert.equal(redesignCandidates(buildRedesignSources(deps, w.sources)).length, 0, "the open PR holds its signature");
  assert.ok(!w.rows.some((r) => r.step === REDESIGN_JUDGED_STEP), "the open PR, not a verdict, holds it");
  state = "closed";
  await runGardenAsync(redesignGardenSpec(later, w.sources), later);
  const after = readGardenState(gardenStatePath(deps.stateDir, "redesign"), ["amend"]);
  assert.equal(after.pending, undefined);
  assert.equal(after.declinedTargets?.length, 1, "the close declines the signature");
  assert.equal(redesignCandidates(buildRedesignSources(deps, w.sources)).length, 0, "a declined signature is not asked again");
  assert.equal(w.prompts.length, 2);
  // The framework hands candidates its declined list too; an action whose signature was declined never acts.
  const action = { class: "amend" as const, target: ID, reason: "r", shard: REL, signature: after.declinedTargets![0]!.target, edit: { reason: "r", filesAdd: [], proofs: [], amendment: "a" } };
  const spec = redesignGardenSpec(deps, w.sources);
  const inv = { candidates: 1, actions: [action], outcomes: [] };
  assert.deepEqual(spec.candidates(inv, () => 0, after.declinedTargets), []);
  assert.deepEqual(spec.candidates(inv, () => 0), [action]);
});

test("a landed amendment is not asked again after the framework releases its still-open PR at 24 h", async (t) => {
  const w = world(t, { answers: [AMEND, AMEND] });
  const ws = mkdtempSync(join(tmpdir(), "rmd-redesign-ws-"));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  cpSync(join(w.root, "plan"), join(ws, "plan"), { recursive: true });
  const at = (ms: number): GardenerDeps => ({ ...w.deps, openWorkspace: () => ({ root: ws, land: () => "https://example.test/pull/903", dispose: () => {} }),
    prState: () => "open", clock: { now: () => ms, date: () => new Date(ms), iso: () => iso(ms) } });
  await runGardenAsync(redesignGardenSpec(at(NOW), w.sources), at(NOW));
  assert.equal(w.prompts.length, 1);
  assert.ok(readGardenState(gardenStatePath(w.deps.stateDir, "redesign"), ["amend"]).pending);
  await runGardenAsync(redesignGardenSpec(at(NOW + 26 * 60 * MIN), w.sources), at(NOW + 26 * 60 * MIN));
  assert.equal(readGardenState(gardenStatePath(w.deps.stateDir, "redesign"), ["amend"]).pending, undefined, "the framework released it");
  assert.equal(redesignCandidates(buildRedesignSources(at(NOW + 26 * 60 * MIN), w.sources)).length, 0, "its landing still holds the signature");
  assert.equal(w.prompts.length, 1, "and no Architect is spawned for it again");
});

test("a machine record's amendment drops its stale ruling and parks for its judge, and a guard refusal is a recorded verdict", async (t) => {
  // 2026-10-30 review: on W1-T10781 (author_class: machine, risk_ruling pinned) a proof-only amendment left the pin stale,
  // and machine-author-verify refuses a stale pin at landing.
  const w = world(t, { answers: [AMEND] });
  const [base] = parseTasksFromYaml(w.read(), REL);
  const machine = (pin: string) => w.read().replace("  attempts: 0\n", "  attempts: 0\n  author_class: machine\n  origin: \"ci-friction:check-body-coverage#r1\"\n")
    .replace(/\n$/, "") + `\n  risk_ruling:\n    verdict: "low"\n    action: proceed\n    confidence: 0.8\n    reasons:\n      - "declared files only"\n    judged_at: "2026-10-28T03:43:51.964Z"\n    pin: "${pin}"\n`;
  // Machine admission requires every declared path to exist, so the record's files and the added suite are on disk.
  for (const rel of ["src/lib/prompt-render.ts", "test/worker/check-body-coverage.test.ts", "test/worker/prompt-render.test.ts"]) {
    mkdirSync(join(w.root, rel, ".."), { recursive: true });
    writeFileSync(join(w.root, rel), "export {};\n");
  }
  const unpinned = machine("0".repeat(64));
  writeFileSync(join(w.root, REL), machine(taskRulingPin(parseTasksFromYaml(unpinned, REL)[0]!)));
  assert.ok(base);
  assert.equal(machineShardFilingRefusal(w.read(), REL, { pathExists: () => true }), undefined, "the judged record lands as filed");
  await runGardenAsync(redesignGardenSpec(w.deps, w.sources), w.deps);
  assert.equal(w.landed.length, 1, "the real landing guard passed it");
  const [after] = parseTasksFromYaml(w.read(), REL);
  assert.equal(after!.risk_ruling, undefined, "the stale ruling is dropped");
  assert.equal(after!.verify, "human", "and the record parks for the machine-filing judge");
  assert.deepEqual(after!.acceptance!.map((c) => c.claim), [CLAIM]);
  assert.equal(machineShardLandingRefusal(w.root, [REL], () => true), undefined);
  // An amendment the guard would refuse (a second concern at risk: low) is refused before landing, never re-asked.
  const wide = world(t, { answers: [AMEND.replace("test/worker/prompt-render.test.ts", "src/cli/commands/fix.ts")] });
  await runGardenAsync(redesignGardenSpec(wide.deps, wide.sources), wide.deps);
  assert.equal(wide.landed.length, 0);
  assert.ok(wide.rows.some((r) => r.step === REDESIGN_JUDGED_STEP && r.outcome === "refused" && /sizing/.test(String(r.reason))));
  assert.equal(redesignCandidates(wide.sources as RedesignSources).length, 0, "the refused signature is not asked again");
  assert.equal(wide.read(), shard(), "the shard is untouched");
});

test("the pointer stamp is read only from the head refusal-amendment.ts writes", () => {
  assert.equal(POINTER_STAMP_RE.test(`  # refusal-amendment (W1-T1, run W1-T1-17, ${STAMP}): the worker refused`), true);
  assert.equal(POINTER_STAMP_RE.test(`  # refusal-amendment (W1-T1, ${STAMP}): the worker refused`), false, "no run, no stamp");
  assert.equal(POINTER_STAMP_RE.test("  # refusal-amendment (W1-T1, run W1-T1-17, yesterday): the worker refused"), false);
});

test("a GRILL answer lands nothing and the same evidence is not asked again", async (t) => {
  const w = world(t, { answers: ['REDESIGN: {"verdict":"grill","reason":"the claim itself needs the operator"}'] });
  await runGardenAsync(redesignGardenSpec(w.deps, w.sources), w.deps);
  assert.equal(w.landed.length, 0);
  assert.ok(w.rows.some((r) => r.step === REDESIGN_JUDGED_STEP && r.outcome === "grill" && r.task_id === ID));
  assert.equal(redesignCandidates(w.sources as RedesignSources).length, 0);
  assert.equal(w.read(), shard(), "the shard is untouched");
  // The unchanged pointer is the same evidence a week later: a verdict older than the evidence window still counts.
  const verdict = w.rows.find((r) => r.step === REDESIGN_JUDGED_STEP)!;
  verdict.ts = iso(NOW - 8 * 24 * 60 * MIN);
  assert.equal(redesignCandidates(w.sources as RedesignSources).length, 0, "an eight-day-old GRILL is not asked again");
});

test("rule 16 and the operator's grants are enforced in code, whatever the Architect answers", (t) => {
  const w = world(t);
  const task = parseTasksFromYaml(shard(), REL)[0]!;
  const exists = w.sources.pathKind!;
  const edit = (over: object) => ({ filesAdd: [], proofs: [], amendment: "x", reason: "r", ...over });
  for (const path of [".github/workflows/ci.yml", "deploy/Dockerfile", "plan/policy.yaml", "scripts/coverage-ratchet.mjs", "src/lib/review.ts"]) {
    assert.match(String(redesignEditRefusal(task, edit({ filesAdd: [path] }), () => "file" as const)), /operator-only grant/, path);
  }
  assert.match(String(redesignEditRefusal(task, edit({ filesAdd: ["../escape.ts"] }), exists)), /not a plain repo path/);
  // Only the canonical spelling reaches the grant lists, so a spelling that resolves to a grant is refused, never passed.
  for (const path of ["./deploy/Dockerfile", "./src/lib/review.ts", "src//lib/review.ts", "src/lib/./review.ts", "src/lib/"]) {
    assert.match(String(redesignEditRefusal(task, edit({ filesAdd: [path] }), () => "file" as const)), /not a plain repo path/, path);
  }
  assert.match(String(redesignEditRefusal(task, edit({ filesAdd: ["src/lib/invented.ts"] }), exists)), /not an existing file/);
  assert.match(String(redesignEditRefusal(task, edit({ filesAdd: ["src/cli"] }), exists)), /not an existing file/, "a directory grants nothing");
  assert.equal(redesignEditRefusal(task, edit({ filesAdd: ["test/new-one.test.ts"] }), exists), undefined, "a new test may be declared");
  mkdirSync(join(w.root, "test", "gardeners"), { recursive: true });
  assert.match(String(redesignEditRefusal(task, edit({ filesAdd: ["test/gardeners"] }), exists)), /not an existing file/, "an existing test directory is no new test");
  assert.match(String(redesignEditRefusal(task, edit({ proofs: [{ criterion: 2, proof: "unit test: x" }] }), exists)), /does not have/);
  assert.match(String(redesignEditRefusal(task, edit({ proofs: [{ criterion: 1, proof: "the test passes" }] }), exists)), /dialect prefix/);
  // A reason with newlines stays inside the amendment scalar, so it can never write a key of its own.
  const smuggled = applyRedesignEdit(shard(), REL, edit({ reason: "x\n  dispatch_hold: true\n  priority: 9" }), "0123456789abcdef", "2026-10-30");
  const parsed = parseTasksFromYaml((smuggled as { text: string }).text, REL)[0]! as unknown as Record<string, unknown>;
  assert.equal(parsed.dispatch_hold, undefined, "no key escapes the amendment block");
  assert.equal(parsed.priority, 1.3);
  assert.match(String(parsed.amendment), /rule 16\): x dispatch_hold: true priority: 9/);
  // A path the Architect names twice is declared once.
  const twice = applyRedesignEdit(shard(), REL, edit({ filesAdd: ["src/cli/commands/fix.ts", "src/cli/commands/fix.ts"] }), "0123456789abcdef", "2026-10-30");
  assert.deepEqual(parseTasksFromYaml((twice as { text: string }).text, REL)[0]!.files,
    ["src/lib/prompt-render.ts", "test/worker/check-body-coverage.test.ts", "src/cli/commands/fix.ts"]);
  // A shard with two records cannot be edited safely, and the edited text must still parse as the same record.
  const two = `${shard()}${shard().replace(ID, "W1-T10662")}`;
  assert.match(String((applyRedesignEdit(two, REL, edit({}), "0123456789abcdef", "2026-10-30") as { refused: string }).refused), /2 records/);
});

test("the redesign garden is registered wherever a garden is named", () => {
  assert.ok((REGISTERED_GARDEN_NAMES as readonly string[]).includes("redesign"));
  assert.ok(MACHINE_LANE_HEAD_RE.test("redesign-garden-1793322451897"), "its plan PRs file from a machine-lane head");
});

test("an Architect answer that is not one REDESIGN: JSON line, with a reason and an amendment, is unparseable", () => {
  assert.equal(parseRedesignAnswer("I would widen files.").verdict, "unparseable");
  assert.match((parseRedesignAnswer("REDESIGN: {not json") as { reason: string }).reason, /not JSON/);
  assert.equal(parseRedesignAnswer('REDESIGN: {"verdict":"maybe"}').verdict, "unparseable");
  assert.equal(parseRedesignAnswer('REDESIGN: {"verdict":"amend","reason":"r"}').verdict, "unparseable", "an amend needs an amendment");
  assert.equal(parseRedesignAnswer('REDESIGN: {"verdict":"grill"}').verdict, "grill");
});

test("the shard marker reads only a whole 16-hex signature line, so a mangled marker re-asks", () => {
  assert.equal(REDESIGN_MARKER_RE.test("  # redesign: signature=0123456789abcdef"), true);
  assert.equal(REDESIGN_MARKER_RE.test("  # redesign: signature=0123456789abcdeg"), false, "a non-hex signature is not a marker");
  assert.equal(REDESIGN_MARKER_RE.test("  # redesign: signature=0123456789abcdef0"), false, "a longer signature is not this marker");
  assert.equal(REDESIGN_MARKER_RE.test("# redesign: signature=0123456789abcdef"), false, "only the record's own indent counts");
});

test("an amendment is appended to the shard's existing amendment block, which keeps its operator history", () => {
  const withBlock = shard().replace('  note: "Filed by the ci-friction gardener."',
    '  note: "Filed by the ci-friction gardener."\n  amendment: |\n    2026-10-29, by operator decision: criterion 1 restated.');
  const edit = { filesAdd: [], proofs: [], amendment: "Build the dispatch guard first.", reason: "the guard belongs in fix.ts" };
  const out = applyRedesignEdit(withBlock, REL, edit, "0123456789abcdef", "2026-10-30") as { text: string };
  const [task] = parseTasksFromYaml(out.text, REL);
  assert.match(task!.amendment!, /^2026-10-29, by operator decision: criterion 1 restated\.\n\n2026-10-30, by the redesign Architect/);
  assert.match(task!.amendment!, /Build the dispatch guard first\.\n?$/);
});

test("the production ledger reader reads the union and refuses an incomplete one", (t) => {
  const w = world(t);
  writeFileSync(join(w.root, "state", "ledger.ndjson"), `${JSON.stringify(heldRow(NOW - MIN))}\n`);
  const sources = buildRedesignSources(w.deps);
  assert.equal(sources.ledger(["sweep.disposed"], iso(NOW - 60 * MIN)).length, 1);
  assert.equal(sources.readShard(REL), shard());
  assert.equal(sources.pathKind("src/cli/commands/fix.ts"), "file");
  assert.equal(sources.pathKind("src/cli/commands"), "dir", "a directory is not a file the task may declare");
  assert.equal(sources.pathKind("test/new-one.test.ts"), "none");
  // A live ledger that cannot be read is an incomplete corpus, never an empty one.
  rmSync(join(w.root, "state", "ledger.ndjson"));
  mkdirSync(join(w.root, "state", "ledger.ndjson"));
  assert.throws(() => sources.ledger(["sweep.disposed"], iso(NOW - 60 * MIN)), /incomplete ledger union/);
});
