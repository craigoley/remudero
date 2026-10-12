/**
 * W1-T5688 — the host watchdog ACTS on W1-T5687's progress verdict instead of reviving a stopped
 * container into the same input. On 2026-10-03 `rmd-relaunch.sh` revived 14 times into one crash
 * (each `prev_restarts=5`), and its healthy arm's `refresh_deploy_code || exit 0` ended every tick
 * that had workers in flight, so a wedged-but-running daemon was never acted on.
 *
 * Every case renders the REAL launcher from deploy/install-host-units.sh into a throwaway tree and
 * runs it with a fake `rmd` (the verdict is a file this suite writes), a fake `docker` and a fake
 * `deploy/recycle-container.sh`, so each rung of the ladder runs for real against no real host.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gitRepo } from "./helpers/git-repo.js";

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

interface Host {
  root: string;
  stateDir: string;
  launcher: string;
  revivals: string;
  rmdLog: string;
  dockerLog: string;
  recycleLog: string;
  verdictFile: string;
  env: NodeJS.ProcessEnv;
}

/** A rendered launcher plus every fake it reaches. `daemonTree` replaces `<state>/remudero` (the
 *  CRASH_LOOP case points it at a real clone so origin/main's sha can move). */
function host(opts: { running: boolean; workersInFlight?: boolean; recycleExit?: number; daemonTree?: string }): Host {
  const root = mkdtempSync(join(tmpdir(), "rmd-watchdog-ladder-"));
  const stateDir = join(root, "state-root");
  const stub = join(root, "stubbin");
  for (const dir of [join(stateDir, "state"), stub, join(stateDir, "daemon-install", "deploy")]) mkdirSync(dir, { recursive: true });
  const daemonTree = join(stateDir, "remudero");
  if (opts.daemonTree) symlinkSync(opts.daemonTree, daemonTree);
  mkdirSync(join(daemonTree, "bin"), { recursive: true });
  mkdirSync(join(daemonTree, "src"), { recursive: true });
  // refresh_deploy_code runs only when the source CLI is present -- the workers-in-flight gate.
  writeFileSync(join(daemonTree, "src", "run-task.ts"), "// fixture\n");

  const rmdLog = join(root, "rmd.log");
  const dockerLog = join(root, "docker.log");
  const recycleLog = join(root, "recycle.log");
  const verdictFile = join(root, "verdict.json");
  writeExecutable(
    join(daemonTree, "bin", "rmd"),
    `#!/usr/bin/env bash\necho "$*" >> "${rmdLog}"\nif [ "$1" = progress-watchdog ]; then cat "${verdictFile}"; fi\nexit 0\n`,
  );
  writeExecutable(
    join(stateDir, "daemon-install", "deploy", "recycle-container.sh"),
    `#!/usr/bin/env bash\necho "RMD_STATE_DIR=$RMD_STATE_DIR RMD_DAEMON_CONTAINER=$RMD_DAEMON_CONTAINER $*" >> "${recycleLog}"\n` +
      (opts.recycleExit ? `echo "recycle-container: REFUSING -- 2 worker(s) still running after the bounded wait" >&2\nexit ${opts.recycleExit}\n` : "exit 0\n"),
  );
  const top = opts.workersInFlight
    ? `echo "PID COMMAND"; echo "42 claude -p task --output-format stream-json"`
    : `echo "PID COMMAND"; echo "1 node bin/rmd daemon"`;
  writeExecutable(
    join(stub, "docker"),
    [
      "#!/usr/bin/env bash",
      `echo "$*" >> "${dockerLog}"`,
      'case "$1" in',
      `  ps) ${opts.running ? "echo fake-container-id" : ":"} ;;`,
      `  top) ${top} ;;`,
      '  image) cat "$RMD_TEST_IMAGE_ID_FILE" ;;',
      "  inspect) echo 1 ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  writeExecutable(join(stub, "findmnt"), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(join(root, "image-id"), "sha256:image-one\n");

  const revivals = join(root, "revivals.log");
  const launcher = join(root, "rmd-relaunch.sh");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RMD_STATE_DIR: stateDir,
    RMD_UNIT_DIR: join(root, "systemd"),
    RMD_BIN_DIR: join(root, "bin"),
    RMD_LAUNCHER_PATH: launcher,
    RMD_REVIVAL_LOG: revivals,
    RMD_NODE_MAX_OLD_SPACE_MB: "8192",
    RMD_CASH_SECRET_DIR: join(root, "no-secrets"),
    RMD_TEST_IMAGE_ID_FILE: join(root, "image-id"),
    PATH: `${stub}:${process.env.PATH ?? ""}`,
  };
  const install = spawnSync("bash", ["deploy/install-host-units.sh", "--install"], { encoding: "utf8", env });
  assert.equal(install.status, 0, `render failed: ${install.stderr}`);
  return { root, stateDir, launcher, revivals, rmdLog, dockerLog, recycleLog, verdictFile, env };
}

function verdict(h: Host, state: string, action: string, extra: Record<string, unknown> = {}): void {
  const body = { stateDir: join(h.stateDir, "state"), rowsRead: 9, state, action, progressAgeMs: 2_400_000, failedBoots15m: 0, reason: "fixture", ...extra };
  writeFileSync(h.verdictFile, `${JSON.stringify(body)}\n`);
}

function tick(h: Host): { status: number | null; stdout: string; stderr: string } {
  return spawnSync("bash", [h.launcher], { encoding: "utf8", env: h.env });
}

const read = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");
const lines = (text: string, re: RegExp): string[] => text.split("\n").filter((l) => re.test(l));

test("a tick with workers in flight still reads the progress verdict before refresh_deploy_code ends it", () => {
  const h = host({ running: true, workersInFlight: true });
  try {
    const bundle = join(h.stateDir, "state", "diagnostics", "progress-20261003T120000Z");
    verdict(h, "STALLED", "capture-diagnostics", { bundle: { written: true, dir: bundle } });
    const r = tick(h);
    assert.equal(r.status, 0, r.stderr);
    // The tick DID end at the idle gate -- the precondition that made the verdict unreachable.
    assert.match(r.stderr, /active workers; deferring/);
    assert.doesNotMatch(read(h.rmdLog), /deploy-run/, "the workers-in-flight tick must still end before deploy-run");
    // ...and the verdict was read before it ended, against the host-side ledger directory.
    assert.match(read(h.rmdLog), new RegExp(`^progress-watchdog --json --state-root ${join(h.stateDir, "state")}$`, "m"));
    // capture-diagnostics: the verb wrote the bundle; the launcher names it in one revival-log line.
    const noted = lines(read(h.revivals), /watchdog-verdict/);
    assert.equal(noted.length, 1, read(h.revivals));
    assert.match(noted[0], new RegExp(`state=STALLED action=capture-diagnostics bundle=${bundle}$`));
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a STALLED recycle verdict runs recycle-container.sh once, not again within 30 minutes, and again after", () => {
  const h = host({ running: true });
  try {
    verdict(h, "STALLED", "recycle");
    const first = tick(h);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(lines(read(h.recycleLog), /./).length, 1, "the first STALLED/recycle tick must recycle");
    assert.match(read(h.recycleLog), new RegExp(`RMD_STATE_DIR=${h.stateDir} RMD_DAEMON_CONTAINER=remudero-daemon`));
    assert.match(read(h.revivals), /watchdog-recycle result=ok rc=0 reason=replaced/);
    // One action per tick: the recycle ended it, so deploy-run did not also ask for one.
    assert.doesNotMatch(read(h.rmdLog), /deploy-run/);

    const second = tick(h);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(lines(read(h.recycleLog), /./).length, 1, "a second tick inside 30 minutes must not recycle again");
    assert.match(second.stdout, /a recycle ran \d+s ago; at most one per 1800s/);

    // 31 minutes later (the marker is the clock), the verdict still asking: it recycles again.
    const marker = join(h.stateDir, "state", "watchdog-recycle-at");
    writeFileSync(marker, `${Math.floor(Date.now() / 1000) - 31 * 60}\n`);
    assert.equal(tick(h).status, 0);
    assert.equal(lines(read(h.recycleLog), /./).length, 2, "past 30 minutes the recycle is due again");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a refused recycle is logged with its reason and is not retried in the same tick or within 30 minutes", () => {
  const h = host({ running: true, recycleExit: 3 });
  try {
    verdict(h, "STALLED", "recycle");
    assert.equal(tick(h).status, 0);
    assert.equal(lines(read(h.recycleLog), /./).length, 1, "a refusal is one attempt, never retried in the tick");
    assert.match(read(h.revivals), /watchdog-recycle result=refused rc=3 reason=recycle-container: REFUSING -- 2 worker\(s\) still running/);
    assert.equal(tick(h).status, 0);
    assert.equal(lines(read(h.recycleLog), /./).length, 1, "nor on the next tick inside 30 minutes");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a CRASH_LOOP verdict starts no container while origin/main is unchanged, and starts it once the sha moves", () => {
  const origin = gitRepo({ bare: true, kind: "watchdog-ladder-origin" });
  const seed = gitRepo({ kind: "watchdog-ladder-seed" });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");
  const loopSha = seed.git("rev-parse", "HEAD");
  const daemon = gitRepo({ cloneFrom: origin.dir, kind: "watchdog-ladder-daemon" });
  const h = host({ running: false, daemonTree: daemon.dir });
  try {
    // Three boots that logged daemon.paths and died before daemon.boot, each after a different step.
    const rows = [
      { ts: "2026-10-03T10:00:00Z", step: "daemon.paths", run_id: "b1" },
      { ts: "2026-10-03T10:00:01Z", step: "plan.sync", run_id: "b1" },
      { ts: "2026-10-03T10:05:00Z", step: "daemon.paths", run_id: "b2" },
      { ts: "2026-10-03T10:05:01Z", step: "plan.load_failed", run_id: "b2" },
      { ts: "2026-10-03T10:10:00Z", step: "daemon.paths", run_id: "b3" },
      { ts: "2026-10-03T10:10:01Z", step: "plan.load_failed", run_id: "b3" },
    ];
    writeFileSync(join(h.stateDir, "state", "ledger.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    verdict(h, "CRASH_LOOP", "hold-revive", { failedBoots15m: 3, progressAgeMs: null });
    const started = (): number => lines(read(h.dockerLog), /^run /).length;

    const first = tick(h);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(started(), 0, "the tick that names the loop must not start the container");
    assert.match(first.stderr, /CRASH LOOP -- not reviving into the same input/);
    const digest = lines(read(h.revivals), /crash-loop-hold/);
    assert.equal(digest.length, 1, read(h.revivals));
    assert.match(digest[0], new RegExp(`failed_boots=3 last_steps=plan.sync,plan.load_failed,plan.load_failed sha=${loopSha} digest=sha256:image-one$`));
    assert.equal(readFileSync(join(h.stateDir, "state", "DAEMON_CRASH_LOOP"), "utf8").trim(), digest[0], "the marker carries the digest line");
    assert.equal(lines(read(h.revivals), / revive boot=/).length, 0, "a held tick writes no revival record");

    // Unchanged input, two more ticks: still nothing started, and the digest is not repeated.
    for (let i = 0; i < 2; i += 1) {
      const held = tick(h);
      assert.equal(held.status, 0, held.stderr);
      assert.match(held.stderr, /CRASH LOOP hold -- input unchanged/);
    }
    assert.equal(started(), 0, "an unchanged origin/main must keep the container down");
    assert.equal(lines(read(h.revivals), /crash-loop-hold/).length, 1);

    // The repair merges: origin/main moves, and the next tick revives exactly once.
    seed.git("commit", "--quiet", "--allow-empty", "-m", "the repair");
    seed.git("push", "--quiet", "origin", "main");
    const repairSha = seed.git("rev-parse", "HEAD");
    const released = tick(h);
    assert.equal(released.status, 0, released.stderr);
    assert.equal(started(), 1, "a moved origin/main must start the container");
    assert.match(read(h.revivals), new RegExp(`crash-loop-release sha=${repairSha} digest=sha256:image-one was sha=${loopSha}`));
    assert.equal(lines(read(h.revivals), / revive boot=0 /).length, 1);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a held CRASH_LOOP also revives once the image digest changes, and stays held after the verdict lapses", () => {
  const h = host({ running: false });
  try {
    writeFileSync(join(h.stateDir, "state", "ledger.ndjson"), `${JSON.stringify({ ts: "2026-10-03T10:00:00Z", step: "daemon.paths", run_id: "b1" })}\n`);
    verdict(h, "CRASH_LOOP", "hold-revive", { failedBoots15m: 3 });
    assert.equal(tick(h).status, 0);
    // A held daemon writes no boots, so the verdict leaves CRASH_LOOP; the hold must not lapse with it.
    verdict(h, "UNKNOWN", "none");
    assert.equal(tick(h).status, 0);
    assert.equal(lines(read(h.dockerLog), /^run /).length, 0, "the hold outlives the verdict's 15-minute window");
    writeFileSync(join(h.root, "image-id"), "sha256:image-two\n");
    assert.equal(tick(h).status, 0);
    assert.equal(lines(read(h.dockerLog), /^run /).length, 1, "a new image is a changed input");
    assert.equal(existsSync(join(h.stateDir, "state", "watchdog-hold-revive")), false, "the release clears the hold");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});
