import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { ghShim, type GhShimRoute } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T12242: the real deploy/recycle-container.sh runs against the shared PATH shim, named
// `docker`. Nothing here reaches a real container: every docker call answers from the table below.
const SCRIPT = join(REPO_ROOT, "deploy/recycle-container.sh");
const DAEMON = "remudero-daemon";
const SMOKE = `${DAEMON}-worker-smoke`;
const FIRST = "sha256:aaaa";
const SECOND = "sha256:bbbb";

interface Scenario {
  smokeFails?: boolean;
  /** The first pulled image is gone after the wait; the re-pull resolves to SECOND. */
  goneAfterWait?: boolean;
  secondSmokeFails?: boolean;
  /** A smoke container that an earlier recycle left, with its state. */
  leftover?: "exited" | "running";
}

function recycleRun(t: TestContext, scenario: Scenario = {}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-smoke-before-pause-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["state", "tmp", "home", "claude"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "key"), "fixture-key\n", { mode: 0o600 });
  const imageId = join(root, "image-id");
  writeFileSync(imageId, `${FIRST}\n`);
  const routes: GhShimRoute[] = [];
  if (scenario.goneAfterWait) {
    routes.push({ when: `image inspect ${FIRST}`, exit: 1, writes: { path: imageId, content: `${SECOND}\n` } });
  }
  if (scenario.secondSmokeFails) {
    // The first smoke passes on FIRST; the smoke on SECOND, after the wait, fails.
    routes.push({ when: ` ${SECOND} node `, stdout: "WORKER-SMOKE FAIL second", exit: 1 });
  }
  routes.push(
    { when: "container run", stdout: scenario.smokeFails ? "WORKER-SMOKE FAIL fixture" : "WORKER-SMOKE PASS fixture", exit: scenario.smokeFails ? 1 : 0 },
    { when: "image inspect", stdoutFile: imageId },
    { when: "ps -a --filter", stdout: scenario.leftover ? `c-old ${SMOKE} ${scenario.leftover}` : "" },
    { when: "Config.Env", stdout: "GH_TOKEN=fixture-token" },
    { when: "Mounts", stdout: `${root}\t/home/node/Remudero\ttrue\n${join(root, "claude")}\t/home/node/.claude\ttrue` },
    { when: "Config.Image", stdout: "fixture/remudero:old" },
    { when: "{{.Id}}", stdout: "0".repeat(63) + "1" },
    { when: "State.Running", stdout: "true" },
    { when: "inspect", stdoutFile: imageId },
  );
  const docker = ghShim(routes, { kind: "docker-shim", command: "docker" });
  t.after(() => rmSync(docker.dir, { recursive: true, force: true }));
  const az = ghShim([], { kind: "az-shim", command: "az" });
  t.after(() => rmSync(az.dir, { recursive: true, force: true }));
  const result = spawnSync("bash", [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: join(root, "home"),
      PATH: `${docker.dir}:${az.dir}:${process.env.PATH ?? ""}`,
      RMD_STATE_DIR: root,
      RMD_CLAUDE_DIR: join(root, "claude"),
      RMD_CODEX_DIR: join(root, "absent-codex"),
      RMD_CONTAINER_CONFIG_DIR: join(root, "absent-config"),
      RMD_RECYCLE_FIRST_BOOT: "1",
      RMD_RECYCLE_WAIT_S: "1",
      RMD_RECYCLE_POLL_S: "1",
      RMD_RECYCLE_SKIP_RECLAIM: "1",
      RMD_RECYCLE_DOCKERENV_PATH: join(root, "no-marker"),
      RMD_OPENWEIGHT_API_KEY_PATH: join(root, "key"),
      RMD_RECYCLE_HOST_LOCK: "",
      RMD_INSTANCE_REGISTRY: undefined,
      RMD_SCRATCH: "off",
      TMPDIR: join(root, "tmp"),
      GH_TOKEN: "fixture-token",
      GH_APP_ID: "",
      GH_APP_INSTALLATION_ID: "",
      GH_APP_PRIVATE_KEY_PATH: "",
    },
  });
  assert.ifError(result.error);
  const calls = docker.calls();
  const rows = readFileSync(join(root, "state/ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const ended = rows.filter((row) => row.step === "recycle.ended");
  assert.equal(ended.length, 1, "one recycle.ended row per recycle");
  const at = (pred: (call: string) => boolean) => calls.findIndex(pred);
  return {
    result,
    output: result.stdout + result.stderr,
    calls,
    ended: ended[0],
    paused: existsSync(join(root, "state/PAUSE")),
    smokes: calls.filter((c) => c.startsWith("container run ")),
    /** The wait reads the running container's workers; it starts only after the pause is written. */
    waitAt: at((c) => c.startsWith(`exec ${DAEMON} `)),
    smokeAt: at((c) => c.startsWith("container run ")),
    lastSmokeAt: calls.findLastIndex((c) => c.startsWith("container run ")),
    stopAt: at((c) => c === `stop ${DAEMON}`),
    startAt: at((c) => c.startsWith("run -d ")),
  };
}

describe("test/deploy/a-recycle-runs-its-worker-smoke-before-the-pause.test.ts", () => {
  test("W1-T12242 criterion 1: the recycle smokes the pulled image before it writes the pause file", (t) => {
    const r = recycleRun(t);
    assert.equal(r.result.status, 0, r.output);
    assert.equal(r.smokes.length, 1, "a present image is smoked once");
    assert.ok(r.smokes[0].includes(` ${FIRST} node `), "the smoke runs on the pulled image id");
    const pull = r.calls.findIndex((c) => c.startsWith("pull "));
    assert.ok(pull >= 0 && pull < r.smokeAt, "the smoke follows the pull");
    assert.ok(r.waitAt > r.smokeAt, `the paused wait follows the smoke: ${r.waitAt} > ${r.smokeAt}`);
    const passed = r.output.indexOf("worker smoke PASSED");
    const engaged = r.output.indexOf("PAUSE engaged");
    assert.ok(passed >= 0 && engaged > passed, "the log shows the smoke passing before the pause");
    assert.equal(r.paused, false, "the pause is cleared when the new container starts");
  });

  test("W1-T12242 criterion 2: a failed smoke refuses with no pause file and the running container not stopped", (t) => {
    const r = recycleRun(t, { smokeFails: true });
    assert.equal(r.result.status, 1, r.output);
    assert.match(r.output, /recycle-container: REFUSING — the real worker smoke FAILED \(exit 1\) on sha256:aaaa\./);
    assert.match(r.output, /The fleet was not paused\./);
    assert.equal(r.paused, false, "no pause file exists after the refusal");
    assert.equal(r.waitAt, -1, "the recycle never reached the paused wait");
    assert.doesNotMatch(r.output, /PAUSE engaged|pause removed/);
    assert.equal(r.stopAt, -1, "the running container is not stopped");
    assert.equal(r.calls.filter((c) => c.startsWith("rm ") || c.startsWith("kill ")).length, 0);
    assert.equal(r.startAt, -1, "no replacement is started");
    assert.equal(r.ended.outcome, "refused");
  });

  test("W1-T12242 criterion 3: after the wait the start uses the smoked id, and a lost image is pulled and smoked again before docker stop", (t) => {
    const kept = recycleRun(t);
    assert.equal(kept.result.status, 0, kept.output);
    assert.equal(kept.calls.filter((c) => c.startsWith("pull ")).length, 1, "a kept image is not pulled again");
    const check = kept.calls.indexOf(`image inspect ${FIRST}`);
    assert.ok(check > kept.waitAt && check < kept.stopAt, "the smoked id is checked after the wait, before docker stop");
    assert.ok(kept.startAt > kept.stopAt);
    assert.match(kept.output, /recycle-container: OK — remudero-daemon recycled onto sha256:aaaa/);

    const gone = recycleRun(t, { goneAfterWait: true });
    assert.equal(gone.result.status, 0, gone.output);
    assert.equal(gone.calls.filter((c) => c.startsWith("pull ")).length, 2, "the lost image is pulled once more");
    assert.equal(gone.smokes.length, 2, "the re-pulled image is smoked again");
    assert.ok(gone.smokes[0].includes(` ${FIRST} node `));
    assert.ok(gone.smokes[1].includes(` ${SECOND} node `), "the second smoke runs on the re-pulled id");
    assert.ok(gone.smokeAt < gone.waitAt && gone.waitAt < gone.lastSmokeAt, "the second smoke runs after the wait");
    assert.ok(gone.lastSmokeAt < gone.stopAt, "the second smoke runs before docker stop");
    assert.match(gone.output, /recycle-container: OK — remudero-daemon recycled onto sha256:bbbb/);

    const bad = recycleRun(t, { goneAfterWait: true, secondSmokeFails: true });
    assert.equal(bad.result.status, 1, bad.output);
    assert.equal(bad.smokes.length, 2);
    assert.match(bad.output, /REFUSING — the real worker smoke FAILED \(exit 1\) on sha256:bbbb\./);
    assert.match(bad.output, /pause removed — the refusal above must not leave the fleet paused/);
    assert.equal(bad.paused, false, "a refusal after the wait takes this recycle's pause off");
    assert.equal(bad.stopAt, -1, "a failed second smoke never stops the running container");
  });

  test("W1-T12242 criterion 4: the check for a leftover smoke container runs before the smoke", (t) => {
    const exited = recycleRun(t, { leftover: "exited" });
    assert.equal(exited.result.status, 0, exited.output);
    const check = exited.calls.findIndex((c) => c.startsWith("ps -a --filter name=" + SMOKE));
    const removed = exited.calls.indexOf("container rm c-old");
    assert.ok(check >= 0 && check < removed && removed < exited.smokeAt, "the leftover is removed before the smoke");
    assert.match(exited.output, /removed leftover remudero-daemon-worker-smoke \(exited\) before the smoke/);

    const running = recycleRun(t, { leftover: "running" });
    assert.equal(running.result.status, 1, running.output);
    assert.match(running.output, /REFUSING — leftover remudero-daemon-worker-smoke \(running\) blocks the smoke/);
    assert.equal(running.smokes.length, 0, "a blocked check refuses before the smoke");
    assert.equal(running.waitAt, -1);
    assert.equal(running.paused, false);
    assert.equal(running.stopAt, -1);
  });

  test("W1-T12242 criterion 5: recycle.ended states where the smoke ran and how many seconds it took", (t) => {
    const before = recycleRun(t);
    assert.equal(before.ended.smoke_at, "before_pause");
    assert.ok(Number.isInteger(before.ended.smoke_s) && before.ended.smoke_s >= 0, String(before.ended.smoke_s));

    const after = recycleRun(t, { goneAfterWait: true });
    assert.equal(after.ended.smoke_at, "after_wait");
    assert.ok(Number.isInteger(after.ended.smoke_s) && after.ended.smoke_s >= 0);

    const failed = recycleRun(t, { smokeFails: true });
    assert.equal(failed.ended.smoke_at, "before_pause", "a failed smoke still states where it ran");
    assert.ok(Number.isInteger(failed.ended.smoke_s));

    const blocked = recycleRun(t, { leftover: "running" });
    assert.equal(blocked.ended.smoke_at, null, "no smoke ran");
    assert.equal(blocked.ended.smoke_s, null);
  });
});
