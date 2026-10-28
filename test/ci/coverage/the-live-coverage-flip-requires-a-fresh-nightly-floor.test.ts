/**
 * W1-T5892 — THE LIVE COVERAGE FLIP REQUIRES A FRESH NIGHTLY FLOOR.
 *
 * A narrowed pull request reads its absolute coverage floor from another run's full-suite lcov.
 * Before this, ci.yml took the newest COMPLETED coverage-nightly or merge-group run, and each
 * consumer chose independently. Now each coverage shard pins a floor through
 * scripts/coverage-floor.mjs as of the triggering event, before it narrows; the aggregator requires
 * every narrowed shard's pin to name one floor and reads exactly that floor. Without a fresh,
 * successful, complete, compatible floor a shard runs full with a named reason.
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
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import {
  agreeOnFloor, buildProvenance, main, MAX_AGE_HOURS, nodeMajor, policyDigest, PRODUCERS, selectFloor, sha256, verifyPin,
  // @ts-expect-error -- plain .mjs script, no type declarations
} from "#scripts/coverage-floor.mjs";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim, type GhShimRoute } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const REPO = "craigoley/remudero";
const NOW = new Date("2026-10-28T12:00:00Z");
const HEAD = "a".repeat(40);
const LCOV = "TN:\nSF:src/a.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\nSF:src/b.ts\nDA:1,0\nLF:1\nLH:0\nend_of_record\n";
const ALL_GREEN = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i + 1, 0]));
const CONSUMER = { repository: REPO, nodeMajor: nodeMajor(), policyDigest: policyDigest(REPO_ROOT) };

const tmp = (kind: string) => mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5892-${kind}-`));

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
  assert.equal(verifyPin(pinDir), join(pinDir, "lcov.info"));
  assert.equal(readFileSync(join(pinDir, "lcov.info"), "utf8"), LCOV);
  assert.equal(existsSync(join(pinDir, ".candidates")), false, "downloaded candidates never ride the published pin");
  assert.ok(calls.some((c) => c.includes(`run list --workflow coverage-nightly.yml --branch main --status success --created <=${NOW.toISOString()}`)),
    "only SUCCESSFUL runs created by the as-of time are listed: a completed red nightly uploads before its exit gate");
  assert.ok(calls.some((c) => /run list --workflow ci\.yml --event merge_group --status success/.test(c)));
  assert.equal(calls.filter((c) => c.startsWith("run download")).length, 1, "only listed candidates are downloaded");
});

test("W1-T5892: a floor that finished after the as-of time is invisible, so every shard weighs the same candidates", () => {
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

test("W1-T5892: the 24-hour bound is inclusive at its boundary and the clock skew is bounded", () => {
  const at = (ms: number) => {
    const n = nightly({ measuredAt: new Date(NOW.getTime() - ms), row: { updatedAt: NOW.toISOString() } });
    return select(n.row, artifact(n.provenance)).pin.decision;
  };
  assert.equal(at(MAX_AGE_HOURS * 3_600_000), "narrow", "exactly 24 hours old still verifies");
  assert.equal(at(MAX_AGE_HOURS * 3_600_000 + 1), "full", "one millisecond past the bound refuses");
  assert.equal(at(-4 * 60_000), "narrow", "a producer clock four minutes ahead is within the skew");
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
  const { row, provenance } = nightly();
  const gh = ghShim(routes(pinDir, row, artifact(provenance)), { kind: "w1t5892-cli-gh" });
  const out = join(dirname(pinDir), "decision");
  const env = { ...process.env, PATH: `${gh.dir}:${process.env.PATH}`, GITHUB_REPOSITORY: REPO };
  const cli = (...args: string[]) => spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "coverage-floor.mjs"), ...args], { encoding: "utf8", env });
  const selected = cli("select", pinDir, "--as-of", NOW.toISOString(), "--decision-file", out);
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
    ".nvmrc", "package-lock.json", "package.json"]) {
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

test("W1-T5892: with the live flag on, a shard narrows only on a floor it pinned as of the event and otherwise runs full naming why", () => {
  const shard = step(CI, "coverage-ratchet", "Test with coverage");
  assert.equal(shard.env?.FLOOR_AS_OF, "${{ github.event.pull_request.updated_at }}", "the as-of time is the event's, not the shard's clock");
  assert.equal(shard.env?.GH_TOKEN, "${{ github.token }}");
  const body = shard.run!.replaceAll("${{ matrix.shard }}", "1").replaceAll("${{ steps.classify.outputs.class }}", "SOURCE");
  const asOf = new Date(Date.now() - 60_000).toISOString();
  const live = { GITHUB_EVENT_NAME: "pull_request", RMD_AFFECTED_SUITE_LIVE: "1", FLOOR_AS_OF: asOf };

  const cwd = checkout();
  const fresh = nightly({ measuredAt: new Date(Date.now() - 3_600_000), row: { updatedAt: new Date(Date.now() - 3_000_000).toISOString() } });
  const narrow = runStep(body, live, routes(join(cwd, "coverage-floor-pin"), fresh.row, artifact(fresh.provenance)), cwd);
  assert.equal(narrow.status, 0, narrow.out);
  assert.ok(narrow.calls.includes(`--created <=${asOf}`), "the shard lists candidates as of the event");
  assert.match(narrow.calls, /--select-candidates/);
  assert.equal(narrow.read("coverage-selection.txt").trim(), "narrow");
  assert.equal(JSON.parse(narrow.read("coverage-floor-pin.json")).floor.run_id, 111, "the shard keeps the pin it narrowed on");
  assert.ok(!existsSync(join(cwd, "coverage-floor-pin")), "the floor lcov is gone before the tests run");

  for (const listing of [[{ when: "run list", stdout: "[]" }], [{ when: "run list", stderr: "HTTP 502", exit: 1 }]]) {
    const full = runStep(body, live, listing);
    assert.equal(full.status, 0, full.out);
    assert.doesNotMatch(full.calls, /--import tsx -e|--select-candidates/, "no floor, no narrow selection");
    assert.match(full.calls, /--select-all/);
    assert.match(full.out, /coverage-floor: full — /, "the floor helper names why");
    assert.match(full.out, /W1-T5892: no fresh verified coverage floor, so this shard runs in full/);
    assert.equal(full.read("coverage-selection.txt").trim(), "all");
  }

  const off = runStep(body, { GITHUB_EVENT_NAME: "pull_request", RMD_AFFECTED_SUITE_LIVE: "0", FLOOR_AS_OF: asOf });
  assert.equal(off.status, 0, off.out);
  assert.doesNotMatch(off.out, /W1-T5892|coverage-floor/, "flag-off behaviour is unchanged");
  assert.doesNotMatch(off.calls, /^gh /m, "flag off reads no other run");
  assert.equal(off.read("coverage-selection.txt").trim(), "all");

  assert.match(step(CI, "coverage-ratchet", "Stage this coverage shard").run!,
    /cp coverage-floor-pin\.json coverage-artifact\/floor-pin\.json/, "the pin rides the shard artifact to the aggregator");
});

/** A narrow pin naming `lcov`'s digest, as a shard stages it. */
const pinFor = (lcov: string, runId = 111) => JSON.stringify({ schema: 1, decision: "narrow", reason: `coverage-nightly run ${runId} verified`,
  floor: { artifact: "coverage-nightly", run_id: runId, run_attempt: 1, head_sha: HEAD, measured_at: "2026-10-28T10:00:00.000Z",
    lcov_sha256: sha256(Buffer.from(lcov)) }, refused: [] });

test("W1-T5892: the aggregator reads exactly the one floor every narrowed shard pinned, and refuses a missing, split or altered pin", () => {
  const ratchet = step(CI, "coverage-ratchet-required", "Coverage ratchet");
  assert.doesNotMatch(ratchet.run!, /gh run list/, "the aggregator never chooses its own newest floor");
  const body = ratchet.run!.replaceAll("${{ steps.coverage-artifact.outputs.class }}", "SOURCE");
  const seeded = (pins: Record<number, string | null>) => Array.from({ length: 8 }, (_, i) => {
    const n = i + 1, dir = `coverage-shards/coverage-shard-${n}`;
    const pin = pins[n];
    return [`mkdir -p ${dir}; echo ${n in pins ? "narrow" : "all"} > ${dir}/selection`,
      typeof pin === "string" ? `cat > ${dir}/floor-pin.json <<'PIN'\n${pin}\nPIN` : ""].join("\n");
  }).join("\n");
  const pr = { GITHUB_EVENT_NAME: "pull_request" };
  const served = (lcov: string): GhShimRoute[] => [{ when: "run download 111", writes: [{ path: "coverage-floor-pin/download/lcov.info", content: lcov }] }];

  const good = runStep(`${seeded({ 3: pinFor(LCOV), 5: pinFor(LCOV) })}\n${body}`, pr, served(LCOV));
  assert.equal(good.status, 0, good.out);
  assert.match(good.calls, /gh run download 111 -n coverage-nightly -D coverage-floor-pin\/download/);
  assert.match(good.calls, /coverage-ratchet\.mjs --lcov coverage-floor-pin\/lcov\.info --baseline scripts\/coverage-baseline\.json/);
  assert.doesNotMatch(good.calls, /--lcov coverage\/lcov\.info/, "a narrowed lcov is never held to the absolute floor");
  assert.match(good.read("summary.md"), /absolute floor \(historical baseline\): pinned coverage-nightly run 111/);
  assert.match(good.read("summary.md"), /Added-line coverage of this head/);
  assert.match(good.read("summary.md"), /Full integration/);

  const refusals: Array<[string, Record<number, string | null>, GhShimRoute[], RegExp]> = [
    ["altered floor", { 3: pinFor(LCOV) }, served(LCOV + "SF:src/z.ts\nend_of_record\n"), /differs from its pinned digest/],
    ["split pins", { 3: pinFor(LCOV), 5: pinFor(LCOV, 112) }, served(LCOV), /shard 5 pinned coverage-nightly 112 .*another shard pinned coverage-nightly 111/],
    ["narrowed without a pin", { 3: pinFor(LCOV), 6: null }, served(LCOV), /shard 6 narrowed without a narrow floor pin/],
    ["expired floor", { 3: pinFor(LCOV) }, [{ when: "run download 111", stderr: "no valid artifacts found to download", exit: 1 }],
      /cannot download the pinned coverage-nightly run 111/],
  ];
  for (const [name, pins, gh, why] of refusals) {
    const r = runStep(`${seeded(pins)}\n${body}`, pr, gh);
    assert.notEqual(r.status, 0, `${name} refuses`);
    assert.match(r.out, /W1-T5892: the narrowed shards' pinned floor does not verify; refusing/, name);
    assert.match(r.out, why, name);
    assert.doesNotMatch(r.calls, /coverage-ratchet\.mjs|run list/, `${name}: no other floor is chosen`);
  }

  for (const full of [runStep(`${seeded({})}\n${body}`, pr), runStep(body, pr)]) {
    assert.equal(full.status, 0, full.out);
    assert.match(full.calls, /coverage-ratchet\.mjs --lcov coverage\/lcov\.info --baseline/);
    assert.doesNotMatch(full.calls, /^gh /m, "a full selection reads its own lcov and no pin");
  }
  assert.throws(() => agreeOnFloor({ shardsDir: tmp("none"), outDir: tmp("out") }), /no shard narrowed/);
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

test("W1-T5892: agreeOnFloor downloads the one pinned floor and refuses a split, altered, missing or unreadable pin", () => {
  const shards = (pins: Record<number, string | null>) => {
    const dir = tmp("shards");
    for (let n = 1; n <= 8; n++) {
      mkdirSync(join(dir, `coverage-shard-${n}`), { recursive: true });
      writeFileSync(join(dir, `coverage-shard-${n}`, "selection"), n in pins ? "narrow\n" : "all\n");
      const pin = pins[n];
      if (typeof pin === "string") writeFileSync(join(dir, `coverage-shard-${n}`, "floor-pin.json"), pin);
    }
    return dir;
  };
  const serve = (lcov: string) => fakeRun((a) => (a.startsWith("run download 111 -n coverage-nightly") ? { status: 0, files: { "lcov.info": lcov } } : { status: 1 }));

  const outDir = tmp("agree");
  assert.equal(agreeOnFloor({ shardsDir: shards({ 2: pinFor(LCOV), 7: pinFor(LCOV) }), outDir, run: serve(LCOV) }), join(outDir, "lcov.info"));
  assert.equal(readFileSync(join(outDir, "lcov.info"), "utf8"), LCOV);
  assert.equal(existsSync(join(outDir, "download")), false, "the download is removed once copied");
  assert.equal(JSON.parse(readFileSync(join(outDir, "pin.json"), "utf8")).floor.run_id, 111);

  assert.throws(() => agreeOnFloor({ shardsDir: shards({ 2: pinFor(LCOV), 7: pinFor(LCOV, 112) }), outDir: tmp("o"), run: serve(LCOV) }),
    /shard 7 pinned coverage-nightly 112 .*another shard pinned coverage-nightly 111/);
  assert.throws(() => agreeOnFloor({ shardsDir: shards({ 2: pinFor(LCOV) }), outDir: tmp("o"), run: serve(LCOV + "x\n") }), /differs from its pinned digest/);
  assert.throws(() => agreeOnFloor({ shardsDir: shards({ 2: null }), outDir: tmp("o"), run: serve(LCOV) }), /shard 2 narrowed without a narrow floor pin/);
  assert.throws(() => agreeOnFloor({ shardsDir: shards({ 2: "{" }), outDir: tmp("o"), run: serve(LCOV) }), /shard 2 narrowed without/);
  assert.throws(() => agreeOnFloor({ shardsDir: shards({ 2: pinFor(LCOV) }), outDir: tmp("o"), run: fakeRun(() => ({ status: 1, stderr: "gone" })) }),
    /cannot download the pinned coverage-nightly run 111: gone/);
  assert.throws(() => agreeOnFloor({ shardsDir: shards({ 2: pinFor(LCOV) }), outDir: tmp("o"), run: fakeRun(() => ({ status: 0 })) }),
    /differs from its pinned digest/, "a download that leaves no lcov is refused");
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
      { when: `-D ${join(dir, "agreed", "download")}`, writes: [{ path: join(dir, "agreed", "download", "lcov.info"), content: LCOV }] },
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
      assert.equal(main(["agree", shardsDir, join(dir, "agreed")], env), 0);
      assert.equal(logs.at(-1), join(dir, "agreed", "lcov.info"));
    } finally {
      process.env.PATH = path;
    }
  } finally {
    console.log = log;
  }
});
