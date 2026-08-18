// W1-T991: "the node runtime the whole fleet executes is INHERITED and never asserted —
// a daemon booted from another account's nvm install is invisible until that install is
// pruned, and then every spawn fails at once with no named cause."
//
// This proves the four acceptance claims:
//  1. the daemon.boot ledger line records the running runtime's absolute path and version
//  2. a runtime resolved under a different account's home, or off the version pin, is
//     reported with a named drift reason; one inside the daemon's own roots at the pinned
//     version reports none
//  3. drift is advisory (still boots) and the expected roots are DERIVED from the daemon's
//     own home + system prefixes, never a hardcoded host path
//  4. the reading is wired into the real boot line, not merely exported (see
//     `grep node_path src/lib/daemon.ts`, proven here by calling `daemonBoot` itself)

import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCleanBoot, checkNodeRuntimeProvenance } from "../src/lib/env.js";
import { daemonBoot } from "../src/lib/daemon.js";

// ── checkNodeRuntimeProvenance: the pure drift reading ──────────────────────

test("checkNodeRuntimeProvenance: a runtime under the daemon's OWN home, matching the pin, reports NO drift", () => {
  const result = checkNodeRuntimeProvenance(
    "/home/craigoleyagent/.nvm/versions/node/v22.22.3/bin/node",
    "v22.22.3",
    "/home/craigoleyagent",
    "22.22.3",
  );
  assert.deepEqual(result, { drift: false });
});

test("checkNodeRuntimeProvenance: a runtime under a KNOWN SYSTEM prefix (homebrew), matching the pin, reports NO drift", () => {
  // The plist-clean production case: launchd's DEFAULT_LAUNCHD_PATH resolves node from
  // /opt/homebrew, never any one user's home.
  const result = checkNodeRuntimeProvenance("/opt/homebrew/bin/node", "v22.22.3", "/Users/craigoleyagent", "22.22.3");
  assert.deepEqual(result, { drift: false });
});

test("checkNodeRuntimeProvenance: a runtime under a DIFFERENT account's home is drift, named as foreign-account", () => {
  // The exact shape the feedback (fb-1785784424838-179bcf) observed: the fleet runs as
  // craigoleyagent but the live worker's node resolved from /Users/craigoley's own nvm.
  const result = checkNodeRuntimeProvenance(
    "/Users/craigoley/.nvm/versions/node/v22.22.1/bin/node",
    "v22.22.1",
    "/Users/craigoleyagent",
    "22.22.3",
  );
  assert.equal(result.drift, true);
  assert.match(result.reason ?? "", /outside the daemon account's own roots/);
  assert.match(result.reason ?? "", /\/Users\/craigoley\/\.nvm\/versions\/node\/v22\.22\.1\/bin\/node/);
});

test("checkNodeRuntimeProvenance: right roots but a version disagreeing with the declared pin is drift, named as a version mismatch", () => {
  const result = checkNodeRuntimeProvenance("/opt/homebrew/bin/node", "v22.22.1", "/Users/craigoleyagent", "22.22.3");
  assert.equal(result.drift, true);
  assert.match(result.reason ?? "", /undeclared node version/);
  assert.match(result.reason ?? "", /v22\.22\.1/);
  assert.match(result.reason ?? "", /22\.22\.3/);
});

test("checkNodeRuntimeProvenance: no declared pin supplied ⇒ only the account/roots check runs, never a false version-drift", () => {
  const result = checkNodeRuntimeProvenance("/opt/homebrew/bin/node", "v22.22.1", "/Users/craigoleyagent", undefined);
  assert.deepEqual(result, { drift: false });
});

test("checkNodeRuntimeProvenance: an out-of-roots path is reported even with NO declared pin at all (roots check is independent)", () => {
  const result = checkNodeRuntimeProvenance(
    "/Users/craigoley/.nvm/versions/node/v22.22.1/bin/node",
    "v22.22.1",
    "/Users/craigoleyagent",
    undefined,
  );
  assert.equal(result.drift, true);
  assert.match(result.reason ?? "", /outside the daemon account's own roots/);
});

// ── ROOTS ARE DERIVED, NEVER A HARDCODED HOST PATH (design part 3) ──────────
// A container lane running as a wholly different user under a wholly different prefix
// (deploy/) must NOT false-positive just because it isn't macOS's /Users/*.

test("checkNodeRuntimeProvenance: a Linux container account's OWN home is a valid root too — not just /Users", () => {
  const result = checkNodeRuntimeProvenance(
    "/home/remudero/.nvm/versions/node/v22.22.3/bin/node",
    "v22.22.3",
    "/home/remudero",
    "22.22.3",
  );
  assert.deepEqual(result, { drift: false }, "a non-/Users home must be honored — the check is never hardcoded to one host");
});

test("checkNodeRuntimeProvenance: an UNRELATED account's home on a Linux host is still foreign, same as macOS", () => {
  const result = checkNodeRuntimeProvenance(
    "/home/otheruser/.nvm/versions/node/v22.22.3/bin/node",
    "v22.22.3",
    "/home/remudero",
    "22.22.3",
  );
  assert.equal(result.drift, true);
  assert.match(result.reason ?? "", /outside the daemon account's own roots/);
});

test("checkNodeRuntimeProvenance: with NO daemon home known (env.HOME unset), system prefixes still work as roots", () => {
  const result = checkNodeRuntimeProvenance("/usr/bin/node", "v22.22.3", undefined, "22.22.3");
  assert.deepEqual(result, { drift: false });
});

// ── assertCleanBoot: the runtime reading joins env_clean/billing_mode on BootAssertion ──

test("assertCleanBoot: always records node_path/node_version, drift or not — this is what makes the runtime OBSERVABLE without a live process listing", () => {
  const clean = assertCleanBoot(
    { PATH: "/usr/bin", HOME: "/Users/craigoleyagent" },
    false,
    { execPath: "/opt/homebrew/bin/node", version: "v22.22.3" },
    "22.22.3",
  );
  assert.equal(clean.node_path, "/opt/homebrew/bin/node");
  assert.equal(clean.node_version, "v22.22.3");
  assert.equal(clean.node_drift, undefined, "matching runtime ⇒ no drift field at all");

  const drifted = assertCleanBoot(
    { PATH: "/usr/bin", HOME: "/Users/craigoleyagent" },
    false,
    { execPath: "/Users/craigoley/.nvm/versions/node/v22.22.1/bin/node", version: "v22.22.1" },
    "22.22.3",
  );
  assert.equal(drifted.node_path, "/Users/craigoley/.nvm/versions/node/v22.22.1/bin/node");
  assert.equal(drifted.node_version, "v22.22.1");
  assert.match(drifted.node_drift ?? "", /outside the daemon account's own roots/);
});

test("assertCleanBoot: defaults the runtime reading to THIS process's own execPath/version when nothing is injected", () => {
  const result = assertCleanBoot({ PATH: "/usr/bin" });
  assert.equal(result.node_path, process.execPath);
  assert.equal(result.node_version, process.version);
});

// ── daemonBoot: WIRED INTO THE REAL BOOT LINE, not merely exported (acceptance claim 4) ──

test("daemonBoot: the daemon.boot ledger line carries node_path/node_version, and a named node_drift when the runtime is foreign", () => {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const env = { PATH: "/usr/bin:/bin", HOME: "/Users/craigoleyagent" };
  const result = daemonBoot(
    (step, extra = {}) => lines.push({ step, extra }),
    env,
    undefined, // sweepTmp
    undefined, // sweepLocks
    undefined, // unlockWorkerKeychain
    undefined, // crashLoopCheck
    undefined, // resolveClaudeBin
    false, // allowApiKey
    undefined, // sweepOrphanWorkers
    undefined, // bootHeadSha
    undefined, // sweepFeedbackLanding
    { execPath: "/Users/craigoley/.nvm/versions/node/v22.22.1/bin/node", version: "v22.22.1" }, // nodeRuntime
    "22.22.3", // declaredNodeVersion
  );

  assert.equal(result.node_path, "/Users/craigoley/.nvm/versions/node/v22.22.1/bin/node");
  assert.equal(result.node_version, "v22.22.1");
  assert.match(result.node_drift ?? "", /outside the daemon account's own roots/);

  const bootLine = lines.find((l) => l.step === "daemon.boot");
  assert.ok(bootLine, "daemon.boot is logged");
  assert.equal(bootLine!.extra.node_path, "/Users/craigoley/.nvm/versions/node/v22.22.1/bin/node");
  assert.equal(bootLine!.extra.node_version, "v22.22.1");
  assert.match(String(bootLine!.extra.node_drift ?? ""), /outside the daemon account's own roots/);
});

test("daemonBoot: drift is ADVISORY ONLY — a daemon on a drifting runtime still boots and returns normally, never throws", () => {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const env = { PATH: "/usr/bin:/bin", HOME: "/Users/craigoleyagent" };
  assert.doesNotThrow(() =>
    daemonBoot(
      (step, extra = {}) => lines.push({ step, extra }),
      env,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      { execPath: "/Users/craigoley/.nvm/versions/node/v22.22.1/bin/node", version: "v22.22.1" },
      "22.22.3",
    ),
  );
  assert.equal(lines.length, 1, "a drifted boot still logs exactly one daemon.boot line and proceeds");
});

test("daemonBoot: a runtime in the daemon's own roots, matching the pin, logs NO node_drift key at all", () => {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const env = { PATH: "/usr/bin:/bin", HOME: "/Users/craigoleyagent" };
  const result = daemonBoot(
    (step, extra = {}) => lines.push({ step, extra }),
    env,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    { execPath: "/opt/homebrew/bin/node", version: "v22.22.3" },
    "22.22.3",
  );
  assert.equal(result.node_drift, undefined);
  const bootLine = lines.find((l) => l.step === "daemon.boot");
  assert.ok(bootLine);
  assert.equal("node_drift" in bootLine!.extra, false, "no node_drift key on a clean-runtime boot");
  assert.equal(bootLine!.extra.node_path, "/opt/homebrew/bin/node");
  assert.equal(bootLine!.extra.node_version, "v22.22.3");
});

test("daemonBoot: with no nodeRuntime/declaredNodeVersion injected, defaults to THIS process's own runtime (real production wiring)", () => {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const result = daemonBoot((step, extra = {}) => lines.push({ step, extra }), { PATH: "/usr/bin:/bin", HOME: "/Users/op" });
  assert.equal(result.node_path, process.execPath);
  assert.equal(result.node_version, process.version);
  const bootLine = lines.find((l) => l.step === "daemon.boot");
  assert.equal(bootLine!.extra.node_path, process.execPath);
  assert.equal(bootLine!.extra.node_version, process.version);
});
