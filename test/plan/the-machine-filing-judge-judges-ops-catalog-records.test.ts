/**
 * W1-T14656: the machine-filing judge reads the public plan composed with the ops catalog and lands a rewrite of an ops
 * record as a plan PR of the ops repository. On origin/main `productionMachineFilingJudgePorts` (src/run-task.ts) read
 * only the public plan monolith at main, so a machine-filed `verify: human` record in the ops catalog was never judged
 * and never released; `rmd verify-human-sweep` read the public plan alone as well.
 *
 * The plan both read is `machineJudgePlanSource` (src/lib/machine-filing-judge.ts); the judge lands each catalog's
 * rewrites apart, by the `openWorkspace` and `openOpsWorkspace` ports. This suite drives those directly: a new importer
 * of src/run-task.ts would trip the affected-suite reach ratchet.
 *
 * Fixtures are real where they can be: the ops snapshot comes through the real pinned reader over a GET-only api serving
 * the ops checkout's files, so each ops record carries the label the production reader gives it (`tasks.d/<file>`). The
 * two workspaces are directory copies of the two checkouts, which is what a garden worktree is to the judge.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
// Namespace imports: a name this build adds reads as undefined at base, so each criterion fails on its own.
import * as judge from "#src/lib/machine-filing-judge.js";
import * as cadence from "#src/lib/measurement-cadence.js";
import { fixedClock } from "#src/lib/clock.js";
import { machineShardHeaderLines } from "#src/lib/machine-filing.js";
import { loadPlan, type Plan, type Task } from "#src/lib/plan.js";
import { OpsCatalogAuthMissingError, type OpsCatalogApi } from "#src/lib/ops-catalog-source.js";
import type { RiskJudgeInput, RiskJudgeVerdict } from "#src/lib/risk-judge.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const OPS = "fixture-private/ops-catalog";
const PUBLIC_ID = "W1-T965601", OPS_ID = "W1-T965602", OPS_RULING = "W1-T965603";
const FILE = "docs/ci-friction-remedies.md";
const CLOCK = fixedClock(1790800000000);

/** A machine-filed `verify: human` record no judge has ruled on: the machine-filing judge's to route. */
const machineRecord = (id: string): string => [
  `- id: ${id}`, `  title: ${JSON.stringify(`record the remedy for ${id}`)}`, "  repo: remudero", "  depends_on: []", "  type: implement",
  ...machineShardHeaderLines([FILE]), `  origin: ${JSON.stringify(`ci-friction:${id}`)}`,
  "  files:", `    - ${FILE}`, "  acceptance:", `    - claim: "the remedy for ${id} is recorded"`, `      proof: "grep: ${id} in ${FILE}"`, "",
].join("\n");

/** A ruling-shaped operator record (it declares DECISIONS.md): the records the sweep keeps for a person. */
const rulingRecord = (id: string): string => [
  `- id: ${id}`, `  title: "Record a ruling for ${id}"`, "  repo: remudero", "  depends_on: []", "  type: implement",
  "  verify: human", "  risk: low", "  priority: 1", "  status: queued", "  files: [DECISIONS.md]",
  "  rationale: \"a ruling only the operator can make\"",
  "  acceptance:", `    - claim: "the ruling for ${id} is recorded"`, `      proof: "grep: ${id} in DECISIONS.md"`, "",
].join("\n");

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
}

/** A GET-only api serving `files` as the ops repository's default branch, every object addressed by its digest. */
function opsApi(files: Record<string, string>): OpsCatalogApi {
  const digest = (s: string) => createHash("sha1").update(s).digest("hex");
  const blobSha = (text: string) => digest(`blob ${Buffer.byteLength(text)}\0${text}`);
  const shards = Object.entries(files).filter(([rel]) => rel.startsWith("plan/tasks.d/"));
  const monolith = files["plan/tasks.yaml"]!;
  const shardTree = digest(`shards:${shards.map(([rel]) => rel).join(",")}`), planTree = digest(`plan:${shardTree}`);
  const rootTree = digest(`root:${planTree}`), commit = digest(`commit:${rootTree}`);
  const blobs = new Map([monolith, ...shards.map(([, text]) => text)].map(text => [blobSha(text), text]));
  const base = `repos/${OPS}`;
  return async path => {
    if (path === base) return { id: 14656, full_name: OPS, default_branch: "main" };
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

interface World { root: string; stateDir: string; publicDir: string; opsDir: string; api: OpsCatalogApi; publicPlan: () => Plan }

/** The fleet shape: `<root>/state` names the ops destination, whose checkout is `<root>/repos/<name>`. */
function world(t: TestContext, shape: { publicRecords: Record<string, string>; opsRecords: Record<string, string> }): World {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}machine-judge-ops-`));
  const stateDir = join(root, "state");
  const publicDir = join(root, "public"), opsDir = join(root, "repos", "ops-catalog");
  mkdirSync(stateDir);
  writeFileSync(join(stateDir, "plan-destination.json"), JSON.stringify({ repository: OPS, kinds: [] }));
  const tree = (records: Record<string, string>) => ({
    "plan/tasks.yaml": "[]\n", ...Object.fromEntries(Object.entries(records).map(([id, text]) => [`plan/tasks.d/${id}.yaml`, text])),
  });
  writeTree(publicDir, { ...tree(shape.publicRecords), [FILE]: "remedies\n" });
  writeTree(opsDir, tree(shape.opsRecords));
  void t;
  return {
    root, stateDir, publicDir, opsDir, api: opsApi(tree(shape.opsRecords)),
    publicPlan: () => loadPlan(join(publicDir, "plan", "tasks.yaml")),
  };
}

const low = async (): Promise<RiskJudgeVerdict> => ({ verdict: "low", confidence: 0.95, reasons: ["a docs remedy"] });
const ids = (tasks: readonly Task[]) => tasks.map(task => task.id).sort();

/** A directory copy of a checkout's plan: what a garden worktree is to the judge. */
const workspace = (from: string, name: string, root: string, landed: { paths: string[]; title: string }[], url: string) => {
  let opened = 0;
  const port = () => {
    opened++;
    const wsRoot = join(root, `${name}-${opened}`);
    cpSync(from, wsRoot, { recursive: true });
    return { root: wsRoot, branch: `${name}-garden`, land: (landing: { paths: string[]; title: string }) => { landed.push(landing); return url; }, dispose: () => undefined };
  };
  return { port, opened: () => opened };
};

type Log = { step: string; extra?: Record<string, unknown> };

function judgePorts(fx: World, source: { plan: Plan; opsIds: ReadonlySet<string>; opsRefusal?: string }, extra: Partial<judge.MachineJudgePorts>) {
  const logs: Log[] = [];
  const ports: judge.MachineJudgePorts = {
    stateDir: fx.stateDir, plan: () => source.plan, riskJudge: async (_input: RiskJudgeInput) => low(),
    ops: () => ({ ids: source.opsIds, ...(source.opsRefusal === undefined ? {} : { refusal: source.opsRefusal }) }),
    codeRoot: fx.publicDir, isMerged: () => false, stageProposal: () => undefined,
    log: (step, more) => void logs.push({ step, extra: more }), clock: CLOCK, ...extra,
  };
  return { ports, logs };
}

test("W1-T14656 criterion 1: the judge's plan holds every queued ops record next to the public ones, each anchored in its own checkout", async t => {
  const fx = world(t, { publicRecords: { [PUBLIC_ID]: machineRecord(PUBLIC_ID) }, opsRecords: { [OPS_ID]: machineRecord(OPS_ID) } });
  const publicPlan = fx.publicPlan();
  const source = await judge.machineJudgePlanSource(publicPlan, { stateDir: fx.stateDir, api: fx.api });
  assert.equal(source.opsRefusal, undefined, "a readable ops catalog is judged, with no refusal named");
  assert.deepEqual(ids(source.plan.tasks), [PUBLIC_ID, OPS_ID], "THE CLAIM: the ops record is in the plan beside the public one");
  assert.deepEqual([...source.opsIds], [OPS_ID], "the ops records are named, so landing can tell the catalogs apart");
  const opsTask = source.plan.byId.get(OPS_ID)!;
  assert.equal(opsTask.sourcePath, join(fx.opsDir, "plan", "tasks.d", `${OPS_ID}.yaml`), "the ops record is addressed in the ops checkout");
  assert.equal(judge.shardRelPath(opsTask), `plan/tasks.d/${OPS_ID}.yaml`);
  assert.ok(judge.needsMachineJudgement(opsTask), "an anchored ops record is one the judge rules on; unanchored it never was");
  assert.equal(source.plan.byId.get(PUBLIC_ID), publicPlan.byId.get(PUBLIC_ID), "a public record is exactly as the public plan holds it");
});

test("W1-T14656 criterion 2: an ops record's rewrite lands through the ops workspace alone, and a public record's through the public one", async t => {
  const fx = world(t, { publicRecords: { [PUBLIC_ID]: machineRecord(PUBLIC_ID) }, opsRecords: { [OPS_ID]: machineRecord(OPS_ID) } });
  const source = await judge.machineJudgePlanSource(fx.publicPlan(), { stateDir: fx.stateDir, api: fx.api });
  const publicLanded: { paths: string[]; title: string }[] = [], opsLanded: { paths: string[]; title: string }[] = [];
  const pub = workspace(fx.publicDir, "public", fx.root, publicLanded, "https://github.com/fixture/public/pull/1");
  const ops = workspace(fx.opsDir, "ops", fx.root, opsLanded, "https://github.com/fixture-private/ops-catalog/pull/2");
  const { ports, logs } = judgePorts(fx, source, { openWorkspace: pub.port, openOpsWorkspace: ops.port, prState: () => "merged" });

  const first = await judge.runMachineFilingJudge(ports);
  assert.deepEqual(first.proceeded, [PUBLIC_ID], "the public record is released first");
  assert.deepEqual(publicLanded.map(l => l.paths), [[`plan/tasks.d/${PUBLIC_ID}.yaml`]], "its landing carries no ops record");
  assert.equal(ops.opened(), 0, "no ops workspace is opened while a public record lands: no landing mixes the catalogs");
  assert.equal(opsLanded.length, 0);

  // The public landing merged: its rewrite is what the public checkout now holds.
  cpSync(join(fx.root, "public-1", "plan"), join(fx.publicDir, "plan"), { recursive: true });
  const next = await judge.machineJudgePlanSource(fx.publicPlan(), { stateDir: fx.stateDir, api: fx.api });
  const second = await judge.runMachineFilingJudge(judgePorts(fx, next, { openWorkspace: pub.port, openOpsWorkspace: ops.port, prState: () => "merged" }).ports);
  assert.deepEqual(second.proceeded, [OPS_ID], "THE CLAIM: the ops record is released by the pass that has no public rewrite");
  assert.deepEqual(opsLanded.map(l => l.paths), [[`plan/tasks.d/${OPS_ID}.yaml`]], "it lands in the ops workspace under its own path");
  assert.equal(publicLanded.length, 1, "the public repository is not asked to carry an ops record");
  const rewritten = readFileSync(join(fx.root, "ops-1", "plan", "tasks.d", `${OPS_ID}.yaml`), "utf8");
  assert.match(rewritten, /^ {2}verify: auto$/m, "the ops record is released to verify: auto in the ops tree");
  assert.equal(readFileSync(join(fx.opsDir, "plan", "tasks.d", `${OPS_ID}.yaml`), "utf8"), machineRecord(OPS_ID), "the checkout itself is not written");
  assert.ok(logs.length > 0, "positive control: the pass logged");
});

test("W1-T14656 criterion 3: the sweep's parked population lists an ops record with the public ones", async t => {
  const fx = world(t, { publicRecords: { [PUBLIC_ID]: rulingRecord(PUBLIC_ID) }, opsRecords: { [OPS_RULING]: rulingRecord(OPS_RULING) } });
  const publicOnly = cadence.parkedVerifyHumanCandidateTasks(fx.publicPlan());
  assert.deepEqual(ids(publicOnly), [PUBLIC_ID], "positive control: on the public plan alone the sweep lists the public record only");
  const source = await judge.machineJudgePlanSource(fx.publicPlan(), { stateDir: fx.stateDir, api: fx.api });
  const parked = cadence.parkedVerifyHumanCandidateTasks(source.plan, new Set(), source);
  assert.deepEqual(ids(parked), [PUBLIC_ID, OPS_RULING], "THE CLAIM: the parked ops record is listed beside the public one");
  const histories = cadence.verifyHumanFilingHistories(fx.publicDir, parked, source);
  assert.equal(typeof histories(OPS_RULING), "object", "an ops record's filing history is read from the checkout it was filed in");
});

test("W1-T14656 criterion 4: with the ops snapshot not ok the judge and the sweep act on the public records and name the refusal", async t => {
  const fx = world(t, { publicRecords: { [PUBLIC_ID]: machineRecord(PUBLIC_ID) }, opsRecords: { [OPS_ID]: machineRecord(OPS_ID) } });
  const unreadable = async () => { throw new OpsCatalogAuthMissingError(); };
  const source = await judge.machineJudgePlanSource(fx.publicPlan(), { stateDir: fx.stateDir, api: unreadable });
  assert.equal(source.opsRefusal, "ops-auth_missing", "the refusal is named");
  assert.deepEqual(ids(source.plan.tasks), [PUBLIC_ID], "the plan is the public plan, as on origin/main");
  assert.equal(source.opsIds.size, 0);

  const publicLanded: { paths: string[]; title: string }[] = [], opsLanded: { paths: string[]; title: string }[] = [];
  const pub = workspace(fx.publicDir, "public", fx.root, publicLanded, "https://github.com/fixture/public/pull/1");
  const ops = workspace(fx.opsDir, "ops", fx.root, opsLanded, "https://github.com/fixture-private/ops-catalog/pull/2");
  const { ports } = judgePorts(fx, source, { openWorkspace: pub.port, openOpsWorkspace: ops.port });
  const report = await judge.runMachineFilingJudge(ports);
  assert.deepEqual(report.proceeded, [PUBLIC_ID], "THE CLAIM: the public record is judged exactly as before");
  assert.equal(ops.opened(), 0, "the ops catalog is not touched");
  assert.equal(opsLanded.length, 0);
  assert.equal(report.opsRefusal, "ops-auth_missing", "the pass names the ops refusal");

  const off = await judge.machineJudgePlanSource(fx.publicPlan(), { stateDir: join(fx.root, "no-state") });
  assert.equal(off.opsRefusal, undefined, "an ops catalog that is off is not a refusal");
  assert.deepEqual(ids(off.plan.tasks), [PUBLIC_ID]);
});
