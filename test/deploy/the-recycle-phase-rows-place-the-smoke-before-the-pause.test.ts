import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim, type GhShimRoute } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T12359: the real deploy/recycle-container.sh runs against a PATH shim named `docker`, the
// fixture of the W1-T12242 smoke test. Nothing here reaches a real container.
type Row = Record<string, unknown>;
const SCRIPT = join(REPO_ROOT, "deploy/recycle-container.sh");
const DAEMON = "remudero-daemon";
const SMOKE = `${DAEMON}-worker-smoke`;
const FIRST = "sha256:aaaa";
const SECOND = "sha256:bbbb";
// A loaded host can spend a few seconds in any phase, so the slow smoke is longer than that.
const SMOKE_DELAY_S = 6;
const LEFTOVER_DELAY_S = 3;

interface Scenario {
  smokeFails?: boolean;
  /** The first smoke takes SMOKE_DELAY_S seconds. */
  slowSmoke?: boolean;
  /** A leftover smoke container whose removal takes LEFTOVER_DELAY_S seconds. */
  slowLeftover?: boolean;
  /** The first pulled image is gone after the wait; the re-pull resolves to SECOND, whose smoke is slow. */
  goneAfterWait?: boolean;
}

function recycleRun(t: TestContext, scenario: Scenario = {}) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}smoke-phase-rows-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["state", "tmp", "home", "claude"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "key"), "fixture-key\n", { mode: 0o600 });
  const imageId = join(root, "image-id");
  writeFileSync(imageId, `${FIRST}\n`);
  const routes: GhShimRoute[] = [];
  if (scenario.goneAfterWait) {
    routes.push(
      { when: `image inspect ${FIRST}`, exit: 1, writes: { path: imageId, content: `${SECOND}\n` } },
      { when: ` ${SECOND} node `, stdout: "WORKER-SMOKE PASS second", delaySeconds: SMOKE_DELAY_S },
    );
  }
  if (scenario.slowLeftover) routes.push({ when: "container rm c-old", delaySeconds: LEFTOVER_DELAY_S });
  routes.push(
    {
      when: "container run",
      stdout: scenario.smokeFails ? "WORKER-SMOKE FAIL fixture" : "WORKER-SMOKE PASS fixture",
      exit: scenario.smokeFails ? 1 : 0,
      ...(scenario.slowSmoke ? { delaySeconds: SMOKE_DELAY_S } : {}),
    },
    { when: "image inspect", stdoutFile: imageId },
    { when: "ps -a --filter", stdout: scenario.slowLeftover ? `c-old ${SMOKE} exited` : "" },
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
    timeout: 90_000,
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
  const ledger = join(root, "state/ledger.ndjson");
  const rows: Row[] = existsSync(ledger)
    ? readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row) : [];
  const phases = rows.filter((row) => row.step === "recycle.phase");
  return {
    result,
    output: result.stdout + result.stderr,
    phases,
    names: phases.map((row) => row.phase),
    row: (name: string) => phases.filter((row) => row.phase === name),
    ended: rows.find((row) => row.step === "recycle.ended"),
    paused: existsSync(join(root, "state/PAUSE")),
  };
}

const seconds = (row: Row | undefined) => {
  assert.ok(row && Number.isInteger(row.seconds), JSON.stringify(row));
  return row.seconds as number;
};

describe("test/deploy/the-recycle-phase-rows-place-the-smoke-before-the-pause.test.ts", () => {
  test("W1-T12359: a recycle writes the smoke row before the pause row", (t) => {
    const r = recycleRun(t);
    assert.equal(r.result.status, 0, r.output);
    assert.deepEqual(r.names, ["lock_wait", "registry_login", "pull", "smoke", "pause", "wait_for_workers", "stop", "remove", "start"]);
    assert.equal(typeof r.row("pull")[0]?.image_changed, "boolean", "the pull row keeps its image_changed field");
    assert.equal(r.row("smoke")[0]?.smoke_at, "before_pause");
    assert.equal(r.row("pause")[0]?.smoke_at, undefined, "only a smoke row names where the smoke ran");
  });

  test("W1-T12359: the pause row does not count the smoke time", (t) => {
    const r = recycleRun(t, { slowSmoke: true, slowLeftover: true });
    assert.equal(r.result.status, 0, r.output);
    assert.match(r.output, /removed leftover remudero-daemon-worker-smoke \(exited\) before the smoke/);
    const smoke = r.row("smoke");
    assert.equal(smoke.length, 1, JSON.stringify(r.phases));
    assert.equal(smoke[0]?.smoke_at, "before_pause");
    // The smoke row holds the leftover removal and the smoke.
    assert.ok(seconds(smoke[0]) >= LEFTOVER_DELAY_S + SMOKE_DELAY_S, JSON.stringify(smoke[0]));
    assert.ok(seconds(r.row("pause")[0]) < SMOKE_DELAY_S, JSON.stringify(r.row("pause")[0]));
  });

  test("W1-T12359: a second smoke after the wait writes its own smoke row", (t) => {
    const r = recycleRun(t, { goneAfterWait: true });
    assert.equal(r.result.status, 0, r.output);
    assert.deepEqual(r.names, [
      "lock_wait", "registry_login", "pull", "smoke", "pause", "wait_for_workers", "smoke", "stop", "remove", "start",
    ]);
    const [first, second] = r.row("smoke");
    assert.equal(first?.smoke_at, "before_pause");
    assert.equal(second?.smoke_at, "after_wait");
    assert.ok(seconds(second) >= SMOKE_DELAY_S, JSON.stringify(second));
    assert.ok(seconds(r.row("wait_for_workers")[0]) < SMOKE_DELAY_S, JSON.stringify(r.row("wait_for_workers")[0]));
    assert.equal(r.row("wait_for_workers")[0]?.smoke_at, undefined);
    assert.equal(r.ended?.smoke_at, "after_wait");
  });

  test("W1-T12359: a failed smoke before the pause writes no pause row", (t) => {
    const r = recycleRun(t, { smokeFails: true });
    assert.equal(r.result.status, 1, r.output);
    assert.match(r.output, /The fleet was not paused\./);
    assert.deepEqual(r.names, ["lock_wait", "registry_login", "pull", "smoke"]);
    assert.equal(r.row("smoke")[0]?.smoke_at, "before_pause");
    assert.equal(r.ended?.outcome, "refused");
    assert.equal(r.ended?.phase, "smoke");
    assert.equal(r.paused, false);
  });
});
