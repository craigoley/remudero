/**
 * W1-T13651: an Inbox Approve read its plan at HEAD through git and YAML-parsed every shard on serve's request loop,
 * about 25 s on the Azure host (2026-11-18 10:53:55Z), so the Console's Approve gave up at 25 s. Approve now gates on
 * serve's board plan when that plan was read from a committed ref, which is never torn; any other source keeps git.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { approvePlanReader } from "#src/lib/panel-graph.js";
import { mergePlanBlobs, type Plan } from "#src/lib/plan.js";
import { gitRepo } from "#test/helpers/git-repo.js";

type TestCtx = { after: (fn: () => void) => void };
const record = (id: string) => `- id: ${id}\n  title: ${id} title\n  repo: remudero\n  type: implement\n  depends_on: []\n`;
const held: Plan = mergePlanBlobs([{ label: "held.yaml", text: record("HELD-T1") }]);
const loaded = { state: "loaded", generation: 3, identity: "ref:/repo@origin/main", observedAt: "2026-11-18T10:50:00.000Z" } as const;

/** A git checkout whose committed plan differs from the held one. */
function checkout(t: TestCtx): { root: string; planPath: string } {
  const repo = gitRepo({ seedCommit: false, kind: "approve-plan-reader" });
  t.after(() => rmSync(repo.dir, { recursive: true, force: true }));
  mkdirSync(join(repo.dir, "plan"), { recursive: true });
  const planPath = join(repo.dir, "plan", "tasks.yaml");
  writeFileSync(planPath, record("COMMITTED-T1"));
  repo.git("add", "plan/tasks.yaml");
  repo.git("commit", "-q", "-m", "plan");
  return { root: repo.dir, planPath };
}

const ids = (plan: Plan) => plan.tasks.map((task) => task.id);

test("W1-T13651 criterion 1: with a plan loaded from a committed ref, Approve reads the held plan and runs no git", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-approve-no-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const read = approvePlanReader({ root, readPlanSnapshot: () => held, readPlanSource: () => loaded });
  assert.deepEqual(ids(read(join(root, "plan", "tasks.yaml"))), ["HELD-T1"], "a git read here would throw: the directory is no repository");
});

test("W1-T13651 criterion 2: any other plan source keeps the git read at HEAD", (t) => {
  const { root, planPath } = checkout(t);
  const sources = [
    undefined,
    { state: "stale", generation: 3, identity: "ref:/repo@origin/main", observedAt: "2026-11-18T10:50:00.000Z", reason: "reload failed", failedAt: "2026-11-18T10:51:00.000Z" },
    { state: "unavailable", reason: "no plan", failedAt: "2026-11-18T10:51:00.000Z" },
    { ...loaded, identity: "file:/repo/plan/tasks.yaml" },
  ];
  for (const source of sources) {
    const read = approvePlanReader({ root, readPlanSnapshot: () => held, readPlanSource: () => source as never });
    assert.deepEqual(ids(read(planPath)), ["COMMITTED-T1"], `source ${JSON.stringify(source)} reads the committed plan`);
  }
  assert.deepEqual(ids(approvePlanReader({ root, readPlanSource: () => loaded })(planPath)), ["COMMITTED-T1"], "no held plan reads git too");
});
