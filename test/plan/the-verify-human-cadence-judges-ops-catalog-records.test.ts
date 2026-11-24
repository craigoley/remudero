/**
 * W1-T14641: the verify-human cadence judges the parked verify: human records of the ops catalog as it judges public
 * ones. On origin/main `defaultVerifyHumanCadenceResult` (src/run-task.ts) read only `loadPlan(<checkout>/plan/tasks.yaml)`,
 * so a record filed in the ops catalog waited on `rmd approve` alone.
 *
 * The cadence's shard source is `readVerifyHumanCadencePlan` (src/lib/task-lookup.ts), its parked population
 * `parkedVerifyHumanCandidateTasks` and its filing-age source `verifyHumanFilingHistories` (src/lib/measurement-cadence.ts);
 * `defaultVerifyHumanCadenceResult` passes the plan they answer to the shard builder, the mechanical rulings, the
 * release reader and the release writer. This suite reads them directly: a new importer of src/run-task.ts would trip
 * the affected-suite reach ratchet.
 *
 * Fixtures are real: a public checkout and an ops checkout as Git repositories (filing ages come from their history),
 * and the ops snapshot through the real pinned reader over a GET-only api serving the ops checkout's files, so each ops
 * record carries the label the production reader gives it (`tasks.yaml`, `tasks.d/<file>`).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
// Namespace imports: a name this build adds reads as undefined at base, so each criterion fails on its own.
import * as lookup from "#src/lib/task-lookup.js";
import * as cadence from "#src/lib/measurement-cadence.js";
import { loadPlan, parseTasksFromYaml, RELEASE_LEDGER_STEP, type Plan, type Task } from "#src/lib/plan.js";
import { OpsCatalogAuthMissingError, readOpsCatalogSnapshotAsync, type OpsCatalogApi, type OpsCatalogSnapshot } from "#src/lib/ops-catalog-source.js";
import { taskRulingPin } from "#src/lib/task-linter.js";
import { operatorReleasePin, releaseContractPins } from "#src/lib/operator-release.js";
import { resolveReleases } from "#src/lib/drain.js";
import { releaseAutomatedShard } from "#src/lib/verify-human-release.js";
import { DEFAULT_RISK_POLICY } from "#src/lib/risk-judge.js";
import { resolveTaskFilingHistory } from "#src/lib/task-filing-history.js";
import type { ShardUnderJudgement } from "#src/lib/verify-human-judge.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const OPS = "fixture-private/ops-catalog";
const PUBLIC_RULING = "W1-T964101", PUBLIC_ESCALATED = "W1-T964102", OPS_RULING = "W1-T964103", OPS_ESCALATED = "W1-T964104";
const PUBLIC_PLAIN = "W1-T964105", OPS_PLAIN = "W1-T964106";
const OPS_IDS = [OPS_RULING, OPS_ESCALATED];
const ALL_IDS = [PUBLIC_RULING, PUBLIC_ESCALATED, OPS_RULING, OPS_ESCALATED];

/** A ruling-shaped operator record (it declares DECISIONS.md): the records this sweep keeps for a person. */
const ruling = (id: string) => [
  `- id: ${id}`, `  title: "Record a ruling for ${id}"`, "  repo: remudero", "  depends_on: []", "  type: implement",
  "  verify: human", "  risk: low", "  priority: 1", "  status: queued", "  files: [DECISIONS.md]",
  "  rationale: \"a ruling only the operator can make\"",
  "  acceptance:", `    - claim: "the ruling for ${id} is recorded"`, `      proof: "grep: ${id} in DECISIONS.md"`, "",
].join("\n");

/** A machine record its judge escalated, at a pin that still matches it: released by the cadence on a proceed. */
function escalated(id: string): string {
  const body = [
    `- id: ${id}`, `  title: "Repair the fixture gate for ${id}"`, "  repo: remudero", "  depends_on: []", "  type: implement",
    "  verify: human", "  risk: low", "  priority: 1", "  status: queued", "  author_class: machine",
    "  origin: \"fixture-family:gate\"", "  files: [src/lib/fixture-gate.ts]",
    "  acceptance:", `    - claim: "the fixture gate for ${id} is repaired"`, `      proof: "grep: ${id} in src/lib/fixture-gate.ts"`, "",
  ].join("\n");
  const pin = taskRulingPin(parseTasksFromYaml(body, "pin")[0]!);
  return body + [
    "  risk_ruling:", "    verdict: \"low\"", "    action: escalate", "    confidence: 0.5", "    reasons:", "      - \"fixture\"",
    "    judged_at: \"2026-11-20T00:00:00.000Z\"", `    pin: "${pin}"`, "",
  ].join("\n");
}

/** A parked operator record carrying no ruling: the machine-filing judge's to route, not this sweep's to park. */
const plain = (id: string) => [
  `- id: ${id}`, `  title: "Add the fixture probe for ${id}"`, "  repo: remudero", "  depends_on: []", "  type: implement",
  "  verify: human", "  risk: low", "  priority: 1", "  status: queued", "  files: [src/lib/fixture-probe.ts]",
  "  acceptance:", `    - claim: "the fixture probe for ${id} exists"`, `      proof: "grep: ${id} in src/lib/fixture-probe.ts"`, "",
].join("\n");

/** The plan files of one catalog: a ruling in the monolith, an escalated machine record and a plain record in shards. */
const catalogFiles = (rulingId: string, escalatedId: string, plainId: string): Record<string, string> => ({
  "plan/tasks.yaml": ruling(rulingId), [`plan/tasks.d/${escalatedId}.yaml`]: escalated(escalatedId), [`plan/tasks.d/${plainId}.yaml`]: plain(plainId),
});

function committed(kind: string, files: Record<string, string>) {
  const git = gitRepo({ kind });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(git.dir, rel, ".."), { recursive: true });
    writeFileSync(join(git.dir, rel), text);
  }
  git.git("add", "--", ...Object.keys(files));
  git.git("commit", "--quiet", "-m", `file ${kind} records`);
  return git;
}

/** A GET-only api serving `files` as the ops repository's default branch, every object addressed by its digest. */
function opsApi(files: Record<string, string>, calls: string[]): OpsCatalogApi {
  const digest = (s: string) => createHash("sha1").update(s).digest("hex");
  const blobSha = (text: string) => digest(`blob ${Buffer.byteLength(text)}\0${text}`);
  const shards = Object.entries(files).filter(([rel]) => rel.startsWith("plan/tasks.d/"));
  const monolith = files["plan/tasks.yaml"]!;
  const shardTree = digest(`shards:${shards.map(([rel]) => rel).join(",")}`), planTree = digest(`plan:${shardTree}`);
  const rootTree = digest(`root:${planTree}`), commit = digest(`commit:${rootTree}`);
  const blobs = new Map([monolith, ...shards.map(([, text]) => text)].map(text => [blobSha(text), text]));
  const base = `repos/${OPS}`;
  return async path => {
    calls.push(path);
    if (path === base) return { id: 4641, full_name: OPS, default_branch: "main" };
    if (path === `${base}/git/ref/heads/main`) return { object: { type: "commit", sha: commit } };
    if (path === `${base}/git/commits/${commit}`) return { sha: commit, tree: { sha: rootTree } };
    if (path === `${base}/git/trees/${rootTree}`) return { sha: rootTree, truncated: false, tree: [{ path: "plan", sha: planTree, type: "tree", mode: "040000" }] };
    if (path === `${base}/git/trees/${planTree}`) return { sha: planTree, truncated: false, tree: [
      { path: "tasks.yaml", sha: blobSha(monolith), type: "blob", mode: "100644" },
      { path: "tasks.d", sha: shardTree, type: "tree", mode: "040000" }] };
    if (path === `${base}/git/trees/${shardTree}`) return { sha: shardTree, truncated: false,
      tree: shards.map(([rel, text]) => ({ path: rel.slice("plan/tasks.d/".length), sha: blobSha(text), type: "blob", mode: "100644" })) };
    const blob = /\/git\/blobs\/([0-9a-f]{40})$/.exec(path)?.[1];
    const text = blob === undefined ? undefined : blobs.get(blob);
    assert.ok(text !== undefined, `only the fixture's own objects are served: ${path}`);
    return { sha: blob, encoding: "base64", size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") };
  };
}

interface World { root: string; stateDir: string; publicDir: string; publicPlan: Plan; api: OpsCatalogApi; calls: string[] }

/** The fleet shape: `<root>/state` names the ops destination, whose checkout is `<root>/repos/<name>`. */
function world(t: TestContext): World {
  const root = mkdtempSync(join(tmpdir(), "rmd-vh-ops-catalog-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  writeFileSync(join(stateDir, "plan-destination.json"), JSON.stringify({ repository: OPS, kinds: [] }));
  const pub = committed("vh-public", catalogFiles(PUBLIC_RULING, PUBLIC_ESCALATED, PUBLIC_PLAIN));
  const opsFiles = catalogFiles(OPS_RULING, OPS_ESCALATED, OPS_PLAIN);
  // The ops checkout sits where the destination names it; a worktree of a fixture repository puts it there.
  committed("vh-ops", opsFiles).addWorktree(join(root, "repos", "ops-catalog"), "checkout");
  const calls: string[] = [];
  t.after(() => { pub.cleanup(); });
  return { root, stateDir, publicDir: pub.dir, publicPlan: loadPlan(join(pub.dir, "plan", "tasks.yaml")), api: opsApi(opsFiles, calls), calls };
}

const ids = (tasks: readonly Task[]) => tasks.map(task => task.id).sort();
const withoutSource = ({ sourcePath: _source, ...task }: Task) => task;
const shardOf = (task: Task): ShardUnderJudgement => ({
  id: task.id, title: task.title, rationale: task.rationale ?? "", acceptance: (task.acceptance ?? []).map(c => c.claim),
  ageDays: null, depsAllMerged: true, citedInSrc: false,
});

test("W1-T14641 criterion 1: the cadence's parked shard set includes a queued verify: human record that exists only in the ops catalog snapshot, judged with the same inputs as a public one", async t => {
  const fx = world(t);
  const source = await lookup.readVerifyHumanCadencePlan(fx.publicPlan, { stateDir: fx.stateDir, api: fx.api });
  assert.ok(fx.calls.some(path => path.endsWith("/git/ref/heads/main")), "positive control: the real ops reader ran over the fixture api");
  assert.equal(source.opsRefusal, undefined, "a readable ops catalog is judged, with no refusal named");
  assert.deepEqual([...source.opsIds].sort(), [...OPS_IDS, OPS_PLAIN], "the ops records the composition admits are named");

  const parked = cadence.parkedVerifyHumanCandidateTasks(source.plan, new Set(), source);
  assert.deepEqual(ids(parked), ALL_IDS, "THE CLAIM: both ops records are parked beside the public ones, each by the rule its public twin meets");

  // Same inputs: the parked ops record is the snapshot's own record, the one the dispatch tick composes; the public ones are untouched.
  const snapshot = await readOpsCatalogSnapshotAsync({ repository: OPS }, fx.api);
  for (const id of OPS_IDS) assert.equal(source.plan.byId.get(id), snapshot.plan?.byId.get(id), `${id} is the snapshot's own record`);
  for (const id of [PUBLIC_RULING, PUBLIC_ESCALATED]) assert.equal(source.plan.byId.get(id), fx.publicPlan.byId.get(id), `${id} is the public plan's own record`);
  assert.deepEqual(withoutSource(source.plan.byId.get(OPS_ESCALATED)!), withoutSource(parseTasksFromYaml(escalated(OPS_ESCALATED), "twin")[0]!),
    "the ops record reads field for field as its yaml");

  // Filing age: a public record's from the code checkout, an ops record's from the ops checkout it was filed in.
  const histories = cadence.verifyHumanFilingHistories(fx.publicDir, parked, source);
  for (const id of ALL_IDS) {
    const history = await resolveTaskFilingHistory(id, histories(id));
    assert.equal(history.state, "qualified", `${id}'s filing age is read where it was filed: ${history.state === "unknown" ? history.reason : ""}`);
  }

  // origin/main: the public plan alone, so no ops record is parked; and an ops record dated from the code checkout has no age.
  assert.deepEqual(ids(cadence.parkedVerifyHumanCandidateTasks(fx.publicPlan, new Set())), [PUBLIC_RULING, PUBLIC_ESCALATED], "on origin/main only public records are judged");
  const publicOnly = cadence.verifyHumanFilingHistories(fx.publicDir, parked, undefined);
  assert.equal((await resolveTaskFilingHistory(OPS_RULING, publicOnly(OPS_RULING))).state, "unknown", "control: the code checkout does not hold the ops record's filing");
});

test("W1-T14641 criterion 2: a release of an ops record writes the same ratify.approved row a public release writes and the dispatch release reader honours it for that ops task", async t => {
  const fx = world(t);
  const snapshot = await readOpsCatalogSnapshotAsync({ repository: OPS }, fx.api);
  const tick = lookup.composeSecondaryPlan(fx.publicPlan, snapshot.plan!);
  assert.equal(tick.outcome, "ok");
  const dispatchPlan = (tick as Extract<typeof tick, { outcome: "ok" }>).plan; // the plan the dispatch tick's release reader reads

  // The cadence's release arm as productionVerifyHumanRelease wires it: the record from the cadence's plan, a proceed from
  // the risk judge, and the row approveParkedTask writes (run_id, task_id, step, released, provenance, release_pin).
  const releaseFrom = async (plan: Plan, id: string, rows: string[]) => releaseAutomatedShard(shardOf(plan.byId.get(id) ?? { id, title: id } as Task),
    { decision: "automate", reason: "fixture automate" }, {
      task: taskId => plan.byId.get(taskId),
      riskJudge: async () => ({ verdict: "low", confidence: 0.99, reasons: ["fixture"] }),
      riskPolicy: DEFAULT_RISK_POLICY,
      writeRelease: (taskId, provenance) => {
        const task = plan.byId.get(taskId)!;
        rows.push(JSON.stringify({ run_id: "VH-FIXTURE", task_id: taskId, step: RELEASE_LEDGER_STEP, released: "verify-human", ...provenance, release_pin: operatorReleasePin(task) }));
        return { code: 0, released: true, message: "released" };
      },
    });
  const read = (rows: string[]) => resolveReleases({ readLedgerLines: () => rows, readDurableReleases: () => new Map() }, dispatchPlan);

  const source = await lookup.readVerifyHumanCadencePlan(fx.publicPlan, { stateDir: fx.stateDir, api: fx.api });
  for (const [publicId, opsId] of [[PUBLIC_ESCALATED, OPS_ESCALATED], [PUBLIC_PLAIN, OPS_PLAIN]] as const) {
    const rows: string[] = [];
    assert.equal((await releaseFrom(source.plan, publicId, rows)).kind, "released");
    assert.equal((await releaseFrom(source.plan, opsId, rows)).kind, "released", `THE CLAIM: the cadence's release arm releases ${opsId}`);
    const [publicRow, opsRow] = rows.map(row => JSON.parse(row) as Record<string, unknown>);
    assert.deepEqual(Object.keys(opsRow!).sort(), Object.keys(publicRow!).sort(), `${opsId}: the ops release row has the public row's fields`);
    assert.equal(opsRow!.step, "ratify.approved");
    assert.equal(opsRow!.release_pin, operatorReleasePin(dispatchPlan.byId.get(opsId)!), `${opsId}: the row pins the record the tick hashes`);
    assert.equal(releaseContractPins(source.plan.tasks)(opsId), opsRow!.release_pin, `${opsId}: the writer's own release check reads the same pin`);

    const resolved = read(rows);
    assert.equal(resolved.authors.get(opsId), "machine", `${opsId}: the dispatch reader reads the ops release by its pin`);
    assert.equal(resolved.ids.has(opsId), resolved.ids.has(publicId), `${opsId}: the ops release is honoured exactly when its public twin's is`);
    assert.equal(resolved.setAside.has(opsId), resolved.setAside.has(publicId), `${opsId}: and set aside exactly when its public twin's is`);
  }
  // The dispatch reader's own rule, the same in both catalogs: a machine release of a record its judge escalated at the
  // current pin waits for the operator; one of a record no judge escalated is honoured.
  const rows: string[] = [];
  await releaseFrom(source.plan, OPS_PLAIN, rows);
  assert.ok(read(rows).ids.has(OPS_PLAIN), "THE CLAIM: the dispatch release reader honours the ops release");
  const escalatedRows: string[] = [];
  await releaseFrom(source.plan, OPS_ESCALATED, escalatedRows);
  assert.ok(read(escalatedRows).setAside.has(OPS_ESCALATED), "control: a current-pin escalation is set aside, as a public one is");

  // origin/main: the cadence's plan is the public plan alone, so an ops record resolves to nothing and no row is written.
  const mainRows: string[] = [];
  for (const opsId of [OPS_ESCALATED, OPS_PLAIN]) assert.equal((await releaseFrom(fx.publicPlan, opsId, mainRows)).kind, "unavailable", `${opsId} resolves to nothing`);
  assert.deepEqual(mainRows, [], "on origin/main no ops record is ever released");
  assert.equal(read(mainRows).ids.has(OPS_PLAIN), false);
});

test("W1-T14641 criterion 3: invariant:unreadable-ops-judges-public-only — when the ops snapshot is not ok the cadence judges the public records exactly as on origin/main and names the ops refusal in its result", async t => {
  const fx = world(t);
  const today = ids(cadence.parkedVerifyHumanCandidateTasks(fx.publicPlan, new Set()));
  const counts = { treeEntries: 0, shards: 0, bytes: 0, passes: 1, fetchedObjects: [0], cachedObjects: 0 };
  const malformed = { outcome: "ok", plan: { tasks: [], byId: new Map([["W1-T964199", {} as Task]]) }, counts } as OpsCatalogSnapshot;
  const unreadableState = join(fx.root, "unreadable-state");
  mkdirSync(unreadableState);
  writeFileSync(join(unreadableState, "plan-destination.json"), "{ not json");
  const refusals: Array<[string, Parameters<typeof lookup.readVerifyHumanCadencePlan>[1]]> = [
    ["destination-unreadable", { stateDir: unreadableState, api: fx.api }],
    ["ops-stale", { stateDir: fx.stateDir, opsSnapshot: { outcome: "stale", counts } }],
    ["ops-auth_missing", { stateDir: fx.stateDir, api: async () => { throw new OpsCatalogAuthMissingError(); } }],
    ["compose-malformed", { stateDir: fx.stateDir, opsSnapshot: malformed }],
  ];
  for (const [reason, sources] of refusals) {
    const source = await lookup.readVerifyHumanCadencePlan(fx.publicPlan, sources);
    assert.equal(source.plan, fx.publicPlan, `${reason}: THE CLAIM: the public plan itself is judged`);
    assert.equal(source.opsIds.size, 0, `${reason}: no ops record is judged`);
    assert.deepEqual(ids(cadence.parkedVerifyHumanCandidateTasks(source.plan, new Set(), source)), today, `${reason}: the parked set is origin/main's`);
    assert.equal(source.opsRefusal, reason, `${reason}: the refusal is named`);
    const appended: Record<string, unknown>[] = [];
    const result = await cadence.verifyHumanCadence({
      shards: cadence.parkedVerifyHumanCandidateTasks(source.plan, new Set(), source).map(shardOf), priorVerdicts: new Map(),
      judge: async () => ({ decision: "backlog", reason: "fixture backlog" }), stageProposal: () => {}, appendRow: row => { appended.push(row); },
      runId: "VH-FIXTURE", opsRefusal: source.opsRefusal,
    });
    assert.notEqual(result.status, "refused", `${reason}: the cadence still runs`);
    assert.equal(result.judged, today.length, `${reason}: every public record is judged`);
    assert.equal(result.opsRefusal, reason, `${reason}: THE CLAIM: the result names the ops refusal`);
  }
  // Control: with no destination the switch is off, nothing is refused and the public plan is judged as on origin/main.
  const off = await lookup.readVerifyHumanCadencePlan(fx.publicPlan, { stateDir: join(fx.root, "no-destination") });
  assert.equal(off.plan, fx.publicPlan);
  assert.equal(off.opsRefusal, undefined);
});
