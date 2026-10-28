/**
 * W1-T5892 — THE LIVE COVERAGE FLIP REQUIRES A FRESH NIGHTLY FLOOR.
 *
 * A narrowed pull request reads its absolute coverage floor from another run's full-suite lcov.
 * One workflow admission publishes a verified floor before tests. All consumers read that pin.
 * Without a fresh, successful, complete, compatible floor the global decision is full.
 *
 * The helper runs for real, as a subprocess, over real local artifacts; GitHub transport is the
 * shared gh shim. The workflow controls execute the real step bodies from ci.yml and
 * coverage-nightly.yml.
 */
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { parse as parseYaml } from "yaml";

import {
  agreeOnFloor, buildProvenance, consumeFloor, main, MAX_AGE_HOURS, nodeMajor, policyDigest, PRODUCERS, selectFloor, sha256, verifyPin,
  // @ts-expect-error -- plain .mjs script, no type declarations
} from "#scripts/coverage-floor.mjs";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim as makeGhShim, type GhShimRoute } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const REPO = "craigoley/remudero";
const NOW = new Date("2026-10-28T12:00:00Z");
const HEAD = "a".repeat(40);
const LCOV = "TN:\nSF:src/a.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\nSF:src/b.ts\nDA:1,0\nLF:1\nLH:0\nend_of_record\n";
const ALL_GREEN = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i + 1, 0]));
const CONSUMER = { repository: REPO, nodeMajor: nodeMajor(), policyDigest: policyDigest(REPO_ROOT) };

const owned: string[] = [];
after(() => { for (const path of owned) rmSync(path, { recursive: true, force: true }); });
const tmp = (kind: string) => {
  const path = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5892-${kind}-`));
  owned.push(path);
  return path;
};
const ghShim: typeof makeGhShim = (...args) => {
  const shim = makeGhShim(...args);
  owned.push(shim.dir);
  return shim;
};

/** A nightly run listing row and the provenance its producer would have written. */
function nightly(overrides: { row?: Record<string, unknown>; provenance?: Record<string, unknown>; measuredAt?: Date } = {}) {
  const measuredAt = overrides.measuredAt ?? new Date(NOW.getTime() - 2 * 3_600_000);
  const row = { attempt: 1, conclusion: "success", createdAt: new Date(measuredAt.getTime() - 45 * 60_000).toISOString(),
    databaseId: 111, event: "schedule", headBranch: "main", headSha: HEAD,
    updatedAt: new Date(Math.min(measuredAt.getTime() + 60_000, NOW.getTime())).toISOString(), ...overrides.row };
  const provenance = {
    ...buildProvenance({ producer: "coverage-nightly", lcov: Buffer.from(LCOV), shardExits: ALL_GREEN, root: REPO_ROOT, now: measuredAt,
      env: { GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: "111", GITHUB_RUN_ATTEMPT: "1", GITHUB_EVENT_NAME: "schedule",
        GITHUB_REF: "refs/heads/main", GITHUB_SHA: HEAD } }),
    ...overrides.provenance,
  };
  return { row, provenance };
}

/** gh routes answering the nightly listing with `row` and its download with `files` (null = download fails). */
function routes(pinDir: string, row: Record<string, unknown>, files: Record<string, string | Uint8Array> | null): GhShimRoute[] {
  const dir = join(pinDir, ".candidates", `coverage-nightly-${row.databaseId}`);
  return [
    { when: "run list --workflow coverage-nightly.yml", stdout: JSON.stringify([row]) },
    { when: "run list --workflow ci.yml", stdout: "[]" },
    files === null
      ? { when: `run download ${row.databaseId}`, stderr: "no valid artifacts found to download", exit: 1 }
      : { when: `run download ${row.databaseId}`, writes: Object.entries(files).map(([name, content]) => ({ path: join(dir, name), content })) },
  ];
}

/** Runs the real selector against the gh shim; returns the pin and the shim's recorded calls. */
function select(row: Record<string, unknown>, files: Record<string, string | Uint8Array> | null, consumer = CONSUMER, now = NOW) {
  const pinDir = join(tmp("pin"), "coverage-floor-pin");
  const gh = ghShim(routes(pinDir, row, files), { kind: "w1t5892-gh" });
  const run = (cmd: string, args: readonly string[], opts: SpawnSyncOptions) =>
    spawnSync(cmd, args, { ...opts, env: { ...process.env, PATH: `${gh.dir}:${process.env.PATH}` } });
  const pin = selectFloor({ pinDir, consumer, now, run: run as typeof spawnSync, log: () => {} });
  return { pin, pinDir, calls: gh.calls() };
}

const artifact = (provenance: unknown, lcov: string | Uint8Array = LCOV) =>
  ({ "lcov.info": lcov, "provenance.json": typeof provenance === "string" ? provenance : JSON.stringify(provenance) });

test("W1-T5892: a fresh successful complete nightly is pinned once and verifies by digest", () => {
  const { row, provenance } = nightly();
  const { pin, pinDir, calls } = select(row, artifact(provenance));
  assert.equal(pin.decision, "narrow", pin.reason);
  assert.deepEqual(pin.floor, { artifact: "coverage-nightly", run_id: 111, run_attempt: 1, head_sha: HEAD,
    measured_at: provenance.created_at, lcov_sha256: sha256(Buffer.from(LCOV)) });
  assert.equal(verifyPin(pinDir, NOW), join(pinDir, "lcov.info"));
  assert.equal(readFileSync(join(pinDir, "lcov.info"), "utf8"), LCOV);
  assert.equal(existsSync(join(pinDir, ".candidates")), false, "downloaded candidates never ride the published pin");
  assert.ok(calls.some((c) => c.includes(`run list --workflow coverage-nightly.yml --branch main --status success --created <=${NOW.toISOString()}`)),
    "only SUCCESSFUL runs created by the as-of time are listed: a completed red nightly uploads before its exit gate");
  assert.ok(calls.some((c) => /run list --workflow ci\.yml --event merge_group --status success/.test(c)));
  assert.equal(calls.filter((c) => c.startsWith("run download")).length, 1, "only listed candidates are downloaded");
});

test("W1-T5892: the admission snapshot excludes a floor that finished after its cutoff", () => {
  const late = nightly({ row: { updatedAt: new Date(NOW.getTime() + 60_000).toISOString() } });
  const { pin, calls } = select(late.row, artifact(late.provenance));
  assert.equal(pin.decision, "full");
  assert.match(pin.reason, /no successful coverage-nightly or merge-group run is listed/);
  assert.equal(calls.filter((c) => c.startsWith("run download")).length, 0, "a run still finishing at the as-of time is never read");
});

test("W1-T5892: failed, partial, expired, future, mismatched and unverifiable floors never authorize narrowing", () => {
  const cases: Array<[string, ReturnType<typeof nightly>, Record<string, string | Uint8Array> | null, RegExp]> = [];
  const add = (name: string, n: ReturnType<typeof nightly>, files: Record<string, string | Uint8Array> | null | undefined, why: RegExp) =>
    cases.push([name, n, files === undefined ? artifact(n.provenance) : files, why]);
  add("completed red run", nightly({ row: { conclusion: "failure" } }), undefined, /concluded failure, not success/);
  add("red shard uploaded before its exit gate", nightly({ provenance: { shard_test_exits: { ...ALL_GREEN, 3: 1 } } }), undefined, /shard\(s\) 3 exited non-zero/);
  add("partial shard record", nightly({ provenance: { shard_test_exits: { ...ALL_GREEN, 8: undefined } } }), undefined, /7 of 8 shard exits \(partial\)/);
  add("missing artifact", nightly(), null, /cannot download coverage-nightly/);
  add("legacy artifact without provenance", nightly(), { "lcov.info": LCOV }, /no provenance \(legacy or unverifiable\)/);
  add("malformed provenance", nightly(), artifact("{not json"), /provenance is malformed/);
  add("empty lcov", nightly(), artifact(nightly().provenance, ""), /lcov is missing or empty/);
  const truncated = LCOV.slice(0, LCOV.lastIndexOf("end_of_record"));
  add("incomplete lcov", nightly({ provenance: { lcov_sha256: sha256(Buffer.from(truncated)) } }), undefined, /lcov is incomplete/);
  cases[cases.length - 1]![2] = artifact(cases[cases.length - 1]![1].provenance, truncated);
  add("digest disagreement", nightly(), artifact(nightly().provenance, LCOV.replace("DA:1,1", "DA:1,9")), /lcov digest differs/);
  add("head disagreement", nightly({ row: { headSha: "b".repeat(40) } }), undefined, /is not the run's head/);
  add("attempt disagreement", nightly({ row: { attempt: 2 } }), undefined, /attempt 1 is not attempt 2/);
  add("run disagreement", nightly({ provenance: { run_id: 999 } }), undefined, /run 999 is not run 111/);
  add("repository disagreement", nightly({ provenance: { repository: "someone/fork" } }), undefined, /measured in someone\/fork/);
  add("untrusted event", nightly({ row: { event: "push" } }), undefined, /event push is not a trusted/);
  add("untrusted ref", nightly({ provenance: { ref: "refs/heads/feature" } }), undefined, /not a trusted ref/);
  add("Node 22 floor for a Node 24 consumer", nightly({ provenance: { node_major: CONSUMER.nodeMajor - 2 } }), undefined, /measured on Node \d+, consumer runs Node/);
  add("different lockfile or loader policy", nightly({ provenance: { policy_digest: "0".repeat(64) } }), undefined, /coverage policy .* differs/);
  add("expired", nightly({ measuredAt: new Date(NOW.getTime() - (MAX_AGE_HOURS * 3_600_000 + 1000)) }), undefined, /older than 24h/);
  add("future-dated", nightly({ measuredAt: new Date(NOW.getTime() + 10 * 60_000), row: { updatedAt: NOW.toISOString() } }), undefined, /in the future/);
  for (const [name, n, files, why] of cases) {
    const { pin, pinDir } = select(n.row, files);
    assert.equal(pin.decision, "full", `${name}: ${pin.reason}`);
    assert.match(pin.reason, why, name);
    assert.equal(existsSync(join(pinDir, "lcov.info")), false, `${name}: no floor lcov is pinned`);
    assert.throws(() => verifyPin(pinDir), /decided full/, `${name}: the aggregator cannot read a floor from a full pin`);
  }
});

test("W1-T5892: the 24-hour bound is inclusive and future measurements refuse", () => {
  const at = (ms: number) => {
    const n = nightly({ measuredAt: new Date(NOW.getTime() - ms), row: { updatedAt: NOW.toISOString() } });
    return select(n.row, artifact(n.provenance)).pin.decision;
  };
  assert.equal(at(MAX_AGE_HOURS * 3_600_000), "narrow", "exactly 24 hours old still verifies");
  assert.equal(at(MAX_AGE_HOURS * 3_600_000 + 1), "full", "one millisecond past the bound refuses");
  assert.equal(at(0), "narrow", "a measurement exactly at the execution clock verifies");
  assert.equal(at(-1), "full", "a measurement one millisecond in the future refuses");
  assert.equal(at(-4 * 60_000), "full", "clock skew cannot admit a future measurement");
});

test("W1-T5892: empty shells and malformed coverage fields never authorize narrowing", () => {
  const invalid = [
    "SF:src/a.ts\nend_of_record\n",
    "SF:src/a.ts\nLF:0\nLH:0\nend_of_record\n",
    LCOV.replace("DA:1,1", "DA:bogus,1"),
    LCOV.replace("DA:1,1", "DA:1,NaN"),
    LCOV.replace("DA:1,1", "DA:1,-1"),
    LCOV.replace("DA:1,1", "DA:1,9007199254740992"),
    LCOV.replace("LF:1", "LF:2"),
    LCOV.replace("LH:1", "LH:0"),
    LCOV.replace("LF:1\n", ""),
    LCOV.replace("DA:1,1", "DA:1,1\nDA:1,1"),
    LCOV.replace("end_of_record\nSF:", "SF:"),
    LCOV.replace("src/a.ts", "../outside.ts"),
    LCOV.replace("DA:1,1", "BRDA:1,0,0,1\nBRF:1\nBRH:0\nDA:1,1"),
  ];
  for (const lcov of invalid) {
    const n = nightly({ provenance: { lcov_sha256: sha256(Buffer.from(lcov)), lcov_sources: 2 } });
    const result = select(n.row, artifact(n.provenance, lcov));
    assert.equal(result.pin.decision, "full", lcov);
    assert.match(result.pin.reason, /lcov is incomplete/);
  }
  const lcov = LCOV.replace("DA:1,1", "BRDA:1,0,0,1\nBRF:1\nBRH:1\nDA:1,1");
  const n = nightly({ provenance: { lcov_sha256: sha256(Buffer.from(lcov)) } });
  assert.equal(select(n.row, artifact(n.provenance, lcov)).pin.decision, "narrow", "valid branch measurements remain usable");
});

test("W1-T5892: an old event cannot make a 49-hour-old floor fresh at execution", () => {
  const execution = new Date();
  const measuredAt = new Date(execution.getTime() - 49 * 3_600_000);
  const cutoff = new Date(execution.getTime() - 48 * 3_600_000);
  const n = nightly({ measuredAt, row: { updatedAt: measuredAt.toISOString() } });
  const pinDir = join(tmp("old-event"), "pin");
  const shim = ghShim(routes(pinDir, n.row, artifact(n.provenance)));
  const decision = join(dirname(pinDir), "decision");
  const result = spawnSync(process.execPath, [join(REPO_ROOT, "scripts/coverage-floor.mjs"), "select", pinDir,
    "--as-of", cutoff.toISOString(), "--decision-file", decision], {
    encoding: "utf8", env: { ...process.env, PATH: `${shim.dir}:${process.env.PATH}`, GITHUB_REPOSITORY: REPO },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(decision, "utf8"), "full\n");
  assert.match(result.stdout, /older than 24h/);
  assert.equal(shim.calls().filter((call) => call.startsWith("run download")).length, 1, "the old candidate was actually read");
});

test("W1-T5892: Node 22 and Node 24 measurements are separate compatible populations", () => {
  for (const producerNode of [22, 24]) {
    const n = nightly({ provenance: { node_major: producerNode } });
    for (const consumerNode of [22, 24]) {
      const result = select(n.row, artifact(n.provenance), { ...CONSUMER, nodeMajor: consumerNode });
      assert.equal(result.pin.decision, producerNode === consumerNode ? "narrow" : "full");
      if (producerNode !== consumerNode) assert.match(result.pin.reason, /measured on Node .* consumer runs Node/);
    }
  }
});

test("W1-T5892: a newer merge-group floor is preferred, and a refused newest falls to the next producer", () => {
  const pinDir = join(tmp("pin"), "coverage-floor-pin");
  const n = nightly();
  const mergedAt = new Date(NOW.getTime() - 30 * 60_000);
  const mergedRow = { attempt: 1, conclusion: "success", createdAt: new Date(mergedAt.getTime() - 60_000).toISOString(),
    databaseId: 222, event: "merge_group", headBranch: "gh-readonly-queue/main/pr-1-x", headSha: "c".repeat(40),
    updatedAt: mergedAt.toISOString() };
  const merged = buildProvenance({ producer: "coverage-merged", lcov: Buffer.from(LCOV), shardExits: ALL_GREEN, root: REPO_ROOT, now: mergedAt,
    env: { GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: "222", GITHUB_RUN_ATTEMPT: "1", GITHUB_EVENT_NAME: "merge_group",
      GITHUB_REF: "refs/heads/gh-readonly-queue/main/pr-1-x", GITHUB_SHA: "c".repeat(40) } });
  const mergedDir = join(pinDir, ".candidates", "coverage-merged-222");
  const run = (shim: ReturnType<typeof ghShim>) => (cmd: string, args: readonly string[], opts: SpawnSyncOptions) =>
    spawnSync(cmd, args, { ...opts, env: { ...process.env, PATH: `${shim.dir}:${process.env.PATH}` } });
  const mergedRoute = (provenance: unknown): GhShimRoute => ({ when: "run download 222", writes: [
    { path: join(mergedDir, "lcov.info"), content: LCOV }, { path: join(mergedDir, "provenance.json"), content: JSON.stringify(provenance) }] });
  const base = routes(pinDir, n.row, artifact(n.provenance));
  const listed = (extra: GhShimRoute[]) => ghShim([...extra, { when: "run list --workflow ci.yml", stdout: JSON.stringify([mergedRow]) }, ...base]);

  const newer = selectFloor({ pinDir, consumer: CONSUMER, now: NOW, run: run(listed([mergedRoute(merged)])) as typeof spawnSync, log: () => {} });
  assert.equal(newer.decision, "narrow", newer.reason);
  assert.equal(newer.floor?.run_id, 222, "the newer verified merge-group floor wins");

  const shim = listed([mergedRoute({ ...merged, head_sha: "d".repeat(40) })]);
  const fallback = selectFloor({ pinDir, consumer: CONSUMER, now: NOW, run: run(shim) as typeof spawnSync, log: () => {} });
  assert.equal(fallback.decision, "narrow", fallback.reason);
  assert.equal(fallback.floor?.run_id, 111, "a refused newest candidate falls to the verified nightly");
  assert.match(JSON.stringify(fallback.refused), /coverage-merged.*222.*is not the run's head/, "the refusal is left as evidence");
});

test("W1-T5892: the CLI writes the decision for the shard and refuses an altered pin", () => {
  const pinDir = join(tmp("cli"), "coverage-floor-pin");
  const { row, provenance } = nightly({ measuredAt: new Date(Date.now() - 3_600_000),
    row: { updatedAt: new Date(Date.now() - 3_000_000).toISOString() } });
  const gh = ghShim(routes(pinDir, row, artifact(provenance)), { kind: "w1t5892-cli-gh" });
  const out = join(dirname(pinDir), "decision");
  const env = { ...process.env, PATH: `${gh.dir}:${process.env.PATH}`, GITHUB_REPOSITORY: REPO };
  const cli = (...args: string[]) => spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "coverage-floor.mjs"), ...args], { encoding: "utf8", env });
  const selected = cli("select", pinDir, "--as-of", new Date().toISOString(), "--decision-file", out);
  assert.equal(selected.status, 0, selected.stderr);
  assert.equal(readFileSync(out, "utf8"), "narrow\n");
  assert.match(selected.stdout, /coverage-floor: narrow — pinned coverage-nightly run 111/);
  const badTime = cli("select", pinDir, "--as-of", "not-a-time");
  assert.equal(badTime.status, 1);
  assert.match(badTime.stderr, /--as-of not-a-time is not a time/);
  const verified = cli("verify", pinDir);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verified.stdout.trim(), join(pinDir, "lcov.info"));
  writeFileSync(join(pinDir, "lcov.info"), LCOV + "SF:src/c.ts\nend_of_record\n");
  const altered = cli("verify", pinDir);
  assert.equal(altered.status, 1);
  assert.match(altered.stderr, /differs from its pinned digest/);
  rmSync(pinDir, { recursive: true, force: true });
  const missing = cli("verify", pinDir);
  assert.equal(missing.status, 1, "a pin that later becomes unreadable still refuses");
  assert.match(missing.stderr, /no pinned floor/);
});

test("W1-T5892: a producer records its own run, runtime, policy and shard exits", () => {
  const dir = tmp("producer");
  writeFileSync(join(dir, "lcov.info"), LCOV);
  for (let n = 1; n <= 8; n++) {
    mkdirSync(join(dir, "coverage-shards", `coverage-shard-${n}`), { recursive: true });
    writeFileSync(join(dir, "coverage-shards", `coverage-shard-${n}`, "test-exit"), n === 5 ? "1\n" : "0\n");
  }
  const env = { ...process.env, GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: "333", GITHUB_RUN_ATTEMPT: "2", GITHUB_EVENT_NAME: "schedule",
    GITHUB_REF: "refs/heads/main", GITHUB_SHA: HEAD };
  const r = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "coverage-floor.mjs"), "provenance", "--producer", "coverage-nightly",
    "--lcov", join(dir, "lcov.info"), "--shards-dir", join(dir, "coverage-shards"), "--out", join(dir, "provenance.json")], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const p = JSON.parse(readFileSync(join(dir, "provenance.json"), "utf8"));
  assert.equal(p.repository, REPO);
  assert.equal(p.run_id, 333);
  assert.equal(p.run_attempt, 2);
  assert.equal(p.head_sha, HEAD);
  assert.equal(p.node_major, nodeMajor());
  assert.equal(p.policy_digest, policyDigest(REPO_ROOT));
  assert.equal(p.lcov_sha256, sha256(Buffer.from(LCOV)));
  assert.equal(p.lcov_sources, 2);
  assert.deepEqual(p.shard_test_exits, { ...ALL_GREEN, 5: 1 }, "a red shard is recorded, never hidden");
  assert.deepEqual(PRODUCERS.map((x: { artifact: string }) => x.artifact), ["coverage-nightly", "coverage-merged"]);
});

// ── the real workflow bodies ────────────────────────────────────────────────────────────────

type Step = { name?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown>; uses?: string; id?: string };
const workflow = (file: string) => parseYaml(readFileSync(join(REPO_ROOT, ".github", "workflows", file), "utf8")) as
  { jobs: Record<string, { outputs?: Record<string, string>; needs?: string[]; steps: Step[] }> };
const CI = workflow("ci.yml");
const NIGHTLY = workflow("coverage-nightly.yml");
const step = (doc: typeof CI, job: string, prefix: string) => {
  const found = doc.jobs[job]?.steps.find((s) => s.name?.startsWith(prefix));
  assert.ok(found, `${job} carries a step starting ${prefix}`);
  return found!;
};

/** A scratch checkout carrying the helper and the policy files it digests, so a real step runs off the tracked tree. */
function checkout(): string {
  const dir = tmp("step");
  for (const f of ["scripts/coverage-floor.mjs", "scripts/lib/argv.mjs", "scripts/lib/repo-root.mjs", "scripts/coverage-merge-ratchet.mjs",
    ".nvmrc", "package-lock.json", "package.json", "test/setup/tmp-hygiene.ts",
    "scripts/lib/lcov.mjs", "scripts/lib/coverage-chunk-codec.mjs"]) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    cpSync(join(REPO_ROOT, f), join(dir, f));
  }
  return dir;
}

/** Runs a step body under bash with the gh shim and a `node` that records every call, runs the real
 *  node for the floor helper and inline `-e` reads, and answers the selector, manifest, runner and ratchet. */
function runStep(body: string, env: Record<string, string>, ghRoutes: GhShimRoute[] = [], cwd = checkout()) {
  const gh = ghShim(ghRoutes, { kind: "w1t5892-step-gh" });
  const bin = join(cwd, ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "node"), `#!/usr/bin/env bash
echo "node $*" >> "$CALL_LOG"
case "$*" in
  scripts/coverage-floor.mjs*|"-e "*) exec ${JSON.stringify(process.execPath)} "$@" ;;
  *--import\\ tsx\\ -e*) for last; do :; done; printf 'test/n0.test.ts\\n' > "$last" ;;
  *--select-candidates*) head -n 1 "$3" ;;
  *--select-all*) echo "test/all.test.ts" ;;
  *test-with-retry.mjs*) mkdir -p coverage/raw; echo "SF:src/a.ts" > coverage/lcov.info; echo "{}" > coverage/raw/coverage-1.json; echo "# tests 1" ;;
  *) echo "# tests 1" ;;
esac
`);
  writeFileSync(join(bin, "git"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(bin, "node"), 0o755);
  chmodSync(join(bin, "git"), 0o755);
  writeFileSync(join(cwd, "changed-files.txt"), "src/a.ts\n");
  writeFileSync(join(cwd, "run.sh"), body);
  const r = spawnSync("bash", ["--noprofile", "--norc", "-e", join(cwd, "run.sh")], {
    cwd, encoding: "utf8",
    env: { PATH: `${bin}:${gh.dir}:${process.env.PATH}`, HOME: process.env.HOME ?? cwd, GITHUB_STEP_SUMMARY: join(cwd, "summary.md"),
      GITHUB_OUTPUT: join(cwd, "outputs.txt"), RUNNER_TEMP: cwd, CALL_LOG: join(cwd, "calls.log"), GITHUB_REPOSITORY: REPO, ...env },
  });
  const read = (f: string) => (existsSync(join(cwd, f)) ? readFileSync(join(cwd, f), "utf8") : "");
  return { status: r.status, out: r.stdout + r.stderr, calls: read("calls.log") + gh.calls().map((c) => `gh ${c}\n`).join(""), read, cwd };
}

test("W1-T5892: coverage-ledger stays the dependency-free choice it was, and pins no floor", () => {
  assert.equal(CI.jobs["coverage-ledger"]!.outputs?.floor_decision, undefined);
  assert.doesNotMatch(JSON.stringify(CI.jobs["coverage-ledger"]), /coverage-floor/);
});

const shardBody = step(CI, "coverage-ratchet", "Test with coverage").run!
  .replaceAll("${{ matrix.shard }}", "1").replaceAll("${{ steps.classify.outputs.class }}", "SOURCE");
const aggregateBody = step(CI, "coverage-ratchet-required", "Coverage ratchet").run!
  .replaceAll("${{ steps.coverage-artifact.outputs.class }}", "SOURCE");
const live = { GITHUB_EVENT_NAME: "pull_request", RMD_AFFECTED_SUITE_LIVE: "1", GITHUB_RUN_ID: "999" };
const output = (text: string, key: string) => text.split("\n").filter((line) => line.startsWith(`${key}=`)).at(-1)?.slice(key.length + 1) ?? "";

/** Execute admission and final publication. Only GitHub transport is synthetic. */
function admit(n = nightly({ measuredAt: new Date(Date.now() - 3_600_000),
  row: { updatedAt: new Date(Date.now() - 3_000_000).toISOString() } }), files = artifact(n.provenance), published = "success") {
  const cwd = checkout();
  const selected = runStep(step(CI, "coverage-floor-admission", "Select one coverage floor").run!, live,
    routes(join(cwd, "coverage-floor-pin"), n.row, files), cwd);
  assert.equal(selected.status, 0, selected.out);
  const selectedOutputs = selected.read("outputs.txt");
  const decision = output(selectedOutputs, "decision"), reason = output(selectedOutputs, "reason");
  const finished = runStep(step(CI, "coverage-floor-admission", "Finalize the global floor decision").run!,
    { DECISION: decision, REASON: reason, PUBLISHED: published });
  assert.equal(finished.status, 0, finished.out);
  const env = { ...live, FLOOR_DECISION: output(finished.read("outputs.txt"), "decision"),
    FLOOR_REASON: output(finished.read("outputs.txt"), "reason"), FLOOR_ARTIFACT: "coverage-floor-pin-1",
    FLOOR_PIN_DIGEST: output(selectedOutputs, "pin_digest") };
  const pin = selected.read("coverage-floor-pin/pin.json");
  const transport: GhShimRoute[] = [{ when: "run download 999 -n coverage-floor-pin-1", writes: [
    { path: "coverage-floor-pin/pin.json", content: pin },
    { path: "coverage-floor-pin/lcov.info", content: selected.read("coverage-floor-pin/lcov.info") }] },
    { when: "run list", stderr: "consumer must never list candidates", exit: 1 }];
  return { selected, env, pin, transport };
}

const seedShards = (pin: string, split = 0) => Array.from({ length: 8 }, (_, i) => {
  const dir = `coverage-shards/coverage-shard-${i + 1}`;
  return `mkdir -p ${dir}\necho narrow > ${dir}/selection\ncat > ${dir}/floor-pin.json <<'PIN'\n${i + 1 === split ? pin.replace('"run_id": 111', '"run_id": 112') : pin}PIN\n`;
}).join("\n");

test("W1-T5892: one admission precedes all shards and every consumer uses its published pin", () => {
  assert.equal(CI.jobs["coverage-floor-admission"]!.outputs?.decision, "${{ steps.finish.outputs.decision }}");
  for (const job of ["coverage-ratchet", "coverage-ratchet-required"]) {
    assert.ok(CI.jobs[job]!.needs?.includes("coverage-floor-admission"), `${job} must wait for admission`);
    const consumer = step(CI, job, job === "coverage-ratchet" ? "Test with coverage" : "Coverage ratchet");
    for (const [key, field] of [["FLOOR_DECISION", "decision"], ["FLOOR_ARTIFACT", "artifact"], ["FLOOR_PIN_DIGEST", "pin_digest"]]) {
      assert.equal(consumer.env?.[key!], `\${{ needs.coverage-floor-admission.outputs.${field} }}`);
    }
  }
  const publish = step(CI, "coverage-floor-admission", "Publish the verified admission");
  assert.equal(publish.with?.name, "coverage-floor-pin-${{ github.run_attempt }}");
  assert.equal(publish.with?.path, "coverage-floor-pin");
  const a = admit();
  assert.equal(a.env.FLOOR_DECISION, "narrow", a.selected.out);
  assert.equal(a.selected.calls.match(/gh run list/g)?.length, 2);
  for (let n = 1; n <= 8; n++) {
    const shard = runStep(shardBody.replaceAll("--shard 1/8", `--shard ${n}/8`), a.env, a.transport);
    assert.equal(shard.status, 0, shard.out);
    assert.equal(shard.read("coverage-selection.txt"), "narrow\n");
    assert.equal(shard.read("coverage-floor-pin.json"), a.pin);
    assert.doesNotMatch(shard.calls, /gh run list|coverage-floor.mjs select/);
    assert.equal(existsSync(join(shard.cwd, "coverage-floor-pin")), false, "historical LCOV leaves before tests");
  }
  const aggregate = runStep(seedShards(a.pin) + aggregateBody, a.env, a.transport);
  assert.equal(aggregate.status, 0, aggregate.out);
  assert.match(aggregate.calls, /coverage-ratchet\.mjs --lcov coverage-floor-pin\/lcov\.info --baseline/);
  assert.doesNotMatch(aggregate.calls, /--lcov coverage\/lcov\.info|gh run list|run download 111/);
  for (const evidence of [/absolute floor \(historical baseline\)/, /Added-line coverage of this head/, /Full integration/]) {
    assert.match(aggregate.read("summary.md"), evidence);
  }
});

test("W1-T5892: refused admission and publication failure make every shard full with one named reason", () => {
  for (const a of [admit(nightly({ row: { conclusion: "failure" } })),
    admit(nightly({ measuredAt: new Date(Date.now() - 49 * 3_600_000) })),
    admit(nightly(), artifact("not json")), admit(undefined, undefined, "failure")]) {
    assert.equal(a.env.FLOOR_DECISION, "full", a.selected.out);
    assert.ok(a.env.FLOOR_REASON);
    for (let n = 1; n <= 8; n++) {
      const shard = runStep(shardBody.replaceAll("--shard 1/8", `--shard ${n}/8`), a.env);
      assert.equal(shard.status, 0, shard.out);
      assert.equal(shard.read("coverage-selection.txt"), "all\n");
      assert.match(shard.calls, /--select-all/);
      assert.doesNotMatch(shard.calls, /coverage-floor|--select-candidates|gh /);
      assert.ok(shard.out.includes(a.env.FLOOR_REASON), shard.out);
    }
  }
  for (const env of [{ ...live, RMD_AFFECTED_SUITE_LIVE: "0" }, { ...live, GITHUB_EVENT_NAME: "merge_group" }]) {
    const owner = runStep(step(CI, "coverage-floor-admission", "Select one coverage floor").run!, env);
    assert.equal(owner.status, 0, owner.out);
    assert.doesNotMatch(owner.calls, /coverage-floor|gh /);
    const shard = runStep(shardBody, env);
    assert.equal(shard.status, 0, shard.out);
    assert.equal(shard.read("coverage-selection.txt"), "all\n");
    assert.doesNotMatch(shard.calls, /coverage-floor|--select-candidates|gh /);
  }
});

test("W1-T5892: the final merge group is full when live selection is enabled and flag-off stays unchanged", () => {
  const classify = CI.jobs["coverage-ratchet"]!.steps.find((s) => s.id === "classify")!;
  for (const flag of ["0", "1"]) {
    const r = runStep(classify.run!, { GITHUB_EVENT_NAME: "merge_group", RMD_AFFECTED_SUITE_LIVE: flag });
    assert.equal(r.status, 0, r.out);
    assert.equal(output(r.read("outputs.txt"), "class"), flag === "1" ? "SOURCE" : "NO_SRC");
  }
  const a = admit();
  const elapsed = new Date(Date.now() + 25 * 3_600_000);
  assert.throws(() => verifyPin(join(a.selected.cwd, "coverage-floor-pin"), elapsed), /24h freshness bound/);
});

test("W1-T5892: an admitted floor becoming unreadable or split refuses without replacement", () => {
  const a = admit();
  const broken: Array<[GhShimRoute[], RegExp]> = [
    [[{ when: "run download", stderr: "artifact vanished", exit: 1 }], /cannot download the pinned admission/],
    [[{ when: "run download", writes: [{ path: "coverage-floor-pin/pin.json", content: "{}" }] }], /admission pin differs/],
    [[{ when: "run download", writes: [{ path: "coverage-floor-pin/pin.json", content: a.pin }] }], /lcov is missing/],
    [[{ when: "run download", writes: [{ path: "coverage-floor-pin/pin.json", content: a.pin },
      { path: "coverage-floor-pin/lcov.info", content: LCOV + "corrupt" }] }], /lcov differs/],
  ];
  for (const [transport, why] of broken) {
    for (const body of [shardBody, seedShards(a.pin) + aggregateBody]) {
      const r = runStep(body, a.env, transport);
      assert.notEqual(r.status, 0, r.out);
      assert.match(r.out, why);
      assert.doesNotMatch(r.calls, /gh run list|--select-candidates|coverage-ratchet\.mjs/);
    }
  }
  const split = runStep(seedShards(a.pin, 5) + aggregateBody, a.env, a.transport);
  assert.notEqual(split.status, 0);
  assert.match(split.out, /shard 5 did not consume the workflow admission's pin/);
  assert.doesNotMatch(split.calls, /coverage-ratchet\.mjs/);
});

test("W1-T5892: both producers write provenance beside the lcov they upload", () => {
  const merged = step(CI, "coverage-ratchet-required", "Stage the merged lcov for the coverage-merged artifact");
  assert.equal(merged.env?.MATRIX_RESULT, "${{ needs.coverage-ratchet.result }}");
  const seed = `mkdir -p coverage && cat > coverage/lcov.info <<'LCOV'\n${LCOV}LCOV\n`;
  const queue = runStep(seed + merged.run!, { GITHUB_EVENT_NAME: "merge_group", MATRIX_RESULT: "success", GITHUB_RUN_ID: "222",
    GITHUB_RUN_ATTEMPT: "1", GITHUB_REF: "refs/heads/gh-readonly-queue/main/pr-1-x", GITHUB_SHA: HEAD });
  assert.equal(queue.status, 0, queue.out);
  const p = JSON.parse(queue.read("coverage-merged-artifact/provenance.json"));
  assert.equal(p.producer, "coverage-merged");
  assert.deepEqual(p.shard_test_exits, ALL_GREEN);
  assert.equal(p.lcov_sha256, sha256(Buffer.from(LCOV)));
  for (const env of [{ GITHUB_EVENT_NAME: "pull_request", MATRIX_RESULT: "success" }, { GITHUB_EVENT_NAME: "merge_group", MATRIX_RESULT: "failure" }]) {
    const none = runStep(seed + merged.run!, env);
    assert.equal(none.status, 0, none.out);
    assert.equal(none.read("coverage-merged-artifact/provenance.json"), "", `${JSON.stringify(env)} vouches for no floor`);
    assert.match(none.out, /coverage-floor: no provenance for coverage-merged/);
  }
  const push = runStep(merged.run!, { GITHUB_EVENT_NAME: "push", MATRIX_RESULT: "skipped" });
  assert.equal(push.status, 0, push.out);
  assert.equal(push.read("coverage-merged-artifact/skipped").trim(), "skipped", "a push still stages its skipped marker");
  assert.equal(push.read("coverage-merged-artifact/provenance.json"), "");

  const summary = step(NIGHTLY, "merge", "Write the ledgerable summary");
  const upload = step(NIGHTLY, "merge", "Upload the merged lcov and the summary");
  assert.match(String(upload.with?.path), /coverage-nightly-artifact\/provenance\.json/);
  const shards = Array.from({ length: 8 }, (_, i) =>
    `mkdir -p coverage-shards/coverage-shard-${i + 1} && echo ${i === 6 ? 1 : 0} > coverage-shards/coverage-shard-${i + 1}/test-exit`).join("\n");
  const night = runStep(`${seed}${shards}\n${summary.run!}`, { GITHUB_EVENT_NAME: "schedule", GITHUB_RUN_ID: "111", GITHUB_RUN_ATTEMPT: "1",
    GITHUB_REF: "refs/heads/main", GITHUB_SHA: HEAD });
  assert.equal(night.status, 0, night.out);
  const np = JSON.parse(night.read("coverage-nightly-artifact/provenance.json"));
  assert.equal(np.producer, "coverage-nightly");
  assert.equal(np.run_id, 111);
  assert.equal(np.shard_test_exits[7], 1, "the nightly records a red shard, so its floor can never be pinned");
});

// ── the helper's own entry points, in process ───────────────────────────────────────────────

/** A `run` that answers `gh` from `answer` (argv joined) and, for a download, writes `files` into its `-D` dir. */
function fakeRun(answer: (args: string) => { status: number; stdout?: string; stderr?: string; files?: Record<string, string> }) {
  return ((_cmd: string, args: readonly string[]) => {
    const a = answer(args.join(" "));
    const d = args.indexOf("-D");
    if (d !== -1 && a.files) for (const [name, content] of Object.entries(a.files)) {
      mkdirSync(args[d + 1]!, { recursive: true });
      writeFileSync(join(args[d + 1]!, name), content);
    }
    return { status: a.status, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  }) as unknown as typeof spawnSync;
}

test("W1-T5892: an unreadable or non-array run listing is refused by name, never narrowed on", () => {
  for (const [listing, why] of [[{ status: 1, stderr: "HTTP 502" }, /cannot list runs: HTTP 502/], [{ status: 0, stdout: "not json" }, /not a JSON array/],
    [{ status: 0, stdout: "{}" }, /not a JSON array/]] as const) {
    const pin = selectFloor({ pinDir: join(tmp("list"), "pin"), consumer: CONSUMER, now: NOW, run: fakeRun(() => listing), log: () => {} });
    assert.equal(pin.decision, "full");
    assert.equal(pin.refused.length, 2, "both producers are named");
    for (const r of pin.refused) assert.match(r.reason, why);
  }
});

test("W1-T5892: builtin consumers reject absent admission identities and missing shard receipts", () => {
  assert.throws(() => consumeFloor({ pinDir: tmp("bad"), runId: "bad" }), /no valid admission identity/);
  const a = admit();
  const dir = tmp("agree");
  writeFileSync(join(dir, "pin.json"), a.pin);
  writeFileSync(join(dir, "lcov.info"), LCOV);
  assert.throws(() => agreeOnFloor({ shardsDir: tmp("empty"), outDir: dir }), /no shard narrowed/);
  const shards = tmp("shards");
  mkdirSync(join(shards, "coverage-shard-2"));
  writeFileSync(join(shards, "coverage-shard-2", "selection"), "narrow\n");
  assert.throws(() => agreeOnFloor({ shardsDir: shards, outDir: dir }), /shard 2 did not consume/);
});

test("W1-T5892: the CLI stamps provenance only for a trusted green run, and select/agree/verify answer through gh", () => {
  const dir = tmp("cli-main");
  const lcov = join(dir, "lcov.info");
  writeFileSync(lcov, LCOV);
  const env = { GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: "222", GITHUB_RUN_ATTEMPT: "1", GITHUB_EVENT_NAME: "merge_group",
    GITHUB_REF: "refs/heads/gh-readonly-queue/main/pr-1-x", GITHUB_SHA: HEAD };
  const out = join(dir, "provenance.json");
  const logs: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  try {
    assert.equal(main(["provenance", "--producer", "coverage-merged", "--lcov", lcov, "--out", out, "--matrix-result", "success"], env), 0);
    assert.equal(JSON.parse(readFileSync(out, "utf8")).run_id, 222);
    const nightlyOut = join(dir, "nightly.json");
    const shardDir = join(dir, "shards");
    for (let n = 1; n <= 8; n++) { mkdirSync(join(shardDir, `coverage-shard-${n}`), { recursive: true }); writeFileSync(join(shardDir, `coverage-shard-${n}`, "test-exit"), "0\n"); }
    assert.equal(main(["provenance", "--producer", "coverage-nightly", "--lcov", lcov, "--out", nightlyOut, "--shards-dir", shardDir],
      { ...env, GITHUB_EVENT_NAME: "schedule", GITHUB_REF: "refs/heads/main" }), 0);
    assert.deepEqual(JSON.parse(readFileSync(nightlyOut, "utf8")).shard_test_exits, ALL_GREEN);
    for (const [argv, e, why] of [
      [["--matrix-result", "failure"], env, /the coverage shards concluded failure/],
      [["--matrix-result", "success"], { ...env, GITHUB_EVENT_NAME: "pull_request" }, /a pull_request run is not a coverage-merged producer/],
    ] as const) {
      const skipped = join(dir, `skip-${logs.length}.json`);
      assert.equal(main(["provenance", "--producer", "coverage-merged", "--lcov", lcov, "--out", skipped, ...argv], e), 0);
      assert.equal(existsSync(skipped), false);
      assert.match(logs.at(-1)!, why);
    }
    assert.equal(main(["provenance", "--producer", "coverage-merged", "--lcov", join(dir, "absent"), "--out", join(dir, "n.json"), "--all-shards-succeeded"], env), 0);
    assert.match(logs.at(-1)!, /no lcov was staged/);
    assert.throws(() => main(["provenance", "--producer", "elsewhere", "--lcov", lcov, "--out", out], env), /usage: coverage-floor\.mjs provenance/);
    assert.throws(() => main(["select", join(dir, "p"), "--as-of", "yesterday"], env), /--as-of yesterday is not a time/);
    assert.throws(() => main(["nonsense"], env), /usage: coverage-floor\.mjs provenance\|select/);

    // select and agree shell the real `gh`, answered here by the shared shim on PATH.
    const { row, provenance } = nightly({ measuredAt: new Date(Date.now() - 3_600_000),
      row: { updatedAt: new Date(Date.now() - 3_000_000).toISOString() } });
    const pinDir = join(dir, "coverage-floor-pin");
    const shim = ghShim([
      ...routes(pinDir, row, artifact(provenance))], { kind: "w1t5892-main-gh" });
    const path = process.env.PATH;
    process.env.PATH = `${shim.dir}:${path}`;
    try {
      const decision = join(dir, "decision");
      assert.equal(main(["select", pinDir, "--as-of", new Date().toISOString(), "--decision-file", decision], { ...env, GITHUB_REPOSITORY: REPO }), 0);
      assert.equal(readFileSync(decision, "utf8"), "narrow\n");
      assert.equal(main(["verify", pinDir], env), 0);
      assert.equal(logs.at(-1), join(pinDir, "lcov.info"));
      const shardsDir = join(dir, "agree-shards");
      mkdirSync(join(shardsDir, "coverage-shard-4"), { recursive: true });
      writeFileSync(join(shardsDir, "coverage-shard-4", "selection"), "narrow\n");
      writeFileSync(join(shardsDir, "coverage-shard-4", "floor-pin.json"), readFileSync(join(pinDir, "pin.json")));
      assert.equal(main(["agree", shardsDir, pinDir], env), 0);
      assert.equal(logs.at(-1), join(pinDir, "lcov.info"));
    } finally {
      process.env.PATH = path;
    }
  } finally {
    console.log = log;
  }
});
