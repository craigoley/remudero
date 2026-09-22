import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildPlanReconcileCadenceInput, planReconcileCadence } from "../src/lib/measurement-cadence.js";
import { buildPlanReconcileProductionInput, defaultCreditedMergedIds, buildCreditCandidates } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";

test("W1-T3970: production measurement cadence supplies plan reconciliation inputs", () => {
  const landed: Array<Array<{ relPath: string; content: string }>> = [];
  const opts = buildPlanReconcileCadenceInput({
    checkoutRoot: "/fixture",
    readShards: () => [
      { taskId: "W1-T1", path: "/fixture/plan/tasks.d/W1-T1.yaml", text: "- id: W1-T1\n  status: queued\n" },
      { taskId: "W1-T2", path: "/fixture/plan/tasks.d/W1-T2.yaml", text: "- id: W1-T2\n  status: queued\n" },
    ],
    creditedMergedIds: () => new Set(["W1-T1"]),
    threshold: 1,
    land: (inputs) => landed.push([...inputs]),
  });
  const report = planReconcileCadence(opts);
  assert.equal(report.status, "landed");
  assert.deepEqual(landed, [[{ relPath: "plan/tasks.d/W1-T1.yaml", content: "- id: W1-T1\n  status: merged\n" }]]);
  assert.deepEqual(report.taskIds, ["W1-T1"]);
});

test("W1-T3970: daemon checkout remains clean", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-plan-reconcile-wiring-"));
  try {
    let landed = false;
    const opts = buildPlanReconcileCadenceInput({
      checkoutRoot: root,
      readShards: () => [{ taskId: "W1-T3", path: join(root, "plan/tasks.d/W1-T3.yaml"), text: "  status: queued\n" }],
      creditedMergedIds: () => new Set(["W1-T3"]),
      threshold: 1,
      land: () => {
        landed = true;
      },
    });
    assert.equal(planReconcileCadence(opts).status, "landed");
    assert.equal(landed, true);
    assert.equal(existsSync(join(root, "plan")), false, "landing must not write the daemon checkout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3970: production adapter lands threshold drift and refuses an unlanded result", () => {
  const ids = Array.from({ length: 10 }, (_, i) => `W1-T${i + 1}`);
  const records = ids.map((taskId) => ({ taskId, path: `/fixture/plan/tasks.d/${taskId}.yaml`, text: `- id: ${taskId}\n  status: queued\n` }));
  let landed = 0;
  const input = buildPlanReconcileProductionInput({
    checkoutRoot: "/fixture",
    readShards: () => records,
    creditedMergedIds: () => new Set(ids),
    land: (_root, writes) => {
      landed = writes.length;
      return { landed: true, files: writes.map((write) => write.relPath) };
    },
  });
  assert.ok(input);
  assert.deepEqual(planReconcileCadence(input!), { drift: 10, taskIds: ids, status: "landed", threshold: 10 });
  assert.equal(landed, 10);

  const refused = buildPlanReconcileProductionInput({
    checkoutRoot: "/fixture",
    readShards: () => records,
    creditedMergedIds: () => new Set(ids),
    land: () => ({ landed: false, files: [], error: "simulated landing refusal" }),
  });
  assert.ok(refused);
  assert.throws(() => planReconcileCadence(refused!), /simulated landing refusal/);
});

test("W1-T3970: production adapter's omitted land seam invokes the real local landing bridge", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-plan-reconcile-default-"));
  const origin = mkdtempSync(join(tmpdir(), "rmd-plan-reconcile-default-origin-"));
  const ghBin = mkdtempSync(join(tmpdir(), "rmd-plan-reconcile-default-gh-"));
  const oldPath = process.env.PATH;
  try {
    execFileSync("git", ["init", "--quiet", "--bare", origin]);
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"]);
    execFileSync("git", ["-C", root, "config", "user.email", "fixture@example.invalid"]);
    execFileSync("git", ["-C", root, "config", "user.name", "fixture"]);
    writeFileSync(join(root, "README.md"), "fixture\n");
    execFileSync("git", ["-C", root, "add", "README.md"]);
    execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "chore: seed fixture"]);
    execFileSync("git", ["-C", root, "remote", "add", "origin", origin]);
    execFileSync("git", ["-C", root, "push", "--quiet", "origin", "main"]);

    writeFileSync(
      join(ghBin, "gh"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = pr ] && [ \"$2\" = list ]; then printf '%s\\n' '[]'; " +
        "elif [ \"$1\" = pr ] && [ \"$2\" = create ]; then printf '%s\\n' 'https://github.com/o/r/pull/3970'; " +
        "else :; fi\n",
      { mode: 0o755 },
    );
    process.env.PATH = `${ghBin}:${oldPath}`;

    const ids = Array.from({ length: 10 }, (_, i) => `W1-T${i + 1}`);
    const input = buildPlanReconcileProductionInput({
      checkoutRoot: root,
      readShards: () =>
        ids.map((taskId) => ({
          taskId,
          path: join(root, "plan", "tasks.d", `${taskId}.yaml`),
          text: `- id: ${taskId}\n  status: queued\n`,
        })),
      creditedMergedIds: () => new Set(ids),
    });
    assert.ok(input);

    const report = withLiveWritesAllowed(() => planReconcileCadence(input));
    assert.equal(report.status, "landed");
    assert.deepEqual(report.taskIds, ids);
    assert.equal(existsSync(join(root, "plan")), false, "the landing bridge must not write the daemon checkout");
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test("W1-T3970: production adapter omits the optional rung when credit projection construction fails", () => {
  const input = buildPlanReconcileProductionInput({
    checkoutRoot: "/fixture",
    readShards: () => [],
    creditedMergedIds: () => {
      throw new Error("simulated credit projection refusal");
    },
    land: () => ({ landed: true, files: [] }),
  });
  assert.equal(input, undefined);
});

test("W1-T3970: the default credit projection reads the supplied checkout plan before deriving candidates", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-credit-projection-"));
  try {
    mkdirSync(join(root, "plan"), { recursive: true });
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(
      join(root, "plan", "tasks.yaml"),
      "- id: W1-T1\n  title: fixture\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n",
    );
    writeFileSync(join(root, "state", "ledger.ndjson"), "{}\n");
    const candidates: ReturnType<typeof buildCreditCandidates> = [
      { taskId: "W1-T1", prNumber: 1, prUrl: "https://github.com/o/r/pull/1", merged: true, creditIsImplementation: true },
    ];
    const credited = defaultCreditedMergedIds(
      { root } as Config,
      root,
      (() => candidates) as typeof buildCreditCandidates,
    );
    assert.deepEqual([...credited], ["W1-T1"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
