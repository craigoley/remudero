import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import { makeTempDir } from "../src/lib/tmp.js";

// ── W1-T3345 — A CANCELLED SHARD IS NOT A BROKEN DIFF ─────────────────────────────────────────
//
// MEASURED 2026-09-10, 64 shard jobs across the 8 most recent completed ci.yml runs: healthy shards
// finish in 9-19 minutes, four sat at the 35m ceiling, and ZERO fell in the 30-35m band. The empty
// band is the argument — a suite growing past its budget populates the approach to the wall, and
// these do not. They HANG and are killed by `timeout-minutes`.
//
// GitHub labels a timeout-kill `cancelled`, `REQUIRED_CHECK_FAIL` contains "CANCELLED", and the
// required aggregator's old text asserted the benign cause outright ("usually a newer push
// superseded this head"). So an operator was shown a broken diff for a hang — measured on #5003,
// which is PLAN-ONLY and cannot slow or break a test shard.
//
// This drives the SHIPPED script out of ci.yml rather than a paraphrase of it: a rewritten gate
// that no longer behaves is the failure this test exists to catch.

const CI_YML = fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));
const SHA_OLD = "a".repeat(40);
const SHA_NEW = "b".repeat(40);

interface Gate {
  jobName: string;
  stepName: string;
  run: string;
}

/** Every required-aggregator gate, found by its `SHARD_RESULT` env rather than by step name — a
 *  renamed step must not silently drop out of this suite and leave it passing over nothing. */
function gates(): Gate[] {
  const doc = parseYaml(readFileSync(CI_YML, "utf8")) as {
    jobs: Record<string, { steps?: Array<{ name?: string; run?: string; env?: Record<string, unknown> }> }>;
  };
  const found: Gate[] = [];
  for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (step.env && Object.prototype.hasOwnProperty.call(step.env, "SHARD_RESULT") && step.run) {
        found.push({ jobName, stepName: step.name ?? "(unnamed)", run: step.run });
      }
    }
  }
  return found;
}

/** Run a gate's own script with a stubbed `gh` ahead of it on PATH. */
function runGate(script: string, env: Record<string, string>, ghBody: string): { code: number; out: string } {
  const dir = makeTempDir("w1-t3345-");
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const gh = join(bin, "gh");
  writeFileSync(gh, ghBody);
  chmodSync(gh, 0o755);
  const scriptPath = join(dir, "gate.sh");
  writeFileSync(scriptPath, script);
  try {
    const out = execFileSync("bash", [scriptPath], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, ...env },
    });
    return { code: 0, out };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const ghSays = (sha: string) => `#!/bin/sh\necho ${sha}\n`;
const GH_FAILS = "#!/bin/sh\nexit 1\n";
const CANCELLED = { SHARD_RESULT: "cancelled", RUN_HEAD_SHA: SHA_OLD, PR_NUMBER: "1", GH_REPO_SLUG: "o/r" };

test("W1-T3345: both required aggregators are found, so this suite cannot pass over nothing", () => {
  const found = gates();
  assert.equal(found.length, 2, `expected the ci and coverage-ratchet gates, got ${JSON.stringify(found.map((g) => g.jobName))}`);
});

test("W1-T3345: a shard matrix CANCELLED BY A NEWER PUSH does not block — the sha it measured is not the sha that merges", () => {
  for (const g of gates()) {
    const r = runGate(g.run, CANCELLED, ghSays(SHA_NEW));
    assert.equal(r.code, 0, `${g.jobName} blocked a superseded run:\n${r.out}`);
    assert.match(r.out, /SUPERSEDED/, `${g.jobName} must name the reason it is not blocking`);
  }
});

test("W1-T3345: a shard matrix cancelled with the head UNCHANGED still blocks, and is reported as a HANG", () => {
  // The load-bearing pair with the case above. Same input but for the head, and the OPPOSITE
  // answer: nothing superseded this run, so the shard was killed at its ceiling and the tests did
  // not run. Blocking is right; calling it a failed diff is not.
  for (const g of gates()) {
    const r = runGate(g.run, CANCELLED, ghSays(SHA_OLD));
    assert.equal(r.code, 1, `${g.jobName} passed a head whose suite never ran:\n${r.out}`);
    assert.match(r.out, /SHARD HANG/, `${g.jobName} must say HANG, not "a shard FAILED"`);
    assert.match(r.out, /DID NOT RUN/, `${g.jobName} must say the tests did not run`);
    assert.doesNotMatch(r.out, /shard FAILED/, `${g.jobName} must not report a hang as a failed diff`);
  }
});

test("W1-T3345: an unreadable current head FAILS CLOSED — 'could not tell' is not permission to pass", () => {
  for (const g of gates()) {
    const r = runGate(g.run, CANCELLED, GH_FAILS);
    assert.equal(r.code, 1, `${g.jobName} passed on an unreadable head:\n${r.out}`);
    assert.match(r.out, /not permission to pass/, `${g.jobName} must say why it refused`);
  }
});

test("W1-T3345: the arms this change does not own are untouched", () => {
  // A relaxation that quietly widened into the other results would pass every assertion above.
  for (const g of gates()) {
    assert.equal(runGate(g.run, { SHARD_RESULT: "success" }, ghSays(SHA_OLD)).code, 0, `${g.jobName}: success must pass`);
    const failed = runGate(g.run, { SHARD_RESULT: "failure" }, ghSays(SHA_OLD));
    assert.equal(failed.code, 1, `${g.jobName}: a real shard failure must still block`);
    assert.match(failed.out, /shard FAILED/);
    assert.equal(runGate(g.run, { SHARD_RESULT: "skipped" }, ghSays(SHA_OLD)).code, 1, `${g.jobName}: skipped must still block`);
    assert.equal(runGate(g.run, { SHARD_RESULT: "zzz" }, ghSays(SHA_OLD)).code, 1, `${g.jobName}: an unknown result must still block`);
  }
});
