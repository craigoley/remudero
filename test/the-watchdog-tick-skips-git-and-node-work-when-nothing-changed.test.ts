import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

function host(t: TestContext, instance = "core") {
  const root = mkdtempSync(join(tmpdir(), "rmd-watchdog-unchanged-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, instance);
  const bin = join(root, "stubs");
  const calls = join(root, "calls");
  const launcher = join(root, "relaunch.sh");
  const snapshot = join(state, "state", "watchdog-tick-snapshot");
  const ledger = join(state, "state", "ledger.ndjson");
  for (const dir of [bin, join(state, "state"), join(state, "daemon-install", ".git"),
    join(state, "daemon-install", "deploy"), join(state, "remudero", ".git"),
    join(state, "remudero", "bin"), join(state, "remudero", "src")]) mkdirSync(dir, { recursive: true });
  const put = (name: string, value: string) => writeFileSync(join(root, name), value + "\n");
  const executable = (path: string, body: string) => {
    writeFileSync(path, "#!/usr/bin/env bash\nset -eu\n" + body + "\n");
    chmodSync(path, 0o755);
  };
  put("remote", "a".repeat(40));
  put("head", "a".repeat(40));
  put("container", "container-one running 0 started-one");
  put("verdict", '{"state":"PROGRESSING","action":"none"}');
  put("dirty", "");
  put("offline", "0");
  put("deploy-exit", "0");
  put("deploy-output", "### rmd deploy-run — no-op: up-to-date (install HEAD == origin/main, daemon alive and running it)");
  put("calls", "");
  writeFileSync(ledger, "fixture\n");
  writeFileSync(join(state, "remudero", "src", "run-task.ts"), "// fixture\n");
  // The launcher targets Linux and asks GNU stat for %Y. This fixture already replaces
  // docker/git; provide that Linux observation from real filesystem metadata on every host.
  // Do not change the production fast-path predicate to accommodate a test machine's stat.
  executable(join(bin, "stat"), `
if [ "$1" = -c ] && [ "$2" = %Y ]; then
  exec ${JSON.stringify(process.execPath)} -e 'console.log(Math.floor(require("node:fs").statSync(process.argv[1]).mtimeMs / 1000))' "$3"
fi
exec /usr/bin/stat "$@"`);
  executable(join(bin, "git"), `
code=""
if [ "$1" = -C ]; then code="$2"; shift 2; fi
echo "git \${code##*/} $*" >> "$FIXTURE/calls"
case "$1" in
  ls-remote) [ "$(cat "$FIXTURE/offline")" = 0 ] || exit 1
    printf '%s\\trefs/heads/main\\n' "$(cat "$FIXTURE/remote")" ;;
  rev-parse) cat "$FIXTURE/head" ;;
  symbolic-ref) echo main ;;
  status) cat "$FIXTURE/dirty" ;;
  merge) cp "$FIXTURE/remote" "$FIXTURE/head" ;;
esac`);
  executable(join(bin, "docker"), `
echo "docker $*" >> "$FIXTURE/calls"
case "$1" in
  ps) echo container-one ;;
  inspect) cat "$FIXTURE/container" ;;
  top) printf 'PID COMMAND\\n1 node daemon\\n' ;;
esac`);
  executable(join(state, "remudero", "bin", "rmd"), `
echo "rmd $*" >> "$FIXTURE/calls"
if [ "$1" = progress-watchdog ]; then cat "$FIXTURE/verdict"; else
  cat "$FIXTURE/deploy-output"; exit "$(cat "$FIXTURE/deploy-exit")"
fi`);
  executable(join(state, "daemon-install", "deploy", "install-host-units.sh"),
    'echo "units $*" >> "$FIXTURE/calls"');
  const env = {
    ...process.env, FIXTURE: root, PATH: `${bin}:${process.env.PATH ?? ""}`,
    RMD_STATE_DIR: state, RMD_UNIT_DIR: join(root, "units"), RMD_BIN_DIR: join(root, "installed-bin"),
    RMD_LAUNCHER_PATH: launcher, RMD_REVIVAL_LOG: join(root, "revivals"),
    RMD_NODE_MAX_OLD_SPACE_MB: "8192", RMD_DAEMON_CONTAINER: `daemon-${instance}`,
  };
  const rendered = spawnSync("bash", ["deploy/install-host-units.sh", "--install"], { env, encoding: "utf8" });
  assert.equal(rendered.status, 0, rendered.stderr);
  let ledgerTime = Math.floor(Date.now() / 1000) - 3600;
  const advance = () => { ledgerTime++; utimesSync(ledger, ledgerTime, ledgerTime); };
  const tick = (args: string[] = []) => {
    put("calls", "");
    const result = spawnSync("bash", [launcher, ...args], { env, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
    return readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);
  };
  const installEdgeHeal = () => executable(join(state, "daemon-install", "deploy", "edge-heal.sh"),
    'echo "edge-heal state=$RMD_STATE_DIR" >> "$FIXTURE/calls"; exit "$(cat "$FIXTURE/edge-exit")"');
  return { state, snapshot, ledger, put, advance, tick, installEdgeHeal };
}

function fullTick(calls: string[]) {
  assert.ok(calls.includes("git remudero status --porcelain --untracked-files=all"), calls.join("\n"));
  assert.ok(calls.some((line) => line.startsWith("git remudero merge-base ")), calls.join("\n"));
  assert.ok(calls.some((line) => line.startsWith("rmd progress-watchdog ")), calls.join("\n"));
  assert.ok(calls.some((line) => line.startsWith("rmd deploy-run ")), calls.join("\n"));
}

test("W1-T6361: an unchanged tick skips the checkout walk", (t) => {
  for (const instance of ["core", "console", "site"]) {
    const h = host(t, instance);
    h.advance();
    fullTick(h.tick());
    h.advance();
    const calls = h.tick();
    assert.deepEqual(calls.filter((line) => line.startsWith("git ")), [
      "git daemon-install ls-remote --exit-code origin refs/heads/main", "git daemon-install rev-parse HEAD",
    ]);
    assert.deepEqual(calls.filter((line) => /^(rmd |units |docker top)/.test(line)), []);
    assert.ok(calls.some((line) => line.startsWith(`docker inspect daemon-${instance} `)));
    assert.match(readFileSync(h.snapshot, "utf8"), /\|PROGRESSING\|[0-9]+\|1\n$/);
  }
});

test("an unchanged core tick still heals the edge without checkout or node work", (t) => {
  const h = host(t);
  h.put("edge-exit", "0");
  h.installEdgeHeal();
  h.advance();
  const initial = h.tick();
  fullTick(initial);
  assert.deepEqual(initial.filter((line) => line.startsWith("edge-heal ")), [`edge-heal state=${h.state}`]);
  for (const exit of ["0", "1"]) {
    h.put("edge-exit", exit);
    h.advance();
    const calls = h.tick();
    assert.deepEqual(calls.filter((line) => line.startsWith("edge-heal ")), [`edge-heal state=${h.state}`]);
    assert.deepEqual(calls.filter((line) => line.startsWith("git ")), [
      "git daemon-install ls-remote --exit-code origin refs/heads/main", "git daemon-install rev-parse HEAD",
    ]);
    assert.deepEqual(calls.filter((line) => /^(rmd |units |docker top)/.test(line)), []);
  }
});

test("W1-T6361: any change runs the full tick", (t) => {
  const mutations = [
    (h: ReturnType<typeof host>) => h.put("remote", "b".repeat(40)),
    (h: ReturnType<typeof host>) => h.put("head", "b".repeat(40)),
    (h: ReturnType<typeof host>) => h.put("container", "container-two running 0 started-one"),
    (h: ReturnType<typeof host>) => h.put("container", "container-one running 1 started-two"),
    (h: ReturnType<typeof host>) => h.put("container", "container-one paused 0 started-one"),
    (h: ReturnType<typeof host>) => h.put("container", ""),
    (h: ReturnType<typeof host>) => writeFileSync(h.snapshot,
      readFileSync(h.snapshot, "utf8").replace("|PROGRESSING|", "|STALLED|")),
    (h: ReturnType<typeof host>) => writeFileSync(h.snapshot, "corrupt\n"),
    (h: ReturnType<typeof host>) => writeFileSync(h.snapshot,
      readFileSync(h.snapshot, "utf8") + "extra line\n"),
    (h: ReturnType<typeof host>) => writeFileSync(h.snapshot,
      readFileSync(h.snapshot, "utf8").replace(/\|0\n$/, "|999\n")),
    (h: ReturnType<typeof host>) => rmSync(h.snapshot),
    (h: ReturnType<typeof host>) => h.put("offline", "1"),
  ];
  for (const mutate of mutations) {
    const h = host(t);
    h.advance();
    fullTick(h.tick());
    mutate(h);
    h.advance();
    fullTick(h.tick());
  }
});

test("unchanged ticks still check progress every third tick despite advancing ledger pulses", (t) => {
  const h = host(t);
  h.advance();
  fullTick(h.tick());
  assert.match(readFileSync(h.snapshot, "utf8"), /\|PROGRESSING\|[0-9]+\|0\n$/);
  for (let i = 0; i < 2; i++) {
    h.advance();
    assert.equal(h.tick().filter((line) => line.startsWith("rmd ")).length, 0);
  }
  h.advance();
  const periodic = h.tick();
  assert.equal(periodic.filter((line) => line.startsWith("rmd progress-watchdog ")).length, 1);
  assert.equal(periodic.filter((line) => line.startsWith("rmd deploy-run ")).length, 0);
  assert.equal(periodic.filter((line) => /git .* (status|fetch|merge-base|diff|merge) /.test(line)).length, 0);
  assert.match(readFileSync(h.snapshot, "utf8"), /\|PROGRESSING\|[0-9]+\|0\n$/);
});

test("a stopped ledger precheck reads the verdict and keeps unhealthy ticks on the full path", (t) => {
  const h = host(t);
  h.advance();
  fullTick(h.tick());
  h.put("verdict", '{"state":"STALLED","action":"capture-diagnostics","dir":"fixture-bundle"}');
  const stalled = h.tick();
  fullTick(stalled);
  assert.equal(stalled.filter((line) => line.startsWith("rmd progress-watchdog ")).length, 1);
  h.advance();
  fullTick(h.tick());
});

test("unreadable verdicts and failed deploys cannot seed a healthy fast path", (t) => {
  for (const unhealthy of ["UNKNOWN", "CRASH_LOOP", "STALLED", "garbage"]) {
    const h = host(t);
    h.put("verdict", JSON.stringify({ state: unhealthy, action: "none" }));
    h.advance();
    fullTick(h.tick());
    h.advance();
    fullTick(h.tick());
  }
  const h = host(t);
  h.put("deploy-exit", "1");
  h.advance();
  fullTick(h.tick());
  h.advance();
  fullTick(h.tick());
});

test("boot and STOP guards bypass the fast path", (t) => {
  const h = host(t);
  h.advance();
  fullTick(h.tick());
  h.advance();
  assert.equal(h.tick(["--boot"]).filter((line) => /^(git |rmd |units )/.test(line)).length, 0);
  writeFileSync(join(h.state, "state", "STOP"), "stop\n");
  assert.deepEqual(h.tick(), []);
});

test("an idle verdict can seed the fast path but a healthy state with an action cannot", (t) => {
  const h = host(t);
  h.put("verdict", '{"state":"IDLE","action":"none"}');
  h.advance();
  fullTick(h.tick());
  assert.match(readFileSync(h.snapshot, "utf8"), /\|IDLE\|/);
  h.advance();
  assert.equal(h.tick().filter((line) => line.startsWith("rmd ")).length, 0);
  rmSync(h.snapshot);
  h.put("verdict", '{"state":"PROGRESSING","action":"capture-diagnostics"}');
  h.advance();
  fullTick(h.tick());
  h.advance();
  fullTick(h.tick());
});

test("a pending image build or deploy request keeps the supervisor reachable", (t) => {
  const h = host(t);
  h.put("deploy-output", "### rmd deploy-run — no-op: the new image is not published yet — waiting for the build");
  h.advance();
  fullTick(h.tick());
  h.advance();
  fullTick(h.tick());
  h.put("deploy-output", "### rmd deploy-run — no-op: up-to-date (install HEAD == origin/main, daemon alive and running it)");
  h.advance();
  fullTick(h.tick());
  writeFileSync(join(h.state, "state", "DEPLOY_REQUESTED"), "operator request\n");
  h.advance();
  fullTick(h.tick());
});
