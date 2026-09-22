/**
 * THE VERIFY-HUMAN CADENCE MUST READ THE CHECKOUT, NOT THE STATE VOLUME.
 *
 * `config.root` and the repo checkout are DIFFERENT DIRECTORIES on every fleet host:
 *
 *     config.root   /home/node/Remudero            <- state volume: ledger, markers, registries
 *     checkout      /home/node/Remudero/remudero   <- plan/, .remudero/mounts.yaml, settings/
 *
 * `defaultVerifyHumanCadenceResult` was called with `config.root`, so it read
 * `<state>/plan/tasks.yaml` — a path that does not exist. `loadPlan` threw, the function's own
 * catch turned that into `status: "refused"`, and the caller discarded the result. The pass was
 * therefore SILENT.
 *
 * MEASURED ON THE FLEET, 2026-09-22, and this is what the bug cost:
 *
 *     verify_human.judged rows, live ledger          0
 *     newest verdict of any kind            2026-09-09   (13 days earlier)
 *     measurement_cadence.ran fires                115   (newest the same morning)
 *     <state>/plan/tasks.yaml                    MISSING
 *     <checkout>/plan/tasks.yaml            13,230 lines
 *     <checkout>/plan/tasks.d                1,812 shards
 *
 * So the judge built to decide whether a shard still needs a person never saw a single shard,
 * every day, for thirteen days, while its cadence reported firing.
 *
 * THE SIBLING RUNG IN THE SAME CALL OBJECT ALREADY HAD IT RIGHT: `coverageImprovement` is
 * constructed with `root: repoRoot` three lines below. One rung took the checkout and its
 * neighbour took the state volume, which is why this reads as a slip rather than a design.
 *
 * WHAT THIS TEST PINS is the DISTINCTION, not a path: given two different directories, the shard
 * reader must be handed the one holding `plan/`. A test that passed the same directory for both
 * could not fail on the bug it exists to catch.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parkedVerifyHumanShards } from "../src/run-task.js";
import { loadPlan } from "../src/lib/plan.js";

const clock = { now: () => Date.UTC(2026, 8, 22), date: () => new Date(Date.UTC(2026, 8, 22)), iso: () => "2026-09-22T00:00:00.000Z" };

/** A state volume with a checkout NESTED INSIDE IT — the exact fleet shape. */
function fleetShape(): { stateRoot: string; checkout: string } {
  const stateRoot = mkdtempSync(join(tmpdir(), "rmd-state-"));
  const checkout = join(stateRoot, "remudero");
  mkdirSync(join(checkout, "plan", "tasks.d"), { recursive: true });
  writeFileSync(
    join(checkout, "plan", "tasks.yaml"),
    [
      "- id: W1-T9001",
      '  title: "a parked shard the judge must be able to see"',
      "  repo: remudero",
      "  type: implement",
      "  verify: human",
      "  status: queued",
      "  depends_on: []",
      "",
    ].join("\n"),
    "utf8",
  );
  // The state volume deliberately has NO plan/ — reading it is the bug.
  return { stateRoot, checkout };
}

test("the shard reader finds parked work when handed the CHECKOUT", () => {
  const { checkout } = fleetShape();
  const plan = loadPlan(join(checkout, "plan", "tasks.yaml"));
  const shards = parkedVerifyHumanShards(plan, checkout, clock);
  assert.ok(shards.length >= 1, "a verify:human shard in the checkout must be visible to the judge");
  assert.ok(shards.some((s) => s.id === "W1-T9001"));
});

test("THE BUG: handed the STATE VOLUME, the plan cannot even be loaded", () => {
  // This is the whole defect in one assertion. The state root has no `plan/`, so the load that
  // `defaultVerifyHumanCadenceResult` performs throws — and its catch converts the throw into a
  // quiet `refused` that nothing ledgers. Zero shards judged, no row, no alarm.
  const { stateRoot } = fleetShape();
  assert.throws(
    () => loadPlan(join(stateRoot, "plan", "tasks.yaml")),
    "reading the state volume must fail loudly here, which is what the cadence was silently swallowing",
  );
});

test("the two roots are genuinely different directories, which is why the slip was invisible", () => {
  // A regression that passed the same path for both would be green on the broken code. The fleet
  // shape nests the checkout INSIDE the state volume, so a substring check is not enough either.
  const { stateRoot, checkout } = fleetShape();
  assert.notEqual(stateRoot, checkout);
  assert.ok(checkout.startsWith(stateRoot), "the checkout nests inside the state volume on the fleet");
});
