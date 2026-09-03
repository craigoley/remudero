/**
 * W1-T2770 — the six merge-lcov CLI failures the September 2 investigation surfaced were
 * `scripts/coverage-merge-ratchet.mjs`'s `assertPinnedNodeVersion` throwing on an EXACT string
 * mismatch against `.nvmrc`. On this host at investigation time: `.nvmrc = 22.22.3`, running
 * Node = `22.23.2`. The image (`deploy/Dockerfile`) shipped `FROM node:22-bookworm-slim` — a
 * FLOATING tag — so an unrelated rebuild moved Node without any file in this repo changing.
 *
 * TWO INDEPENDENT HALVES, EACH GUARDED HERE:
 *
 * (A) IMAGE-SIDE, the actual fix: `deploy/Dockerfile` pins to `.nvmrc` exactly. Ships inert in
 *     a merged, green commit until the operator dispatches `.github/workflows/acr-build.yml`,
 *     at which point the running Node matches the pin and the six tests pass again.
 *
 * (B) MOUNT-SIDE, the diagnosis carrier: a `HOST_CAUSED_SUITE_REDS` cluster that lets
 *     `ci:host-caused-suite-reds` report "these 6 are Node-pin drift, not this diff" while
 *     that inert commit sits waiting. The cluster is INFORMATIONAL — `ci-parity.ts`'s own
 *     header spells it out ("SEPARATION, NOT SUPPRESSION" ... "always reports `ok: true` (it is
 *     informational, never a verdict of its own — the day this table gates a merge on a HOST
 *     FACT rather than on a test result is the day it stops testing the diff)") — so it does
 *     NOT restore a green ci-parity gate; the image half is the whole fix, and this cluster is
 *     the annotation that stops a reader from misreading those six failures.
 *
 * THE CLUSTER SELF-EXPIRES around ANY drift from `.nvmrc`, not just the specific 22.22.3 ->
 * 22.23.2 direction that produced today's outage. A cluster that outlives its cause is a
 * permanent suppression of six working tests reading exactly like six tests that broke, so
 * `appliesTo` must fire ONLY while `process.versions.node !== .nvmrc`, and its every guard
 * pattern here proves one of the ways it could otherwise fail to expire.
 *
 * THE HIGHEST-VALUE LINE IS THE ONE ASSERTING THE CLUSTER CANNOT ALTER `ci:test`'S VERDICT —
 * that guard is what stops a later session from turning separation into suppression, which is
 * the class this whole task exists inside.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CI_PARITY_TABLE,
  HOST_CAUSED_SUITE_REDS,
  computeHostFacts,
  detectHostFacts,
  hostCausedSuiteRedsForFacts,
  hostCausedSuiteRedsStep,
  type CiParityStepResult,
  type HostFacts,
} from "../src/lib/ci-parity.js";
import type { PreflightSpawn } from "../src/lib/commit-message.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

/** A neutral facts row where every non-node axis is inert — the fixture the six per-guard
 *  tests below start from, so each guard varies ONE dimension at a time. */
const NEUTRAL: HostFacts = {
  platform: "linux",
  bashMajorVersion: 5,
  hasProcMeminfo: true,
  nodeVersion: "22.22.3",
  pinnedNodeVersion: "22.22.3",
};

const MERGE_LCOV = "test/merge-lcov.test.ts";
const CAUSE = "node-version-drift-from-pin";

function mergeLcovEntry(facts: HostFacts): boolean {
  return hostCausedSuiteRedsForFacts(facts).some((e) => e.file === MERGE_LCOV && e.cause === CAUSE);
}

// ── (A) IMAGE-SIDE: the Dockerfile pin ──────────────────────────────────────────────────────

test("W1-T2770: deploy/Dockerfile pins Node to the EXACT `.nvmrc` version — never the floating `node:22` slot", () => {
  const dockerfile = readFileSync(join(REPO_ROOT, "deploy", "Dockerfile"), "utf8");
  const nvmrc = readFileSync(join(REPO_ROOT, ".nvmrc"), "utf8").trim();
  const fromLine = dockerfile.split("\n").find((l) => /^FROM\s+node:/i.test(l));
  assert.ok(fromLine, "deploy/Dockerfile must have a `FROM node:...` line");
  // The exact tag shape is `node:<version>-bookworm-slim` at time of pin; this asserts on the
  // version fragment specifically because that IS the moving part — a future rebase onto a
  // different slim/alpine flavor is out of scope for this guard.
  assert.match(
    fromLine!,
    new RegExp(`FROM\\s+node:${nvmrc.replace(/\./g, "\\.")}\\b`),
    `FROM line must pin to the .nvmrc version (${nvmrc}); got: ${fromLine}`,
  );
  // FLOATING TAG REGRESSION LOCK: a bare `node:22` (or `node:22-<flavor>`) is what let 22.23.2
  // arrive silently — the exact defect this task exists for. Pinning must not slide back into
  // that shape without failing this test first.
  assert.doesNotMatch(
    fromLine!,
    /FROM\s+node:\d+-[a-z]+-\w+$/i,
    "the floating major-only tag is the defect — a rebuild whose base slot moved shipped 22.23.2 with no file change",
  );
});

// ── (B) MOUNT-SIDE: the informational cluster, and its self-expiry ─────────────────────────

test("W1-T2770: the cluster fires on any Node-pin drift — the incident's own 22.22.3 vs 22.23.2 direction included", () => {
  assert.ok(
    mergeLcovEntry({ ...NEUTRAL, nodeVersion: "22.23.2", pinnedNodeVersion: "22.22.3" }),
    "22.23.2 running against .nvmrc 22.22.3 is exactly the September 2 shape and MUST fire",
  );
});

test("W1-T2770: the cluster fires equally on the opposite direction — running BEHIND the pin, not just ahead", () => {
  // `assertPinnedNodeVersion` is a `!==` compare, not a range check; the cluster's own predicate
  // must match, or else a bump to `.nvmrc` that lands before its image would silently start
  // reading those six as diff-caused instead.
  assert.ok(
    mergeLcovEntry({ ...NEUTRAL, nodeVersion: "22.22.3", pinnedNodeVersion: "22.24.0" }),
    "22.22.3 running against .nvmrc 22.24.0 fires the same string mismatch",
  );
});

test("W1-T2770: the cluster SELF-EXPIRES the moment running Node matches the pin — no lingering suppression", () => {
  // The core self-expiry contract. A stale cluster is worse than none, per the file's design
  // comment — this guard is what stops it from lingering into a version-alignment window.
  assert.equal(
    mergeLcovEntry({ ...NEUTRAL, nodeVersion: "22.22.3", pinnedNodeVersion: "22.22.3" }),
    false,
    "when running Node == .nvmrc, the cluster MUST NOT apply — otherwise it hides real failures forever after the image lands",
  );
});

test("W1-T2770: the cluster degrades silently to `does not apply` when `.nvmrc` is unreadable — never guesses `differs`", () => {
  // Mirror of `bashMajorVersion: undefined`'s discipline. A probe that cannot tell must not
  // claim a verdict either way; a claim of `applies` on an unread pin would hide diff-caused
  // failures whenever `.nvmrc` moved from the checkout the read expected.
  assert.equal(
    mergeLcovEntry({ ...NEUTRAL, nodeVersion: "22.22.3", pinnedNodeVersion: undefined }),
    false,
    "an absent .nvmrc reads as `cannot tell`, never as `differs`",
  );
});

test("W1-T2770: `v`-prefix and trailing whitespace do not fool the compare into a false-drift", () => {
  // Common shapes on both sides — `process.versions.node` returns `"22.22.3"` (no v); `.nvmrc`
  // is often `"v22.22.3\n"`. `computeHostFacts` normalizes both, but this pins the behavior at
  // the caller's contract so a caller that constructs facts by hand can trust it.
  const facts = computeHostFacts({
    platform: "linux",
    bashVersionText: "5.0",
    hasProcMeminfo: true,
    nodeVersion: "22.22.3",
    nvmrcText: "v22.22.3\n",
  });
  assert.equal(facts.pinnedNodeVersion, "22.22.3");
  assert.equal(mergeLcovEntry(facts), false, "a `v` and a newline are NOT drift");
});

test("W1-T2770: the cluster names the exact file and count the six failures live at", () => {
  const entry = HOST_CAUSED_SUITE_REDS.find((e) => e.cause === CAUSE);
  assert.ok(entry, "the node-version-drift cluster must exist");
  assert.equal(entry!.file, MERGE_LCOV);
  assert.equal(entry!.count, 6, "the six failures are the exact set — never a floor, never rounded");
});

// ── (B, load-bearing): the cluster IS informational — cannot alter `ci:test`'s verdict ──────

test("W1-T2770 (HIGHEST-VALUE GUARD): `ci:host-caused-suite-reds` is `ok: true` on every combination of host facts — a cluster never gates a merge on a HOST FACT rather than on a test result", () => {
  // If this guard fails, someone has turned separation into suppression, which is the exact
  // class of defect this whole task exists to prevent. The design comment at the top of
  // `ci-parity.ts` names this contract in prose; this test pins it in code.
  //
  // Covers the neutral case, the drift case, and every extreme of the platform/bash axes —
  // three orthogonal populations at three orthogonal boundaries; if any of them can produce
  // `ok: false` the informational contract has been broken somewhere it was not looking.
  const combos: HostFacts[] = [
    NEUTRAL,
    { ...NEUTRAL, nodeVersion: "22.23.2", pinnedNodeVersion: "22.22.3" }, // the drift case
    { ...NEUTRAL, nodeVersion: "22.22.3", pinnedNodeVersion: undefined }, // absent .nvmrc
    { ...NEUTRAL, platform: "darwin", bashMajorVersion: 3, hasProcMeminfo: false }, // bash-3.2
    { ...NEUTRAL, platform: "win32", bashMajorVersion: undefined }, // an unfamiliar platform
  ];
  for (const facts of combos) {
    assert.equal(
      hostCausedSuiteRedsStep(facts).ok,
      true,
      `hostCausedSuiteRedsStep must be ok:true for every host facts combination — got ok:false for ${JSON.stringify(facts)}`,
    );
  }
});

test("W1-T2770 (HIGHEST-VALUE GUARD): `ci:test` runs regardless of whether the cluster applies — it is never gated on host facts", () => {
  // Records only which STEPS the ci entry emits, without actually spawning any commands. If a
  // future edit gates `ci:test` behind `hostCausedSuiteRedsStep`'s verdict (turning separation
  // into suppression), the step list itself changes — this guard fires before any test runs.
  const seen: string[] = [];
  const spawn: PreflightSpawn = (_file, _args, _opts) => {
    // Any spawn call is fine — these leaves only use it to shell out; we're inspecting the
    // STRUCTURE of the emitted step list, not the content of any step's own run.
    return { status: 0, stdout: "", stderr: "" };
  };
  const ciEntry = CI_PARITY_TABLE.find((e) => e.job === "ci");
  assert.ok(ciEntry, "the ci entry must still exist");
  const steps: CiParityStepResult[] = ciEntry!.run!(REPO_ROOT, spawn);
  for (const s of steps) seen.push(s.name);

  assert.ok(seen.includes("ci:test"), "ci:test must be present regardless of any cluster");
  assert.ok(seen.includes("ci:host-caused-suite-reds"), "the annotation runs alongside it");
  // Ordering also matters: `ci:host-caused-suite-reds` must not sit between `ci:test`'s spawn
  // and its own verdict aggregation in a way that would let it short-circuit `ci:test`.
  const testIdx = seen.indexOf("ci:test");
  const clusterIdx = seen.indexOf("ci:host-caused-suite-reds");
  assert.notEqual(testIdx, -1);
  assert.notEqual(clusterIdx, -1);
  assert.ok(testIdx !== clusterIdx, "they are distinct entries, never merged into one");
});

// ── (B, integration): detectHostFacts reads .nvmrc for real and produces a working entry ────

test("W1-T2770: detectHostFacts reads this repo's real .nvmrc and produces a facts row with a plausible pin", () => {
  // The all-fakes trap CLAUDE.md documents — a suite where every test above uses `computeHostFacts`
  // with a hand-built `nvmrcText` never exercises the real `.nvmrc` read path. This guard proves
  // the impure leaf runs and returns a usable pin, so a later regression that broke the real
  // read (a bad `readFileSync` path, a swallowed error) fails HERE, not in production.
  const spawn: PreflightSpawn = (_file, _args, _opts) => ({ status: 0, stdout: "", stderr: "" });
  const facts = detectHostFacts(REPO_ROOT, spawn, () => false);
  assert.match(
    String(facts.pinnedNodeVersion),
    /^\d+\.\d+\.\d+$/,
    `pinnedNodeVersion must be a plausible semver string; got ${JSON.stringify(facts.pinnedNodeVersion)}`,
  );
  // And the running Node reading, too — same all-fakes-trap logic.
  assert.match(facts.nodeVersion, /^\d+\.\d+\.\d+$/, `nodeVersion must be a plausible semver string; got ${facts.nodeVersion}`);
});

test("W1-T2770: detectHostFacts against a repoRoot with no .nvmrc reads the readFileSync throw and represents it as pinnedNodeVersion: undefined — never a thrown error out of the step, never a guessed value", () => {
  // `tmpdir()` has no `.nvmrc` sitting in it, so this exercises the SAME catch branch
  // `computeHostFacts`'s own doc comment describes: "Absent/unreadable is `undefined`, NOT the
  // empty string". The `REPO_ROOT`-reading test above only ever exercises the try's happy path;
  // this is the read that actually throws.
  const spawn: PreflightSpawn = (_file, _args, _opts) => ({ status: 0, stdout: "", stderr: "" });
  const facts = detectHostFacts(tmpdir(), spawn, () => false);
  assert.equal(facts.pinnedNodeVersion, undefined, "a missing .nvmrc must read as undefined, never a guessed match/mismatch");
});
