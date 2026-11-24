import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFieldTrialsCaseFiles, readCaseFileCatalog, readCaseFileOpsCatalog, type CaseFileCatalog, type CaseFileOpsRead,
  type CaseFileOpsReadDeps,
  type FieldTrialsCaseFilePlan, type ViewPr } from "#src/lib/field-trials-case-files.js";
import type { FlowRow } from "#src/lib/field-trials-flow.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { caseFileCommand, parseCasePrSnapshot } from "#src/lib/report-commands.js";
import type { StatusProjection } from "#src/lib/status.js";
import { readTaskCaseLedgers, type TaskCaseFile } from "#src/lib/task-case-file.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const now = "2026-11-24T04:00:00.000Z";
const sha = "d".repeat(40);
const publicId = "W1-T14001";
const opsId = "W1-T14571";
const taskOf = (id: string, title: string) => ({ id, title, repo: "remudero", depends_on: [], type: "implement",
  verify: "auto", risk: "high", status: "queued", attempts: 0 }) as Task;
const planOf = (...tasks: Task[]): Plan => ({ tasks, byId: new Map(tasks.map((task) => [task.id, task])) });
const publicPlan = planOf(taskOf(publicId, "public task"));
const opsPlan = planOf(taskOf(opsId, "ops-filed task"), taskOf(publicId, "an ops copy never replaces the public record"));
const prNumber = (id: string) => 50000 + Number(id.slice(4)) - 14000;

function flow(partial: Partial<FlowRow>): FlowRow {
  return { fingerprint: Math.random().toString(16), ts: null, step: "", host: null, actor: null, taskId: null, runId: null,
    assignmentId: null, requestedModel: null, selectedModel: null, servedModel: null, prRepo: null, prNumber: null,
    ...partial } as FlowRow;
}
const rows = [publicId, opsId].flatMap((id) => [
  flow({ step: "worker.assignment", taskId: id, runId: `run-${id}`, ts: "2026-11-20T00:00:00.000Z" }),
  flow({ step: "pr.opened", taskId: id, prRepo: "craigoley/remudero", prNumber: prNumber(id), ts: "2026-11-20T01:00:00.000Z" })]);
const prRaw = (number: number) => {
  const id = `W1-T${number - 50000 + 14000}`;
  return { number, url: `https://github.com/craigoley/remudero/pull/${number}`, state: "MERGED", headRefOid: sha,
    headRefName: `run-${id}-1`, body: `Remudero-Task: ${id}`, mergedAt: "2026-11-21T00:00:00Z", statusCheckRollup: [] };
};

/** The script's build: the catalog's ids and records, one caseFileCommand batch over a real (empty) ledger. */
async function build(t: TestContext, catalog: CaseFileCatalog) {
  const ledger = writeLedger([], { scope: t });
  const viewPr: ViewPr = async (number) => prRaw(number);
  return buildFieldTrialsCaseFiles({ rows, planIds: catalog.planIds, carry: undefined, opsCatalog: catalog.opsCatalog },
    async () => [], viewPr, { nowIso: () => now, sleep: async () => {} },
    async (plan: FieldTrialsCaseFilePlan): Promise<TaskCaseFile[]> => {
      let printed = "";
      const code = await caseFileCommand(["--tasks", plan.selected.join(","), "--json"], {
        stateDir: ledger.dir, nowIso: () => now, resolveOwnerRepo: () => ({ owner: "craigoley", repo: "remudero" }),
        readTask: catalog.readTask,
        readLedgers: (dir, taskIds, asOf) => readTaskCaseLedgers(dir, taskIds, asOf),
        readProjection: (task) => ({ taskId: task.id, status: "merged", merged: true, source: "trailer",
          prNumber: plan.prNumbers.get(task.id) }) as StatusProjection,
        readPr: (number, _owner, _repo, readAt) => parseCasePrSnapshot(prRaw(number), readAt),
        out: (line) => { printed = line; }, err: () => {},
      });
      assert.equal(code, 0);
      return JSON.parse(printed) as TaskCaseFile[];
    });
}

test("W1-T14717: the daily case-file snapshot selects a task filed only in the ops catalog", async (t) => {
  for (const read of [{ outcome: "ok", plan: opsPlan }, { outcome: "last-good", plan: opsPlan, refusal: "http_error" }] as CaseFileOpsRead[]) {
    const catalog = await readCaseFileCatalog(publicPlan, async () => read);
    assert.deepEqual([...catalog.planIds].sort(), [publicId, opsId].sort());
    assert.equal(catalog.readTask(publicId)?.title, "public task", "the public record wins a shared id");
    const result = await build(t, catalog);
    assert.equal(result.summary.outsidePlan, 0, "an ops-filed task is never counted outside the plan");
    assert.equal(result.summary.selected, 2);
    assert.equal(result.summary.opsCatalog, read.outcome === "ok" ? "ok" : "last-good-http_error");
    const file = result.files.find((entry) => entry.taskId === opsId);
    assert.ok(file, "the ops-filed task gets a case file");
    assert.equal(file.plan.state === "observed" && file.plan.value.title, "ops-filed task");
    assert.equal(file.pr.state === "observed" && file.pr.value.number, prNumber(opsId));
  }
  // With no destination the public plan alone answers, and says so.
  const off = await readCaseFileCatalog(publicPlan, async () => ({ outcome: "off" }));
  const result = await build(t, off);
  assert.equal(result.summary.outsidePlan, 1);
  assert.equal(result.summary.opsCatalog, "off");
});

test("W1-T14717: an unreadable ops catalog still builds case files for public tasks and names the refusal", async (t) => {
  const reads: Array<[() => Promise<CaseFileOpsRead>, string]> = [
    [async () => ({ outcome: "unreadable", reason: "ops-http_error" }), "unreadable-ops-http_error"],
    [async () => { throw new RangeError("socket hang up"); }, "unreadable-ops-read-failed:RangeError"],
  ];
  for (const [readOps, named] of reads) {
    const catalog = await readCaseFileCatalog(publicPlan, readOps);
    assert.deepEqual([...catalog.planIds], [publicId]);
    assert.equal(catalog.opsCatalog, named);
    const result = await build(t, catalog);
    assert.equal(result.summary.opsCatalog, named, "the refusal is named, never read as an empty catalog");
    assert.equal(result.summary.outsidePlan, 1);
    assert.deepEqual(result.files.map((file) => file.taskId), [publicId]);
  }
});

test("the script's ops catalog read: off, a refused destination, the live catalog, the last good one, or the refusal", async () => {
  const named = (() => ({ outcome: "named", kinds: [], owner: "craigoley", repo: "remudero-ops" })) as unknown as CaseFileOpsReadDeps["destination"];
  const live = (outcome: string, plan?: Plan) => (async (target: { repository: string }) => {
    assert.equal(target.repository, "craigoley/remudero-ops");
    return { outcome, plan, counts: {} };
  }) as unknown as CaseFileOpsReadDeps["snapshot"];
  const kept = (plan?: Plan) => (async () => plan ? { outcome: "ok", plan } : { outcome: "none", reason: "no_record" }) as unknown as CaseFileOpsReadDeps["lastGood"];
  assert.deepEqual(await readCaseFileOpsCatalog("/s", { destination: (() => ({ outcome: "off" })) as never }), { outcome: "off" });
  assert.deepEqual(await readCaseFileOpsCatalog("/s", { destination: (() => ({ outcome: "unreadable", reason: "x" })) as never }),
    { outcome: "unreadable", reason: "destination-unreadable" });
  assert.deepEqual(await readCaseFileOpsCatalog("/s", { destination: named, snapshot: live("ok", opsPlan), lastGood: kept() }),
    { outcome: "ok", plan: opsPlan });
  assert.deepEqual(await readCaseFileOpsCatalog("/s", { destination: named, snapshot: live("http_error"), lastGood: kept(opsPlan) }),
    { outcome: "last-good", plan: opsPlan, refusal: "http_error" });
  assert.deepEqual(await readCaseFileOpsCatalog("/s", { destination: named, snapshot: live("http_error"), lastGood: kept() }),
    { outcome: "unreadable", reason: "ops-http_error" });
  // The real reads: a state dir naming no destination is off, never an error.
  const dir = mkdtempSync(join(tmpdir(), "rmd-case-ops-"));
  try { assert.deepEqual(await readCaseFileOpsCatalog(dir), { outcome: "off" }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
