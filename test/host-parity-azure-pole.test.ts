/**
 * THE THIRD POLE: the containerised daemon host, which used to report as `ci`.
 *
 * `scripts/host-parity.ts` decided the pole with `process.platform === "darwin" ? "mini" : "ci"`,
 * under a comment that lumped the two remaining cases together in as many words — *"Anything else
 * running this is a runner or a container, and its failure set belongs to the OTHER side of the
 * diff."* A runner and a container are not the same side. MEASURED on the Azure container at
 * `3a5c677`: 16 failures diffed against a `ci` baseline whose single entry is none of them.
 *
 * THIS FILE IS HOST-INDEPENDENT, like its sibling and for the same reason: a parity checker whose
 * own fixtures borrow the ambient environment would be the next instance of the defect it exists to
 * find. `resolveHostPole` takes platform, env and the container marker as ARGUMENTS — nothing here
 * reads `process.platform`, `process.env` or the filesystem.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_PARITY_BASELINE, diffHostParity, resolveHostPole } from "../src/lib/host-parity.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── resolveHostPole, every branch, both directions ───────────────────────────────────────────

test("a container that is NOT a CI runner resolves to azure — the case that used to answer ci", () => {
  assert.equal(resolveHostPole({ platform: "linux", env: {}, inContainer: true }), "azure");
});

test("THE OTHER DIRECTION: a linux host with no container marker still resolves to ci, unchanged", () => {
  // The falsifier for "just return azure on linux". The fallback is deliberately untouched, so a
  // developer's bare box reports exactly what it reported before this function existed.
  assert.equal(resolveHostPole({ platform: "linux", env: {}, inContainer: false }), "ci");
});

test("darwin is still the mini, container marker or not — the judge's pole is decided first", () => {
  assert.equal(resolveHostPole({ platform: "darwin", env: {}, inContainer: false }), "mini");
  assert.equal(resolveHostPole({ platform: "darwin", env: {}, inContainer: true }), "mini");
});

test("ORDER TRAP: a CI job running INSIDE a container is ci, never azure", () => {
  // A GitHub job configured with `container:` carries /.dockerenv, but its failure set is the one
  // the ci baseline describes. Testing the marker before the CI env would silently reclassify every
  // containerised CI job as azure and empty the ci pole.
  assert.equal(resolveHostPole({ platform: "linux", env: { CI: "true" }, inContainer: true }), "ci");
  assert.equal(
    resolveHostPole({ platform: "linux", env: { GITHUB_ACTIONS: "true" }, inContainer: true }),
    "ci",
  );
});

test("the CI predicate matches isCiEnv's falsiness rules — '', '0' and 'false' are NOT CI", () => {
  // Duplicated from lib/self-sync.ts's isCiEnv rather than imported (this module has no imports at
  // all). This test is what keeps the copy honest; if it ever drifts, isCiEnv is the authority.
  for (const v of ["", "0", "false", "FALSE"]) {
    assert.equal(
      resolveHostPole({ platform: "linux", env: { CI: v }, inContainer: true }),
      "azure",
      `CI=${JSON.stringify(v)} is not truthy, so the container marker decides`,
    );
  }
  assert.equal(resolveHostPole({ platform: "linux", env: { CI: "1" }, inContainer: false }), "ci");
});

// ── the pole actually scopes the diff ────────────────────────────────────────────────────────

test("an azure run is diffed against azure's OWN declared set, not the mini's or ci's", () => {
  // The mini's four entries and ci's one must not silence — or be reported as healed by — an azure
  // run. That scoping is the whole reason the pole field exists.
  const miniEntry = HOST_PARITY_BASELINE.find((d) => d.pole === "mini");
  assert.ok(miniEntry, "fixture assumption: the baseline still declares at least one mini entry");
  const diff = diffHostParity({ observed: [miniEntry.test], pole: "azure" });
  assert.deepEqual(diff.undeclared, [miniEntry.test], "a mini entry observed on azure is a FINDING");
  assert.deepEqual(diff.healed, [], "and no mini entry is reported healed by an azure run");
  assert.deepEqual(diff.declaredSeen, []);
});

test("azure declares NOTHING today, and that is asserted rather than assumed", () => {
  // 14 of the 16 measured failures are `jq` missing from the image — a dependency defect fixed in
  // deploy/, not a divergence to bless — and the other 2 are the worker-containment flake this
  // baseline's own doc refuses to declare. So the correct azure set is empty, and an entry
  // appearing here later should be a deliberate act with a reason attached.
  assert.deepEqual(HOST_PARITY_BASELINE.filter((d) => d.pole === "azure"), []);
});

test("every declared entry still carries a pole the type admits, and a non-empty reason", () => {
  for (const d of HOST_PARITY_BASELINE) {
    assert.ok(["mini", "ci", "azure"].includes(d.pole), `unknown pole: ${d.pole}`);
    assert.ok(d.reason.trim().length > 0, `${d.test} has no reason`);
  }
});

// ── the runner really uses it (the reachability half) ────────────────────────────────────────

test("REACHABILITY: scripts/host-parity.ts resolves its pole through resolveHostPole, not a ternary", () => {
  // A unit test of resolveHostPole passes just as happily while the runner keeps its old inline
  // ternary — the same consumer-wired-producer-never shape that let W1-T126 ship dead. This reads
  // the runner's source because the runner is a top-level script with no importable seam.
  const src = readFileSync(join(REPO_ROOT, "scripts", "host-parity.ts"), "utf8");
  assert.match(src, /resolveHostPole\(\{/, "the runner must call the resolver");
  assert.match(src, /inContainer:\s*existsSync\("\/\.dockerenv"\)/, "and pass the real marker");
  assert.doesNotMatch(
    src,
    /process\.platform === "darwin" \? "mini" : "ci"/,
    "the old two-pole ternary must be gone, or a container still reports as ci",
  );
});
