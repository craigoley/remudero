import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Clock } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import type { IssueGateway, OpenIssue } from "#src/lib/escalate.js";
import { runGardenAsync, type GardenerDeps } from "#src/lib/gardener.js";
import { PARKED_PR_REMEDY_STEP, type ParkedPrHost } from "#src/lib/parked-pr-remedy.js";
import type { PlanInventory } from "#src/lib/plan-gardener.js";
import { parseTasksFromYaml, type Plan } from "#src/lib/plan.js";
import { buildRedesignSources, REDESIGN_AFTER_MS, redesignCandidates, redesignGardenSpec, type RedesignSources } from "#src/lib/redesign-gardener.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { buildSweepEffects, HELD_ESCALATION_SLO_MS, runSweep, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";

// W1-T13657: PR #19296 (W1-T10148) waited from 07:34Z on "fix needs a task contract amendment at this exact head" with no
// Architect, no escalation and no remedy. The gardener now asks about that wait, and past the held-escalation SLO the sweep
// reads it as a held escalation, so the ladder acts. Neither opens a needs-human issue.

const MIN = 60_000;
type Row = Record<string, unknown>;

// ── The gardener half ──
const G_NOW = Date.parse("2026-11-18T11:18:00.000Z");
const G_ID = "W1-T10148";
const G_REL = `plan/tasks.d/${G_ID}-scout-pr-open-refused.yaml`;
const G_HEAD = "9c1e5d0a7b3f2e4d6c8a0b1c2d3e4f5a6b7c8d9e";
const G_CLAIM = "pr.open_refused stops recurring on the replayed ledger";
const shard = [
  `- id: ${G_ID}`, "  title: \"Make pr.open_refused stop recurring\"", "  repo: remudero", "  depends_on: []", "  type: implement",
  "  verify: auto", "  risk: low", "  status: queued", "  attempts: 0", "  files:", "    - test/scout-pr-open-refused.test.ts",
  "  acceptance:", `    - claim: "${G_CLAIM}"`, '      proof: "unit test: test/scout-pr-open-refused.test.ts"', "",
].join("\n");
const AMENDMENT_REASON = "fix needs a task contract amendment at this exact head (round work-fix-dispatch-W1-T10148:1:1) — the fix " +
  "lane proposed it from the worker's contract report; a changed contract releases this head: fixing its cause needs production " +
  "changes outside the declared scope";
const waitRow = (atMs: number, extra: Row = {}): Row => ({ step: "sweep.disposed", pr_number: 19296, task_id: G_ID, head_sha: G_HEAD,
  disposition: "wait", blocker_owner: "fix-lane", ts: new Date(atMs).toISOString(), reason: AMENDMENT_REASON, ...extra });
const designRow = (atMs: number): Row => waitRow(atMs, { disposition: "refused-escalate",
  reason: "fix needs design at this exact head (round R:1:1) — the scout cannot reach the refusal" });

function garden(t: { after: (fn: () => void) => void }, rows: Row[]) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}amendment-wait-garden-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, G_REL), shard);
  const prompts: string[] = [];
  const clock: Clock = { now: () => G_NOW, date: () => new Date(G_NOW), iso: () => new Date(G_NOW).toISOString() };
  const plan = (): PlanInventory => {
    const tasks = parseTasksFromYaml(readFileSync(join(root, G_REL), "utf8"), G_REL);
    return { open: tasks, all: tasks, shards: new Map([[G_ID, G_REL]]) };
  };
  const sources: Partial<RedesignSources> = {
    clock, plan,
    readShard: (rel) => readFileSync(join(root, rel), "utf8"),
    ledger: (steps, since) => rows.filter((r) => steps.includes(String(r.step)) && String(r.ts) >= since),
    pathKind: (rel) => { const st = statSync(join(root, rel), { throwIfNoEntry: false }); return st === undefined ? "none" : st.isFile() ? "file" : "dir"; },
    judgeText: async (prompt) => { prompts.push(prompt); return 'REDESIGN: {"verdict":"grill","reason":"the fixture asks a person"}'; },
    settled: () => buildRedesignSources(deps, { ledger: sources.ledger }).settled(),
  };
  const deps: GardenerDeps = {
    stateDir: join(root, "state"), repoRoot: root, clock, seed: 1,
    log: (step, extra = {}) => { rows.push({ task_id: "DAEMON", ...extra, step, ts: new Date(G_NOW).toISOString() }); },
    mergedPlanLint: () => undefined,
    openWorkspace: () => ({ root, land: () => "https://example.test/pull/1", dispose: () => {} }),
  };
  return { prompts, sources: sources as RedesignSources, run: () => runGardenAsync(redesignGardenSpec(deps, sources), deps) };
}

test("W1-T13657 criterion 1: the Architect is asked about an amendment wait that stood unbroken at one head for REDESIGN_AFTER_MS", async (t) => {
  const g = garden(t, [waitRow(G_NOW - REDESIGN_AFTER_MS - 10 * MIN), waitRow(G_NOW - 30 * MIN), waitRow(G_NOW - MIN)]);
  await g.run();
  assert.equal(g.prompts.length, 1, "one Architect spawn for the one waiting task");
  assert.match(g.prompts[0]!, /Standing rule 16/);
  assert.ok(g.prompts[0]!.includes(`PR #19296 at head ${G_HEAD.slice(0, 7)} is held: ${AMENDMENT_REASON}`),
    "the prompt names the PR, the head and the hold reason");
});

test("W1-T13657 criterion 2: invariant:young-holds-stay-with-the-fix-lane, a young or moved amendment wait is not asked, and design holds are asked as today", (t) => {
  const young = garden(t, [waitRow(G_NOW - (REDESIGN_AFTER_MS - MIN)), waitRow(G_NOW - MIN)]);
  assert.equal(redesignCandidates(young.sources).length, 0, "a wait younger than REDESIGN_AFTER_MS stays with the fix lane");
  const moved = garden(t, [waitRow(G_NOW - 3 * 60 * MIN, { head_sha: "0".repeat(40) }), waitRow(G_NOW - 30 * MIN), waitRow(G_NOW - MIN)]);
  assert.equal(redesignCandidates(moved.sources).length, 0, "a wait at an older head does not age this one");
  const interrupted = garden(t, [waitRow(G_NOW - 3 * 60 * MIN), waitRow(G_NOW - 50 * MIN, { reason: "fix round dispatched" }),
    waitRow(G_NOW - 40 * MIN), waitRow(G_NOW - MIN)]);
  assert.equal(redesignCandidates(interrupted.sources).length, 0, "another wait between the rows restarts the hour");
  const design = garden(t, [designRow(G_NOW - 2 * 60 * MIN), designRow(G_NOW - MIN)]);
  assert.equal(redesignCandidates(design.sources).length, 1, "a refused-escalate design hold is asked as today");
  const youngDesign = garden(t, [designRow(G_NOW - 30 * MIN), designRow(G_NOW - MIN)]);
  assert.equal(redesignCandidates(youngDesign.sources).length, 0);
});

// ── The sweep half ──
const NOW = Date.parse("2026-11-18T11:18:00.000Z");
const stamp = (offset = 0) => new Date(NOW + offset).toISOString();
const TASK = "W1-T10148";
const PR = 19296;
const HEAD = "4d2f9e1".padEnd(40, "0");
const RUN = "amendment-wait-run";
const HOLD = "pr.open_refused is the designed refusal record; fixing its cause needs production changes outside the declared scope";

/** A completed NEEDS_DESIGN round the fix lane routed to an amendment (W1-T12714). */
function amendmentRound(heldForMs: number): Row[] {
  const who = { task_id: TASK, head_sha: HEAD, run_id: RUN, host: "fleet-host", actor_pid: 4242,
    repair_pr_url: `https://github.com/acme/remudero/pull/${PR}`, round_id: `${RUN}:1:1` };
  return [
    { step: "sweep.disposed", pr_number: PR, head_sha: HEAD, task_id: TASK, run_id: RUN, disposition: "blocked-fixable",
      acted: true, ts: stamp(-heldForMs - 20 * MIN) },
    { step: "fix.dispatch", ...who, mode: "reviewer-unmet", ts: stamp(-heldForMs - MIN) },
    { step: "fix.needs_design", ...who, reason: HOLD, contract_revision: "contract-A", needs_design_kind: "contract",
      needs_design_remedy: "amendment-proposed", ts: stamp(-heldForMs) },
    { step: "fix.done", ...who, fix_outcome: "NEEDS_DESIGN", ts: stamp(-heldForMs + 1000) },
  ];
}

function sweepWorld(t: { after: (fn: () => void) => void }, heldForMs: number, opts: { contract?: string; parkedPr?: ParkedPrHost } = {}) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}amendment-wait-sweep-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"));
  const rows: Row[] = amendmentRound(heldForMs);
  const calls: string[] = [];
  const judged: string[] = [];
  const open: OpenIssue[] = [];
  const closed = new Set<number>();
  const issues: IssueGateway = {
    ensureLabel: () => true, listOpen: () => open,
    create: (title, body) => {
      calls.push("create");
      open.push({ number: open.length + 1, url: `https://github.com/acme/remudero/issues/${open.length + 1}`, title, body });
      return open.at(-1)!.url;
    },
    comment: () => { calls.push("comment"); },
  };
  const effects = buildSweepEffects({
    owner: "acme", repo: "remudero", repoRoot: root, config: { root, claudeBin: "/bin/true" } as Config,
    plan: { tasks: [], byId: new Map() } as unknown as Plan, ledgerPath: join(root, "ledger.ndjson"), runId: RUN,
    log: () => undefined, issuesImpl: issues, ghRunImpl: () => undefined, nowMsImpl: () => NOW,
    readJsonImpl: async () => ({ user: { login: "remudero-fleet[bot]" } }),
  });
  const deps = {
    strikeLadder: effects.strikeLadder,
    fixProgressJudge: async (input) => {
      judged.push(String(input.parkedReason));
      return { verdict: "change-approach", reason: "the amendment was never made", approach: "rebuild with the amendment as a note" };
    },
    readTaskContractRevision: () => opts.contract ?? "contract-A",
    readOpenEscalations: () => open,
    arm: () => { calls.push("arm"); },
    close: (candidate) => { calls.push("close"); closed.add(candidate.prNumber); },
    updateBranch: () => { calls.push("refresh"); return "updated"; },
    dispatchFix: () => { calls.push("fix"); },
    escalate: () => { calls.push("escalate"); },
    claimFixAdmission: () => ({ admitted: true }),
    readLiveState: (candidate) => ({ ok: true, state: closed.has(candidate.prNumber) ? "CLOSED" : "OPEN", headSha: candidate.headSha }),
    ledgerPath: join(root, "ledger.ndjson"), runId: RUN,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push({ ts: stamp(), ...row }); }, now: () => NOW,
    log: () => undefined,
    ...(opts.parkedPr === undefined ? {} : { parkedPr: opts.parkedPr }),
  } as SweepDeps;
  const pr: OpenPrView = {
    prNumber: PR, prUrl: `https://github.com/acme/remudero/pull/${PR}`, taskId: TASK, headSha: HEAD,
    headRefName: `run-${TASK}-1794986401127`, checksState: "green", reviewState: "failure",
    unmetCriteria: [{ claim: "pr.open_refused stops recurring", proof: "unit test: test/scout-pr-open-refused.test.ts",
      met: false, reason: "the cause is outside the declared scope", proof_exec: "executed_pass" }],
    priorStrikes: 1, autoMergeArmed: false, lastActivityAt: stamp(-heldForMs),
    body: `Scouts the refusal.\n\nRemudero-Task: ${TASK}\n`,
  };
  const disposed = () => rows.findLast(r => r.step === "sweep.disposed" && r.pr_number === PR && r.run_id === RUN && r.ts === stamp())!;
  return { rows, calls, judged, effects, disposed, sweep: () => runSweep([pr], deps) };
}

test("W1-T13657 criterion 3: an amendment wait older than HELD_ESCALATION_SLO_MS with an unchanged contract takes the held-escalation ladder", async (t) => {
  const w = sweepWorld(t, HELD_ESCALATION_SLO_MS + 60 * MIN);
  await w.sweep();
  const row = w.disposed();
  assert.equal(row.disposition, "refused-escalate", JSON.stringify(row));
  assert.deepEqual(w.calls, ["close"], "the ladder's rebuild acts on the unanswered wait");
  assert.equal(w.judged.length, 1, "the fix-progress judge decides before the close");
  assert.match(w.judged[0]!, /held on an unanswered escalation: fix needs a task contract amendment at this exact head .*unanswered past the held-escalation SLO, so the ladder's rebuild acts/);
  assert.ok(w.rows.some(r => r.step === "sweep.strike_ladder.requeued" && r.pr_number === PR), "the task is requeued");
  const notes = w.effects.strikeLadder!.readNotes(TASK);
  assert.match(notes[0]!.note, /Unanswered escalation it was held on: fix needs a task contract amendment at this exact head/);
});

test("W1-T13657 criterion 4: invariant:an-amendment-wait-opens-no-issue, the wait asks no one at any age and a changed contract releases it", async (t) => {
  const young = sweepWorld(t, HELD_ESCALATION_SLO_MS - 10 * MIN);
  for (let pass = 0; pass < 3; pass++) {
    await young.sweep();
    assert.equal(young.disposed().disposition, "wait");
    assert.match(String(young.disposed().reason), /^fix needs a task contract amendment at this exact head .*a changed contract releases this head/);
    assert.notEqual(young.disposed().blocker, "escalated");
  }
  assert.deepEqual(young.calls, [], "a young wait opens no issue and closes nothing");

  const aged = sweepWorld(t, HELD_ESCALATION_SLO_MS + 60 * MIN);
  await aged.sweep();
  assert.ok(!aged.calls.includes("escalate") && !aged.calls.includes("create"), `an aged wait opens no issue: ${aged.calls.join(",")}`);
  assert.notEqual(aged.disposed().blocker, "escalated", "no needs-human blocker is set");

  // With the parked-PR host the sweep wires in production, the aged wait takes a remedy row in place of any issue.
  const parked: ParkedPrHost = {
    readTaskShard: async () => ({ outcome: "refused", reason: "task-absent" }),
    reserveTaskId: () => { throw new Error("the fixture reserves no id"); },
    landTaskFiles: async () => ({ error: "the fixture lands nothing" }),
    closePr: async () => { throw new Error("the fixture closes nothing"); },
  };
  const remedied = sweepWorld(t, HELD_ESCALATION_SLO_MS + 60 * MIN, { parkedPr: parked });
  await remedied.sweep();
  assert.ok(!remedied.calls.includes("escalate") && !remedied.calls.includes("create"), remedied.calls.join(","));
  const remedy = remedied.rows.find(r => r.step === PARKED_PR_REMEDY_STEP && r.pr_number === PR);
  assert.equal(remedy?.cause, "needs-design", JSON.stringify(remedy));

  for (const heldForMs of [HELD_ESCALATION_SLO_MS - 10 * MIN, HELD_ESCALATION_SLO_MS + 60 * MIN]) {
    const amended = sweepWorld(t, heldForMs, { contract: "contract-B" });
    await amended.sweep();
    assert.equal(amended.disposed().disposition, "blocked-fixable", "a changed task contract releases the wait");
    assert.ok(!amended.calls.includes("escalate") && !amended.calls.includes("create"));
  }
});
