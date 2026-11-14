// W1-T12552: the shipped policy restarts the daemon for freshness at most every 3 hours, with a 4 hour staleness horizon.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { readFileSync } from "node:fs";

import { freshnessRestartLadder, freshnessRestartOpts } from "#src/cli/commands/daemon.js";
import * as judge from "#src/lib/deploy-judge.js";
import { loadPolicy, policyPath, PolicyError, validatePolicy } from "#src/lib/policy.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const HOUR = 3_600_000;
const POLICY_PATH = policyPath(REPO_ROOT);
const shipped = () => loadPolicy(POLICY_PATH);
const raw = () => parseYaml(readFileSync(POLICY_PATH, "utf8")) as Record<string, unknown>;

function withRow(key: string, value: number): unknown {
  const table = raw();
  const block = table.freshnessRestart as Record<string, Record<string, unknown>>;
  block[key] = { ...block[key]!, value };
  return table;
}

test("W1-T12552 criterion 1: the shipped policy loads a 4 hour staleness horizon and a 3 hour minimum lifetime", () => {
  const policy = shipped();
  const rows = policy.values.freshnessRestart;
  assert.equal(rows.stalenessHorizonMs, 4 * HOUR);
  assert.equal(rows.minLifetimeMs, 3 * HOUR);
  assert.equal(rows.scoreLimit, 18);
  assert.equal(rows.quietWindowMs, 600_000);
  for (const key of ["stalenessHorizonMs", "minLifetimeMs"] as const) {
    const bounds = policy.bounds[`freshnessRestart.${key}`]!;
    assert.ok(rows[key] >= bounds.min! && rows[key] <= bounds.max!, `${key} sits inside its row's bounds`);
  }
});

test("W1-T12552 criterion 2: the daemon options and the live-edit ladder from the shipped policy carry the new values", () => {
  const rows = shipped().values.freshnessRestart;
  const opts = freshnessRestartOpts(rows);
  assert.equal(opts.freshnessStalenessHorizonMs, 4 * HOUR);
  assert.equal(opts.freshnessMinLifetimeMs, 3 * HOUR);
  assert.deepEqual(freshnessRestartLadder(rows), { scoreLimit: 18, stalenessHorizonMs: 4 * HOUR });
});

test("W1-T12552 criterion 3: invariant freshness-rows-stay-bounded: values past the max are refused and an absent block loads the lifted values", () => {
  for (const [key, value] of [["stalenessHorizonMs", 4 * HOUR + 1], ["minLifetimeMs", 6 * HOUR + 1]] as const) {
    assert.throws(() => validatePolicy(withRow(key, value)), (e: unknown) => e instanceof PolicyError && e.message.includes(`freshnessRestart.${key}`));
  }
  const absent = raw();
  delete absent.freshnessRestart;
  const loaded = validatePolicy(absent).values.freshnessRestart;
  assert.equal(loaded.stalenessHorizonMs, judge.DEPLOY_RESTART_RATE_CEILING_MS);
  assert.equal(loaded.stalenessHorizonMs, HOUR);
  assert.equal(loaded.minLifetimeMs, judge.FRESHNESS_MIN_LIFETIME_MS);
  assert.equal(loaded.minLifetimeMs, 1.5 * HOUR);
});
