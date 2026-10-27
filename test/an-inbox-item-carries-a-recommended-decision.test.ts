// W1-T8950: on 2026-10-13 the operator decided 47 inbox items from a recommendations page built outside the console.
// Each operator inbox item now carries the recommended decision itself: what to choose, the exact text to post, why,
// the evidence on main and whether the item is already obsolete. The route is attached at serve time from W1-T8826's
// mapping; a recommendation whose source changed is not served; the writer's answers pass a checker that resolves every
// evidence entry on main; the operator session's recommendations are imported once as a seed.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { InboxClassification, InboxState } from "../src/lib/inbox.js";
import {
  backfillRecommendations,
  buildRecommendationPrompt,
  checkRecommendation,
  gitRecommendationEvidence,
  readRecommendationStore,
  realRecommendationWriter,
  recommendationSourcePath,
  recommendationFingerprint,
  recommendationStorePath,
  startRecommendationBackfill,
  type EvidenceKind,
  type RecommendationEvidence,
  type StoredRecommendation,
} from "../src/lib/inbox-recommendation.js";
import { writeClassificationSnapshot } from "../src/lib/fleet-lane.js";
import { inboxLanes } from "../src/lib/panel-graph.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";
import { SPEC, violations } from "./helpers/openapi-strict.js";

const READY_ID = "machine-judge:W1-T5418";
const READY_SUMMARY = "A parked fix is waiting for a ruling on whether to land it.";
const OBSOLETE_ID = "machine-judge:W1-T6088";
const OBSOLETE_SUMMARY = "A merge-queue guard is parked for a risk decision.";
const FLEET_ID = "adoption:src/lib/unused.ts";

function stateRoot(t: { after: (fn: () => void) => void }): { root: string; stateDir: string } {
  const root = makeTempDir("rmd-inbox-recommendation");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  return { root, stateDir };
}

function stored(proposal: { id: string; summary: string }, lane: Parameters<typeof recommendationFingerprint>[1], fields: Partial<StoredRecommendation>, shardBlob?: string): StoredRecommendation {
  return {
    action: "approve", why: "The fix is small and its proof passed on main.", evidence: ["#11199"], obsolete: false,
    generatedAt: "2026-10-14T00:00:00.000Z", source: "writer", ...fields,
    sourceFingerprint: recommendationFingerprint(proposal, lane, shardBlob), ...(shardBlob ? { shardBlob } : {}),
  };
}

/** The independently captured current source the writer's pinned pass leaves beside the store. */
function writeSource(stateDir: string, fields: { tasks?: Record<string, string>; monolith?: string[]; repository?: string } = {}): void {
  writeFileSync(recommendationSourcePath(stateDir), JSON.stringify({
    repository: fields.repository ?? "acme/target", commit: "a".repeat(40), tasks: fields.tasks ?? {}, monolith: fields.monolith ?? [],
  }));
}

function lanesOf(root: string, items: Array<{ id: string; summary: string; state: InboxState }>) {
  const classifications: InboxClassification[] = items.map((i) => ({ proposalId: i.id, state: i.state, reasons: [] }));
  return inboxLanes(
    { proposals: items.map((i) => ({ id: i.id, summary: i.summary, evidenceAnchors: [] })), classifications, ledgerLines: Object.assign([], { torn: 0, present: true }) },
    root,
  );
}

/** Evidence on a pretend main: the PRs, shas, tasks and paths that resolve, and every task record's blob. */
function mainEvidence(resolves: Record<string, EvidenceKind>, shards: Record<string, string> = {}): RecommendationEvidence & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    shards: async () => new Map(Object.entries(shards).map(([id, blob]) => [id, { path: `plan/tasks.d/${id}-x.yaml`, blob }])),
    shardText: async (path) => `- id: from ${path}`,
    taskHistory: async (id) => [`abc1234 feat: something (${id}) (#11199)`],
    resolve: async (entry) => {
      asked.push(entry);
      return resolves[entry];
    },
  };
}

test("W1-T8950: a ready item serves its recommendation with its route", (t) => {
  const { root, stateDir } = stateRoot(t);
  const ready = { id: READY_ID, summary: READY_SUMMARY };
  const obsolete = { id: OBSOLETE_ID, summary: OBSOLETE_SUMMARY };
  writeFileSync(recommendationStorePath(stateDir), JSON.stringify({
    [READY_ID]: stored(ready, "ready", {}),
    [OBSOLETE_ID]: stored(obsolete, "notReady", { action: "decline", text: "Moot while the merge queue is off.", obsolete: true, source: "operator-session-seed", evidence: ["W1-T6088"] }),
    [FLEET_ID]: stored({ id: FLEET_ID, summary: "unused" }, "ready", {}),
  }));
  writeSource(stateDir, { monolith: ["W1-T5418", "W1-T6088"] });
  const lanes = lanesOf(root, [
    { ...ready, state: "ready" }, { ...obsolete, state: "not_ready" }, { id: FLEET_ID, summary: "unused", state: "ready" },
  ]);

  const item = lanes.needsYou.ready.find((i) => i.proposalId === READY_ID)!;
  assert.deepEqual(item.recommendation?.route, { method: "POST", path: "/v1/inbox/approve", fields: { proposalId: READY_ID } });
  assert.equal(item.recommendation?.action, "approve");
  assert.equal(Object.hasOwn(item.recommendation!, "sourceFingerprint"), false, "the fingerprint is the store's, never served");
  assert.deepEqual(violations(JSON.parse(JSON.stringify(item)), SPEC.components.schemas.InboxReadyItem!), [], "the served item matches the contract");

  const parked = lanes.needsYou.notReady.find((i) => i.proposalId === OBSOLETE_ID)!;
  assert.equal(parked.recommendation?.action, "decline");
  assert.equal(parked.recommendation?.obsolete, true);
  assert.equal(parked.recommendation?.source, "operator-session-seed");
  assert.deepEqual(parked.recommendation?.route, { method: "POST", path: "/v1/inbox/decline", fields: { proposalId: OBSOLETE_ID }, input: "reason" });
  assert.deepEqual(violations(JSON.parse(JSON.stringify(parked)), SPEC.components.schemas.InboxNotReadyItem!), []);

  assert.equal(lanes.ready.find((i) => i.proposalId === FLEET_ID)?.recommendation, undefined, "a fleet item never carries one");
  assert.equal(Object.hasOwn(lanes.fleet.find((i) => i.proposalId === FLEET_ID)!, "recommendation"), false);

  // A stale one is omitted: the summary changed, or the item moved lane.
  const changed = lanesOf(root, [{ ...ready, summary: `${READY_SUMMARY} It was re-filed.`, state: "ready" }, { ...obsolete, state: "ready" }]);
  assert.equal(Object.hasOwn(changed.needsYou.ready.find((i) => i.proposalId === READY_ID)!, "recommendation"), false, "changed summary");
  assert.equal(Object.hasOwn(changed.needsYou.ready.find((i) => i.proposalId === OBSOLETE_ID)!, "recommendation"), false, "changed lane");

  // approve is never routed off a ready item; keep records a decision in this lane too.
  writeFileSync(recommendationStorePath(stateDir), JSON.stringify({
    [READY_ID]: stored(ready, "declined", {}),
    [OBSOLETE_ID]: stored(obsolete, "notReady", { action: "keep" }),
  }));
  const unrouted = lanesOf(root, [{ ...ready, state: "declined" }, { ...obsolete, state: "not_ready" }]);
  const declined = unrouted.needsYou.declined[0]!.recommendation!;
  assert.equal(declined.action, "approve");
  assert.equal(Object.hasOwn(declined, "route"), false);
  assert.deepEqual(unrouted.needsYou.notReady[0]!.recommendation!.route, {
    method: "POST", path: "/v1/inbox/keep", fields: { proposalId: OBSOLETE_ID }, input: "reason",
  });
});

test("W1-T8950: the checker refuses unproven obsolete claims and unroutable actions", async () => {
  const evidence = mainEvidence({ "#11199": "pr", "1bbec7c94": "sha", "W1-T8918": "task", "src/lib/inbox.ts:1655": "path" });
  const item = { id: OBSOLETE_ID, lane: "notReady" as const, ifNothingHappens: "The task stays parked." };
  const good = { action: "decline", text: "Already fixed on main.", why: "The guard it adds merged in another change.", evidence: ["#11199", "W1-T8918"], obsolete: true };
  assert.deepEqual(await checkRecommendation(good, item, evidence), { ok: true, problems: [] }, "control: a proven obsolete decline passes");

  const taskOnly = await checkRecommendation({ ...good, evidence: ["W1-T8918"] }, item, evidence);
  assert.equal(taskOnly.ok, false);
  assert.match(taskOnly.problems.join("; "), /obsolete needs a merged PR or a commit on main/);
  assert.equal((await checkRecommendation({ ...good, evidence: ["1bbec7c94"] }, item, evidence)).ok, true, "a sha on main proves it too");

  const approve = await checkRecommendation({ ...good, action: "approve", obsolete: false }, item, evidence);
  assert.match(approve.problems.join("; "), /cannot be routed to approve/, "approve is routable only on a ready item");
  assert.equal((await checkRecommendation({ ...good, action: "approve", obsolete: false }, { ...item, lane: "ready" }, evidence)).ok, true);
  assert.match((await checkRecommendation({ ...good, action: "execute" }, item, evidence)).problems.join("; "), /action must be one of/);

  assert.match((await checkRecommendation({ ...good, text: undefined }, item, evidence)).problems.join("; "), /decline posts a reason/);
  assert.match((await checkRecommendation({ ...good, why: "  " }, item, evidence)).problems.join("; "), /why is missing its whatHappened/);
  const unresolved = await checkRecommendation({ ...good, evidence: ["#11199", "#99999"] }, item, evidence);
  assert.match(unresolved.problems.join("; "), /evidence "#99999" does not resolve on main/);

  // A writer refused twice stores nothing, and its second ask names the first refusal's problems.
  const t0 = makeTempDir("rmd-inbox-recommendation-check");
  try {
    const stateDir = join(t0, "state");
    mkdirSync(stateDir, { recursive: true });
    const prompts: string[] = [];
    const deps = {
      stateDir, evidence,
      readProposals: () => [{ id: OBSOLETE_ID, summary: OBSOLETE_SUMMARY }],
      readLanes: () => ({ [OBSOLETE_ID]: "notReady" as const }),
      summarize: async ({ context: prompt }: { context: string }) => {
        prompts.push(prompt);
        return { ...good, evidence: ["W1-T8918"] };
      },
    };
    const first = await backfillRecommendations(deps, 1);
    assert.deepEqual({ written: first.written, refused: first.refused }, { written: 0, refused: 1 });
    assert.equal(prompts.length, 2, "retried once");
    assert.match(prompts[1]!, /refused for: obsolete needs a merged PR/);
    assert.equal(readRecommendationStore(recommendationStorePath(stateDir))[OBSOLETE_ID], undefined);
    assert.equal((await backfillRecommendations(deps, 1)).refused, 0, "a refused item is not re-asked until its source changes");

    // control: an answer that passes is stored, with this item's fingerprint, and served.
    const ok = await backfillRecommendations({ ...deps, readProposals: () => [{ id: READY_ID, summary: READY_SUMMARY }], readLanes: () => ({ [READY_ID]: "ready" as const }), summarize: async () => ({ ...good, action: "approve", obsolete: false }) }, 1);
    assert.equal(ok.written, 1);
    const row = readRecommendationStore(recommendationStorePath(stateDir))[READY_ID]!;
    assert.equal(row.source, "writer");
    assert.equal(row.sourceFingerprint, recommendationFingerprint({ id: READY_ID, summary: READY_SUMMARY }, "ready"));
  } finally {
    rmSync(t0, { recursive: true, force: true });
  }
});

test("W1-T8950: the seed is imported once for items still in the inbox", async (t) => {
  const { root, stateDir } = stateRoot(t);
  const seed = JSON.stringify({
    version: 1,
    recommendations: {
      [OBSOLETE_ID]: { action: "decline", why: "Moot while the merge queue is off.", evidence: ["gh api rulesets: disabled"], obsolete: true, generatedAt: "2026-10-13T01:34:03+00:00", source: "operator-session-seed" },
      [READY_ID]: { action: "reframe", text: "Re-measure after the census fixes land.", why: "Its cause is being fixed elsewhere.", evidence: ["W1-T8918"], obsolete: false, group: "census refusals", generatedAt: "2026-10-13T01:34:03+00:00", source: "operator-session-seed" },
      "machine-judge:W1-T1": { action: "keep", why: "Gone from the inbox.", evidence: [], obsolete: false, generatedAt: "2026-10-13T01:34:03+00:00", source: "operator-session-seed" },
    },
  });
  const proposals = [{ id: OBSOLETE_ID, summary: OBSOLETE_SUMMARY }, { id: READY_ID, summary: READY_SUMMARY }];
  const lanes = { [OBSOLETE_ID]: "notReady" as const, [READY_ID]: "ready" as const };
  const deps = { stateDir, evidence: mainEvidence({}, { "W1-T6088": "blob6088" }), readProposals: () => proposals, readLanes: () => lanes, readSeed: () => seed };
  writeFileSync(recommendationStorePath(stateDir), JSON.stringify({ [READY_ID]: stored(proposals[1]!, "ready", { why: "Already written by the writer." }) }));

  const first = await backfillRecommendations(deps, 1);
  assert.equal(first.seeded, 1, "only the present item with no stored recommendation");
  const store = readRecommendationStore(recommendationStorePath(stateDir));
  assert.equal(store[READY_ID]!.why, "Already written by the writer.", "a stored recommendation is never overwritten by the seed");
  assert.equal(store["machine-judge:W1-T1"], undefined, "an item no longer in the inbox is not imported");
  assert.equal(store[OBSOLETE_ID]!.source, "operator-session-seed");
  assert.equal(store[OBSOLETE_ID]!.sourceFingerprint, recommendationFingerprint(proposals[0]!, "notReady", "blob6088"));

  writeSource(stateDir, { tasks: { "W1-T6088": "blob6088" } });
  // The falsifier: the seeded item serves its decline with the decline route, and a changed summary hides it.
  const served = lanesOf(root, [{ ...proposals[0]!, state: "not_ready" }]).needsYou.notReady[0]!.recommendation;
  assert.deepEqual({ action: served?.action, obsolete: served?.obsolete, source: served?.source, route: served?.route }, {
    action: "decline", obsolete: true, source: "operator-session-seed", route: { method: "POST", path: "/v1/inbox/decline", fields: { proposalId: OBSOLETE_ID }, input: "reason" },
  });
  assert.equal(lanesOf(root, [{ ...proposals[0]!, summary: "Re-filed.", state: "not_ready" }]).needsYou.notReady[0]!.recommendation, undefined);

  // Once: a later tick imports nothing, even after the seeded entry is gone.
  writeFileSync(recommendationStorePath(stateDir), "{}\n");
  assert.equal((await backfillRecommendations(deps, 1)).seeded, 0);
  assert.deepEqual(readRecommendationStore(recommendationStorePath(stateDir)), {});
});

test("W1-T8950: a changed task record on main drops the recommendation and the writer rewrites it", async (t) => {
  const { stateDir } = stateRoot(t);
  const proposal = { id: OBSOLETE_ID, summary: OBSOLETE_SUMMARY };
  writeFileSync(recommendationStorePath(stateDir), JSON.stringify({ [OBSOLETE_ID]: stored(proposal, "notReady", { action: "keep" }, "old-blob") }));
  const asked: string[] = [];
  const deps = {
    stateDir, evidence: mainEvidence({ "W1-T6088": "task" }, { "W1-T6088": "new-blob" }), readProposals: () => [proposal], readLanes: () => ({ [OBSOLETE_ID]: "notReady" as const }),
    summarize: async ({ context: prompt }: { context: string }) => {
      asked.push(prompt);
      return { action: "reframe", text: "Restate it against the new record.", why: "The task record changed on main.", evidence: ["W1-T6088"], obsolete: false };
    },
  };
  const tick = await backfillRecommendations(deps, 1);
  assert.deepEqual({ dropped: tick.dropped, written: tick.written }, { dropped: 1, written: 1 });
  const row = readRecommendationStore(recommendationStorePath(stateDir))[OBSOLETE_ID]!;
  assert.equal(row.action, "reframe");
  assert.equal(row.shardBlob, "new-blob");
  assert.match(asked[0]!, /The task record on main:\n- id: from plan\/tasks\.d\/W1-T6088-x\.yaml/, "the writer reads the task record");
  assert.match(asked[0]!, /Commits on main that name the task/, "and main's history for it");
  assert.match(buildRecommendationPrompt({ proposal, lane: "notReady", history: [] }), /"action" is one of: decline, reframe, reply, keep\./, "approve is not offered off a ready item");
});

test("W1-T8950: the evidence resolves against origin/main", async () => {
  const repo = gitRepo({ kind: "inbox-recommendation" });
  try {
    mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
    writeFileSync(join(repo.dir, "plan", "tasks.d", "W1-T6088-a-guard.yaml"), "- id: W1-T6088\n  title: a guard\n");
    writeFileSync(join(repo.dir, "plan", "tasks.yaml"), "- id: W1-T204\n  title: legacy\n");
    repo.git("add", "plan");
    repo.git("commit", "--quiet", "-m", "feat: a guard (W1-T6088) (#11199)");
    const merged = repo.git("rev-parse", "HEAD");
    repo.git("update-ref", "refs/remotes/origin/main", merged);
    repo.git("commit", "--quiet", "--allow-empty", "-m", "local only (#11200)");
    const local = repo.git("rev-parse", "HEAD");
    const evidence = gitRecommendationEvidence(async (args) => repo.git(...args), { planDir: "plan", planMonolith: "plan/tasks.yaml" });

    const shards = await evidence.shards();
    assert.deepEqual([...shards.keys()], ["W1-T6088"]);
    assert.equal(shards.get("W1-T6088")!.blob, repo.git("rev-parse", "origin/main:plan/tasks.d/W1-T6088-a-guard.yaml"));
    assert.match((await evidence.taskHistory("W1-T6088"))[0]!, /a guard \(W1-T6088\)/);
    assert.equal(await evidence.resolve("#11199"), "pr");
    assert.equal(await evidence.resolve("#11200"), undefined, "a PR that is not on main");
    assert.equal(await evidence.resolve(merged.slice(0, 9)), "sha");
    assert.equal(await evidence.resolve(local.slice(0, 9)), undefined, "a commit that is not on main");
    assert.equal(await evidence.resolve("W1-T6088"), "task");
    assert.equal(await evidence.resolve("W1-T204"), "task", "a task in the legacy plan file");
    assert.equal(await evidence.resolve("W1-T9999999"), undefined);
    assert.equal(await evidence.resolve("plan/tasks.yaml:1"), "path");
    assert.equal(await evidence.resolve("src/missing.ts"), undefined);
    assert.equal(await evidence.resolve("gh api rulesets: disabled"), undefined);
  } finally {
    repo.cleanup();
  }
});

test("W1-T8950: the backfill runs on its own timer and logs what it wrote", async (t) => {
  const { stateDir } = stateRoot(t);
  const rows: string[] = [];
  const pump = startRecommendationBackfill({
    stateDir, evidence: mainEvidence({ "#11199": "pr" }), readProposals: () => [{ id: READY_ID, summary: READY_SUMMARY }], readLanes: () => ({ [READY_ID]: "ready" as const }),
    summarize: async () => ({ action: "approve", why: "Its proof passed.", evidence: ["#11199"], obsolete: false }),
  }, 60_000, (step) => rows.push(step));
  await pump.settled();
  pump.stop();
  assert.deepEqual(rows, ["inbox.recommendation_written"]);
  assert.ok(existsSync(recommendationStorePath(stateDir)));
  assert.equal(JSON.parse(readFileSync(recommendationStorePath(stateDir), "utf8"))[READY_ID].action, "approve");
});

test("W1-T8950: unreadable stores, seeds, records and logs read as nothing, and the real writer parses one answer", async (t) => {
  const { stateDir } = stateRoot(t);
  writeFileSync(recommendationStorePath(stateDir), "{not json");
  assert.deepEqual(readRecommendationStore(recommendationStorePath(stateDir)), {}, "a torn store reads as empty");

  const failing = gitRecommendationEvidence(async (args) => {
    if (args[0] === "ls-tree") return "";
    throw new Error(`git ${args[0]} failed`);
  }, { planDir: "plan", planMonolith: "plan/tasks.yaml" });
  assert.equal(await failing.shardText("plan/tasks.d/W1-T1-x.yaml"), undefined, "a record gone from main is no context");
  assert.equal(await failing.resolve("#11199"), undefined, "an unreadable log resolves nothing");
  assert.equal(await failing.resolve("../outside/file.ts"), undefined, "a path leaving the tree resolves nothing");

  // The default lanes come from serve's classification snapshot; an unreadable seed seeds nothing.
  writeClassificationSnapshot(stateDir, [{ proposalId: READY_ID, state: "ready" }, { proposalId: OBSOLETE_ID, state: "retired" }]);
  const tick = await backfillRecommendations({
    stateDir, evidence: mainEvidence({ "#11199": "pr" }), readProposals: () => [{ id: READY_ID, summary: READY_SUMMARY }, { id: OBSOLETE_ID, summary: OBSOLETE_SUMMARY }],
    readSeed: () => "{not json",
    summarize: async () => ({ action: "approve", why: "Its proof passed.", evidence: ["#11199"], obsolete: false }),
  }, 5);
  assert.deepEqual({ seeded: tick.seeded, written: tick.written }, { seeded: 0, written: 1 }, "only the item the snapshot places in a lane");
  assert.deepEqual(Object.keys(readRecommendationStore(recommendationStorePath(stateDir))), [READY_ID]);

  const answers = ['Here it is: {"action": "keep", "why": "x", "evidence": [], "obsolete": false}', "no json at all", "{not: json}"];
  const prompts: string[] = [];
  const writer = realRecommendationWriter({
    mount: { model: "m", effort: "low", maxTurns: 1 } as never, cwd: stateDir, settingsFile: "settings.json",
    spawn: (async (args: { prompt: string }) => {
      prompts.push(args.prompt);
      return { text: answers.shift() };
    }) as never,
  });
  assert.deepEqual(await writer({ context: "the recommendation prompt" }), { action: "keep", why: "x", evidence: [], obsolete: false });
  assert.equal(prompts[0], "the recommendation prompt", "the prompt is sent whole");
  assert.equal(await writer({ context: "p" }), null, "no object in the answer");
  assert.equal(await writer({ context: "p" }), null, "an unparseable object");
});
