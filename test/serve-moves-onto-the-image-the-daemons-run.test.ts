import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { IMAGE_RECYCLE_FAILURE_BACKOFF_MS } from "../src/lib/deployer.js";
import type { Escalation } from "../src/lib/escalate.js";
import { realServePolicyDeps, runServePolicyCycle, type ServeImageDrift } from "../src/lib/serve-policy-convergence.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const OLD = `sha256:${"b".repeat(64)}`;
const CURRENT = `sha256:${"e".repeat(64)}`;
const DRIFT = { expected: CURRENT, actual: OLD };
const NOW = Date.parse("2026-10-07T16:27:00Z");
const TICK = { imageDriftOnly: true };
type ServeDeps = Parameters<typeof runServePolicyCycle>[0];

function harness(over: Partial<ServeDeps> = {}, readings: (ServeImageDrift | undefined)[] = [DRIFT, undefined]) {
  const rows: { step: string; data?: Record<string, unknown> }[] = [];
  const failures: { message: string; atMs: number }[] = [];
  const escalations: Escalation[] = [];
  let replaced = 0;
  let cleared = 0;
  let read = 0;
  const deps = {
    log: (step: string, data?: Record<string, unknown>) => rows.push({ step, data }),
    now: () => NOW,
    stopPresent: () => false,
    pausePresent: () => false,
    serveHandoffInProgress: () => false,
    serveHealthy: () => true,
    servePolicyLastFailedAtMs: () => undefined,
    servePolicyDrift: () => [],
    serveMountPlanDrift: () => [],
    serveImageDrift: () => readings[Math.min(read++, readings.length - 1)],
    replaceServe: () => { replaced++; },
    clearServePolicyFailure: () => { cleared++; },
    recordServePolicyFailure: (message: string, atMs: number) => failures.push({ message, atMs }),
    escalate: (e: Escalation) => escalations.push(e),
    ...over,
  } as unknown as ServeDeps;
  return { deps, rows, failures, escalations, replaces: () => replaced, clears: () => cleared };
}

function primary(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}serve-image-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installPath = join(root, "install");
  const stateRoot = join(root, "primary-state");
  mkdirSync(join(installPath, ".remudero"), { recursive: true });
  writeFileSync(join(installPath, ".remudero", "daemon-instances.yaml"),
    `instances:\n  core:\n    primary: true\n    state_dir: ${stateRoot}\n    container_name: custom-primary\n`);
  return { root, installPath, stateRoot };
}

test("W1-T6245: serve on an older image than the daemons is replaced", () => {
  const h = harness();
  const out = runServePolicyCycle(h.deps, TICK);
  assert.equal(out.replaced, true, out.reason);
  assert.equal(h.replaces(), 1);
  assert.deepEqual(out.imageDrift, DRIFT);
  assert.match(out.reason, /serve image drift/);
  assert.ok(out.reason.includes(`expected=${CURRENT} actual=${OLD}`));
  assert.deepEqual(h.rows.map(r => r.step), ["deploy.serve_policy_replace", "deploy.serve_policy_replaced"]);
  for (const row of h.rows) assert.deepEqual(row.data?.imageDrift, DRIFT);
  assert.equal(h.clears(), 1);
  assert.equal(h.failures.length + h.escalations.length, 0);
  const otherUnknown = harness({ servePolicyDrift: () => undefined, serveMountPlanDrift: () => undefined });
  assert.equal(runServePolicyCycle(otherUnknown.deps, TICK).replaced, true);
});

test("W1-T6245: an unreadable serve image id replaces nothing", (t) => {
  const f = primary(t);
  const seams = realServePolicyDeps(f, (_cmd, args) => {
    if (args[1] === "remudero-serve") throw new Error("serve inspect denied");
    return CURRENT;
  });
  const h = harness({ serveImageDrift: seams.serveImageDrift });
  const out = runServePolicyCycle(h.deps, TICK);
  assert.equal(out.replaced, false);
  assert.equal(h.replaces(), 0);
  assert.deepEqual(out.imageDrift, { kind: "unknown", reason: "serve inspect denied" });
  assert.match(out.reason, /image unreadable/);
  assert.equal(h.rows.length, 0);
});

test("image drift shares every serve hold, dry run and primary watchdog restriction", () => {
  const cases: [Partial<ServeDeps>, RegExp][] = [
    [{ stopPresent: () => true }, /STOP/],
    [{ stopPresent: () => undefined }, /STOP/],
    [{ pausePresent: () => true }, /PAUSE/],
    [{ pausePresent: () => undefined }, /PAUSE/],
    [{ serveHandoffInProgress: () => true }, /handoff/],
    [{ serveHandoffInProgress: () => undefined }, /handoff/],
    [{ serveHealthy: () => false }, /not healthy/],
    [{ serveHealthy: () => undefined }, /not healthy/],
    [{ servePolicyLastFailedAtMs: () => NOW - 60_000 }, /backing off/],
  ];
  for (const [over, why] of cases) {
    const h = harness(over);
    const out = runServePolicyCycle(h.deps, TICK);
    assert.equal(out.replaced, false);
    assert.equal(h.replaces(), 0);
    assert.match(out.reason, why);
    assert.deepEqual(h.rows.map(r => r.step), ["deploy.serve_policy_held"]);
    assert.deepEqual(h.rows[0]?.data?.imageDrift, DRIFT);
  }
  const dry = harness();
  assert.match(runServePolicyCycle(dry.deps, { ...TICK, dryRun: true }).reason, /dry run/);
  assert.equal(dry.replaces(), 0);
  assert.deepEqual(dry.rows[0]?.data?.imageDrift, DRIFT);
  const ordinary = harness();
  assert.equal(runServePolicyCycle(ordinary.deps).replaced, false);
  assert.equal(ordinary.replaces(), 0);
  const unwired = harness({ replaceServe: undefined });
  assert.equal(runServePolicyCycle(unwired.deps, TICK).replaced, false);
  const expired = harness({ servePolicyLastFailedAtMs: () => NOW - IMAGE_RECYCLE_FAILURE_BACKOFF_MS });
  assert.equal(runServePolicyCycle(expired.deps, TICK).replaced, true);
});

test("an image replace verifies the image and records failed or unreadable verification", () => {
  for (const after of [DRIFT, { kind: "unknown" as const, reason: "docker unavailable" }]) {
    const h = harness({}, [DRIFT, after]);
    const out = runServePolicyCycle(h.deps, TICK);
    assert.equal(out.replaced, false);
    assert.equal(h.replaces(), 1);
    assert.match(out.reason, /image still off the daemon after the replace/);
    assert.equal(h.clears(), 0);
    assert.equal(h.failures[0]?.atMs, NOW);
    assert.equal(h.rows.at(-1)?.step, "deploy.serve_policy_failed");
    assert.deepEqual(h.rows.at(-1)?.data?.imageDrift, DRIFT);
    assert.equal(h.escalations.length, 1);
    assert.ok(h.escalations[0]!.detail.includes(`image drift: expected=${CURRENT} actual=${OLD}`));
    if ("kind" in after) assert.match(out.reason, /docker unavailable/);
  }
  const thrown = harness({ replaceServe: () => { throw new Error("pull refused"); } });
  assert.match(runServePolicyCycle(thrown.deps, TICK).reason, /pull refused/);
  assert.equal(thrown.failures.length, 1);
  assert.deepEqual(thrown.rows.at(-1)?.data?.imageDrift, DRIFT);
});

test("matching images and an unwired image reader leave serve alone", () => {
  for (const over of [{}, { serveImageDrift: undefined }]) {
    const h = harness(over, [undefined]);
    const out = runServePolicyCycle(h.deps, TICK);
    assert.equal(out.replaced, false);
    assert.equal(h.replaces(), 0);
    assert.equal(h.rows.length, 0);
    assert.equal(Object.hasOwn(out, "imageDrift"), true);
  }
});

test("the real image reader compares docker image ids using the registry's primary daemon", (t) => {
  const f = primary(t);
  let serve = OLD;
  const calls: string[][] = [];
  const seams = realServePolicyDeps(f, (cmd, args) => {
    calls.push([cmd, ...args]);
    return args[1] === "remudero-serve" ? serve : CURRENT;
  });
  assert.deepEqual(seams.serveImageDrift!(), DRIFT);
  assert.deepEqual(calls, [
    ["docker", "inspect", "remudero-serve", "--format", "{{.Image}}"],
    ["docker", "inspect", "custom-primary", "--format", "{{.Image}}"],
  ]);
  serve = CURRENT;
  assert.equal(seams.serveImageDrift!(), undefined);
  serve = OLD;
  const h = harness({ serveImageDrift: seams.serveImageDrift, replaceServe: () => { serve = CURRENT; } });
  const out = runServePolicyCycle(h.deps, TICK);
  assert.equal(out.replaced, true, out.reason);
  assert.equal(serve, CURRENT);
  assert.deepEqual(h.rows.at(-1)?.data?.imageDrift, DRIFT);
  assert.equal(realServePolicyDeps({ ...f, stateRoot: join(f.root, "secondary") }).serveImageDrift, undefined);
});

test("unreadable daemon ids and empty or malformed image ids are unknown", (t) => {
  const f = primary(t);
  for (const container of ["remudero-serve", "custom-primary"]) {
    for (const bad of ["", "latest", "<no value>", "sha256:short"]) {
      const seams = realServePolicyDeps(f, (_cmd, args) => args[1] === container ? bad : CURRENT);
      assert.deepEqual(seams.serveImageDrift!(), { kind: "unknown", reason: "serve or daemon image id unreadable" });
    }
  }
  const seams = realServePolicyDeps(f, (_cmd, args) => {
    if (args[1] === "custom-primary") throw "daemon missing";
    return OLD;
  });
  assert.deepEqual(seams.serveImageDrift!(), { kind: "unknown", reason: "daemon missing" });
  const h = harness({ serveImageDrift: seams.serveImageDrift });
  assert.equal(runServePolicyCycle(h.deps, TICK).replaced, false);
  assert.equal(h.replaces(), 0);
});

test("the default image seam shells out and reports docker failures as unknown", (t) => {
  const f = primary(t);
  const docker = join(f.root, "docker");
  writeFileSync(docker, `#!/bin/sh\ncase "$2" in\nremudero-serve) echo '${OLD}';;\ncustom-primary) echo '${CURRENT}';;\nesac\n`);
  chmodSync(docker, 0o755);
  const run = () => execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import { realServePolicyDeps } from './src/lib/serve-policy-convergence.ts';
     console.log(JSON.stringify(realServePolicyDeps(${JSON.stringify(f)}).serveImageDrift()));`],
    { cwd: join(import.meta.dirname, ".."), encoding: "utf8", env: { ...process.env, PATH: `${f.root}:${process.env.PATH}` } });
  assert.deepEqual(JSON.parse(run()), DRIFT);
  writeFileSync(docker, "#!/bin/sh\necho 'docker unavailable' >&2\nexit 1\n");
  const unknown = JSON.parse(run()) as { kind: string; reason: string };
  assert.equal(unknown.kind, "unknown");
  assert.match(unknown.reason, /docker unavailable/);
});
