/**
 * W1-T5515 — the required `ci-gate` context reports on a merge queue's group commit.
 *
 * Branch protection on main requires `ci-gate`. ci.yml's `ci-gate` job used to be guarded to
 * `pull_request`, so on a `merge_group` commit it was a SKIPPED check run, and GitHub counts a skipped
 * required check as passing: the operator's 2026-09-29 sandbox rehearsal saw a group with
 * `ci=failure, ci-gate=skipped` MERGED by the queue under main's exact protection shape.
 *
 * The full REQUIRED list cannot be waited on there: seven of its names come from workflows that never
 * trigger on `merge_group`, so the wait would time out on every entry. The contract (ci-gate.yml)
 * therefore carries MERGE_GROUP_REQUIRED, the subset a group commit really produces, and the runner
 * (scripts/ci-gate-from-contract.mjs) selects it ONLY from an explicit `--event merge_group` flag.
 * The PR-only gates already passed on the PR head, which is the precondition for entering the queue.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { ghShim } from "./helpers/gh-shim.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = join(REPO_ROOT, "scripts", "ci-gate-from-contract.mjs");
const WORKFLOWS = join(REPO_ROOT, ".github", "workflows");
const runner = (await import(pathToFileURL(RUNNER).href)) as {
  contractRun: (text: string) => { env: Record<string, string>; script: string };
  main: (argv: string[], deps?: { root?: string; run?: (...args: unknown[]) => { status: number | null } }) => number;
};

type Job = { name?: unknown; if?: unknown; env?: Record<string, string>; steps?: Array<{ run?: string }> };
type Wf = { on?: unknown; jobs?: Record<string, Job> };
const GATE_TEXT = readFileSync(join(WORKFLOWS, "ci-gate.yml"), "utf8");
const ci = parseYaml(readFileSync(join(WORKFLOWS, "ci.yml"), "utf8")) as Wf;
const CONTRACT_ENV = runner.contractRun(GATE_TEXT).env;
const REQUIRED = JSON.parse(CONTRACT_ENV.REQUIRED!) as string[];
const PR_ONLY_GUARD = "github.event_name == 'pull_request'";

type Row = { name: string; status: string; conclusion: string | null };
const green = (names: readonly string[]): Row[] => names.map((name) => ({ name, status: "completed", conclusion: "success" }));

/** The real runner against a contract (the real one unless `contract` is given), with the shared gh
 *  shim answering every check-runs read with `runs` and a no-op sleep, so any wait is instant and a
 *  missing required check reaches the contract's own TIMED OUT refusal. */
function runGate(runs: Row[], args: string[], extraEnv: Record<string, string> = {}, contract?: string) {
  const page = JSON.stringify([{ check_runs: runs.map((r) => ({ ...r, started_at: "2026-10-05T00:00:00Z" })) }]);
  const shim = ghShim([{ when: "check-runs", stdout: page }], { kind: "w1t5515" });
  const bin = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5515-bin-`));
  writeFileSync(join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  const r = spawnSync(process.execPath, [RUNNER, ...args, ...(contract ? ["--contract", contract] : [])], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${shim.dir}:${bin}:${process.env.PATH}`,
      GH_TOKEN: "t",
      REPO: "o/r",
      SHA: "group-head",
      GRACE_WINDOW_SECONDS: "0",
      WAIT_CAP_SECONDS: "0",
      RETRY_BACKOFF_SECONDS: "0",
      ...extraEnv,
    },
  });
  return { status: r.status, out: r.stdout + r.stderr, calls: shim.calls().filter((c) => c.includes("check-runs")).length };
}

/** Every workflow that triggers on `merge_group`. */
function mergeGroupWorkflows(): Array<[string, Wf]> {
  return readdirSync(WORKFLOWS)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f): [string, Wf] => [f, parseYaml(readFileSync(join(WORKFLOWS, f), "utf8")) as Wf])
    .filter(([, wf]) => {
      const on = wf.on;
      if (typeof on === "string") return on === "merge_group";
      if (Array.isArray(on)) return on.includes("merge_group");
      return on !== null && typeof on === "object" && "merge_group" in on;
    });
}

/** The REQUIRED names a group commit really produces: a job in a `merge_group` workflow whose literal
 *  `name:` is in REQUIRED and whose job `if` is neither the PR-only guard nor `false`. */
function mergeGroupCensus(): string[] {
  const names = new Set<string>();
  for (const [, wf] of mergeGroupWorkflows()) {
    for (const job of Object.values(wf.jobs ?? {})) {
      if (typeof job.name !== "string" || !REQUIRED.includes(job.name)) continue;
      if (job.if === false || job.if === PR_ONLY_GUARD) continue;
      names.add(job.name);
    }
  }
  return [...names].sort();
}

/** A copy of the real contract with MERGE_GROUP_REQUIRED replaced (or removed when `value` is undefined). */
function contractWith(value: string | undefined): string {
  const doc = parseYaml(GATE_TEXT) as { jobs: Record<string, { env: Record<string, unknown> }> };
  const env = doc.jobs["ci-gate"]!.env;
  if (value === undefined) delete env.MERGE_GROUP_REQUIRED;
  else env.MERGE_GROUP_REQUIRED = value;
  const path = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5515-contract-`)), "ci-gate.yml");
  writeFileSync(path, stringifyYaml(doc));
  return path;
}

test("W1-T5515: a merge group commit is gated on exactly ci, coverage-ratchet and test-slow", () => {
  // The job runs on the group commit, and keeps both load-bearing arms: always() aggregates a FAILED
  // need (a skipped required check counts as passing), !cancelled() releases a superseded run.
  const job = ci.jobs!["ci-gate"]!;
  assert.ok(ci.on !== null && typeof ci.on === "object" && "merge_group" in ci.on);
  assert.equal(job.if, "${{ always() && !cancelled() && (github.event_name == 'pull_request' || github.event_name == 'merge_group') }}");
  // github.event.pull_request.head.sha is EMPTY on merge_group; github.sha is the group head commit.
  assert.equal(job.env!.SHA, "${{ github.event.pull_request.head.sha || github.sha }}");
  assert.match(job.steps!.map((s) => s.run ?? "").join("\n"), /node scripts\/ci-gate-from-contract\.mjs --event "\$\{\{ github\.event_name \}\}"/);

  // The contract's merge-group list is exactly the census of what a group commit produces.
  const mergeGroupRequired = JSON.parse(CONTRACT_ENV.MERGE_GROUP_REQUIRED!) as string[];
  assert.deepEqual([...mergeGroupRequired].sort(), mergeGroupCensus());
  assert.deepEqual([...mergeGroupRequired].sort(), ["ci", "coverage-ratchet", "test-slow"]);
  assert.ok(mergeGroupRequired.length >= 3);
  // ...and it is a strict subset: the census found real PR-only names it leaves out.
  assert.ok(REQUIRED.length > mergeGroupRequired.length);
  for (const name of ["claims", "acceptance-author-gate", "scan-pr / osv-scan", "License Review"]) {
    assert.ok(REQUIRED.includes(name) && !mergeGroupRequired.includes(name), name);
  }

  // The real runner with --event merge_group: the three green, every pull_request-only gate ABSENT,
  // one read and a pass. An ambient REQUIRED or MERGE_GROUP_REQUIRED cannot widen or narrow it.
  const pass = runGate(green(mergeGroupRequired), ["--event", "merge_group"]);
  assert.equal(pass.status, 0, pass.out);
  assert.equal(pass.calls, 1, "a finished group commit is evaluated by a single read");
  const ambient = runGate(green(mergeGroupRequired), ["--event", "merge_group"], {
    REQUIRED: JSON.stringify(REQUIRED),
    MERGE_GROUP_REQUIRED: JSON.stringify(["ci"]),
  });
  assert.equal(ambient.status, 0, ambient.out);
  const ambientRed = runGate(
    green(mergeGroupRequired).map((r) => (r.name === "test-slow" ? { ...r, conclusion: "failure" } : r)),
    ["--event", "merge_group"],
    { MERGE_GROUP_REQUIRED: JSON.stringify(["ci"]) },
  );
  assert.notEqual(ambientRed.status, 0, "an ambient MERGE_GROUP_REQUIRED must not drop test-slow");
  assert.match(ambientRed.out, /test-slow/);
});

test("W1-T5515: a red ci on the group commit fails the gate", () => {
  const names = JSON.parse(CONTRACT_ENV.MERGE_GROUP_REQUIRED!) as string[];
  for (const failing of names) {
    for (const conclusion of ["failure", "cancelled"]) {
      const runs = green(names).map((r) => (r.name === failing ? { ...r, conclusion } : r));
      const r = runGate(runs, ["--event", "merge_group"]);
      assert.notEqual(r.status, 0, `${failing}=${conclusion} must fail the group gate`);
      assert.match(r.out, /required check\(s\) FAILED/);
      assert.ok(r.out.includes(`  - ${failing}`), `the refusal names ${failing}: ${r.out}`);
    }
    // A required check that never registered times out; it is never read as a pass.
    const missing = runGate(green(names.filter((n) => n !== failing)), ["--event", "merge_group"]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.out, /TIMED OUT/);
    assert.ok(missing.out.includes(`  - ${failing}`), missing.out);
  }
});

test("W1-T5515: a missing or empty merge-group list fails closed", () => {
  const cases: Array<[string, string | undefined, RegExp]> = [
    ["absent", undefined, /declares no MERGE_GROUP_REQUIRED/],
    ["unparsable", "not json", /MERGE_GROUP_REQUIRED is not valid JSON/],
    ["not an array", '{"ci": true}', /MERGE_GROUP_REQUIRED is not a JSON array of strings/],
    ["not strings", "[1, 2]", /MERGE_GROUP_REQUIRED is not a JSON array of strings/],
    ["empty", "[]", /MERGE_GROUP_REQUIRED is EMPTY/],
    ["outside REQUIRED", '["ci", "not-a-required-check"]', /names check\(s\) outside REQUIRED: not-a-required-check/],
  ];
  for (const [label, value, error] of cases) {
    const contract = contractWith(value);
    // Even with every required check green, a bad list is refused before any check-runs read.
    const r = runGate(green(REQUIRED), ["--event", "merge_group"], {}, contract);
    assert.notEqual(r.status, 0, `${label}: ${r.out}`);
    assert.equal(r.status, 1, label);
    assert.match(r.out, error, label);
    assert.match(r.out, /::error::ci-gate-from-contract: refusing the merge_group gate/, label);
    assert.equal(r.calls, 0, `${label}: refused before reading check-runs`);
    // In process: the refusal returns non-zero and never spawns the aggregation step.
    let spawned = 0;
    const code = runner.main(["--event", "merge_group", "--contract", contract], {
      run: () => {
        spawned += 1;
        return { status: 0 };
      },
    });
    assert.equal(code, 1, label);
    assert.equal(spawned, 0, label);
  }
  // A contract whose REQUIRED itself is unreadable cannot vouch for the subset either.
  const badRequired = (() => {
    const doc = parseYaml(GATE_TEXT) as { jobs: Record<string, { env: Record<string, unknown> }> };
    doc.jobs["ci-gate"]!.env.REQUIRED = "not json";
    const path = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5515-contract-`)), "ci-gate.yml");
    writeFileSync(path, stringifyYaml(doc));
    return path;
  })();
  const bad = runGate(green(REQUIRED), ["--event", "merge_group"], {}, badRequired);
  assert.equal(bad.status, 1, bad.out);
  assert.match(bad.out, /: REQUIRED is not valid JSON/);
  assert.equal(bad.calls, 0);
  // The control: the same rewrite with a VALID list runs the gate normally.
  const control = runGate(green(["ci", "coverage-ratchet", "test-slow"]), ["--event", "merge_group"], {}, contractWith('["ci", "coverage-ratchet", "test-slow"]'));
  assert.equal(control.status, 0, control.out);
  assert.equal(control.calls, 1);
});

test("W1-T5515: the pull_request gate keeps the full REQUIRED list", () => {
  const subset = JSON.parse(CONTRACT_ENV.MERGE_GROUP_REQUIRED!) as string[];
  const modes: Array<[string, string[], Record<string, string>]> = [
    ["--event pull_request", ["--event", "pull_request"], {}],
    ["no --event", [], {}],
    ["ambient GITHUB_EVENT_NAME=merge_group, no flag", [], { GITHUB_EVENT_NAME: "merge_group" }],
  ];
  for (const [label, args, env] of modes) {
    const pass = runGate(green(REQUIRED), args, env);
    assert.equal(pass.status, 0, `${label}: ${pass.out}`);
    assert.equal(pass.calls, 1, label);
    // A lone claims failure still fails the gate and is named.
    const red = runGate(green(REQUIRED).map((r) => (r.name === "claims" ? { ...r, conclusion: "failure" } : r)), args, env);
    assert.notEqual(red.status, 0, label);
    assert.ok(red.out.includes("  - claims"), `${label}: ${red.out}`);
    // Only the merge-group subset present: the full list is still waited on, so it times out.
    const subsetOnly = runGate(green(subset), args, env);
    assert.notEqual(subsetOnly.status, 0, label);
    assert.match(subsetOnly.out, /TIMED OUT/, label);
    assert.ok(subsetOnly.out.includes("  - claims"), label);
  }
  // Without the flag a malformed merge-group list is never consulted: behaviour is unchanged.
  const untouched = runGate(green(REQUIRED), [], {}, contractWith("[]"));
  assert.equal(untouched.status, 0, untouched.out);
});
