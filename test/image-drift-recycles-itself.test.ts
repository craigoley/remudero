import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { deterministicDeployWorth } from "../src/lib/deploy-judge.js";
import {
  decideDeployTrigger,
  IMAGE_BAKED_PATHS,
  IMAGE_RECYCLE_FAILURE_BACKOFF_MS,
  imageRefFor,
  runDeployCycle,
  type DeployDeps,
  type TriggerInputs,
} from "../src/lib/deployer.js";

// Operator ruling 2026-09-22: restarts that big changes need should happen automatically. Mounted
// source already goes live through the daemon's own freshness restart; the human gate was holding
// back only IMAGE drift — measured the same day, a Claude CLI upgrade (#6625) built and published
// at 19:31Z and sat unrunning behind "no operator marker (human-gated; run rmd deploy)".

const REPO_ROOT = join(import.meta.dirname, "..");
const NOW = Date.parse("2026-09-22T21:30:00.000Z");
const NEWEST = "a0548a6bd3a461b6598bb9e8580b1c92152a97ca";

// The watchdog tick's reading on the default fleet: no marker, no DEPLOY_AUTO, image one commit stale.
const tick: TriggerInputs = {
  markerPresent: false,
  autoMode: false,
  installHead: "cccccccccccccccccccccccccccccccccccccccc",
  originMain: "cccccccccccccccccccccccccccccccccccccccc",
  runningHead: "cccccccccccccccccccccccccccccccccccccccc",
  daemonAlive: true,
  stopPresent: false,
  imageDriftOnly: true,
  imageBakedCommitsBehind: 1,
  newestBakedSha: NEWEST,
  nowMs: NOW,
};

test("the tick recycles a published image with no operator marker", () => {
  const d = decideDeployTrigger({ ...tick, imagePublished: true });
  assert.equal(d.deploy, true);
  assert.match(d.reason, /automatic image recycle/);
  assert.match(d.reason, /a0548a6bd is published/);
});

test("an image not yet published, or of unknown publication, waits for the build instead of pulling the old one", () => {
  const notYet = decideDeployTrigger({ ...tick, imagePublished: false });
  assert.equal(notYet.deploy, false);
  assert.match(notYet.reason, /not published yet — waiting for the build/);
  const unknown = decideDeployTrigger({ ...tick, imagePublished: undefined });
  assert.equal(unknown.deploy, false);
  assert.match(unknown.reason, /unknown publication/);
});

test("STOP, the operator's opt-out, and a recent failure each hold the automatic recycle", () => {
  for (const stopPresent of [true, undefined]) {
    const d = decideDeployTrigger({ ...tick, imagePublished: true, stopPresent });
    assert.equal(d.deploy, false, `stopPresent=${stopPresent}`);
    assert.match(d.reason, /STOP is set or unknown/);
  }
  const manual = decideDeployTrigger({ ...tick, imagePublished: true, imageRecycleManual: true });
  assert.equal(manual.deploy, false);
  assert.match(manual.reason, /human-gated; run rmd deploy/, "the opt-out restores today's gate exactly");

  const failedAt = NOW - IMAGE_RECYCLE_FAILURE_BACKOFF_MS + 60_000;
  const backingOff = decideDeployTrigger({ ...tick, imagePublished: true, lastFailedAtMs: failedAt });
  assert.equal(backingOff.deploy, false);
  assert.match(backingOff.reason, /backs off/);
  const after = decideDeployTrigger({ ...tick, imagePublished: true, lastFailedAtMs: NOW - IMAGE_RECYCLE_FAILURE_BACKOFF_MS - 1 });
  assert.equal(after.deploy, true, "the back-off is an hour, not forever");
});

test("mount staleness alone is still the daemon's own job, and the operator's full reading is unchanged", () => {
  const mountOnly = decideDeployTrigger({ ...tick, imageBakedCommitsBehind: 0, imagePublished: true, originMain: "d".repeat(40) });
  assert.equal(mountOnly.deploy, false);
  const full = decideDeployTrigger({ ...tick, imageDriftOnly: undefined, imagePublished: true });
  assert.equal(full.deploy, false, "outside the tick, image drift still waits for rmd deploy");
  assert.match(full.reason, /no operator marker/);
});

test("in DEPLOY_AUTO, low source-change pressure no longer vetoes an image the tick found stale", () => {
  const pressureLow = { restart: false, reason: "restart pressure 1/18 below threshold", total: 1, threshold: 18 };
  const d = decideDeployTrigger({ ...tick, autoMode: true, autoRestartPressure: pressureLow });
  assert.equal(d.deploy, true);
  const mountOnly = decideDeployTrigger({ ...tick, autoMode: true, imageDriftOnly: undefined, imageBakedCommitsBehind: 0, originMain: "d".repeat(40), autoRestartPressure: pressureLow });
  assert.equal(mountOnly.deploy, false, "control: pressure still governs mounted staleness");
});

test("the judge scores an image input at the top rung — only a recycle delivers it", () => {
  for (const file of IMAGE_BAKED_PATHS) {
    assert.equal(deterministicDeployWorth({ sha: "x", files: [file] }).score, 18, file);
  }
  assert.equal(deterministicDeployWorth({ sha: "x", files: ["src/lib/worker.ts"] }).score, 1, "control: source keeps its floor");
});

test("drift detection and the image build trigger watch exactly the same paths", () => {
  const workflow = readFileSync(join(REPO_ROOT, ".github", "workflows", "acr-build.yml"), "utf8");
  const block = /\n {4}paths:\n((?: {6}- .+\n)+)/.exec(workflow);
  assert.ok(block, "acr-build.yml declares a push paths filter");
  const built = block[1].trim().split("\n").map((line) => line.replace(/^\s*-\s*/, "").trim());
  assert.deepEqual([...built].sort(), [...IMAGE_BAKED_PATHS].sort());
  for (const cli of ["deploy/package.json", "deploy/package-lock.json"]) assert.ok(IMAGE_BAKED_PATHS.includes(cli), cli);
});

test("each instance's image comes from its own registry row", () => {
  const registry = readFileSync(join(REPO_ROOT, ".remudero", "daemon-instances.yaml"), "utf8");
  assert.equal(imageRefFor(registry, "/home/craigoleyagent/rmd-state2"), "synthwatcholey0620.azurecr.io/remudero:latest");
  assert.equal(imageRefFor(registry, "/nowhere"), undefined);
});

test("a full supervisor tick asks the registry only on drift, then recycles through the idle gate and health check", () => {
  const calls: string[] = [];
  const asked: string[] = [];
  const deps = (drift: number): DeployDeps => ({
    log: () => {},
    now: () => NOW,
    fetch: () => {},
    installHead: () => tick.installHead,
    runningHead: () => tick.runningHead,
    originMain: () => tick.originMain,
    markerPresent: () => false,
    autoMode: () => false,
    lastFailedHead: () => undefined,
    daemonAlive: () => true,
    stopPresent: () => false,
    imageBakedCommitsBehind: () => drift,
    newestBakedSha: () => NEWEST,
    imagePublished: (sha) => {
      asked.push(sha);
      return true;
    },
    imageRecycleManual: () => false,
    lastFailedAtMs: () => undefined,
    dirtyFiles: () => [],
    incomingFiles: () => [],
    discardLocal: () => {},
    pullFf: () => calls.push("pullFf"),
    resetHard: () => {},
    probeIdle: () => ({ workers: 0, inflightLocks: 0, worktreeLocks: 0 }),
    kickstart: () => calls.push("kickstart"),
    waitBootHealth: () => {
      calls.push("waitBootHealth");
      return { bootObserved: true, crashCount: 0 };
    },
    alert: () => calls.push("alert"),
    clearMarker: () => {},
    kickstartConsole: () => {},
    consolePid: () => 1,
    waitConsoleUp: () => true,
    alertConsoleOnly: () => {},
    deferredSince: () => undefined,
    setDeferredSince: () => {},
    clearDeferredSince: () => {},
  } as DeployDeps);

  const quiet = runDeployCycle(deps(0), { imageDriftOnly: true });
  assert.equal(quiet.deployed, false);
  assert.deepEqual(asked, [], "no drift, no registry call");

  const out = runDeployCycle(deps(1), { imageDriftOnly: true });
  assert.equal(out.deployed, true, out.reason);
  assert.deepEqual(asked, [NEWEST]);
  assert.ok(calls.includes("kickstart") && calls.includes("waitBootHealth"), calls.join(","));
  assert.ok(!calls.includes("alert"), "a healthy recycle raises no alert");
});

test("the real deps read the newest image commit, ask the instance's own image repository, and read the failure time", async () => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { realDeployDeps } = await import("../src/lib/deployer.js");
  const root = mkdtempSync(join(tmpdir(), "rmd-image-recycle-"));
  const install = join(root, "install");
  const state = join(root, "state-root");
  try {
    mkdirSync(join(install, ".remudero"), { recursive: true });
    mkdirSync(join(state, "state"), { recursive: true });
    const registry = readFileSync(join(REPO_ROOT, ".remudero", "daemon-instances.yaml"), "utf8")
      .replace("state_dir: /home/craigoleyagent/rmd-state2", `state_dir: ${state}`);
    writeFileSync(join(install, ".remudero", "daemon-instances.yaml"), registry);
    const inspected: string[] = [];
    const execFile = (cmd: string, args: string[]): string => {
      if (cmd === "git" && args.includes("log")) return `${NEWEST}\n`;
      if (cmd === "docker" && args[0] === "manifest") {
        const ref = args[2]!;
        inspected.push(ref);
        if (ref.endsWith(NEWEST)) return "{}";
        if (ref.endsWith("unauthorized")) throw new Error("Command failed: docker manifest inspect\nunauthorized: authentication required");
        throw new Error(`Command failed: docker manifest inspect\nno such manifest: ${ref}`);
      }
      return "";
    };
    const deps = realDeployDeps({
      installPath: install,
      stateRoot: state,
      daemonLabel: "com.remudero.daemon",
      serveLabel: "com.remudero.serve",
      servePort: 4317,
      uid: 502,
      ledgerPath: join(root, "ledger.ndjson"),
      log: () => {},
      execFile,
      sleep: () => {},
    });
    assert.equal(deps.newestBakedSha?.(), NEWEST);
    const gitless = realDeployDeps({
      installPath: install, stateRoot: state, daemonLabel: "com.remudero.daemon", serveLabel: "com.remudero.serve",
      servePort: 4317, uid: 502, ledgerPath: join(root, "ledger.ndjson"), log: () => {}, sleep: () => {},
      execFile: () => { throw new Error("git: not a repository"); },
    });
    assert.equal(gitless.newestBakedSha?.(), undefined, "no git answer is unknown, so the tick waits");
    assert.equal(deps.imagePublished?.(NEWEST), true);
    assert.equal(inspected[0], `synthwatcholey0620.azurecr.io/remudero:${NEWEST}`, "the tag replaces :latest on the instance's own image");
    assert.equal(deps.imagePublished?.("f".repeat(40)), false, "the registry said no such tag");
    assert.equal(deps.imagePublished?.("unauthorized"), undefined, "auth trouble is unknown, never a no");

    assert.equal(deps.imageRecycleManual?.(), false);
    writeFileSync(join(state, "state", "DEPLOY_IMAGE_MANUAL"), "");
    assert.equal(deps.imageRecycleManual?.(), true);

    assert.equal(deps.lastFailedAtMs?.(), undefined);
    writeFileSync(join(state, "state", "DEPLOY_FAILED"), JSON.stringify({ at: "2026-09-22T20:00:00.000Z" }));
    assert.equal(deps.lastFailedAtMs?.(), Date.parse("2026-09-22T20:00:00.000Z"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
