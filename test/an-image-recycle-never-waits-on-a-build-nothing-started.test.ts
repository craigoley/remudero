// W1-T4809: observed 2026-09-29 — two merges landed 13 seconds apart, GitHub fired no push event for
// the first (a deploy/ change), so nothing ever built it; the deploy tick then asked the registry for
// an image tagged with THAT exact commit, which no later build can satisfy, and logged "not published
// yet — waiting for the build" every five minutes for 3.5 hours. The fix: an image built from a
// commit that CONTAINS the baked change counts as published, and when no image does and no build is
// queued or running, the tick dispatches the build itself, once.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  githubSlugOf,
  realDeployDeps,
  runDeployCycle,
  type DeployDeps,
} from "../src/lib/deployer.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const NOW = Date.parse("2026-09-29T18:40:00.000Z");
const HEAD = "c".repeat(40);
/** The baked change no push event ever built. */
const BAKED = "3".repeat(40);
/** A later main commit that a manual dispatch built — it contains BAKED. */
const LATER = "4".repeat(40);
/** An older image that predates BAKED. */
const OLDER = "1".repeat(40);
const REPO = "synthwatcholey0620.azurecr.io/remudero";

test("W1-T4809: a published image built after the baked change satisfies the recycle", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-image-descendant-"));
  try {
    const install = join(root, "install");
    const state = join(root, "state-root");
    mkdirSync(join(install, ".remudero"), { recursive: true });
    mkdirSync(join(state, "state"), { recursive: true });
    writeFileSync(
      join(install, ".remudero", "daemon-instances.yaml"),
      readFileSync(join(REPO_ROOT, ".remudero", "daemon-instances.yaml"), "utf8")
        .replace("state_dir: /home/craigoleyagent/rmd-state2", `state_dir: ${state}`),
    );
    const inspected: string[] = [];
    // The registry holds two images: one at OLDER (predates BAKED) and the manual build at LATER.
    // No image is tagged with BAKED itself — that is the whole incident.
    const commitOfTag: Record<string, string> = { "image/20260929-4444444": LATER, "image/20260920-1111111": OLDER };
    const execFile = (cmd: string, args: string[]): string => {
      if (cmd === "git" && args.includes("tag")) return Object.keys(commitOfTag).join("\n") + "\n";
      if (cmd === "git" && args.includes("rev-list")) return `${commitOfTag[args[args.length - 1]!]}\n`;
      if (cmd === "git" && args.includes("merge-base")) {
        const built = args[args.length - 1]!;
        if (built === LATER) return ""; // BAKED is an ancestor of LATER
        throw Object.assign(new Error("exit 1"), { status: 1 }); // and not of OLDER
      }
      if (cmd === "docker" && args[0] === "manifest") {
        const ref = args[2]!;
        inspected.push(ref);
        if (ref === `${REPO}:${LATER}` || ref === `${REPO}:${OLDER}`) return "{}";
        throw new Error(`Command failed: docker manifest inspect\nno such manifest: ${ref}`);
      }
      return "";
    };
    const events: { step: string; data?: Record<string, unknown> }[] = [];
    const deps = realDeployDeps({
      installPath: install, stateRoot: state, daemonLabel: "com.remudero.daemon", serveLabel: "com.remudero.serve",
      servePort: 4317, uid: 502, ledgerPath: join(root, "ledger.ndjson"),
      log: (step, data) => events.push({ step, data }), execFile, sleep: () => {},
    });

    assert.equal(deps.imagePublished?.(BAKED), true, "an image built at a descendant contains the change");
    assert.deepEqual(inspected, [`${REPO}:${BAKED}`, `${REPO}:${LATER}`], "exact tag first, then the containing build");
    assert.ok(events.some((e) => e.step === "deploy.image_published_by_descendant"), "the descendant is named in the ledger");

    // Control: with only the OLDER image published, nothing contains BAKED — still a registry "no".
    delete commitOfTag["image/20260929-4444444"];
    assert.equal(deps.imagePublished?.(BAKED), false, "an image that predates the change does not satisfy it");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4809: a baked change no build covers dispatches the build exactly once", () => {
  const events: { step: string; data?: Record<string, unknown> }[] = [];
  let dispatches = 0;
  let buildRunning = false;
  const deps = (): DeployDeps => ({
    log: (step, data) => events.push({ step, data }),
    now: () => NOW,
    fetch: () => {},
    installHead: () => HEAD,
    runningHead: () => HEAD,
    originMain: () => HEAD,
    markerPresent: () => false,
    autoMode: () => false,
    lastFailedHead: () => undefined,
    daemonAlive: () => true,
    stopPresent: () => false,
    imageBakedCommitsBehind: () => 1,
    newestBakedSha: () => BAKED,
    imagePublished: () => false,
    imageBuildInFlight: () => buildRunning,
    dispatchImageBuild: () => {
      dispatches += 1;
      buildRunning = true; // the dispatched run is now queued
    },
    imageRecycleManual: () => false,
    lastFailedAtMs: () => undefined,
    dirtyFiles: () => [],
    incomingFiles: () => [],
    discardLocal: () => {},
    pullFf: () => {},
    resetHard: () => {},
    probeIdle: () => ({ workers: 0, inflightLocks: 0, worktreeLocks: 0 }),
    kickstart: () => {},
    waitBootHealth: () => ({ bootObserved: true, crashCount: 0 }),
    alert: () => {},
    clearMarker: () => {},
    kickstartConsole: () => {},
    consolePid: () => 1,
    waitConsoleUp: () => true,
    alertConsoleOnly: () => {},
    deferredSince: () => undefined,
    setDeferredSince: () => {},
    clearDeferredSince: () => {},
  } as DeployDeps);

  const first = runDeployCycle(deps(), { imageDriftOnly: true });
  assert.equal(first.deployed, false, "nothing published, so nothing recycles");
  assert.equal(dispatches, 1, "no image and no build in flight: the tick starts the build");
  assert.equal(events.filter((e) => e.step === "deploy.image_build_dispatched").length, 1);

  runDeployCycle(deps(), { imageDriftOnly: true });
  runDeployCycle(deps(), { imageDriftOnly: true });
  assert.equal(dispatches, 1, "a queued or running build is waited on, never re-dispatched per tick");

  // Unknown is not "no build running": an unreadable run list must never dispatch.
  buildRunning = false;
  const unknown = { ...deps(), imageBuildInFlight: () => undefined };
  runDeployCycle(unknown, { imageDriftOnly: true });
  assert.equal(dispatches, 1, "an unanswered in-flight read does not dispatch");

  // A published image never dispatches.
  const published = { ...deps(), imagePublished: () => true };
  const out = runDeployCycle(published, { imageDriftOnly: true });
  assert.equal(dispatches, 1, "a published image needs no build");
  assert.equal(out.deployed, true, out.reason);

  assert.equal(githubSlugOf("https://github.com/craigoley/remudero.git\n"), "craigoley/remudero");
  assert.equal(githubSlugOf("git@github.com:craigoley/remudero.git"), "craigoley/remudero");
  assert.equal(githubSlugOf("/srv/mirror/remudero"), undefined);
});
