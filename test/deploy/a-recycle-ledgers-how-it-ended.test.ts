import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SCRIPT = join(REPO_ROOT, "deploy/recycle-container.sh");

function fixture(t: TestContext, busy = false) {
  const root = mkdtempSync(join(tmpdir(), "rmd-recycle-ended-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["state/inflight", "bin", "tmp", "home", "claude"]) mkdirSync(join(root, dir), { recursive: true });
  const ledger = join(root, "state/ledger.ndjson");
  writeFileSync(join(root, "key"), "fixture-key\n", { mode: 0o600 });
  if (busy) writeFileSync(join(root, "state/inflight/W1-T11322.lock"), JSON.stringify({
    pid: 1, host: "fixture-host", run_id: "run-busy", startedAt: new Date().toISOString(),
  }));
  writeFileSync(join(root, "bin/az"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(root, "bin/docker"), `#!/usr/bin/env bash
case "$1" in
  pull)
    if [ "\${BREAK_LEDGER:-0}" = 1 ]; then cp "$RMD_STATE_DIR/state/ledger.ndjson" "$RMD_STATE_DIR/invoked"; rm "$RMD_STATE_DIR/state/ledger.ndjson"; mkdir "$RMD_STATE_DIR/state/ledger.ndjson"; fi
    if [ "\${PULL_HOLD:-0}" = 1 ]; then echo 'fixture pull waiting'; /bin/sleep 1; fi
    exit "\${PULL_RC:-0}" ;;
  image) [ "$2" != inspect ] || echo sha256:fixture ;;
  inspect)
    case "$*" in
      *Config.Env*) echo GH_TOKEN=fixture-token ;;
      *Mounts*) printf '%s\\t/home/node/Remudero\\ttrue\\n%s\\t/home/node/.claude\\ttrue\\n' "$RMD_STATE_DIR" "$RMD_CLAUDE_DIR" ;;
      *Config.Image*) echo fixture/remudero:old ;;
      *'{{.Id}}'*) printf '%064d\\n' 1 ;;
      *State.Running*) case "$*" in *worker-smoke*) exit 1 ;; *) echo true ;; esac ;;
      *) echo sha256:fixture ;;
    esac ;;
  stop) touch "$RMD_STATE_DIR/stopped"; exit "\${STOP_RC:-0}" ;;
  run) touch "$RMD_STATE_DIR/started" ;;
esac
exit 0
`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: join(root, "home"), PATH: `${join(root, "bin")}:${process.env.PATH}`,
    RMD_STATE_DIR: root, RMD_CLAUDE_DIR: join(root, "claude"),
    RMD_CODEX_DIR: join(root, "absent-codex"), RMD_CONTAINER_CONFIG_DIR: join(root, "absent-config"),
    RMD_RECYCLE_FIRST_BOOT: "1", RMD_RECYCLE_WAIT_S: "1", RMD_RECYCLE_POLL_S: "1",
    RMD_RECYCLE_SKIP_RECLAIM: "1", RMD_RECYCLE_DOCKERENV_PATH: join(root, "no-marker"),
    RMD_OPENWEIGHT_API_KEY_PATH: join(root, "key"), TMPDIR: join(root, "tmp"),
    GH_TOKEN: "fixture-token", GH_APP_ID: "", GH_APP_INSTALLATION_ID: "", GH_APP_PRIVATE_KEY_PATH: "",
    RMD_RECYCLE_HOST_LOCK: "", RMD_INSTANCE_REGISTRY: undefined,
  };
  const rows = () => readFileSync(ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const run = (extra: NodeJS.ProcessEnv = {}, args: string[] = []) => spawnSync("bash", [SCRIPT, ...args], {
    cwd: REPO_ROOT, env: { ...env, ...extra }, encoding: "utf8", timeout: 30_000,
  });
  const receipt = (status: number | null) => {
    const invoked = rows().filter((row) => row.step === "recycle.invoked");
    const ended = rows().filter((row) => row.step === "recycle.ended");
    assert.equal(invoked.length, 1);
    assert.equal(ended.length, 1, "each invocation must have exactly one ended row");
    assert.equal(ended[0].run_id, invoked[0].run_id);
    assert.equal(ended[0].rc, status);
    assert.equal(ended[0].wait_s, 1);
    assert.equal(ended[0].wait_source, "caller-supplied RMD_RECYCLE_WAIT_S");
    assert.equal(ended[0].lane, "deploy");
    assert.ok(Number.isFinite(Date.parse(ended[0].ts)));
    return ended[0];
  };
  return { root, ledger, env, rows, run, receipt };
}

describe("test/deploy/a-recycle-ledgers-how-it-ended.test.ts", () => {
  test("a drain refusal records the exact printed blockers and final reason with its wait", (t) => {
    const f = fixture(t, true);
    const r = f.run();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const printed = r.stderr.match(/recycle-blockers-json: (.+)/);
    assert.ok(printed, r.stderr);
    const ended = f.receipt(r.status);
    assert.equal(ended.outcome, "refused");
    assert.equal(ended.reason, r.stderr.split("\n").find((line) => line.startsWith("recycle-container: REFUSING")));
    assert.equal(ended.waited_s, 1);
    assert.deepEqual(ended.blockers, JSON.parse(printed[1]));
    assert.equal(ended.blockers[0].run_id, "run-busy");
    assert.equal(existsSync(join(f.root, "stopped")), false);
    assert.equal(existsSync(join(f.root, "state/PAUSE")), false);
  });

  for (const [signal, rc, duringPull] of [["SIGHUP", 129, false], ["SIGINT", 130, false], ["SIGTERM", 143, false], ["SIGHUP", 129, true]] as const) {
    test(`${signal} during ${duringPull ? "pull" : "drain"} before docker stop records an aborted receipt`, { timeout: 30_000 }, async (t) => {
      const f = fixture(t, true);
      const child = spawn("bash", [SCRIPT], {
        cwd: REPO_ROOT, detached: true,
        env: { ...f.env, RMD_RECYCLE_WAIT_S: "60", PULL_HOLD: duringPull ? "1" : "0" },
      });
      t.after(() => {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* the process group already exited */ }
        }
      });
      let output = "", sent = false;
      child.stdout.on("data", (b) => {
        output += b;
        if (!sent && output.includes(duringPull ? "fixture pull waiting" : "— polling")) {
          sent = true;
          process.kill(-child.pid!, signal);
        }
      });
      child.stderr.on("data", (b) => { output += b; });
      const status = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", resolve);
      });
      assert.equal(status, rc, output);
      const ended = f.rows().filter((row) => row.step === "recycle.ended");
      assert.equal(ended.length, 1);
      assert.equal(ended[0].run_id, f.rows()[0].run_id);
      assert.equal(ended[0].outcome, "aborted");
      assert.equal(ended[0].rc, rc);
      assert.equal(ended[0].wait_s, 60);
      assert.equal(ended[0].wait_source, "caller-supplied RMD_RECYCLE_WAIT_S");
      assert.equal(ended[0].waited_s, 0);
      assert.ok(output.includes(ended[0].reason));
      assert.match(ended[0].reason, new RegExp(`ABORTED by ${signal}`));
      assert.equal(existsSync(join(f.root, "stopped")), false);
      assert.equal(existsSync(join(f.root, "state/PAUSE")), false);
    });
  }

  test("a successful replacement records replaced and the successful reason", (t) => {
    const f = fixture(t);
    const r = f.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const ended = f.receipt(r.status);
    assert.equal(ended.outcome, "replaced");
    assert.equal(ended.waited_s, 0);
    assert.equal(ended.reason, "recycle-container: OK — remudero-daemon recycled onto sha256:fixture");
    assert.equal(existsSync(join(f.root, "started")), true);
  });

  test("an unexpected docker failure aborts with the real status and drain wait", (t) => {
    const f = fixture(t);
    const r = f.run({ STOP_RC: "7" });
    assert.equal(r.status, 7, r.stdout + r.stderr);
    const ended = f.receipt(r.status);
    assert.equal(ended.outcome, "aborted");
    assert.equal(ended.waited_s, 0);
    assert.equal(existsSync(join(f.root, "started")), false);
  });

  test("an early refusal still ends its invocation and preserves escaped diagnostic text", (t) => {
    const f = fixture(t);
    const arg = '--bad-"argument\\with\ttab';
    const r = f.run({}, [arg]);
    assert.equal(r.status, 2, r.stderr);
    const ended = f.receipt(r.status);
    assert.equal(ended.outcome, "refused");
    assert.equal(ended.reason, r.stderr.trim().split("\n").at(-1));
    assert.equal(ended.waited_s, 0);
  });

  test("an early refusal without a supplied wait records the fallback source", (t) => {
    const f = fixture(t);
    const r = f.run({ RMD_RECYCLE_WAIT_S: "" }, ["--bad-argument"]);
    assert.equal(r.status, 2);
    const ended = f.rows().find((row) => row.step === "recycle.ended");
    assert.ok(ended);
    assert.equal(ended.wait_s, 3000);
    assert.equal(ended.wait_source, "no-history fallback (nothing supplied RMD_RECYCLE_WAIT_S)");
  });

  test("a failed ended append preserves successful and refused exit statuses", (t) => {
    for (const pullRc of ["0", "7"]) {
      const f = fixture(t);
      const r = f.run({ BREAK_LEDGER: "1", PULL_RC: pullRc });
      assert.equal(r.status, pullRc === "0" ? 0 : 1, r.stdout + r.stderr);
      assert.equal(JSON.parse(readFileSync(join(f.root, "invoked"), "utf8").split("\n")[0]!).step, "recycle.invoked");
      assert.equal(existsSync(join(f.root, "started")), pullRc === "0");
    }
  });
});
