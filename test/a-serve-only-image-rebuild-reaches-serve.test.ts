import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { IMAGE_BAKED_PATHS } from "#src/lib/deploy-judge.js";
import type { Escalation } from "#src/lib/escalate.js";
import { realServePolicyDeps, runServePolicyCycle, type ServeImageDrift, type ServeImageInputs } from "#src/lib/serve-policy-convergence.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

// W1-T9487 — 2026-10-14: #11665 changed only serve-supervisor source, acr-build.yml published its
// image, the build daemon (W1-T9094) rightly stayed put, and serve — judged against the daemon's
// image — never moved either.
const OLD_BUILD = "510cfc9973204f1a5e9376f96c82cf72717ce784";
const NEW_BUILD = "ba5c02fd4c9b8a7e6f5d4c3b2a1098765432100f";
const DAEMON_IMAGE = `sha256:${"3".repeat(64)}`;
const NEW_SERVE_IMAGE = `sha256:${"b".repeat(64)}`;
const NOW = Date.parse("2026-10-14T16:30:00Z");
const TICK = { imageDriftOnly: true };
type ServeDeps = Parameters<typeof runServePolicyCycle>[0];

function harness(inputs: (ServeImageInputs | undefined)[], over: Partial<ServeDeps> = {}) {
  const rows: { step: string; data?: Record<string, unknown> }[] = [];
  const failures: string[] = [];
  const escalations: Escalation[] = [];
  const published: string[] = [];
  let replaced = 0;
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
    serveImageInputs: () => inputs[Math.min(read++, inputs.length - 1)],
    // the daemon keeps its older image: serve ≠ daemon once serve moves, which must not read as drift
    serveImageDrift: (): ServeImageDrift | undefined => replaced > 0 ? { expected: DAEMON_IMAGE, actual: NEW_SERVE_IMAGE } : undefined,
    newestBakedSha: () => NEW_BUILD,
    imagePublished: (sha: string) => { published.push(sha); return sha === NEW_BUILD; },
    replaceServe: () => { replaced++; },
    clearServePolicyFailure: () => {},
    recordServePolicyFailure: (message: string) => failures.push(message),
    escalate: (e: Escalation) => escalations.push(e),
    ...over,
  } as unknown as ServeDeps;
  return { deps, rows, failures, escalations, published, replaces: () => replaced };
}

function primary(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}serve-inputs-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installPath = join(root, "install");
  const stateRoot = join(root, "primary-state");
  mkdirSync(join(installPath, ".remudero"), { recursive: true });
  writeFileSync(join(installPath, ".remudero", "daemon-instances.yaml"),
    `instances:\n  core:\n    primary: true\n    state_dir: ${stateRoot}\n    container_name: remudero-daemon\n`);
  return { root, installPath, stateRoot };
}

test("W1-T9487: a serve-only image rebuild reaches serve", () => {
  const h = harness([{ buildSha: OLD_BUILD, behind: 3 }, { buildSha: NEW_BUILD, behind: 0 }]);
  const out = runServePolicyCycle(h.deps, TICK);
  assert.equal(out.replaced, true, out.reason);
  assert.equal(h.replaces(), 1);
  assert.deepEqual(out.imageDrift, { expected: NEW_BUILD, actual: OLD_BUILD, basis: "serve-inputs" });
  assert.match(out.reason, new RegExp(`serve image drift \\(expected=${NEW_BUILD} actual=${OLD_BUILD}\\)`));
  assert.deepEqual(h.published, [NEW_BUILD]);
  assert.deepEqual(h.rows.map(r => r.step), ["deploy.serve_policy_replace", "deploy.serve_policy_replaced"]);
  assert.deepEqual(h.failures, []);
  assert.deepEqual(h.escalations, []);
});

test("W1-T9487: serve on every input of its own is converged, whatever image the daemon runs", () => {
  const h = harness([{ buildSha: NEW_BUILD, behind: 0 }], { serveImageDrift: () => ({ expected: DAEMON_IMAGE, actual: NEW_SERVE_IMAGE }) });
  const out = runServePolicyCycle(h.deps, TICK);
  assert.equal(out.replaced, false);
  assert.equal(out.imageDrift, undefined);
  assert.equal(h.replaces(), 0);
  assert.deepEqual(h.rows, []);
  assert.deepEqual(h.published, []);
});

test("W1-T9487: a serve input with no published image waits for the build and replaces nothing", () => {
  for (const [answer, words] of [[false, /not published yet/], [undefined, /of unknown publication/]] as const) {
    const h = harness([{ buildSha: OLD_BUILD, behind: 1 }], { imagePublished: () => answer });
    const out = runServePolicyCycle(h.deps, TICK);
    assert.equal(out.replaced, false);
    assert.equal(h.replaces(), 0);
    assert.ok(out.imageDrift && "kind" in out.imageDrift, JSON.stringify(out.imageDrift));
    assert.match(out.reason, /unknown is never drift/);
    assert.match(out.reason, words);
    assert.match(out.reason, /1 image-input commit\(s\) behind/);
    assert.deepEqual(h.rows, []);
  }
  const unnamed = harness([{ buildSha: OLD_BUILD, behind: 2 }], { newestBakedSha: () => undefined });
  const out = runServePolicyCycle(unnamed.deps, TICK);
  assert.equal(out.replaced, false);
  assert.match(out.reason, /the newest image input is unknown/);
});

test("W1-T9487: an unreadable serve build sha leaves the daemon comparison deciding", () => {
  const drift = { expected: DAEMON_IMAGE, actual: `sha256:${"0".repeat(64)}` };
  const h = harness([undefined], { serveImageDrift: () => drift, replaceServe: () => {} });
  const out = runServePolicyCycle(h.deps, TICK);
  assert.equal(out.replaced, false);
  assert.deepEqual(out.imageDrift, drift);
  assert.match(out.reason, /image still off the daemon after the replace/);
  assert.deepEqual(h.published, []);
});

test("W1-T9487: a replace that leaves serve behind a published input is a failure", () => {
  const h = harness([{ buildSha: OLD_BUILD, behind: 3 }]);
  const out = runServePolicyCycle(h.deps, TICK);
  assert.equal(out.replaced, false);
  assert.equal(h.replaces(), 1);
  assert.match(out.reason, new RegExp(`image still behind its newest published input after the replace \\(expected=${NEW_BUILD} actual=${OLD_BUILD}\\)`));
  assert.equal(h.failures.length, 1);
  assert.equal(h.escalations.length, 1);
  const unread = harness([{ buildSha: OLD_BUILD, behind: 3 }, undefined], { serveImageDrift: () => undefined });
  assert.equal(runServePolicyCycle(unread.deps, TICK).replaced, true, "an unreadable re-read falls back to the daemon comparison");
});

test("W1-T9487: the real reader counts serve's own image inputs from its build sha", (t) => {
  const f = primary(t);
  const calls: string[][] = [];
  let buildSha = `${OLD_BUILD}\n`;
  let revList: () => string = () => "2\n";
  const seams = realServePolicyDeps(f, (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "docker") return buildSha;
    if (args.includes("rev-list")) return revList();
    throw new Error("no lockfile at that sha"); // the lockfile image inputs read unknown, never drift
  });
  assert.deepEqual(seams.serveImageInputs!(), { buildSha: OLD_BUILD, behind: 2 });
  assert.deepEqual(calls[0], ["docker", "exec", "remudero-serve", "cat", "/etc/rmd-build-sha"]);
  assert.deepEqual(calls[1], ["git", "-C", f.installPath, "rev-list", "--count", `${OLD_BUILD}..origin/main`, "--", ...IMAGE_BAKED_PATHS]);
  for (const bad of ["unknown\n", "", "510cfc997\n"]) {
    buildSha = bad;
    assert.equal(seams.serveImageInputs!(), undefined, `build sha ${JSON.stringify(bad)}`);
  }
  buildSha = OLD_BUILD;
  revList = () => { throw new Error("unknown revision"); };
  assert.equal(seams.serveImageInputs!(), undefined);
  const down = realServePolicyDeps(f, (cmd) => { if (cmd === "docker") throw new Error("no such container"); return "0"; });
  assert.equal(down.serveImageInputs!(), undefined);
  assert.equal(realServePolicyDeps({ ...f, stateRoot: join(f.root, "secondary") }).serveImageInputs, undefined);
});
