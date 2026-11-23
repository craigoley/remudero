import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T12260: the rendered watchdog tick reads `df -Pk` for `/` and for the state directory, and its
// healthy line carries both readings. The stub `df` answers from fixture files; `real` keeps the host's.
const HEADER = "Filesystem     1024-blocks     Used Available Capacity Mounted on";
const dfRow = (device: string, pct: number, availKb: number, mount: string) =>
  `${HEADER}\n${device} 31000000 ${31000000 - availKb} ${availKb} ${pct}% ${mount}`;

function host(t: TestContext, opts: { realDf?: boolean; env?: Record<string, string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-watchdog-disk-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "core");
  const bin = join(root, "stubs");
  const calls = join(root, "calls");
  const launcher = join(root, "relaunch.sh");
  const ledger = join(state, "state", "ledger.ndjson");
  const registry = join(root, "instances.yaml");
  writeFileSync(registry, "instances:\n" + ["core", "console", "site"].map(name => [
    `  ${name}:`, "    repo: remudero", `    state_dir: ${state}`,
    `    container_name: daemon-${name}`, "    service_user: fixture",
    "    image: example.invalid/remudero:fixture", "    max_old_space_mb: 8192",
    `    service_name: rmd-${name}-fleet.service`, `    watchdog_service_name: rmd-${name}-watchdog.service`,
    `    watchdog_timer_name: rmd-${name}-watchdog.timer`, `    launcher_path: ${launcher}`,
    `    revival_log: ${root}/revivals`, "    gh_app_id: 1234", "    gh_app_installation_id: 5678",
    "    gh_app_private_key_path: /home/node/.claude/fixture.pem", `    claude_dir: ${root}/claude`,
    `    codex_dir: ${root}/codex`, `    container_config_dir: ${root}/config`,
  ].join("\n")).join("\n") + "\n");
  for (const dir of [bin, join(state, "state"), join(state, "daemon-install", ".git"),
    join(state, "daemon-install", "deploy"), join(state, "remudero", ".git"),
    join(state, "remudero", "bin"), join(state, "remudero", "src")]) mkdirSync(dir, { recursive: true });
  const put = (name: string, value: string) => writeFileSync(join(root, name), value + "\n");
  const executable = (path: string, body: string) => {
    writeFileSync(path, "#!/usr/bin/env bash\nset -eu\n" + body + "\n");
    chmodSync(path, 0o755);
  };
  for (const [name, value] of Object.entries({
    remote: "a".repeat(40), head: "a".repeat(40), container: "container-one running 0 started-one",
    verdict: '{"state":"PROGRESSING","action":"none"}', dirty: "", "deploy-exit": "0",
    "deploy-output": "### rmd deploy-run — no-op: up-to-date (install HEAD == origin/main, daemon alive and running it)",
    calls: "", "df-root": dfRow("/dev/root", 42, 18 * 1048576, "/"),
    "df-state": dfRow("/dev/sdb1", 30, 700 * 1048576, "/mnt/rmd"), "df-root-exit": "0", "df-state-exit": "0",
  })) put(name, value);
  writeFileSync(ledger, "fixture\n");
  writeFileSync(join(state, "remudero", "src", "run-task.ts"), "// fixture\n");
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
  ls-remote) printf '%s\\trefs/heads/main\\n' "$(cat "$FIXTURE/remote")" ;;
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
  if (!opts.realDf) executable(join(bin, "df"), `
echo "df $*" >> "$FIXTURE/calls"
which=state; [ "$2" = / ] && which=root
cat "$FIXTURE/df-$which"; exit "$(cat "$FIXTURE/df-$which-exit")"`);
  executable(join(state, "remudero", "bin", "rmd"), `
echo "rmd $*" >> "$FIXTURE/calls"
if [ "$1" = progress-watchdog ]; then cat "$FIXTURE/verdict"; else
  cat "$FIXTURE/deploy-output"; exit "$(cat "$FIXTURE/deploy-exit")"
fi`);
  executable(join(state, "daemon-install", "deploy", "install-host-units.sh"),
    'echo "units $*" >> "$FIXTURE/calls"');
  const env: NodeJS.ProcessEnv = {
    ...process.env, FIXTURE: root, PATH: `${bin}:${process.env.PATH ?? ""}`,
    RMD_INSTANCE_REGISTRY: registry,
    RMD_STATE_DIR: state, RMD_UNIT_DIR: join(root, "units"), RMD_BIN_DIR: join(root, "installed-bin"),
    RMD_LAUNCHER_PATH: launcher, RMD_REVIVAL_LOG: join(root, "revivals"),
    RMD_NODE_MAX_OLD_SPACE_MB: "8192", RMD_DAEMON_CONTAINER: "daemon-core",
    HIGH_WATER: undefined, RMD_CLEANUP_WATCH_FS: undefined, ...opts.env,
  };
  const rendered = spawnSync("bash", ["deploy/install-host-units.sh", "--install", "--instance", "core"],
    { cwd: REPO_ROOT, env, encoding: "utf8" });
  assert.equal(rendered.status, 0, rendered.stderr);
  let ledgerTime = Math.floor(Date.now() / 1000) - 3600;
  const tick = () => {
    ledgerTime++;
    utimesSync(ledger, ledgerTime, ledgerTime);
    put("calls", "");
    const result = spawnSync("bash", [launcher], { env, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
    const lines = readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);
    return { calls: lines, stdout: result.stdout, line: diskLine(result.stdout) };
  };
  return { state, put, tick };
}

const diskLine = (stdout: string) =>
  stdout.split("\n").find((line) => /^rmd-relaunch: daemon-core .*(healthy|disk )/.test(line)) ?? "";

function fullTick(calls: string[]) {
  assert.ok(calls.some((line) => line.startsWith("rmd deploy-run ")), calls.join("\n"));
}
function unchangedTick(calls: string[]) {
  assert.deepEqual(calls.filter((line) => /^(rmd |units |docker top)/.test(line)), [], calls.join("\n"));
  assert.deepEqual(calls.filter((line) => line.startsWith("git ")), [
    "git daemon-install ls-remote --exit-code origin refs/heads/main", "git daemon-install rev-parse HEAD",
  ]);
}

test("W1-T12260 criterion 1: each tick reads / and the state volume with one df call for each", (t) => {
  const h = host(t);
  const full = h.tick();
  fullTick(full.calls);
  assert.deepEqual(full.calls.filter((line) => line.startsWith("df ")), ["df -Pk /", `df -Pk ${h.state}`]);
  const unchanged = h.tick();
  unchangedTick(unchanged.calls);
  assert.deepEqual(unchanged.calls.filter((line) => line.startsWith("df ")), ["df -Pk /", `df -Pk ${h.state}`]);
});

test("W1-T12260 criterion 1: the real df is parsed into a percent and a free size", (t) => {
  const h = host(t, { realDf: true, env: { HIGH_WATER: "100", RMD_CLEANUP_WATCH_FS: "" } });
  for (const tick of [h.tick(), h.tick()]) {
    assert.match(tick.line, /disk \/ [0-9]+% [0-9]+[KMG] free, state [0-9]+% [0-9]+[KMG] free$|disk low: /, tick.stdout);
    assert.doesNotMatch(tick.line, /unreadable/, tick.stdout);
  }
});

test("W1-T12260 criterion 2: inside both marks the healthy line carries both readings", (t) => {
  const h = host(t);
  const full = h.tick();
  fullTick(full.calls);
  assert.equal(full.line, "rmd-relaunch: daemon-core healthy -- asking the supervisor whether a RECYCLE is due." +
    " disk / 42% 18G free, state 30% 700G free");
  const unchanged = h.tick();
  unchangedTick(unchanged.calls);
  assert.equal(unchanged.line, "rmd-relaunch: daemon-core unchanged and healthy -- skipping checkout and deploy work." +
    " disk / 42% 18G free, state 30% 700G free");
});

test("W1-T12260 criterion 3: a volume past its mark prints volume, percent, free and mark, never healthy", (t) => {
  const h = host(t);
  h.put("df-root", dfRow("/dev/root", 99, 1048576, "/"));
  const full = h.tick();
  assert.doesNotMatch(full.stdout, /healthy/);
  assert.equal(full.line, "rmd-relaunch: daemon-core progressing, disk low: / 99% used, 1G free, mark 85%" +
    " -- asking the supervisor whether a RECYCLE is due.");
  const unchanged = h.tick();
  unchangedTick(unchanged.calls);
  assert.doesNotMatch(unchanged.stdout, /healthy/);
  assert.equal(unchanged.line, "rmd-relaunch: daemon-core progressing, disk low: / 99% used, 1G free, mark 85%" +
    " -- skipping checkout and deploy work.");

  // The marks are the janitor's: HIGH_WATER for /, the RMD_CLEANUP_WATCH_FS entry of the state mount.
  const marked = host(t, { env: { HIGH_WATER: "95", RMD_CLEANUP_WATCH_FS: "/mnt/rmd:70 /mnt/scratch:90/40G" } });
  marked.put("df-root", dfRow("/dev/root", 90, 3 * 1048576, "/"));
  marked.put("df-state", dfRow("/dev/sdb1", 75, 250 * 1048576, "/mnt/rmd"));
  const judged = marked.tick();
  assert.doesNotMatch(judged.stdout, /healthy/);
  assert.equal(judged.line, "rmd-relaunch: daemon-core progressing, disk low: state 75% used, 250G free, mark 70%" +
    " -- asking the supervisor whether a RECYCLE is due.");

  // One device is judged once, at the stricter of its two marks.
  const shared = host(t, { env: { HIGH_WATER: "95", RMD_CLEANUP_WATCH_FS: "/mnt/rmd:85" } });
  shared.put("df-root", dfRow("/dev/sdb1", 90, 3 * 1048576, "/mnt/rmd"));
  shared.put("df-state", dfRow("/dev/sdb1", 90, 3 * 1048576, "/mnt/rmd"));
  const one = shared.tick();
  assert.doesNotMatch(one.stdout, /healthy/);
  assert.equal(one.line, "rmd-relaunch: daemon-core progressing, disk low: / 90% used, 3G free, mark 85%;" +
    " state 90% used, 3G free, mark 85% -- asking the supervisor whether a RECYCLE is due.");
});

test("W1-T12260 criterion 4: an unreadable reading prints unreadable, no number and never healthy", (t) => {
  for (const breakIt of [
    (h: ReturnType<typeof host>) => h.put("df-state-exit", "1"),
    (h: ReturnType<typeof host>) => h.put("df-state", HEADER),
    (h: ReturnType<typeof host>) => h.put("df-state", `${HEADER}\n/dev/sdb1 31000000 10 garbage 30% /mnt/rmd`),
    (h: ReturnType<typeof host>) => h.put("df-state", `${HEADER}\n/dev/sdb1 31000000 10 20 -% /mnt/rmd`),
  ]) {
    const h = host(t);
    breakIt(h);
    for (const tick of [h.tick(), h.tick()]) {
      assert.doesNotMatch(tick.stdout, /healthy/);
      assert.match(tick.line, /^rmd-relaunch: daemon-core progressing, disk unreadable: state unreadable -- /);
      assert.doesNotMatch(tick.line.replace(/^rmd-relaunch: daemon-core /, ""), /[0-9]/);
    }
  }
  const h = host(t);
  h.put("df-root-exit", "1");
  h.put("df-state", dfRow("/dev/sdb1", 99, 1024, "/mnt/rmd"));
  const both = h.tick();
  assert.doesNotMatch(both.stdout, /healthy/);
  assert.equal(both.line, "rmd-relaunch: daemon-core progressing, disk low: / unreadable; state 99% used, 1M free," +
    " mark 85% -- asking the supervisor whether a RECYCLE is due.");
});

test("W1-T12260 criterion 5: a disk reading starts no restart, recycle or deploy work", (t) => {
  const run = (low: boolean) => {
    const h = host(t);
    if (low) {
      h.put("df-root", dfRow("/dev/root", 99, 1048576, "/"));
      h.put("df-state-exit", "1");
    }
    const ticks = [h.tick(), h.tick(), h.tick()];
    assert.equal(ticks.every((tick) => /disk (low|unreadable): /.test(tick.line)), low, ticks[0].stdout);
    // Everything but the df reads, with the fixture's own directory named alike in both runs.
    return { ticks, work: ticks.map((tick) => tick.calls.filter((line) => !line.startsWith("df "))
      .map((line) => line.split(h.state).join("<state>"))) };
  };
  const healthy = run(false);
  const low = run(true);
  assert.deepEqual(low.work, healthy.work);
  fullTick(low.ticks[0].calls);
  for (const tick of low.ticks.slice(1)) unchangedTick(tick.calls);
  assert.deepEqual(low.ticks.flatMap((tick) => tick.calls).filter((line) =>
    /restart|recycle|docker (rm|stop|run|kill|restart)/.test(line)), []);
});
