// W1-T4589: the automatic image recycle (operator ruling 2026-09-22) waits until the new image is
// PUBLISHED, but only on the default fleet -- its branch is guarded by `!autoMode`. A host with
// state/DEPLOY_AUTO fell through to `auto mode + ...` on image drift alone, so it could recycle while
// acr-build was still running and restart onto the old :latest.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decideDeployTrigger, type TriggerInputs } from "../src/lib/deployer.js";

const HEAD = "c".repeat(40);
const OLDER = "b".repeat(40);

/** The auto-mode watchdog tick: checkout and daemon current, image one baked commit behind. */
const autoImageDrift: TriggerInputs = {
  markerPresent: false,
  autoMode: true,
  installHead: HEAD,
  originMain: HEAD,
  runningHead: HEAD,
  daemonAlive: true,
  stopPresent: false,
  imageDriftOnly: true,
  imageBakedCommitsBehind: 1,
  newestBakedSha: HEAD,
  nowMs: Date.parse("2026-09-26T22:00:00.000Z"),
};

test("W1-T4589: an auto-mode host with image drift waits for the image to be published", () => {
  for (const imagePublished of [false, undefined]) {
    const d = decideDeployTrigger({ ...autoImageDrift, imagePublished });
    assert.equal(d.deploy, false, `imagePublished=${String(imagePublished)} must wait for the build`);
    assert.match(d.reason, /waiting for the build/);
  }
  const published = decideDeployTrigger({ ...autoImageDrift, imagePublished: true });
  assert.equal(published.deploy, true, "once published, auto mode recycles");
});

test("W1-T4589: auto mode still deploys at once for mounted staleness, published image or not", () => {
  const behind = decideDeployTrigger({ ...autoImageDrift, imageDriftOnly: false, installHead: OLDER, imagePublished: false });
  assert.equal(behind.deploy, true, "a stale checkout is not held back by an unpublished image");
  const current = decideDeployTrigger({ ...autoImageDrift, imageBakedCommitsBehind: 0, imagePublished: false });
  assert.equal(current.deploy, false, "nothing stale, nothing to do");
});
