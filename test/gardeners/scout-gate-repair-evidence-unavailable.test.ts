import assert from "node:assert/strict";
import test from "node:test";

import { loadGateRepairObservations, type GateRepairRule } from "#src/lib/gate-gardener.js";

const suite = "test/enrolled-census.test.ts";
const nestedSuite = "test/nested-census.test.ts";
const changedFile = "src/census.ts";
const patch = "@@ -1 +1 @@\n-old\n+new";
const rules: GateRepairRule[] = [suite, nestedSuite].map(gate => ({
  gate, recognizer: changedFile, symbol: "census", ownFiles: [], gateRegex: null,
}));

async function readRepair(log: string) {
  const events: Array<{ step: string; reason: unknown }> = [];
  const observations = await loadGateRepairObservations(rules, {
    ghJson: async args => {
      const path = args[1] ?? "";
      if (args[0] === "repo") return { nameWithOwner: "owner/repo" };
      if (path.startsWith("repos/owner/repo/pulls?")) return [{ number: 42, base: { sha: "base" } }];
      if (path.startsWith("repos/owner/repo/pulls/42/commits?")) return [{ sha: "red" }, { sha: "green" }];
      if (path.endsWith("/check-runs?per_page=100")) return { check_runs: [{
        id: 92, name: "ci-shard (1/8)", status: "completed",
        conclusion: path.includes("/red/") ? "failure" : "success",
        app: { slug: "github-actions" }, details_url: "https://github.com/owner/repo/actions/runs/90/job/91",
      }] };
      if (path.endsWith("/status")) return { statuses: [] };
      if (path.endsWith("/compare/red...green")) return { files: [{ filename: changedFile, patch }] };
      if (path.endsWith("/compare/base...red")) return { merge_base_commit: { sha: "base" }, files: [] };
      assert.fail(`unexpected GitHub read: ${args.join(" ")}`);
    },
    ghText: async args => {
      assert.deepEqual(args, ["run", "view", "--job", "91", "--log-failed"]);
      return log;
    },
  }, (step, extra) => events.push({ step, reason: extra?.reason }));
  return { observations, events };
}

function failedJobLog(file: string, diagnostic: string[] = []) {
  return [
    `ok 1 - ${nestedSuite}`,
    "not ok 2 - the census finds a violation",
    "  ---",
    `  location: '/home/runner/work/repo/repo/${file}:12:1'`,
    ...diagnostic,
    "  ...",
  ].map(line => `2026-11-18T19:00:00.0000000Z ${line}`).join("\n");
}

test("W1-T12427: gate.repair_evidence_unavailable no longer recurs", async () => {
  for (let inventory = 0; inventory < 2; inventory++) {
    const { observations, events } = await readRepair(failedJobLog(suite));
    assert.deepEqual(observations.map(({ pair }) => pair.gate), [suite]);
    assert.deepEqual(observations[0]?.pair.repairFiles, [changedFile]);
    assert.equal(observations[0]?.repairDiff, `diff --git a/${changedFile} b/${changedFile}\n${patch}`);
    assert.deepEqual(events, []);
  }
});

test("a non-enrolled TAP failure still has no repair evidence", async () => {
  const { observations, events } = await readRepair(failedJobLog("test/other.test.ts", [
    "  error: |",
    `    not ok 1 - ${nestedSuite}`,
    `      location: '/home/runner/work/repo/repo/${nestedSuite}:3:1'`,
  ]));
  assert.deepEqual(observations, []);
  assert.deepEqual(events, [{ step: "gate.repair_evidence_unavailable", reason: "no-enrolled-failed-suite" }]);
});
