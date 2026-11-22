/**
 * W1-T13785 — A HELD PUBLIC RECORD IS NOT RELEASED BY RMD APPROVE.
 *
 * composeSecondaryPlan holds public records too: both copies of an id the two catalogs hold without a valid moved_from,
 * a public task naming an ops id, and every task depending on either. The daemon dispatches from that composition, but
 * approve resolved a public hit without composing and released it. Here the approve release plan answers held for such a
 * record over the public view it reads, the refusal row and the stuck-state probe name the public record's digest, and
 * every record the composition does not hold is answered as before.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { readOriginMainSha } from "#src/lib/inbox.js";
import { readOpsCatalogSnapshotAsync, type OpsCatalogApi } from "#src/lib/ops-catalog-source.js";
import { operatorReleasePin } from "#src/lib/operator-release.js";
import { loadPlan, parseTasksFromYaml, type Plan } from "#src/lib/plan.js";
import {
  APPROVE_RELEASE_REFUSED_STEP, opsRecordDigest, productionStuckStatePorts, productionStuckStateProbe, publicRecordDigest, readApproveRelease, runStuckStateGardener, scanStuckState,
} from "#src/lib/stuck-state-gardener.js";
import { composeSecondaryPlan, findApproveReleasePlan, loadLocalReleasePlan, readReleasePublicPlan, type ReleasePublicPlan } from "#src/lib/task-lookup.js";
import { gitRepo } from "#test/helpers/git-repo.js";

type Row = Record<string, unknown>;
const REPOSITORY = "fixture-private/ops";
const MISSING = "W1-T9";
const BAD_EDGE = "invalid_cross_catalog_dependency";
const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

const record = (id: string, depends: string[] = [], title = `held public fixture ${id}`): string =>
  `- id: ${id}\n  title: ${title}\n  repo: remudero\n  type: implement\n  verify: human\n  status: queued\n  depends_on: [${depends.join(", ")}]\n`;
const planOf = (text: string, label: string): Plan => {
  const tasks = parseTasksFromYaml(text, `${label}.yaml`);
  return { tasks, byId: new Map(tasks.map(task => [task.id, task])) };
};

/** A state directory naming the ops repository, and that repository's read-only routes over a text a test may change. */
function opsCatalog(t: TestContext, initial: string, branch = "main") {
  let text = initial;
  let blobUnreadable = false;
  const root = mkdtempSync(join(tmpdir(), "rmd-held-public-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"); mkdirSync(stateDir);
  writeFileSync(join(stateDir, "plan-destination.json"), JSON.stringify({ repository: REPOSITORY, kinds: [] }));
  const api: OpsCatalogApi = async path => {
    const commit = sha1(text), tree = sha1(commit + "root"), plan = sha1(commit + "plan");
    const blob = sha1(`blob ${Buffer.byteLength(text)}\0${text}`);
    const base = `repos/${REPOSITORY}`;
    if (path === base) return { id: 42, full_name: REPOSITORY, default_branch: branch };
    if (path === `${base}/git/ref/heads/${branch}`) return { object: { type: "commit", sha: commit } };
    if (path === `${base}/git/commits/${commit}`) return { sha: commit, tree: { sha: tree } };
    if (path === `${base}/git/trees/${tree}`) return { sha: tree, truncated: false, tree: [{ path: "plan", sha: plan, type: "tree", mode: "040000" }] };
    if (path === `${base}/git/trees/${plan}`) return { sha: plan, truncated: false, tree: [{ path: "tasks.yaml", sha: blob, type: "blob", mode: "100644" }] };
    assert.equal(path, `${base}/git/blobs/${blob}`, "only pinned read-only fixture routes may run");
    if (blobUnreadable) throw new Error("fixture ops blob unavailable");
    return { sha: blob, encoding: "base64", size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") };
  };
  return { stateDir, api, lookup: { stateDir, api }, set: (next: string) => { text = next; }, commit: () => sha1(text),
    setBlobUnreadable: (unreadable: boolean) => { blobUnreadable = unreadable; },
    read: () => readOpsCatalogSnapshotAsync({ repository: REPOSITORY }, api) };
}

// W1-T13749's fixture worlds (test/daemon/one-bad-cross-catalog-edge-holds-only-its-own-task.test.ts), with a public
// dependant of the duplicated id added so each held public shape has a dependant.
const PUBLIC_TEXT = record("PUB-1") + record("PUB-2");
const SOUND_OPS = record("OPS-GOOD") + record("OPS-ON-PUBLIC", ["PUB-1"]) + record("OPS-ON-GOOD", ["OPS-GOOD"]);
const BAD_OPS = record("OPS-BAD", [MISSING]) + record("OPS-CHILD", ["OPS-BAD"]) + record("OPS-GRANDCHILD", ["OPS-CHILD"]);
const DUP_HOLD = { reason: "duplicate_task_id", task: "PUB-2" };
const REV_HOLD = { reason: BAD_EDGE, task: "PUB-REV", dependsOn: "OPS-GOOD" };
const WORLDS = [
  { name: "a dangling ops edge", publicText: PUBLIC_TEXT, opsText: BAD_OPS + SOUND_OPS },
  { name: "a duplicate without moved_from", publicText: PUBLIC_TEXT + record("PUB-2-CHILD", ["PUB-2"]),
    opsText: record("PUB-2") + record("OPS-DUP-CHILD", ["PUB-2"]) + SOUND_OPS },
  { name: "a public task naming an ops id", publicText: PUBLIC_TEXT + record("PUB-REV", ["OPS-GOOD"]) + record("PUB-REV-CHILD", ["PUB-REV"]),
    opsText: SOUND_OPS },
  { name: "no bad edge", publicText: PUBLIC_TEXT, opsText: SOUND_OPS },
];
const viewOf = (plan: Plan, read: "origin/main" | "working_tree"): (() => Promise<ReleasePublicPlan>) =>
  async () => read === "origin/main" ? { plan, read } : { plan, read, reason: "origin-main-unreadable" };

test("W1-T13785 criterion 3: findApproveReleasePlan answers held with the reason and the edge for each held public record, and undefined for a sound one", async t => {
  const cases = [
    { world: WORLDS[1]!, held: { "PUB-2": DUP_HOLD, "PUB-2-CHILD": DUP_HOLD }, sound: ["PUB-1"] },
    { world: WORLDS[2]!, held: { "PUB-REV": REV_HOLD, "PUB-REV-CHILD": REV_HOLD }, sound: ["PUB-1"] },
  ];
  for (const { world, held, sound } of cases) {
    const fx = opsCatalog(t, world.opsText), publicPlan = planOf(world.publicText, "public");
    for (const read of ["origin/main", "working_tree"] as const) {
      for (const [id, hold] of Object.entries(held)) {
        assert.deepEqual(await findApproveReleasePlan(id, publicPlan, viewOf(publicPlan, read), fx.lookup), { outcome: "held", hold },
          `${world.name}, ${read}: ${id} is held by ${JSON.stringify(hold)}`);
      }
      for (const id of sound) {
        assert.equal(await findApproveReleasePlan(id, publicPlan, viewOf(publicPlan, read), fx.lookup), undefined,
          `${world.name}, ${read}: the sound ${id} keeps its own local plan`);
      }
    }
  }
});

/** A public plan committed at origin/main in a git checkout; `publish` moves origin/main and leaves the boot detached. */
function publicMain(t: TestContext, text: string) {
  const checkout = gitRepo({ scope: t, seedCommit: false });
  const planPath = join(checkout.dir, "plan", "tasks.yaml");
  mkdirSync(join(checkout.dir, "plan"));
  const publish = (next: string) => {
    writeFileSync(planPath, next);
    checkout.git("add", "plan/tasks.yaml");
    checkout.git("commit", "--quiet", "--allow-empty", "-m", "fixture main");
    const sha = checkout.git("rev-parse", "HEAD");
    checkout.git("update-ref", "refs/remotes/origin/main", sha);
    return sha;
  };
  const boot = publish(text);
  return { dir: checkout.dir, planPath, boot, publish: (next: string) => { const sha = publish(next); checkout.git("checkout", "--quiet", "--detach", boot); return sha; },
    head: () => readOriginMainSha(checkout.dir), unpublish: () => checkout.git("update-ref", "-d", "refs/remotes/origin/main"),
    restoreBootRef: () => checkout.git("update-ref", "refs/remotes/origin/main", boot) };
}

/** The refused public release and the gardener replay over an older detached checkout. */
async function refusalFixture(t: TestContext, opsBranch = "main", bootText = PUBLIC_TEXT.replace("held public fixture PUB-2", "older boot record"),
  refusedText = PUBLIC_TEXT) {
  const fx = opsCatalog(t, record("PUB-2") + record("OPS-GOOD"), opsBranch);
  const main = publicMain(t, bootText);
  main.publish(refusedText);
  const rows: Row[] = [];
  let now = NOW;
  const append = (row: Row) => rows.push({ ts: iso(now), ...row });
  const bootPlan = loadPlan(main.planPath);
  const held = await readApproveRelease("PUB-2", bootPlan, main.dir, fx.lookup, append);
  assert.deepEqual(held, { outcome: "held", hold: DUP_HOLD });
  const approved: { id: string; pin: string }[] = [];
  const ports = {
    ...productionStuckStatePorts({
      stateDir: fx.stateDir, api: fx.api, publicRoot: main.dir, publicMainCommit: main.head, gardenNames: [],
      log: (step, extra = {}) => void rows.push({ ts: iso(now), step, ...extra }), escalate: () => null,
      destinationRead: async () => undefined, approve: async (id, digest, publicSource, checkout) => {
        const release = await readApproveRelease(id, digest === undefined ? bootPlan : undefined, checkout ?? main.dir, fx.lookup, append, digest, publicSource === "working_tree");
        const task = (release?.outcome === "found" ? release.plan : bootPlan).byId.get(id)!;
        approved.push({ id, pin: operatorReleasePin(task) });
        return release?.outcome === "found" || release === undefined ? 0 : 1;
      },
    }),
    readRows: () => rows, nowMs: () => now,
  };
  const pass = async () => { now += MIN; await runStuckStateGardener(ports); };
  return { fx, main, rows, ports, pass, approved };
}
const steps = (rows: readonly Row[], step: string) => rows.filter(row => row.step === step);

test("W1-T13785 criterion 4: the release probe reads a held public record's cause while the composition holds it and gone once the edge clears, with the public record's digest, and the gardener re-runs that release once", async t => {
  const { fx, main, rows, ports, pass, approved } = await refusalFixture(t);
  const refusal = steps(rows, APPROVE_RELEASE_REFUSED_STEP);
  assert.equal(refusal.length, 1, "the operator's refusal wrote one row");
  const current = (await readReleasePublicPlan(main.dir)).plan.byId.get("PUB-2")!;
  const digest = publicRecordDigest(current);
  assert.notEqual(digest, publicRecordDigest(loadPlan(main.planPath).byId.get("PUB-2")!), "the detached record predates the refused record");
  assert.equal(refusal[0]!.public_record_digest, digest, "the row names the public record's digest");
  const [item] = scanStuckState(rows).open;
  assert.equal(item?.digest, digest, "the held item carries it");
  assert.equal((await ports.probe(item!)).present, true, "present while the composition holds the public copy");

  await pass();
  assert.equal(steps(rows, "stuck_state.held").length, 1);
  await pass();
  assert.deepEqual(approved, [], "an unchanged cause re-runs nothing");

  fx.set(record("OPS-GOOD"));
  assert.deepEqual(await ports.probe(item!), { present: false, digest }, "gone once the edge clears, with the same public digest");
  await pass();
  await pass();
  assert.deepEqual(approved, [{ id: "PUB-2", pin: operatorReleasePin(current) }], "one replay pins the verified public record");
  assert.deepEqual(steps(rows, "stuck_state.record_changed"), []);
  assert.deepEqual(steps(rows, "stuck_state.cleared").map(row => row.retry), ["approve"]);
});

test("W1-T13785 criterion 4: a failed ops blob read leaves the new ref pending for a single replay at the same ref", async t => {
  const { fx, main, rows, ports, pass, approved } = await refusalFixture(t);
  const readOpsStamp = ports.eventStamps["ops-main"]!;
  const initialRef = await readOpsStamp();
  await pass();
  const [item] = scanStuckState(rows).open;
  assert.ok(item);

  fx.set(record("OPS-GOOD"));
  fx.setBlobUnreadable(true);
  const advancedRef = await readOpsStamp();
  assert.equal(typeof advancedRef, "string");
  assert.notEqual(advancedRef, initialRef);
  const probe = await ports.probe(item);
  assert.equal(probe.present, true);
  assert.match(probe.reason ?? "", /^ops-/);
  assert.equal("digest" in probe, false);
  await pass();
  assert.deepEqual(approved, []);
  const state = JSON.parse(readFileSync(join(fx.stateDir, "stuck-state.json"), "utf8"));
  assert.equal(state.items[item.key].stamps["ops-main"], initialRef, "the unread blob did not consume the ref advance");

  fx.setBlobUnreadable(false);
  assert.equal(await readOpsStamp(), advancedRef, "recovery needs no further ref movement");
  const current = (await readReleasePublicPlan(main.dir)).plan.byId.get("PUB-2")!;
  assert.deepEqual(await ports.probe(item), { present: false, digest: publicRecordDigest(current) });
  await pass();
  await pass();
  assert.deepEqual(approved, [{ id: "PUB-2", pin: operatorReleasePin(current) }]);
  assert.deepEqual(steps(rows, "stuck_state.cleared").map(row => row.events), [["ops-main"]]);
  assert.deepEqual(steps(rows, "stuck_state.record_changed"), []);
});

test("W1-T13785 criterion 4: the ops clearing event follows the catalog's default branch, so a hold cleared on trunk re-runs the release once", async t => {
  const { fx, main, rows, ports, pass, approved } = await refusalFixture(t, "trunk");
  const [item] = scanStuckState(rows).open;
  assert.ok(item);
  const readOpsStamp = ports.eventStamps["ops-main"]!;
  assert.equal(await readOpsStamp(), fx.commit(), "the stamp is the trunk commit the catalog read binds");
  await pass();
  assert.deepEqual(approved, [], "an unchanged cause re-runs nothing");

  fx.set(record("OPS-GOOD"));
  assert.equal(await readOpsStamp(), fx.commit(), "removing the duplicate on trunk moves the stamp");
  const current = (await readReleasePublicPlan(main.dir)).plan.byId.get("PUB-2")!;
  assert.deepEqual(await ports.probe(item), { present: false, digest: publicRecordDigest(current) });
  await pass();
  await pass();
  assert.deepEqual(approved, [{ id: "PUB-2", pin: operatorReleasePin(current) }], "one replay on the trunk clearing event");
  assert.deepEqual(steps(rows, "stuck_state.cleared").map(row => row.events), [["ops-main"]]);
  assert.deepEqual(steps(rows, "stuck_state.record_changed"), []);
});

test("W1-T13785 criterion 4: a pinned public replay waits for a strict working-tree repair after the ops duplicate clears", async t => {
  const { fx, main, ports, rows, pass, approved } = await refusalFixture(t);
  const invalid = PUBLIC_TEXT + record("PUB-REV", ["OPS-GOOD"]);
  const publicCommit = main.publish(invalid);
  writeFileSync(main.planPath, invalid);
  const [item] = scanStuckState(rows).open;
  assert.ok(item?.publicRelease?.publicCommit);
  const current = (await readReleasePublicPlan(main.dir, { keepUnseenDependencies: true })).plan.byId.get("PUB-2")!;
  const digest = publicRecordDigest(current);
  assert.equal(item.digest, digest);
  assert.deepEqual(await ports.probe(item), { present: true, digest, reason: "held" });
  await pass();

  fx.set(record("OPS-GOOD"));
  const opsCommit = fx.commit();
  assert.deepEqual(await ports.probe(item), { present: true, digest, reason: "public-replay-plan-invalid" });
  await pass();
  await pass();
  assert.deepEqual(approved, [], "no replay while origin/main's approve would refuse the plan");

  writeFileSync(main.planPath, PUBLIC_TEXT);
  assert.equal(main.head(), publicCommit);
  assert.equal(fx.commit(), opsCommit);
  assert.deepEqual(await ports.probe(item), { present: false, digest });
  await pass();
  await pass();
  assert.deepEqual(approved, [{ id: "PUB-2", pin: operatorReleasePin(current) }]);
  assert.deepEqual(steps(rows, "stuck_state.retried").map(row => [row.exit_code, row.events]), [[0, ["public-working-tree"]]]);
  assert.deepEqual(steps(rows, "stuck_state.record_changed"), []);
});

test("W1-T13785 criterion 4: clearing the duplicate replays the unchanged public record from the strict fallback", async t => {
  const { fx, main, ports, rows, pass, approved } = await refusalFixture(t, "main", PUBLIC_TEXT);
  const invalidTip = PUBLIC_TEXT + record("PUB-REV", ["OPS-GOOD"]);
  main.publish(invalidTip);
  const [item] = scanStuckState(rows).open;
  assert.ok(item?.publicRelease?.publicCommit);
  const strict = await readReleasePublicPlan(main.dir);
  assert.equal(strict.read, "working_tree");
  const current = strict.plan.byId.get("PUB-2")!;
  const digest = publicRecordDigest(current);
  assert.equal(item.digest, digest);
  assert.deepEqual(await ports.probe(item), { present: true, digest, reason: "held" });
  await pass();

  fx.set(record("OPS-GOOD"));
  assert.equal(await readApproveRelease("PUB-2", strict.plan, main.dir, fx.lookup, row => rows.push(row)), undefined,
    "ordinary approve uses the valid working-tree record");
  assert.deepEqual(await ports.probe(item), { present: false, digest });
  await pass();
  await pass();
  assert.deepEqual(approved, [{ id: "PUB-2", pin: operatorReleasePin(current) }]);
  assert.deepEqual(steps(rows, "stuck_state.retried").map(row => row.exit_code), [0]);
  assert.deepEqual(steps(rows, "stuck_state.record_changed"), []);
});

test("W1-T13785 criterion 4: the probe and retry reject a changed record in the strict fallback", async t => {
  const { fx, main, ports, rows, pass, approved } = await refusalFixture(t, "main", PUBLIC_TEXT);
  main.publish(PUBLIC_TEXT + record("PUB-REV", ["OPS-GOOD"]));
  const [item] = scanStuckState(rows).open;
  assert.ok(item?.digest);
  await pass();
  fx.set(record("OPS-GOOD"));
  assert.deepEqual(await ports.probe(item), { present: false, digest: item.digest });

  writeFileSync(main.planPath, PUBLIC_TEXT.replace("held public fixture PUB-2", "edited after the probe"));
  const fallback = loadPlan(main.planPath).byId.get("PUB-2")!;
  assert.deepEqual(await readApproveRelease("PUB-2", undefined, main.dir, fx.lookup, row => rows.push(row), item.digest),
    { outcome: "unreadable", reason: "public-replay-record-unverified" });
  await pass();
  await pass();
  assert.deepEqual(approved, []);
  assert.deepEqual(steps(rows, "stuck_state.record_changed").map(row => row.current_digest), [publicRecordDigest(fallback)]);
});

test("W1-T13785 criterion 4: beside an unrelated public-to-ops edge, the probe reports the digest of the record the strict fallback's composition resolved, and the retry checks that same record", async t => {
  // The reviewer's world (2026-11-21 14:03Z): the ops duplicate clears and origin/main retitles the refused PUB-2 beside
  // an unrelated public-to-ops edge, so origin/main does not load strictly and its working-tree fallback, where PUB-2 is
  // unchanged, is the composition (operator ruling 2026-11-21). The probe's digest and the retry's check are one record.
  const { fx, main, ports, rows, pass, approved } = await refusalFixture(t, "main", PUBLIC_TEXT);
  const [item] = scanStuckState(rows).open;
  assert.ok(item?.digest);
  await pass();
  main.publish(PUBLIC_TEXT.replace("held public fixture PUB-2", "retitled PUB-2") + record("PUB-REV", ["OPS-GOOD"]));
  fx.set(record("OPS-GOOD"));
  const deferred = await readReleasePublicPlan(main.dir, { keepUnseenDependencies: true }), strict = await readReleasePublicPlan(main.dir);
  assert.deepEqual([deferred.read, strict.read], ["origin/main", "working_tree"], "origin/main does not load strictly");
  assert.notEqual(publicRecordDigest(deferred.plan.byId.get("PUB-2")!), item.digest, "origin/main retitled the refused record");
  const resolved = strict.plan.byId.get("PUB-2")!;
  assert.equal(publicRecordDigest(resolved), item.digest, "the fallback's record is the refused one");
  const probed = await ports.probe(item);
  assert.deepEqual(probed, { present: false, digest: publicRecordDigest(resolved) }, "the cleared edge reads gone with the resolved record's digest");
  const retry = await readApproveRelease("PUB-2", undefined, main.dir, fx.lookup, () => undefined, probed.digest);
  assert.equal(retry?.outcome, "found", `the retry accepts the digest the probe reported (${JSON.stringify(retry)})`);
  assert.deepEqual(retry.plan.byId.get("PUB-2"), resolved, "and releases the record the probe digested");
  await pass();
  assert.deepEqual(approved, [{ id: "PUB-2", pin: operatorReleasePin(resolved) }], "one replay pins the resolved record");
  assert.deepEqual(steps(rows, "stuck_state.retried").map(row => row.exit_code), [0]);
  assert.deepEqual(steps(rows, "stuck_state.record_changed"), []);

  // The mirror: the fallback's own record changes, so the probe reports that change and the retry refuses it.
  const other = await refusalFixture(t, "main", PUBLIC_TEXT);
  const [held] = scanStuckState(other.rows).open;
  assert.ok(held?.digest);
  await other.pass();
  other.main.publish(PUBLIC_TEXT + record("PUB-REV", ["OPS-GOOD"]));
  writeFileSync(other.main.planPath, PUBLIC_TEXT.replace("held public fixture PUB-2", "edited fallback PUB-2"));
  other.fx.set(record("OPS-GOOD"));
  const edited = publicRecordDigest(loadPlan(other.main.planPath).byId.get("PUB-2")!);
  assert.deepEqual(await other.ports.probe(held), { present: false, digest: edited }, "the fallback's changed record is reported");
  assert.deepEqual(await readApproveRelease("PUB-2", undefined, other.main.dir, other.fx.lookup, () => undefined, held.digest),
    { outcome: "unreadable", reason: "public-replay-record-unverified" });
  await other.pass();
  assert.deepEqual(other.approved, []);
  assert.deepEqual(steps(other.rows, "stuck_state.record_changed").map(row => [row.recorded_digest, row.current_digest]), [[held.digest, edited]]);
});

test("W1-T13785 criterion 4: working-tree refusals replay once after an ops-only edit or switching the destination off", async t => {
  for (const clearing of ["ops edit", "destination off"] as const) {
    const { fx, main, ports, rows, pass, approved } = await refusalFixture(t);
    main.unpublish();
    rows.length = 0;
    const publicPlan = loadPlan(main.planPath);
    const current = publicPlan.byId.get("PUB-2")!;
    const append = (row: Row) => rows.push({ ts: iso(NOW), ...row });
    assert.deepEqual(await readApproveRelease("PUB-2", publicPlan, main.dir, fx.lookup, append), { outcome: "held", hold: DUP_HOLD });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.public_commit, null);
    const digest = publicRecordDigest(current);
    assert.equal(rows[0]?.public_record_digest, digest);
    const [item] = scanStuckState(rows).open;
    assert.equal(item?.digest, digest, clearing);
    assert.equal((await ports.probe(item!)).present, true, clearing);
    await pass();
    assert.deepEqual(approved, [], clearing);

    if (clearing === "ops edit") fx.set(record("OPS-GOOD"));
    else rmSync(join(fx.stateDir, "plan-destination.json"));
    assert.deepEqual(await ports.probe(item!), { present: false, digest }, clearing);
    await pass();
    await pass();
    assert.deepEqual(approved, [{ id: "PUB-2", pin: operatorReleasePin(current) }], clearing);
    assert.deepEqual(steps(rows, "stuck_state.cleared").map(row => row.retry), ["approve"], clearing);
  }
});

test("W1-T13785 criterion 4: recovering an older origin/main preserves an unchanged working-tree record and detects local edits or moves", async t => {
  for (const shape of ["unchanged", "edited", "moved"] as const) await t.test(shape, async sub => {
    const { fx, main, ports, rows, pass, approved } = await refusalFixture(sub, "main", record("PUB-1"));
    main.unpublish();
    writeFileSync(main.planPath, PUBLIC_TEXT);
    rows.length = 0;
    const task = loadPlan(main.planPath).byId.get("PUB-2")!;
    const append = (row: Row) => rows.push({ ts: iso(NOW), ...row });
    assert.deepEqual(await readApproveRelease(task.id, loadPlan(main.planPath), main.dir, fx.lookup, append), { outcome: "held", hold: DUP_HOLD });
    assert.equal(rows[0]?.public_commit, null);
    const [item] = scanStuckState(rows).open;
    assert.ok(item);
    const digest = publicRecordDigest(task);
    await pass();

    main.restoreBootRef();
    const older = await readReleasePublicPlan(main.dir);
    assert.equal(older.read, "origin/main");
    assert.equal(older.plan.byId.has(task.id), false);
    assert.deepEqual(await ports.probe(item), { present: true, digest, reason: "held" });
    await pass();
    assert.deepEqual(steps(rows, "stuck_state.record_changed"), []);
    assert.deepEqual(approved, []);

    if (shape === "unchanged") {
      rmSync(main.planPath);
      assert.deepEqual(await ports.probe(item), { present: true, reason: "public-working-tree-unreadable" });
      writeFileSync(main.planPath, PUBLIC_TEXT);
    }
    if (shape !== "moved") fx.set(record("OPS-GOOD"));
    if (shape === "unchanged") {
      main.publish(record("PUB-1") + record(task.id, ["OPS-GOOD"]));
      writeFileSync(main.planPath, PUBLIC_TEXT);
      assert.deepEqual(await ports.probe(item), { present: true, digest, reason: "held" });
      assert.equal((await readApproveRelease(task.id, undefined, main.dir, fx.lookup, append, digest, true))?.outcome, "held");
      await pass();
      assert.deepEqual(approved, []);
      main.restoreBootRef();
    }
    if (shape === "edited") writeFileSync(main.planPath, PUBLIC_TEXT.replace(task.title, "edited local public record"));
    if (shape === "moved") writeFileSync(main.planPath, record("PUB-1"));
    const current = loadPlan(main.planPath);
    if (shape === "unchanged") {
      assert.equal(await readApproveRelease(task.id, current, main.dir, fx.lookup, append), undefined, "ordinary approve keeps the local record");
      assert.deepEqual(await ports.probe(item), { present: false, digest });
    }
    await pass();
    await pass();
    assert.deepEqual(approved, shape === "unchanged" ? [{ id: task.id, pin: operatorReleasePin(task) }] : []);
    assert.deepEqual(steps(rows, "stuck_state.retried").map(row => row.exit_code), shape === "unchanged" ? [0] : []);
    const changed = steps(rows, "stuck_state.record_changed").map(row => row.current_digest);
    if (shape === "unchanged") assert.deepEqual(changed, []);
    if (shape === "edited") assert.deepEqual(changed, [publicRecordDigest(current.byId.get(task.id)!)]);
    if (shape === "moved") assert.deepEqual(changed, [opsRecordDigest((await fx.read()).plan!.byId.get(task.id)!)]);
  });
});

test("W1-T13785: the working-tree event returns no stamp while the public plan is missing", t => {
  const fx = opsCatalog(t, SOUND_OPS);
  const publicRoot = join(fx.stateDir, "public");
  const planPath = join(publicRoot, "plan", "tasks.yaml");
  mkdirSync(join(publicRoot, "plan"), { recursive: true });
  writeFileSync(planPath, PUBLIC_TEXT);
  const ports = productionStuckStatePorts({
    stateDir: fx.stateDir, api: fx.api, publicRoot, publicMainCommit: () => undefined, gardenNames: [],
    log: () => undefined, escalate: () => null, destinationRead: async () => undefined, approve: async () => 0,
  });
  const readStamp = ports.eventStamps["public-working-tree"]!;
  const before = readStamp();
  assert.equal(typeof before, "string");

  rmSync(planPath);
  assert.equal(readStamp(), undefined);

  writeFileSync(planPath, PUBLIC_TEXT + record("PUB-3"));
  const after = readStamp();
  assert.equal(typeof after, "string");
  assert.notEqual(after, before);
});

test("W1-T13785 criterion 4: a working-tree edge edit in a different checkout replays an unchanged public dependant even when branch refs do not move", async t => {
  const fx = opsCatalog(t, SOUND_OPS);
  const main = publicMain(t, WORLDS[2]!.publicText);
  const daemon = publicMain(t, PUBLIC_TEXT);
  main.unpublish();
  const id = "PUB-REV-CHILD", rows: Row[] = [], replays: string[][] = [];
  const localPlan = loadLocalReleasePlan(main.planPath, fx.stateDir);
  const digest = publicRecordDigest(localPlan.byId.get(id)!);
  let now = NOW, catalogUnavailable = false, failedReads = 0;
  const append = (row: Row) => rows.push({ ts: iso(now), ...row });
  assert.deepEqual(await readApproveRelease(id, localPlan, main.dir, fx.lookup, append), { outcome: "held", hold: REV_HOLD });
  const ports = {
    ...productionStuckStatePorts({
      stateDir: fx.stateDir, publicRoot: daemon.dir, publicMainCommit: readOriginMainSha, gardenNames: [],
      api: path => {
        // The commit route only the catalog read opens: the stamp reads the repository and its default branch's ref.
        if (catalogUnavailable && path.startsWith(`repos/${REPOSITORY}/git/commits/`)) {
          failedReads++;
          throw new Error("ops repository unavailable");
        }
        return fx.api(path);
      },
      log: (step, extra = {}) => void append({ step, ...extra }), escalate: () => null, destinationRead: async () => undefined,
      approve: async (task, ...replay) => {
        replays.push([task, ...replay]);
        const result = await readApproveRelease(task, undefined, replay[2] ?? daemon.dir, fx.lookup, append, replay[0], replay[1] === "working_tree");
        assert.equal(result?.outcome, "found");
        return 0;
      },
    }),
    readRows: () => rows, nowMs: () => now,
  };
  const [item] = scanStuckState(rows).open;
  assert.equal(ports.eventStamps["public-main"]!(), daemon.head());
  assert.equal(ports.eventStamps["public-main"]!(item), undefined, "the refused checkout has no origin/main ref");
  assert.equal((await ports.probe(item!)).present, true);
  const pass = async () => { now += MIN; await runStuckStateGardener(ports); };
  await pass();
  assert.deepEqual(replays, []);
  writeFileSync(main.planPath, PUBLIC_TEXT + record("PUB-REV") + record(id, ["PUB-REV"]));
  assert.equal(main.head(), undefined);
  catalogUnavailable = true;
  await pass();
  assert.equal(failedReads, 1, "the ops ref responds while its catalog read fails");
  assert.deepEqual(replays, []);
  catalogUnavailable = false;
  assert.deepEqual(await ports.probe(item!), { present: false, digest });
  await pass();
  await pass();
  assert.deepEqual(replays, [[id, digest, "working_tree", main.dir]]);
  assert.deepEqual(steps(rows, "stuck_state.cleared").map(row => row.retry), ["approve"]);
  assert.deepEqual(steps(rows, "stuck_state.record_changed"), []);
});

test("W1-T13785 criterion 4: a held public record that changed, or moved to the ops catalog, is never re-run and writes stuck_state.record_changed", async t => {
  for (const shape of ["changed", "moved"] as const) {
    const { fx, main, ports, rows, pass, approved } = await refusalFixture(t);
    await pass();
    const [item] = scanStuckState(rows).open;
    if (shape === "changed") {
      main.publish(PUBLIC_TEXT.replace("held public fixture PUB-2", "retitled PUB-2"));
      const current = (await readReleasePublicPlan(main.dir)).plan.byId.get("PUB-2")!;
      const probed = await ports.probe(item!);
      assert.equal(probed.present, true, "a title edit leaves the duplicate hold present");
      assert.equal(probed.digest, publicRecordDigest(current), "the held probe also reports the edited record");
    } else {
      // The public copy leaves main; the ops catalog keeps a record of the same text, now the only copy.
      main.publish(record("PUB-1"));
    }
    await pass();
    await pass();
    assert.deepEqual(approved, [], `${shape}: a changed record is never released on the operator's behalf`);
    const changed = steps(rows, "stuck_state.record_changed");
    assert.equal(changed.length, 1, `${shape}: one record_changed row`);
    assert.equal(changed[0]!.recorded_digest, steps(rows, APPROVE_RELEASE_REFUSED_STEP)[0]!.public_record_digest, shape);
    assert.notEqual(changed[0]!.current_digest, changed[0]!.recorded_digest, shape);
    if (shape === "changed") {
      fx.set(record("OPS-GOOD"));
      await pass();
      assert.deepEqual(approved, [], "clearing the edge later still cannot replay the edited record");
      assert.equal(steps(rows, "stuck_state.record_changed").length, 1);
    }
  }
});

test("W1-T13785 criterion 4: a public retry checks the digest and catalog again before it can release", async t => {
  const { fx, main, ports, rows } = await refusalFixture(t);
  const [item] = scanStuckState(rows).open;
  const expected = item?.digest;
  assert.ok(expected);
  const append = (row: Row) => rows.push(row);
  const retry = () => readApproveRelease("PUB-2", undefined, main.dir, fx.lookup, append, expected);
  assert.equal((await retry())?.outcome, "held", "a hold still present refuses automatic release");
  fx.set(record("OPS-GOOD"));
  const snapshot = await fx.read();
  assert.equal(snapshot.outcome, "ok");
  const malformed = { ...fx.lookup, opsSnapshot: { ...snapshot, plan: { ...snapshot.plan!, tasks: [] } } };
  assert.deepEqual(await readApproveRelease("PUB-2", undefined, main.dir, malformed, append, expected),
    { outcome: "unreadable", reason: "compose-malformed" });
  const publicPlan = (await readReleasePublicPlan(main.dir)).plan;
  const probe = productionStuckStateProbe({
    ...fx.lookup, publicPlan: () => ({ ...publicPlan, tasks: [] }), destinationRead: async () => undefined,
  });
  assert.deepEqual(await probe(item!), { present: true, reason: "compose-malformed" });
  const offline = { ...fx.lookup, api: async () => { throw new Error("ops offline"); } };
  assert.deepEqual(await readApproveRelease("PUB-2", undefined, main.dir, offline, append, expected),
    { outcome: "unreadable", reason: "public-replay-ops-unreadable" });
  main.publish(PUBLIC_TEXT.replace("held public fixture PUB-2", "edited after the probe"));
  assert.deepEqual(await retry(), { outcome: "unreadable", reason: "public-replay-record-unverified" });
  main.publish(record("PUB-1"));
  fx.set(record("PUB-2"));
  assert.deepEqual(await retry(), { outcome: "unreadable", reason: "public-replay-record-unverified" });
  main.unpublish();
  assert.deepEqual(await ports.probe(item!), { present: true, reason: "origin-main-unreadable" });
  assert.deepEqual(await retry(), { outcome: "unreadable", reason: "public-replay-record-unverified" });
  const invalid = PUBLIC_TEXT + record("PUB-REV", ["OPS-GOOD"]);
  main.publish(invalid);
  writeFileSync(main.planPath, invalid);
  rmSync(join(fx.stateDir, "plan-destination.json"));
  assert.deepEqual(await ports.probe(item!), { present: true, digest: expected, reason: "public-replay-plan-invalid" });
  assert.deepEqual(await retry(), { outcome: "unreadable", reason: "public-replay-plan-invalid" });
});

test("W1-T13785 criterion 4: the probe reads the cause from the composition alone, so an edge that clears on a changed or moved record reads gone and the gardener writes record_changed", async t => {
  // Every way the record can differ from the refused one, each with the edge cleared in the same step.
  const shapes = {
    retitled: { publicText: PUBLIC_TEXT.replace("held public fixture PUB-2", "retitled PUB-2"), opsText: record("OPS-GOOD") },
    "new dependency": { publicText: record("PUB-1") + record("PUB-2", ["PUB-1"]), opsText: record("OPS-GOOD") },
    "moved to ops": { publicText: record("PUB-1"), opsText: record("PUB-2") + record("OPS-GOOD") },
    deleted: { publicText: record("PUB-1"), opsText: record("OPS-GOOD") },
  };
  for (const [shape, { publicText, opsText }] of Object.entries(shapes)) {
    const { fx, main, ports, rows, pass, approved } = await refusalFixture(t);
    await pass();
    const [item] = scanStuckState(rows).open;
    assert.ok(item?.digest, shape);
    main.publish(publicText);
    fx.set(opsText);
    const publicPlan = (await readReleasePublicPlan(main.dir)).plan, opsPlan = (await fx.read()).plan!;
    const composition = composeSecondaryPlan(publicPlan, opsPlan);
    assert.equal(composition.outcome === "ok" && composition.held.has("PUB-2"), false, `${shape}: the composition no longer holds PUB-2`);
    const now = publicPlan.byId.get("PUB-2"), moved = opsPlan.byId.get("PUB-2");
    const digest = now ? publicRecordDigest(now) : moved ? opsRecordDigest(moved) : undefined;
    assert.notEqual(digest, item.digest, `${shape}: the record differs from the refused one`);
    assert.deepEqual(await ports.probe(item), { present: false, digest }, `${shape}: the cleared edge reads gone, with the current digest`);
    assert.deepEqual(await readApproveRelease("PUB-2", undefined, main.dir, fx.lookup, () => undefined, item.digest),
      { outcome: "unreadable", reason: "public-replay-record-unverified" }, `${shape}: the retry still refuses the changed record`);
    await pass();
    await pass();
    assert.deepEqual(approved, [], `${shape}: a changed record is never released on the operator's behalf`);
    const changed = steps(rows, "stuck_state.record_changed");
    assert.deepEqual(changed.map(row => [row.recorded_digest, row.current_digest]), [[item.digest, digest ?? null]], shape);
    assert.deepEqual(steps(rows, "stuck_state.escalated").length, 1, `${shape}: escalated once`);
  }
});

test("W1-T13785 criterion 5: invariant no-held-record-is-released-from-either-catalog — no record the composition holds is answered found by the approve release plan, and every other record is answered as on origin/main", async t => {
  let heldSeen = 0, soundSeen = 0;
  for (const world of WORLDS) {
    const fx = opsCatalog(t, world.opsText), publicPlan = planOf(world.publicText, "public");
    const opsSnapshot = await fx.read();
    assert.equal(opsSnapshot.outcome, "ok");
    const opsPlan = opsSnapshot.plan!;
    const composition = composeSecondaryPlan(publicPlan, opsPlan);
    assert.equal(composition.outcome, "ok", world.name);
    if (composition.outcome !== "ok") continue;
    const ids = new Set([...publicPlan.tasks, ...opsPlan.tasks].map(task => task.id));
    for (const id of ids) {
      const answer = await findApproveReleasePlan(id, publicPlan, viewOf(publicPlan, "origin/main"), { ...fx.lookup, opsSnapshot });
      const hold = composition.held.get(id), label = `${world.name}: ${id}`;
      if (hold !== undefined) {
        heldSeen += 1;
        assert.deepEqual(answer, { outcome: "held", hold }, `${label} is held, never found`);
      } else if (publicPlan.byId.has(id)) {
        soundSeen += 1;
        assert.equal(answer, undefined, `${label}: origin/main defers a public hit to the local plan`);
      } else {
        soundSeen += 1;
        assert.deepEqual(answer, { outcome: "found", catalog: "ops", plan: composition.plan },
          `${label}: origin/main releases an ops hit from the composed plan`);
      }
    }
  }
  // Every bad world contributes: the dangling edge and its two dependants; the duplicated id (one id, both copies held)
  // with its public and its ops dependant; the public task naming an ops id and its dependant.
  assert.equal(heldSeen, 3 + 3 + 2, `the held records the worlds name (${heldSeen})`);
  // The sound ones: five per world, less the duplicated id in its world.
  assert.equal(soundSeen, 5 + 4 + 5 + 5, `the sound records the worlds name (${soundSeen})`);
});

test("W1-T13785 criterion 5: beside an unrelated public-to-ops edge, approve answers an ops record from the strict fallback's composition, as on origin/main, and keeps a public edge's hold", async t => {
  const main = publicMain(t, PUBLIC_TEXT + record("PUB-BOOT") + record("PUB-DUP"));
  main.publish(PUBLIC_TEXT + record("PUB-REV", ["OPS-GOOD"]));
  const fx = opsCatalog(t, SOUND_OPS + BAD_OPS + record("PUB-DUP") +
    record("OPS-ON-BOOT", ["PUB-BOOT"]) + record("OPS-ON-DUP", ["PUB-DUP"]) + record("OPS-ON-REV", ["PUB-REV"]));
  const opsSnapshot = await fx.read();
  assert.equal(opsSnapshot.outcome, "ok");
  const strict = await readReleasePublicPlan(main.dir);
  assert.equal(strict.read, "working_tree");
  const deferred = await readReleasePublicPlan(main.dir, { keepUnseenDependencies: true });
  assert.equal(deferred.read, "origin/main");
  const strictComposition = composeSecondaryPlan(strict.plan, opsSnapshot.plan!);
  const deferredComposition = composeSecondaryPlan(deferred.plan, opsSnapshot.plan!);
  assert.equal(strictComposition.outcome, "ok");
  assert.equal(deferredComposition.outcome, "ok");
  assert.deepEqual(deferredComposition.held.get("OPS-ON-BOOT"), { reason: BAD_EDGE, task: "OPS-ON-BOOT", dependsOn: "PUB-BOOT" });
  const approve = (id: string) => readApproveRelease(id, strict.plan, main.dir, { ...fx.lookup, opsSnapshot }, () => undefined);

  // Operator ruling 2026-11-21: origin/main does not load strictly, so the strict loader's working-tree fallback, where
  // PUB-BOOT exists, is the composition, as on origin/main. The deferred ref's hold on OPS-ON-BOOT exists only because
  // the ref failed to load, so it is not a hold the composition makes.
  for (const id of ["OPS-ON-BOOT", "OPS-ON-GOOD"]) {
    const sound = await approve(id);
    assert.equal(sound?.outcome, "found", `${id}: ${JSON.stringify(sound)}`);
    assert.equal(sound.catalog, "ops");
    assert.deepEqual(sound.plan, strictComposition.plan, `${id} is released from the strict fallback's composition`);
  }
  assert.deepEqual(await approve("OPS-CHILD"), { outcome: "held", hold: { reason: BAD_EDGE, task: "OPS-BAD", dependsOn: MISSING } });
  assert.deepEqual(await approve("OPS-ON-DUP"), { outcome: "held", hold: { reason: "duplicate_task_id", task: "PUB-DUP" } });
  assert.deepEqual(await approve("OPS-ON-REV"), { outcome: "held", hold: REV_HOLD });
});

test("W1-T13785 criterion 5: beside an unrelated public-to-ops edge, a record the strict fallback's composition or a public edge holds is never answered found, by approve or by the probe, and every other record is answered from the fallback as on origin/main", async t => {
  // origin/main (read with deferred edges) and the strict fallback (the older working tree) differ both ways:
  // PUB-BOOT is only in the working tree, PUB-NEW only on origin/main, and origin/main's PUB-REV names an ops id, so
  // origin/main does not load strictly and the fallback's composition is the composition (operator ruling 2026-11-21).
  const main = publicMain(t, PUBLIC_TEXT + record("PUB-BOOT") + record("PUB-DUP"));
  main.publish(PUBLIC_TEXT + record("PUB-NEW") + record("PUB-REV", ["OPS-GOOD"]));
  const fx = opsCatalog(t, SOUND_OPS + BAD_OPS + record("PUB-DUP") + record("OPS-ON-BOOT", ["PUB-BOOT"]) +
    record("OPS-ON-BOOT-CHILD", ["OPS-ON-BOOT"]) + record("OPS-ON-NEW", ["PUB-NEW"]) + record("OPS-ON-DUP", ["PUB-DUP"]) +
    record("OPS-ON-REV", ["PUB-REV"]));
  const opsSnapshot = await fx.read();
  assert.equal(opsSnapshot.outcome, "ok");
  const strict = await readReleasePublicPlan(main.dir), deferred = await readReleasePublicPlan(main.dir, { keepUnseenDependencies: true });
  assert.deepEqual([strict.read, deferred.read], ["working_tree", "origin/main"]);
  const [refView, fallbackView] = [composeSecondaryPlan(deferred.plan, opsSnapshot.plan!), composeSecondaryPlan(strict.plan, opsSnapshot.plan!)];
  assert.ok(refView.outcome === "ok" && fallbackView.outcome === "ok");
  if (refView.outcome !== "ok" || fallbackView.outcome !== "ok") return;
  // A hold the composition makes: the fallback's, or one on a public edge of origin/main (the edge that fails it).
  const publicEdgeHold = (id: string) => { const hold = refView.held.get(id); return hold && deferred.plan.byId.has(hold.task) ? hold : undefined; };
  const rows: Row[] = [];
  const ports = productionStuckStatePorts({
    stateDir: fx.stateDir, api: fx.api, publicRoot: main.dir, publicMainCommit: main.head, gardenNames: [],
    log: () => undefined, escalate: () => null, destinationRead: async () => undefined, approve: async () => 1,
  });
  const held: string[] = [], fromFallback: string[] = [];
  for (const id of new Set([...deferred.plan.tasks, ...strict.plan.tasks, ...opsSnapshot.plan!.tasks].map(task => task.id))) {
    const before = rows.length;
    const answer = await readApproveRelease(id, strict.plan, main.dir, { ...fx.lookup, opsSnapshot }, row => rows.push({ ts: iso(NOW), ...row }));
    if (fallbackView.held.has(id) || publicEdgeHold(id) !== undefined) {
      held.push(id);
      assert.equal(answer?.outcome, "held", `${id} is held by the composition, never ${JSON.stringify(answer)}`);
      const [item] = scanStuckState(rows.slice(before)).open;
      // A hold both views make keeps origin/main's commit for its row; a working-tree-only hold may write none (#19593).
      if (refView.held.has(id)) assert.ok(item, `${id}: its refusal opens a held item`);
      if (item) assert.equal((await ports.probe(item)).present, true, `${id}: the probe reads the hold present`);
    } else if (opsSnapshot.plan!.byId.has(id)) {
      if (refView.held.has(id)) fromFallback.push(id);
      assert.deepEqual(answer, { outcome: "found", catalog: "ops", plan: fallbackView.plan }, `${id}: released as origin/main composes it`);
    } else {
      assert.ok(answer === undefined || answer.outcome === "absent", `${id}: a sound public record is not held (${JSON.stringify(answer)})`);
    }
  }
  // Held: the dangling ops edge and its two dependants, the duplicate (both copies) and its ops dependant, PUB-REV and
  // OPS-ON-REV, OPS-ON-NEW (the working tree lacks PUB-NEW).
  assert.deepEqual(held.sort(), ["OPS-BAD", "OPS-CHILD", "OPS-GRANDCHILD", "OPS-ON-DUP", "OPS-ON-NEW", "OPS-ON-REV", "PUB-DUP", "PUB-REV"]);
  // The deferred ref alone holds these (origin/main lacks PUB-BOOT); the fallback's composition releases them.
  assert.deepEqual(fromFallback.sort(), ["OPS-ON-BOOT", "OPS-ON-BOOT-CHILD"]);
});

test("W1-T13785 criterion 4: an ops refusal origin/main no longer holds is probed through the strict fallback, which can still hold it", async t => {
  const id = "OPS-ON-NEW";
  const main = publicMain(t, PUBLIC_TEXT);
  const fx = opsCatalog(t, SOUND_OPS + record(id, ["PUB-NEW"]));
  const rows: Row[] = [];
  assert.deepEqual(await readApproveRelease(id, loadPlan(main.planPath), main.dir, fx.lookup, row => rows.push({ ts: iso(NOW), ...row })),
    { outcome: "held", hold: { reason: BAD_EDGE, task: id, dependsOn: "PUB-NEW" } });
  const [item] = scanStuckState(rows).open;
  assert.ok(item?.digest);
  const ports = productionStuckStatePorts({
    stateDir: fx.stateDir, publicRoot: main.dir, publicMainCommit: main.head, gardenNames: [], api: fx.api,
    log: () => undefined, escalate: () => null, destinationRead: async () => undefined, approve: async () => 1,
  });
  // origin/main gains PUB-NEW beside a public-to-ops edge, so it loads only with deferred edges; the strict fallback
  // (the working tree) still lacks PUB-NEW and holds the record.
  main.publish(PUBLIC_TEXT + record("PUB-NEW") + record("PUB-REV", ["OPS-GOOD"]));
  assert.deepEqual(await ports.probe(item), { present: true, reason: "held" });
  writeFileSync(main.planPath, PUBLIC_TEXT + record("PUB-REV", ["OPS-GOOD"]));
  assert.deepEqual(await ports.probe(item), { present: true, reason: "public-replay-plan-invalid" }, "no strict view at all");
  main.publish(PUBLIC_TEXT + record("PUB-NEW"));
  assert.deepEqual(await ports.probe(item), { present: false, digest: item.digest }, "a strict origin/main with PUB-NEW clears it");
});

test("W1-T13785 criterion 4: an existing ops refusal beside an unrelated public-to-ops edge is answered from the strict fallback in the probe and approve, as on origin/main", async t => {
  const id = "OPS-ON-BOOT";
  const main = publicMain(t, PUBLIC_TEXT);
  const fx = opsCatalog(t, SOUND_OPS + record(id, ["PUB-BOOT"]));
  const rows: Row[] = [];
  const approve = () => readApproveRelease(id, loadPlan(main.planPath), main.dir, fx.lookup,
    row => rows.push({ ts: iso(NOW), ...row }));
  assert.deepEqual(await approve(), { outcome: "held", hold: { reason: BAD_EDGE, task: id, dependsOn: "PUB-BOOT" } });
  const [item] = scanStuckState(rows).open;
  assert.ok(item?.digest);
  assert.equal(item.publicRelease, undefined);
  const retries: string[][] = [];
  const ports = {
    ...productionStuckStatePorts({
      stateDir: fx.stateDir, publicRoot: main.dir, publicMainCommit: main.head, gardenNames: [], api: fx.api,
      log: (step, extra) => void rows.push({ ts: iso(NOW + MIN), step, ...extra }),
      escalate: () => null, destinationRead: async () => undefined,
      approve: async (...args) => { retries.push(args); return (await approve())?.outcome === "found" ? 0 : 1; },
    }),
    readRows: () => rows, nowMs: () => NOW + MIN,
  };
  const publicCommit = main.publish(PUBLIC_TEXT + record("PUB-REV", ["OPS-GOOD"]));
  const opsCommit = fx.commit();
  assert.deepEqual(await ports.probe(item), { present: true, reason: "held" });
  await runStuckStateGardener(ports);
  assert.deepEqual(retries, []);

  // origin/main does not load strictly, so its working-tree fallback is the composition (operator ruling 2026-11-21):
  // the working tree gaining PUB-BOOT clears the hold, and that edit is the clearing event.
  writeFileSync(main.planPath, PUBLIC_TEXT + record("PUB-BOOT"));
  assert.equal(main.head(), publicCommit);
  assert.equal(fx.commit(), opsCommit);
  const release = await approve();
  assert.equal(release?.outcome, "found");
  assert.equal(release.catalog, "ops");
  const digest = opsRecordDigest(release.plan.byId.get(id)!);
  assert.equal(digest, item.digest);
  assert.deepEqual(await ports.probe(item), { present: false, digest });
  await runStuckStateGardener(ports);
  await runStuckStateGardener(ports);
  assert.deepEqual(retries, [[id]]);
  assert.deepEqual(steps(rows, "stuck_state.retried").map(row => [row.exit_code, row.events]), [[0, ["public-working-tree"]]]);
});

test("W1-T13785 criterion 4: a hand edit to a nested sourcePath in a held public record changes its digest, so the gardener never re-runs the edited release and writes stuck_state.record_changed", async t => {
  // Review 2026-11-21 20:18Z: a human edit can set principles.sourcePath, which the loader keeps. Only the lookup's
  // top-level sourcePath stamp is provenance; a nested field of the same name is part of the record.
  const withSource = (path: string) => PUBLIC_TEXT.replace("  title: held public fixture PUB-2\n",
    `  title: held public fixture PUB-2\n  principles:\n    tdd: strict\n    sourcePath: ${path}\n`);
  const refused = withSource("plan/original.yaml"), edited = withSource("plan/edited-by-hand.yaml");
  const { fx, main, ports, rows, pass, approved } = await refusalFixture(t, "main", undefined, refused);
  await pass();
  const [item] = scanStuckState(rows).open;
  assert.ok(item?.digest);
  main.publish(edited);
  const current = (await readReleasePublicPlan(main.dir)).plan.byId.get("PUB-2")!;
  assert.deepEqual(current.principles, { tdd: "strict", sourcePath: "plan/edited-by-hand.yaml" }, "the loader keeps the nested field");
  assert.notEqual(publicRecordDigest(current), item.digest, "the edited record digests apart from the refused one");
  fx.set(record("OPS-GOOD"));
  assert.deepEqual(await ports.probe(item), { present: false, digest: publicRecordDigest(current) });
  assert.deepEqual(await readApproveRelease("PUB-2", undefined, main.dir, fx.lookup, () => undefined, item.digest),
    { outcome: "unreadable", reason: "public-replay-record-unverified" }, "the retry refuses the edited record");
  await pass();
  await pass();
  assert.deepEqual(approved, [], "the edited record is never released on the operator's behalf");
  assert.deepEqual(steps(rows, "stuck_state.record_changed").map(row => [row.recorded_digest, row.current_digest]),
    [[item.digest, publicRecordDigest(current)]]);
});

test("W1-T13785 criterion 5: an ops task on a public record that origin/main gives a public-to-ops edge, while the strict fallback's copy is sound, is answered from the fallback by approve and the probe, as on origin/main", async t => {
  // Review 2026-11-21 20:18Z: the deferred ref's hold on the public edge of PUB-EDGED is not the composition's when
  // origin/main does not load strictly (operator ruling 2026-11-21); the fallback, where PUB-EDGED is sound, decides.
  const id = "OPS-ON-EDGED";
  const main = publicMain(t, PUBLIC_TEXT);
  const fx = opsCatalog(t, SOUND_OPS + record(id, ["PUB-EDGED"]));
  const rows: Row[] = [];
  const approve = (subject: string) => readApproveRelease(subject, loadPlan(main.planPath), main.dir, fx.lookup,
    row => rows.push({ ts: iso(NOW), ...row }));
  assert.deepEqual(await approve(id), { outcome: "held", hold: { reason: BAD_EDGE, task: id, dependsOn: "PUB-EDGED" } });
  const [item] = scanStuckState(rows).open;
  assert.ok(item?.digest);
  const ports = productionStuckStatePorts({
    stateDir: fx.stateDir, publicRoot: main.dir, publicMainCommit: main.head, gardenNames: [], api: fx.api,
    log: () => undefined, escalate: () => null, destinationRead: async () => undefined, approve: async () => 1,
  });
  main.publish(PUBLIC_TEXT + record("PUB-EDGED", ["OPS-GOOD"]));
  writeFileSync(main.planPath, PUBLIC_TEXT + record("PUB-EDGED"));
  const strict = await readReleasePublicPlan(main.dir), deferred = await readReleasePublicPlan(main.dir, { keepUnseenDependencies: true });
  assert.deepEqual([strict.read, deferred.read], ["working_tree", "origin/main"], "origin/main does not load strictly");
  const opsSnapshot = await fx.read();
  assert.equal(opsSnapshot.outcome, "ok");
  const refView = composeSecondaryPlan(deferred.plan, opsSnapshot.plan!), fallbackView = composeSecondaryPlan(strict.plan, opsSnapshot.plan!);
  assert.ok(refView.outcome === "ok" && fallbackView.outcome === "ok");
  if (refView.outcome !== "ok" || fallbackView.outcome !== "ok") return;
  assert.deepEqual(refView.held.get(id), { reason: BAD_EDGE, task: "PUB-EDGED", dependsOn: "OPS-GOOD" }, "the ref alone holds it on a public edge");
  assert.equal(fallbackView.held.has(id), false, "the fallback's composition does not hold it");

  const release = await approve(id);
  assert.equal(release?.outcome, "found", `approve answers the fallback's decision (${JSON.stringify(release)})`);
  assert.equal(release.catalog, "ops");
  assert.deepEqual(release.plan, fallbackView.plan, "released from the strict fallback's composition");
  assert.deepEqual(await ports.probe(item), { present: false, digest: item.digest }, "the probe reads the cause gone");
  assert.equal((await approve("PUB-EDGED"))?.outcome, "held", "the public record whose own edge fails origin/main stays held");
});

test("W1-T13785 criterion 5: a public dependant of a public record held on a public edge of origin/main stays held beside the unloadable ref, by approve and by the probe", async t => {
  // Review 2026-11-22: the detached boot plan still has the parent without its public-to-ops edge, so the strict fallback
  // alone would release the dependant while its parent's own hold is kept. Every public record the composition holds,
  // whether by its own edge or an inherited one, is held in any view.
  const bootText = PUBLIC_TEXT + record("PUB-EDGE") + record("PUB-EDGE-CHILD", ["PUB-EDGE"]) + record("PUB-EDGE-GRANDCHILD", ["PUB-EDGE-CHILD"]);
  const main = publicMain(t, bootText);
  main.publish(PUBLIC_TEXT + record("PUB-EDGE", ["OPS-GOOD"]) + record("PUB-EDGE-CHILD", ["PUB-EDGE"]) + record("PUB-EDGE-GRANDCHILD", ["PUB-EDGE-CHILD"]));
  const fx = opsCatalog(t, SOUND_OPS);
  const opsSnapshot = await fx.read();
  assert.equal(opsSnapshot.outcome, "ok");
  const bootPlan = loadPlan(main.planPath);
  const deferred = await readReleasePublicPlan(main.dir, { keepUnseenDependencies: true });
  assert.equal(deferred.read, "origin/main");
  assert.equal(publicRecordDigest(bootPlan.byId.get("PUB-EDGE-CHILD")!), publicRecordDigest(deferred.plan.byId.get("PUB-EDGE-CHILD")!), "the dependant is the same record in both views");
  const edge = { reason: BAD_EDGE, task: "PUB-EDGE", dependsOn: "OPS-GOOD" };
  const rows: Row[] = [];
  const ports = productionStuckStatePorts({
    stateDir: fx.stateDir, api: fx.api, publicRoot: main.dir, publicMainCommit: main.head, gardenNames: [],
    log: () => undefined, escalate: () => null, destinationRead: async () => undefined, approve: async () => 1,
  });
  for (const id of ["PUB-EDGE", "PUB-EDGE-CHILD", "PUB-EDGE-GRANDCHILD"]) {
    const before = rows.length;
    const answer = await readApproveRelease(id, bootPlan, main.dir, { ...fx.lookup, opsSnapshot }, row => rows.push({ ts: iso(NOW), ...row }));
    assert.deepEqual(answer, { outcome: "held", hold: edge }, `${id} is held by the edge of PUB-EDGE`);
    const written = rows.slice(before);
    assert.equal(written.length, 1, `${id}: one approve.release_refused row`);
    assert.equal(written[0]!.public_record_digest, publicRecordDigest(deferred.plan.byId.get(id)!), `${id}: the row carries the public record's digest`);
    const [item] = scanStuckState(written).open;
    assert.deepEqual(await ports.probe(item!), { present: true, digest: publicRecordDigest(deferred.plan.byId.get(id)!), reason: "held" });
  }
  assert.equal(await readApproveRelease("PUB-1", bootPlan, main.dir, { ...fx.lookup, opsSnapshot }, () => undefined), undefined, "a sound neighbour keeps its local plan");
});

/** An ops copy of a record with fields the plan parser keeps, among them a nested `catalog` key. */
const withNestedCatalog = (id: string, catalog?: string) => {
  const text = record(id).replace(`  title: held public fixture ${id}\n`,
    `  title: held public fixture ${id}\n  principles:\n    tdd: strict\n${catalog === undefined ? "" : `    catalog: ${catalog}\n`}`);
  return parseTasksFromYaml(text, "ops.yaml")[0]!;
};

test("W1-T13785 criterion 4: the ops record digest is the deployed one, so a refusal row written before this change still matches an unchanged ops record with a nested catalog key", () => {
  const plain = withNestedCatalog("OPS-NESTED"), nested = withNestedCatalog("OPS-NESTED", "private"), other = withNestedCatalog("OPS-NESTED", "elsewhere");
  assert.deepEqual((nested.principles as Record<string, unknown>).catalog, "private", "the parser keeps the nested field");
  assert.equal(opsRecordDigest(nested), opsRecordDigest(plain), "no catalog key, at any depth, is part of the ops digest");
  assert.equal(opsRecordDigest(nested), opsRecordDigest(other));
  assert.equal(opsRecordDigest({ ...nested, catalog: "ops" } as typeof nested), opsRecordDigest(plain), "nor is the lookup's top-level stamp");
  // The public digest keeps the nested field and drops only the lookup's top-level stamps.
  assert.notEqual(publicRecordDigest(nested), publicRecordDigest(plain), "a nested catalog key is part of a public record");
  assert.equal(publicRecordDigest({ ...nested, catalog: "public" } as typeof nested), publicRecordDigest(nested));
  assert.notEqual(publicRecordDigest(plain), opsRecordDigest(plain), "the two catalogs never digest alike");
});

test("W1-T13785 criterion 4: a working-tree refusal whose id left origin/main for the ops catalog by a completed move reads as record_changed, never as the stale public copy", async t => {
  const { fx, main, ports, rows, pass, approved } = await refusalFixture(t, "main", record("PUB-1"));
  main.unpublish();
  writeFileSync(main.planPath, PUBLIC_TEXT);
  rows.length = 0;
  const task = loadPlan(main.planPath).byId.get("PUB-2")!;
  assert.deepEqual(await readApproveRelease(task.id, loadPlan(main.planPath), main.dir, fx.lookup, row => rows.push({ ts: iso(NOW), ...row })), { outcome: "held", hold: DUP_HOLD });
  const [item] = scanStuckState(rows).open;
  assert.equal(item?.digest, publicRecordDigest(task));
  await pass();

  // origin/main is recovered at a commit that lacks the id, and the ops catalog now holds it as the move's copy.
  main.restoreBootRef();
  assert.equal((await readReleasePublicPlan(main.dir)).plan.byId.has(task.id), false);
  const movedText = record("PUB-2") + `  moved_from: remudero@${"a".repeat(40)}\n` + record("OPS-GOOD");
  fx.set(movedText);
  const moved = (await fx.read()).plan!.byId.get(task.id)!;
  assert.deepEqual(await ports.probe(item!), { present: false, digest: opsRecordDigest(moved) }, "the id resolves as the ops record");
  assert.deepEqual(await readApproveRelease(task.id, undefined, main.dir, fx.lookup, () => undefined, item!.digest, true),
    { outcome: "unreadable", reason: "public-replay-record-unverified" }, "the retry refuses the stale public copy");
  await pass();
  await pass();
  assert.deepEqual(approved, [], "the stale public copy is never released on the operator's behalf");
  assert.deepEqual(steps(rows, "stuck_state.record_changed").map(row => [row.recorded_digest, row.current_digest]), [[item!.digest, opsRecordDigest(moved)]]);
});
