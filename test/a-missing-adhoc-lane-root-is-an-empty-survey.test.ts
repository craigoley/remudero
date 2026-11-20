import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ADHOC_LANE_REAP_GRACE_MS, adhocLaneRoot, runAdhocLaneReapRung } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";

type Row = { step: string; fields: Record<string, unknown> };

/** A config whose root exists and whose `<root>/lanes` was never made: the fleet container's shape. */
function missingLaneRoot(): { config: Config; root: string } {
  const root = mkdtempSync(join(realpathSync(tmpdir()), `${RMD_TMP_PREFIX}adhoc-lane-missing-`));
  const config = { root } as unknown as Config;
  assert.equal(existsSync(adhocLaneRoot(config)), false);
  return { config, root };
}

async function run(config: Config, deps: Parameters<typeof runAdhocLaneReapRung>[2] = {}): Promise<Row[]> {
  const rows: Row[] = [];
  await runAdhocLaneReapRung(config, (step, fields) => rows.push({ step, fields: fields ?? {} }), deps);
  return rows;
}

const census = (rows: Row[]): Record<string, unknown> => {
  const row = rows.find((r) => r.step === "adhoc_lane.reap.census");
  assert.ok(row, "every pass writes one census row");
  return row.fields;
};

test("W1-T13789 criterion 1: a missing lanes root logs no enumeration or headroom error and an empty census", async () => {
  const { config } = missingLaneRoot();
  const rows = await run(config);
  assert.equal(rows.filter((r) => r.step === "adhoc_lane.reap.enumeration_error").length, 0);
  assert.equal(rows.filter((r) => r.step === "adhoc_lane.reap.headroom_error").length, 0);
  const row = census(rows);
  assert.equal("error" in row, false, "a missing root is not an error");
  assert.deepEqual(row.kept_by_reason, {});
  assert.equal((row.reaped as { count: number }).count, 0);
});

test("W1-T13789 criterion 2: with the lanes root missing, headroom is measured on the config root", async () => {
  const { config } = missingLaneRoot();
  const row = census(await run(config));
  const fraction = row.free_fraction;
  assert.equal(typeof fraction, "number", "the disk-pressure rule has a fraction to scale by");
  assert.ok((fraction as number) > 0 && (fraction as number) <= 1, `free_fraction ${String(fraction)} is in (0, 1]`);
  assert.equal(row.grace_ms, ADHOC_LANE_REAP_GRACE_MS * (fraction as number));
});

test("W1-T13789 criterion 3: an unreadable lanes root still reports, and a missing one still runs the unmanaged sweep", async () => {
  const blocked = missingLaneRoot();
  writeFileSync(adhocLaneRoot(blocked.config), "a file where the lanes folder belongs\n");
  const blockedRows = await run(blocked.config);
  assert.equal(blockedRows.filter((r) => r.step === "adhoc_lane.reap.enumeration_error").length, 1);
  assert.match(String(census(blockedRows).error), /ENOTDIR/);

  const { config, root } = missingLaneRoot();
  const repo = gitRepo({ kind: "adhoc-lane-missing-repo" });
  const lane = join(root, "manual", "lane");
  mkdirSync(join(root, "manual"), { recursive: true });
  repo.git("worktree", "add", "--quiet", "--detach", lane, "HEAD");
  const rows = await run(config, { repoDir: realpathSync(repo.dir) });
  const unmanaged = rows.find((r) => r.step === "adhoc_lane.unmanaged");
  assert.ok(unmanaged, "the unmanaged sweep runs although the lanes root is missing");
  assert.deepEqual(unmanaged.fields.lanes, [lane]);
  assert.ok(existsSync(lane), "the young lane stays");
});
