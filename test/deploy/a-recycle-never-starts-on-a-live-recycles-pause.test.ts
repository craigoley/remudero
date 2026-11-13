import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SCRIPT = join(REPO_ROOT, "deploy/recycle-container.sh");
const REASON = "container recycle (deploy/recycle-container.sh)";
const PROOF = "test/deploy/a-recycle-never-starts-on-a-live-recycles-pause.test.ts";
const START = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], {
  encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
}).replace(/\s+/g, " ").trim();
assert.notEqual(START, "", "positive control: the live writer has a readable start");

function body(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    reason: REASON, pid: process.pid, host: hostname(), writerStart: START,
    container: "fixture-old-id", containerName: "remudero-daemon", phase: "waiting", ...extra,
  }) + "\n";
}

function fixture(t: TestContext, written?: string, unreadableStart = false) {
  const root = mkdtempSync(join(tmpdir(), "rmd-live-recycle-pause-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state-root");
  const bin = join(root, "bin");
  const scratch = join(root, "tmp");
  const home = join(root, "home");
  for (const dir of [join(state, "state"), bin, scratch, home]) mkdirSync(dir, { recursive: true });
  const pause = join(state, "state/PAUSE");
  if (written !== undefined) writeFileSync(pause, written);
  const key = join(root, "openweight-key");
  writeFileSync(key, "fixture-durable-openweight-key\n", { mode: 0o600 });
  writeFileSync(join(bin, "az"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_ROOT/calls"
case "$1" in
  inspect)
    case "$3" in
      *Config.Image*) echo 'fixture/remudero:old' ;;
      *Config.Env*) echo 'GH_TOKEN=fixture-token' ;;
      *Mounts*)
        printf '%s\\t/home/node/Remudero\\ttrue\\n' "$RMD_STATE_DIR"
        printf '%s\\t/home/node/.claude\\ttrue\\n' "$RMD_CLAUDE_DIR" ;;
      *.Image}}*) echo 'sha256:fixture-image' ;;
      '{{.Id}}') echo 'fixture-old-id' ;;
    esac ;;
  image)
    case "$*" in *Config.Env*) : ;; *) echo 'sha256:fixture-image' ;; esac ;;
  stop)
    cp "$RMD_STATE_DIR/state/PAUSE" "$STUB_ROOT/pause-at-stop"
    exit 73 ;;
esac
exit 0
`, { mode: 0o755 });
  if (unreadableStart) {
    writeFileSync(join(bin, "ps"), `#!/usr/bin/env bash
case "$*" in *lstart*) exit 1 ;; esac
exec /bin/ps "$@"
`, { mode: 0o755 });
  }
  const run = () => {
    const result = spawnSync("bash", [SCRIPT], {
      cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000,
      env: {
        ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}`, TMPDIR: scratch,
        STUB_ROOT: root, RMD_STATE_DIR: state, RMD_CLAUDE_DIR: join(home, "claude"),
        RMD_CODEX_DIR: join(home, "codex"), RMD_CONTAINER_CONFIG_DIR: join(home, "config"),
        RMD_OPENWEIGHT_API_KEY_PATH: key, RMD_RECYCLE_FIRST_BOOT: "1",
        RMD_RECYCLE_DOCKERENV_PATH: join(root, "no-dockerenv"),
        RMD_RECYCLE_WAIT_S: "0", RMD_RECYCLE_HOST_LOCK: "", RMD_INSTANCE_REGISTRY: undefined,
        GH_TOKEN: "", GH_APP_ID: "", GH_APP_INSTALLATION_ID: "", GH_APP_PRIVATE_KEY_PATH: "",
        LC_ALL: "C", TZ: "Pacific/Honolulu",
      },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return { status: result.status, out: result.stdout + result.stderr };
  };
  const refusals = () => readFileSync(join(state, "state/ledger.ndjson"), "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.step === "recycle.refused");
  return { root, pause, run, refusals };
}

for (const phase of ["waiting", "stopping"]) {
  test(`${PROOF}: a live writer in ${phase} refuses before touching PAUSE or stopping docker`, (t) => {
    const written = body({ phase });
    const f = fixture(t, written);
    const before = statSync(f.pause, { bigint: true });
    const r = f.run();
    assert.notEqual(r.status, 0, r.out);
    assert.ok(r.out.includes(`recycle-container: REFUSING — recycle pid ${process.pid} (started ${START}) is still running and owns PAUSE`), r.out);
    assert.equal(readFileSync(f.pause, "utf8"), written);
    const after = statSync(f.pause, { bigint: true });
    assert.equal(after.ino, before.ino, "the original PAUSE is not replaced");
    assert.equal(after.mtimeNs, before.mtimeNs, "even rewriting identical bytes is forbidden");
    const calls = readFileSync(join(f.root, "calls"), "utf8").split("\n");
    // W1-T12242: the smoke runs before the pause, so only a container stop or removal is a touch.
    assert.equal(calls.some((line) => /^(stop|rm) /.test(line)), false, r.out);
    const rows = f.refusals();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.reason, "live-recycle-owns-pause");
    assert.equal(rows[0]!.writer_pid, process.pid);
    assert.equal(rows[0]!.writer_start, START);
    assert.equal(rows[0]!.host, hostname());
  });
}

const dead = spawnSync("true");
assert.ok(dead.pid > 0);
assert.equal(spawnSync("ps", ["-o", "lstart=", "-p", String(dead.pid)], { encoding: "utf8" }).stdout.trim(), "");
const controls = [
  { name: "dead writer", written: body({ pid: dead.pid }) },
  { name: "reused pid", written: body({ writerStart: "Thu Jan 1 00:00:00 1970" }) },
  { name: "another host", written: body({ host: `${hostname()}-elsewhere` }) },
  { name: "missing writerStart", written: body({ writerStart: undefined }) },
  { name: "empty writerStart", written: body({ writerStart: "" }) },
  { name: "missing pid", written: body({ pid: undefined }) },
  { name: "absent PAUSE", written: undefined },
  { name: "unreadable body", written: "not json\n" },
  { name: "operator PAUSE", written: body({ reason: `${REASON} — operator investigation` }) },
  { name: "unreadable process start", written: body(), unreadableStart: true },
];
for (const control of controls) {
  test(`${PROOF}: ${control.name} keeps the existing recycle behavior`, (t) => {
    const f = fixture(t, control.written, control.unreadableStart);
    const r = f.run();
    assert.equal(r.status, 73, `control: recycle reaches the deliberately failing docker stop\n${r.out}`);
    assert.deepEqual(f.refusals(), []);
    const atStop = readFileSync(join(f.root, "pause-at-stop"), "utf8");
    if (control.name === "operator PAUSE" || control.name === "unreadable body") {
      assert.equal(atStop, control.written);
      assert.equal(readFileSync(f.pause, "utf8"), control.written);
    } else {
      const current = JSON.parse(atStop) as Record<string, unknown>;
      assert.equal(current.reason, REASON);
      assert.equal(current.phase, "stopping");
      assert.notEqual(current.pid, process.pid, "a replacement recycle wrote its own body");
    }
    assert.equal(existsSync(join(f.root, "pause-at-stop")), true);
  });
}
