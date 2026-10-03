import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Escalation } from "../src/lib/escalate.js";
import { loadPlan, loadPlanQuarantiningDuplicates, mergePlanBlobs, mergePlanBlobsQuarantiningDuplicates } from "../src/lib/plan.js";
import { withTempDir } from "../src/lib/tmp.js";
import { createPlanSyncCoalescer, lintPlanCommand, loadDaemonPlan, quarantineReporter, quarantiningPlanSync, syncPlanFromOrigin } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

// 2026-10-03 — two plan PRs merged 28 s apart each added a `priority:` key to one shard. git merged both, the shard
// stopped parsing ("Map keys must be unique"), and the core daemon crash-looped at boot: the whole fleet stopped
// dispatching over one shard of ~2,900. One bad SHARD is now quarantined like a duplicate id; the monolith stays fatal.

function task(id: string, dependsOn: string[] = []): string {
  return `- id: ${id}\n  title: task ${id}\n  repo: remudero\n  type: implement\n  depends_on: [${dependsOn.join(", ")}]\n  status: queued\n`;
}

/** The incident's shape: one mapping holding the same key twice. */
const DUPLICATE_KEY_SHARD = `- id: W1-T60\n  title: task W1-T60\n  repo: remudero\n  type: implement\n  priority: 2.5\n  priority: 4\n  status: queued\n`;

type Row = { step: string; extra?: Record<string, unknown> };

function recorder(): { rows: Row[]; raised: Escalation[]; log: (step: string, extra?: Record<string, unknown>) => void; raise: (e: Escalation) => string } {
  const rows: Row[] = [];
  const raised: Escalation[] = [];
  return {
    rows,
    raised,
    log: (step, extra) => rows.push({ step, extra }),
    raise: (e) => {
      raised.push(e);
      return `https://github.com/o/r/issues/${raised.length}`;
    },
  };
}

/** A working checkout whose origin/main holds a shard that does not parse and a task depending on it. */
function originWithBadShardOnMain(): string {
  const seed = gitRepo({ kind: "bad-shard-seed", seedCommit: false });
  mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), task("W1-T1"));
  writeFileSync(join(seed.dir, "plan", "tasks.d", "W1-T60-bad.yaml"), DUPLICATE_KEY_SHARD);
  writeFileSync(join(seed.dir, "plan", "tasks.d", "W1-T61-after.yaml"), task("W1-T61", ["W1-T60"]));
  writeFileSync(join(seed.dir, "plan", "tasks.d", "W1-T62-fine.yaml"), task("W1-T62"));
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "plan with a shard that does not parse");
  const origin = gitRepo({ kind: "bad-shard-origin", bare: true });
  seed.git("push", "--quiet", origin.dir, "main");
  return gitRepo({ kind: "bad-shard-checkout", cloneFrom: origin.dir }).dir;
}

test("a shard holding a duplicate key is quarantined and ledgered while every other task loads", () => {
  const clone = originWithBadShardOnMain();
  const r = recorder();

  const { plan } = syncPlanFromOrigin(clone, "plan/tasks.yaml", { quarantine: quarantineReporter(r.log, r.raise) });

  assert.deepEqual(plan.tasks.map((t) => t.id), ["W1-T1", "W1-T62"], "every other shard still loads");
  assert.equal(plan.byId.has("W1-T60"), false, "the quarantined task can never be dispatched");
  assert.equal(plan.byId.has("W1-T61"), false, "nor can a task depending on it");
  const shardRows = r.rows.filter((row) => row.step === "plan.shard_quarantined");
  assert.equal(shardRows.length, 1);
  assert.equal(shardRows[0]!.extra!.file, "origin/main:plan/tasks.d/W1-T60-bad.yaml");
  assert.equal(shardRows[0]!.extra!.id, "W1-T60");
  assert.match(String(shardRows[0]!.extra!.error), /Map keys must be unique/);
  assert.deepEqual(
    r.rows.filter((row) => row.step === "plan.duplicate_quarantined").map((row) => [row.extra!.id, row.extra!.reason]),
    [["W1-T61", "depends_on_quarantined"]],
  );
  assert.equal(r.raised.length, 1);
  assert.equal(r.raised[0]!.taskId, "W1-T60");
  assert.match(r.raised[0]!.detail, /Map keys must be unique/);
  assert.equal(r.rows.find((row) => row.step === "plan.shard_escalated")?.extra?.issue_url, "https://github.com/o/r/issues/1");
  // run-task and drain stay strict.
  assert.throws(() => syncPlanFromOrigin(clone, "plan/tasks.yaml"), /Map keys must be unique/);
});

test("a quarantined shard is escalated once across repeated plan loads", () => {
  const clone = originWithBadShardOnMain();
  const r = recorder();
  const report = quarantineReporter(r.log, r.raise);
  const sync = createPlanSyncCoalescer(join(clone, "plan", "tasks.yaml"), quarantiningPlanSync(report)).sync;

  syncPlanFromOrigin(clone, "plan/tasks.yaml", { quarantine: report });
  for (let tick = 0; tick < 3; tick++) {
    assert.deepEqual(sync({}).plan.tasks.map((t) => t.id), ["W1-T1", "W1-T62"], "every lane gets the quarantined plan");
  }

  assert.equal(r.raised.length, 1, "one escalation for the shard across four loads");
  assert.equal(r.rows.filter((row) => row.step === "plan.shard_quarantined").length, 1, "one ledger row naming the file");
});

test("a monolith that does not parse still refuses the whole plan", async () => {
  const blobs = [
    { label: "origin/main:plan/tasks.yaml", text: DUPLICATE_KEY_SHARD },
    { label: "origin/main:plan/tasks.d/W1-T62-fine.yaml", text: task("W1-T62") },
  ];
  assert.throws(() => mergePlanBlobsQuarantiningDuplicates(blobs), /Map keys must be unique/);
  await withTempDir("bad-monolith", (dir) => {
    const path = join(dir, "tasks.yaml");
    writeFileSync(path, DUPLICATE_KEY_SHARD);
    assert.throws(() => loadPlanQuarantiningDuplicates(path), /Map keys must be unique/);
  });
});

test("a shard failing field validation or naming no id is quarantined under its file", async () => {
  const noId = "- title: nameless\n  repo: remudero\n";
  const badRisk = task("W1-T70").replace("status: queued", "risk: enormous");
  const blobs = [
    { label: "m", text: task("W1-T1") },
    { label: "s-risk", text: badRisk },
    { label: "s-noid", text: noId },
  ];
  const { plan, quarantined } = mergePlanBlobsQuarantiningDuplicates(blobs);
  assert.deepEqual(plan.tasks.map((t) => t.id), ["W1-T1"]);
  assert.deepEqual(
    quarantined.map((q) => [q.id, q.files, q.reason]),
    [
      ["W1-T70", ["s-risk"], "shard_invalid"],
      ["s-noid", ["s-noid"], "shard_invalid"],
    ],
  );
  assert.throws(() => mergePlanBlobs(blobs), /invalid risk 'enormous'/, "strict merging still refuses");

  await withTempDir("bad-shard-disk", (dir) => {
    const path = join(dir, "tasks.yaml");
    writeFileSync(path, task("W1-T1"));
    mkdirSync(join(dir, "tasks.d"));
    writeFileSync(join(dir, "tasks.d", "W1-T60-bad.yaml"), DUPLICATE_KEY_SHARD);
    const r = recorder();
    const daemonPlan = loadDaemonPlan(path, r.log, () => {
      throw new Error("gh is down");
    });
    assert.deepEqual(daemonPlan.tasks.map((t) => t.id), ["W1-T1"]);
    assert.equal(r.rows.find((row) => row.step === "plan.shard_quarantined")?.extra?.file, join(dir, "tasks.d", "W1-T60-bad.yaml"));
    assert.equal(r.rows.find((row) => row.step === "plan.shard_escalation_failed")?.extra?.reason, "gh is down");
    assert.throws(() => loadPlan(path), /Map keys must be unique/, "loadPlan stays strict");
  });
});

test("lint-plan still refuses a shard holding a duplicate key", async () => {
  await withTempDir("bad-shard-lint", async (dir) => {
    mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
    const path = join(dir, "plan", "tasks.yaml");
    writeFileSync(path, task("W1-T1"));
    writeFileSync(join(dir, "plan", "tasks.d", "W1-T60-bad.yaml"), DUPLICATE_KEY_SHARD);
    const errors: string[] = [];
    const origError = console.error;
    console.error = (m: string) => errors.push(String(m));
    let exitCode: number;
    try {
      exitCode = await lintPlanCommand(["--plan", path], { offline: true, repoRoot: dir });
    } finally {
      console.error = origError;
    }
    assert.equal(exitCode, 2);
    assert.match(errors.join("\n"), /W1-T60-bad\.yaml.*Map keys must be unique/s);
  });
});
