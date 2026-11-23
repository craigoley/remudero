import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { runGardenAsync, type GardenerDeps } from "#src/lib/gardener.js";
import { parseTasksFromYaml } from "#src/lib/plan.js";
import { REDESIGN_JUDGED_STEP, redesignGardenSpec } from "#src/lib/redesign-gardener.js";

test("W1-T12441: redesign.gardener_failed no longer recurs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-redesign-null-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const id = "W1-T1";
  const shard = "plan/tasks.d/W1-T1-example.yaml";
  const clock = fixedClock(Date.UTC(2026, 10, 10, 16));
  const text = [
    `- id: ${id}`,
    '  title: "Example task held for redesign"',
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    "  verify: auto",
    "  risk: low",
    "  priority: 1",
    "  status: queued",
    "  attempts: 0",
    "  # refusal-amendment (W1-T1, run example, 2026-11-10T14:00:00.000Z): amend the scope",
    "",
  ].join("\n");
  const tasks = parseTasksFromYaml(text, shard);
  const rows: Array<{ step: string; fields?: Record<string, unknown> }> = [];
  const deps: GardenerDeps = {
    stateDir: root,
    repoRoot: root,
    clock,
    log: (step, fields) => rows.push({ step, fields }),
    openWorkspace: () => assert.fail("an unparseable answer must never open a filing workspace"),
  };
  const spec = redesignGardenSpec(deps, {
    plan: () => ({ all: tasks, open: tasks, shards: new Map([[id, shard]]) }),
    readShard: () => text,
    ledger: (steps) => rows.filter(({ step }) => steps.includes(step)).map(({ step, fields }) => ({ step, ...fields })),
    judgeText: async () => "REDESIGN: null",
  });

  const result = await runGardenAsync(spec, deps);

  assert.equal(result.ran, true);
  const verdict = rows.find(({ step }) => step === REDESIGN_JUDGED_STEP)?.fields;
  assert.equal(verdict?.task_id, id);
  assert.equal(verdict?.outcome, "unparseable");
  assert.equal(verdict?.reason, "REDESIGN: needs a JSON object");
});
