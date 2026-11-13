/**
 * W1-T12240 — the daemon container reads the second stage of its entrypoint from the checkout.
 *
 * Each case boots the real `deploy/entrypoint.sh` against a fixture origin. The entrypoint clones
 * it into `$HOME/Remudero/remudero`, then sources `deploy/entrypoint-supervise.sh` from that
 * checkout, or the image copy when the checkout copy cannot run. Outside the image the image copy
 * is the file beside the entrypoint, so here it is this branch's own `deploy/entrypoint-supervise.sh`.
 * The fixture daemon is a committed `bin/rmd` that records each start and exits with the next code
 * from `TEST_CODES`.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SCRIPT = join(REPO_ROOT, "deploy", "entrypoint.sh");
const SUPERVISE = "deploy/entrypoint-supervise.sh";
const BOOT_TIMEOUT_MS = 120_000;

const FIXTURE_DAEMON = [
  "#!/usr/bin/env bash",
  'dir="$TEST_RECORD_DIR"',
  'n=1; if [ -f "$dir/starts" ]; then n=$(( $(wc -l < "$dir/starts") + 1 )); fi',
  'echo "start $n" >> "$dir/starts"',
  'if [ "$n" = 1 ] && [ -f "$dir/on-first-start.sh" ]; then bash "$dir/on-first-start.sh"; fi',
  'if [ -n "${TEST_HOLD:-}" ]; then',
  "  exec node -e 'const fs = require(\"node:fs\"); const d = process.env.TEST_RECORD_DIR;",
  '    for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { fs.writeFileSync(d + "/signal", s); process.exit(143); });',
  '    fs.writeFileSync(d + "/held", "held"); setInterval(() => {}, 1000);\'',
  "fi",
  'code="$(printf "%s" "${TEST_CODES:-0}" | cut -d, -f"$n")"',
  'exit "${code:-0}"',
  "",
].join("\n");

const realSupervise = () => readFileSync(join(REPO_ROOT, SUPERVISE), "utf8");
const markedSupervise = (marker: string) => `log "${marker}"\n${realSupervise()}`;

interface Fixture { home: string; tree: string; record: string; origin: GitRepo; work: GitRepo; }

/** A bare origin whose one commit holds the fixture daemon and, when given, a supervise copy. */
function fixture(t: TestContext, supervise: string | null): Fixture {
  const origin = gitRepo({ bare: true, scope: t, kind: "w12240-origin" });
  const seed = gitRepo({ scope: t, seedCommit: false, kind: "w12240-seed" });
  const put = (rel: string, body: string, mode = 0o644) => {
    mkdirSync(dirname(join(seed.dir, rel)), { recursive: true });
    writeFileSync(join(seed.dir, rel), body, { mode });
  };
  put("bin/rmd", FIXTURE_DAEMON, 0o755);
  put("node_modules/.bin/tsx", "#!/bin/sh\n", 0o755);
  if (supervise !== null) put(SUPERVISE, supervise);
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "chore: fixture");
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");
  const home = ownedFixtureDir(t, "w12240-home").dir;
  const record = ownedFixtureDir(t, "w12240-record").dir;
  return { home, tree: join(home, "Remudero", "remudero"), record, origin, work: seed };
}

function bootEnv(fx: Fixture, codes: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const ambient = Object.fromEntries(Object.entries(process.env)
    .filter(([k]) => !k.startsWith("RMD_") && !/^(GH_APP_|GH_TOKEN$|GITHUB_TOKEN$)/.test(k)));
  return {
    ...ambient,
    HOME: fx.home,
    RMD_REPO_URL: fx.origin.dir,
    RMD_REF: "main",
    RMD_RESTART_THROTTLE_S: "0",
    RMD_FRESHNESS_RESTART_PAUSE_S: "0",
    RMD_BLOCKED_RESTART_PAUSE_S: "0",
    RMD_ENVIRONMENTAL_RESTART_PAUSE_S: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    TEST_RECORD_DIR: fx.record,
    TEST_CODES: codes,
    ...extra,
  };
}

function boot(fx: Fixture, codes: string, cmd = ["./bin/rmd", "daemon"], extra: Record<string, string> = {}) {
  const r = spawnSync("bash", [SCRIPT, ...cmd], { encoding: "utf8", cwd: REPO_ROOT, timeout: BOOT_TIMEOUT_MS, env: bootEnv(fx, codes, extra) });
  return { status: r.status, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}

function rows(fx: Fixture, step: string): Array<Record<string, unknown>> {
  const path = join(fx.home, "Remudero", "state", "ledger.ndjson");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>).filter((row) => row.step === step);
}

const starts = (fx: Fixture) => existsSync(join(fx.record, "starts")) ? readFileSync(join(fx.record, "starts"), "utf8").split("\n").filter(Boolean).length : 0;
const count = (text: string, needle: string) => text.split(needle).length - 1;

test("W1-T12240 criterion 1: after the first sync the entrypoint runs the checkout's supervise script", (t) => {
  const fx = fixture(t, markedSupervise("fixture second stage v1"));
  const run = boot(fx, "0");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(count(run.stderr, "fixture second stage v1"), 1, run.stderr);
  assert.ok(run.stderr.includes(`second stage: ${join(fx.tree, SUPERVISE)}`), run.stderr);
  assert.equal(rows(fx, "entrypoint.supervise_fallback").length, 0);
  assert.equal(starts(fx), 1);
});

test("W1-T12240 criterion 2: a checkout with no supervise script runs the image copy and writes one fallback row", (t) => {
  const fx = fixture(t, null);
  const run = boot(fx, "75,0");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(starts(fx), 2, "the image copy started the daemon and restarted it after a freshness exit");
  assert.equal(count(run.stderr, "second stage: running the image copy"), 1, run.stderr);
  const fallback = rows(fx, "entrypoint.supervise_fallback");
  assert.equal(fallback.length, 1);
  assert.match(String(fallback[0].reason), /the checkout has no deploy\/entrypoint-supervise\.sh/);
});

test("W1-T12240 criterion 2: a supervise script that bash -n refuses is not run; the image copy runs", (t) => {
  const fx = fixture(t, 'log "fixture broken copy"\nif then fi (\n');
  const run = boot(fx, "0");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(starts(fx), 1);
  assert.ok(!run.stderr.includes("fixture broken copy"), run.stderr);
  const fallback = rows(fx, "entrypoint.supervise_fallback");
  assert.equal(fallback.length, 1);
  assert.match(String(fallback[0].reason), /bash -n refused deploy\/entrypoint-supervise\.sh/);
});

test("W1-T12240 criterion 2: a supervise script with local changes in the checkout is not run", (t) => {
  const fx = fixture(t, markedSupervise("fixture second stage v1"));
  assert.equal(boot(fx, "0").status, 0);
  writeFileSync(join(fx.tree, SUPERVISE), markedSupervise("fixture local change"));
  const run = boot(fx, "0");
  assert.equal(run.status, 0, run.stderr);
  assert.ok(!run.stderr.includes("fixture local change"), run.stderr);
  const fallback = rows(fx, "entrypoint.supervise_fallback");
  assert.equal(fallback.length, 1);
  assert.match(String(fallback[0].reason), /untracked or has local changes/);
});

test("W1-T12240 criterion 3: a changed checkout copy replaces the running one after a freshness exit, and the counters keep their values", (t) => {
  const fx = fixture(t, markedSupervise("fixture second stage v1"));
  // The next commit on main changes the supervise copy; the fixture daemon pushes it on its first run.
  const work = gitRepo({ scope: t, cloneFrom: fx.origin.dir, kind: "w12240-work" });
  writeFileSync(join(work.dir, SUPERVISE), markedSupervise("fixture second stage v2"));
  work.git("commit", "--quiet", "-am", "chore: supervise v2");
  writeFileSync(join(fx.record, "on-first-start.sh"), `git -C '${work.dir}' push --quiet origin HEAD:main\n`);
  const run = boot(fx, "75,75,0");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(starts(fx), 3);
  assert.ok(run.stderr.indexOf("fixture second stage v1") < run.stderr.indexOf("fixture second stage v2"), run.stderr);
  assert.equal(count(run.stderr, "fixture second stage v2"), 1, run.stderr);
  assert.match(run.stderr, /the checkout copy changed \([0-9a-f]{12} -> [0-9a-f]{12}\); re-running with it, counters kept/);
  assert.equal(count(run.stderr, "(freshness) — restart 1/100"), 1, run.stderr);
  assert.equal(count(run.stderr, "(freshness) — restart 2/100"), 1, "the count went on from the run before the re-run");
  assert.deepEqual(rows(fx, "daemon.process.exit").map((row) => row.exit_code), [75, 75, 0]);
  assert.equal(rows(fx, "entrypoint.supervise_fallback").length, 0);
});

test("W1-T12240 criterion 4: a checkout copy that fails before the first daemon start does not end the container", (t) => {
  const fx = fixture(t, 'log "fixture copy that fails"\nexit 3\n');
  const run = boot(fx, "0");
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stderr.includes("fixture copy that fails"), run.stderr);
  assert.equal(starts(fx), 1, "the image copy started the daemon once");
  const fallback = rows(fx, "entrypoint.supervise_fallback");
  assert.equal(fallback.length, 1);
  assert.match(String(fallback[0].reason), /the checkout copy exited 3 before it started the daemon/);
});

test("W1-T12240 criterion 5: exit codes 75 to 78 restart in the container, a crash exits, and each exit is one row", (t) => {
  const fx = fixture(t, markedSupervise("fixture second stage v1"));
  const run = boot(fx, "75,76,77,78,1");
  assert.equal(run.status, 1, run.stderr);
  assert.equal(starts(fx), 5);
  for (const line of ["exited 75 (freshness) — restart 1/100", "exited 76 (blocked) — restart 1/100",
    "exited 77 (environmental) — restart 1/100", "idle_starved: supervisor setup/clock failed", "exited 1 — sleeping 0s"]) {
    assert.ok(run.stderr.includes(line), `${line}\n${run.stderr}`);
  }
  const exits = rows(fx, "daemon.process.exit");
  assert.deepEqual(exits.map((row) => row.exit_code), [75, 76, 77, 78, 1]);
  assert.deepEqual(exits.map((row) => row.clean_exit), [true, false, false, false, false]);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`W1-T12240 criterion 5: a forwarded ${signal} stops the daemon and the container exits 0`, async (t) => {
    const fx = fixture(t, markedSupervise("fixture second stage v1"));
    const child = spawn("bash", [SCRIPT, "./bin/rmd", "daemon"], { cwd: REPO_ROOT, env: bootEnv(fx, "0", { TEST_HOLD: "1" }) });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (!existsSync(join(fx.record, "held"))) {
      if (Date.now() > deadline) { child.kill("SIGKILL"); assert.fail(`the fixture daemon never started\n${stderr}`); }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    child.kill(signal);
    const code = await exited;
    assert.equal(code, 0, stderr);
    const short = signal.slice(3);
    assert.ok(stderr.includes(`received ${short} — forwarding to pid`), stderr);
    assert.ok(stderr.includes("operator stop handled"), stderr);
    assert.equal(readFileSync(join(fx.record, "signal"), "utf8"), signal);
    assert.deepEqual(rows(fx, "daemon.process.exit").map((row) => row.clean_exit), [true]);
  });
}

test("W1-T12240 criterion 5: RMD_SKIP_BOOTSTRAP=1 and a one-shot verb do not reach the second stage", (t) => {
  const fx = fixture(t, markedSupervise("fixture second stage v1"));
  const skipped = boot(fx, "0", ["bash", "-c", "echo skip-ran"], { RMD_SKIP_BOOTSTRAP: "1" });
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.equal(skipped.stdout.trim(), "skip-ran");
  assert.equal(existsSync(fx.tree), false, "no clone under RMD_SKIP_BOOTSTRAP=1");
  const oneShot = boot(fx, "0", ["bash", "-c", "echo one-shot-ran"]);
  assert.equal(oneShot.status, 0, oneShot.stderr);
  assert.equal(oneShot.stdout.trim(), "one-shot-ran");
  for (const run of [skipped, oneShot]) assert.ok(!run.stderr.includes("second stage"), run.stderr);
});

test("W1-T12240 criterion 6: the image holds a copy of the supervise script under /usr/local/lib/rmd/", () => {
  // @source-text-subject: the Dockerfile's COPY line is the image content this criterion names.
  const dockerfile = readFileSync(join(REPO_ROOT, "deploy", "Dockerfile"), "utf8");
  assert.match(dockerfile, /^COPY --chown=node:node deploy\/entrypoint-supervise\.sh \/usr\/local\/lib\/rmd\/entrypoint-supervise\.sh$/m);
});
