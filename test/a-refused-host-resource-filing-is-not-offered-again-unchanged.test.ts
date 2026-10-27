/**
 * The host-resource gardener filed the `rmd` consumer on host azure with the proof
 * `grep: rmd in deploy/rmd-host-cleanup.sh`, which already passes at origin/main, so the plan-PR preflight refused
 * it (proof-discrimination). The landing returns no PR url on a refusal, and the pass recorded nothing for an
 * undefined url, so the same unchanged filing was offered again on the next pass: 495
 * `plan_pr.preflight_refused` rows 2026-10-11..14, each reserving a task id (402 orphaned `refs/rmd-id` pushes)
 * and running an ~80 s preflight child.
 *
 * These tests pin both halves of the repair. A filing the preflight refused is not offered again while its shape
 * is unchanged, and is offered again once the shape changes. The rendered proof greps the filing's origin, so it
 * misses at a base whose janitor already names the consumer.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import {
  consumerShardYaml,
  runHostResourcePass,
  samplesPath,
  type ConsumerFiling,
  type HostResourcePorts,
  type HostSample,
} from "#src/lib/host-resource-gardener.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const GB = 1024 * 1024;

/** 72 h of samples: the root disk falls 2 GB/h and `rmd` grows 1.6 GB/h with no janitor pass reaping it. */
function seedGrowingRmd(dir: string): void {
  const n = 144;
  const samples: HostSample[] = Array.from({ length: n }, (_, i) => {
    const tsMs = NOW - (n - 1 - i) * 30 * 60_000;
    return {
      host: "azure",
      beatTs: new Date(tsMs).toISOString(),
      tsMs,
      values: { root_free_kb: 400 * GB + (n - 1 - i) * GB },
      consumers: { rmd: 10 * GB + i * 0.8 * GB },
      devices: { root: "/dev/root" },
      consumerDevices: { rmd: "/dev/root" },
      janitorTs: new Date(Math.floor(tsMs / (6 * HOUR)) * 6 * HOUR).toISOString(),
      janitorFreedKb: 4 * 1024,
    };
  });
  writeFileSync(samplesPath(dir), samples.map((s) => JSON.stringify(s)).join("\n") + "\n");
}

function ports(dir: string, fileConsumer: HostResourcePorts["fileConsumer"]) {
  const rows: { step: string; extra?: Record<string, unknown> }[] = [];
  const p: HostResourcePorts = {
    stateDir: dir,
    clock: fixedClock(NOW),
    log: (step, extra) => void rows.push({ step, extra }),
    readHeartbeats: () => [],
    planOrigins: () => [],
    fileConsumer,
  };
  return { p, rows };
}

test("a host-resource filing the preflight refused is not offered again while its shape is unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-resource-refused-`));
  try {
    seedGrowingRmd(dir);
    const offered: ConsumerFiling[] = [];
    // The daemon's landing returns no url when the plan-PR preflight refuses the tree.
    const refused = ports(dir, (f) => void offered.push(f));
    runHostResourcePass(refused.p);
    assert.equal(offered.length, 1);
    assert.equal(offered[0]!.origin, "host-resource:azure:rmd");
    const row = refused.rows.find((r) => r.step === "host_resource.file_not_landed");
    assert.equal(row?.extra?.consumer, "rmd");
    assert.match(String(row?.extra?.shape), /^[0-9a-f]{16}$/, "the refused filing is recorded by its shape");

    runHostResourcePass(refused.p);
    runHostResourcePass(refused.p);
    assert.equal(offered.length, 1, "an unchanged refused filing reserves no id and runs no preflight again");
    assert.equal(refused.rows.filter((r) => r.step === "host_resource.file_not_landed").length, 1);

    // A changed shape (here: the recorded one is from an older renderer) is offered again, and a PR that opens is filed.
    const statePath = join(dir, "host-resource-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { filed: Record<string, { notLandedShape?: string }> };
    state.filed["host-resource:azure:rmd"]!.notLandedShape = "an-older-renderer";
    writeFileSync(statePath, JSON.stringify(state));
    const landed = ports(dir, (f) => (offered.push(f), "https://github.com/o/r/pull/1"));
    runHostResourcePass(landed.p);
    assert.equal(offered.length, 2);
    assert.equal(landed.rows.filter((r) => r.step === "host_resource.filed").length, 1);
    runHostResourcePass(landed.p);
    assert.equal(offered.length, 2, "a filed origin is not filed again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a host-resource filing's proof greps its origin, not a consumer name the janitor already holds", () => {
  const filing: ConsumerFiling = {
    host: "azure",
    device: "root",
    consumer: "rmd",
    origin: "host-resource:azure:rmd",
    attribution: { consumer: "rmd", growthKbPerHour: 0.8 * GB, share: 0.8, spanHours: 72, points: 144, janitorPasses: 12 },
  };
  const task = loadPlanFromYaml(consumerShardYaml(filing, "W1-T9999"), "W1-T9999.yaml").tasks[0]!;
  assert.deepEqual(task.files, ["deploy/rmd-host-cleanup.sh"]);
  const proofs = (task.acceptance ?? []).map((c) => c.proof);
  assert.deepEqual(proofs, ["grep: host-resource:azure:rmd in deploy/rmd-host-cleanup.sh"]);
  // The janitor on main names `rmd` all over; the origin string is what a new rule must add.
  const janitorAtBase = "#!/bin/bash\n# rmd-host-cleanup.sh: reap idle rmd scratch\nrm -rf ~/rmd-scratch/old\n";
  assert.ok(janitorAtBase.includes("rmd") && !janitorAtBase.includes(filing.origin), "the proof misses at a base that names the consumer");
});
