import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { coveragePrecheck, coveragePushRefusal, pushFixRoundPrechecked, type CoveragePrecheckPorts } from "#test/helpers/run-task-test.js";
import { gitRepo } from "#test/helpers/git-repo.js";

function consumerTree(changedPath: string) {
  const tree = gitRepo({ kind: "consumer-coverage-precheck" });
  for (const path of ["app/page.tsx", "lib/feature.ts", "tests/unit/feature.test.ts"]) {
    mkdirSync(dirname(join(tree.dir, path)), { recursive: true });
    writeFileSync(join(tree.dir, path), "export {};\n");
  }
  tree.git("add", "-A");
  tree.git("commit", "-qm", "seed consumer layout");
  tree.git("update-ref", "refs/remotes/origin/main", "HEAD");
  mkdirSync(dirname(join(tree.dir, changedPath)), { recursive: true });
  writeFileSync(join(tree.dir, changedPath), "export const changed = true;\n");
  tree.git("add", "-A");
  tree.git("commit", "-qm", "change consumer feature");
  return tree;
}

test("W1-T8925: a consumer-repo push records its coverage precheck as not applicable", async () => {
  const tree = consumerTree("src/feature.ts");
  try {
    for (const repo of ["remudero-console", "remudero-site"]) {
      const calls: string[] = [];
      const ports: CoveragePrecheckPorts = {
        repo,
        changedFiles: () => { calls.push("changedFiles"); return ["src/feature.ts"]; },
        select: () => { calls.push("select"); throw new Error("core selector must not run"); },
        manifest: () => { calls.push("manifest"); throw new Error("core manifest must not load"); },
        run: () => { calls.push("run"); throw new Error("core coverage must not run"); },
        conflictMarkers: () => [],
      };
      const result = await coveragePrecheck(tree.dir, ports);
      const expected = { outcome: "not-applicable", repo, reason: `core's diff-coverage selector does not apply to ${repo}` };
      assert.deepEqual(result, expected);
      const rows: Record<string, unknown>[] = [];
      const log = (step: string, extra?: Record<string, unknown>) => rows.push({ step, ...extra });
      for (const site of ["rung.fix_push", "fallback_push", "fallback_push.repair"]) {
        assert.equal(coveragePushRefusal(result, log, site), undefined);
        assert.deepEqual(rows.at(-1), { step: "push.coverage_precheck", site, ...expected });
      }
      let pushes = 0;
      await pushFixRoundPrechecked(log, tree.dir, "run-CONSUMER-T1-1", undefined, ports, () => { pushes++; });
      assert.equal(pushes, 1, "not-applicable permits the fix push");
      assert.deepEqual(calls, [], "no core precheck input or runner is invoked");
    }
  } finally {
    tree.cleanup();
  }
});

test("W1-T8925: a consumer-repo push with no src change is not reported as covered", async () => {
  const tree = consumerTree("app/page.tsx");
  try {
    for (const repo of ["remudero-console", "remudero-site"]) {
      const result = await coveragePrecheck(tree.dir, { repo });
      assert.deepEqual(result, { outcome: "not-applicable", repo, reason: `core's diff-coverage selector does not apply to ${repo}` });
      const rows: Record<string, unknown>[] = [];
      assert.equal(coveragePushRefusal(result, (step, extra) => rows.push({ step, ...extra }), "fallback_push"), undefined);
      assert.deepEqual(rows, [{ step: "push.coverage_precheck", site: "fallback_push", ...result }]);
      assert.equal(rows[0]!.outcome, "not-applicable");
    }
  } finally {
    tree.cleanup();
  }
});

test("W1-T8925: a core push still runs the coverage precheck", async () => {
  // The same tree has no test/ directory: repository identity alone decides applicability.
  const tree = consumerTree("src/feature.ts");
  try {
    for (const repo of ["remudero", undefined]) {
      const calls: string[] = [];
      const ports: CoveragePrecheckPorts = {
        repo,
        select: (_wt, changed) => {
          calls.push("select");
          assert.deepEqual(changed, ["src/feature.ts"]);
          return { suites: ["test/feature.test.ts"], fullRun: false, reasons: [], recentOnly: { floor: [] } };
        },
        manifest: () => { calls.push("manifest"); return { thresholdMs: 5000, files: {} }; },
        run: (_wt, suites) => {
          calls.push("run");
          assert.deepEqual(suites, ["test/feature.test.ts"]);
          return { status: 1, output: "diff-coverage: BLOCKED -- this diff adds source line(s) with zero covering tests; cover each line:\n  - src/feature.ts:1", timedOut: false };
        },
      };
      const result = await coveragePrecheck(tree.dir, ports);
      assert.equal(result.outcome, "uncovered");
      assert.deepEqual(calls, ["select", "manifest", "run"]);
      assert.ok(coveragePushRefusal(result, () => {}, "rung.fix_push")?.text.includes("src/feature.ts:1"));
      assert.equal((await coveragePrecheck(tree.dir, { repo })).outcome, "unavailable", "a missing core selector is not a consumer skip");
      assert.deepEqual(await coveragePrecheck(tree.dir, { repo, changedFiles: () => ["README.md"] }), {
        outcome: "covered", reason: "no changed src file for diff-coverage to prove", suites: 0,
      });
    }
  } finally {
    tree.cleanup();
  }
});
