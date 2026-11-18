import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gitRepo } from "#test/helpers/git-repo.js";
import { taskIdDestinationSnapshot, TASK_ID_DESTINATION_MAX_BUFFER } from "#src/run-task.js";

// A plan destination whose plan is bigger than Node's 1 MiB child stdout default. Before the bound, the batched blob
// read failed with "stdout maxBuffer length exceeded" and the mint refused as "plan destination is unreadable at plan".
test("a plan destination larger than one mebibyte still yields its task id population", async t => {
  const origin = gitRepo({ bare: true, scope: t }), seed = gitRepo({ scope: t }), root = gitRepo({ scope: t });
  mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), "[]\n");
  const filler = "x".repeat(400_000), ids = ["OPS-T1", "OPS-T2", "OPS-T3"];
  for (const id of ids) {
    writeFileSync(join(seed.dir, "plan", "tasks.d", `${id}-fixture.yaml`),
      `- id: ${id}\n  title: Fixture ${id}\n  repo: ops\n  depends_on: []\n  type: implement\n  verify: auto\n  risk: low\n  rationale: ${filler}\n  status: queued\n  acceptance:\n    - claim: fixture\n      proof: "grep: fixture in README.md"\n`);
  }
  seed.git("add", "plan"); seed.git("commit", "--quiet", "-m", "test: a large ops plan");
  seed.addRemote("origin", origin.dir); seed.git("push", "--quiet", "origin", "main");
  const stateDir = join(root.dir, "state"); mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "plan-destination.json"), JSON.stringify({ repository: "fixture-owner/ops", kinds: [] }));
  mkdirSync(join(root.dir, "repos"), { recursive: true });
  root.git("clone", "--quiet", origin.dir, join(root.dir, "repos", "ops"));
  assert.ok(TASK_ID_DESTINATION_MAX_BUFFER > 3 * filler.length, "the bound holds the whole fixture plan");
  const snapshot = await taskIdDestinationSnapshot({ destinationStateDir: () => stateDir, destinationPrFetch: async () => [] });
  assert.ok(snapshot, "a named destination answers");
  assert.deepEqual([...snapshot.ids].sort(), ids);
  assert.ok(snapshot.planTexts.reduce((n, text) => n + text.length, 0) > 1024 * 1024, "the fixture really exceeds 1 MiB");
});
