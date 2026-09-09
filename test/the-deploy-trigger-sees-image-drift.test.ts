/**
 * W1-T3240 — the deploy trigger reasons about the IMAGE, not only the checkout.
 *
 * MEASURED 2026-09-09 on the live fleet host. #4785 repaired `deploy/entrypoint.sh` so a
 * `core.bare=true` flag could not stop the fleet — the exact condition that took it down for
 * 7h32m that morning. It merged at c4bf56026; `acr-build.yml` fired on that push and SUCCEEDED at
 * 11:14; `/etc/rmd-build-sha` in the running container read c6baa842, the 2026-09-06 build.
 * Merged, built, published, NOT RUNNING.
 *
 * `decideDeployTrigger` could not see it. `installHead`, `originMain` and `runningHead` are ALL
 * read off the bind-mounted checkout: `ensureInstallFresh` keeps the checkout current, the daemon
 * boots off that same mount, so both of its comparisons read healthy — AND BOTH WERE CORRECT.
 * They are simply not about the image.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  IMAGE_BAKED_PATHS,
  IMAGE_BUILD_SHA_PATH,
  IMAGE_SHA_CONTAINER,
  bakedPathCommitsBehind,
  decideDeployTrigger,
  realDeployDeps,
} from "../src/lib/deployer.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

/** The exact shape the incident had: checkout current, daemon on it, alive, no STOP. */
const HEALTHY_CHECKOUT = {
  markerPresent: false,
  autoMode: true,
  installHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  originMain: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  runningHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  daemonAlive: true,
  stopPresent: false,
};

test("W1-T3240: a stale image is seen when install and running heads are both current", () => {
  const d = decideDeployTrigger({ ...HEALTHY_CHECKOUT, imageBakedCommitsBehind: 1 });

  assert.equal(d.deploy, true, "a published-but-unrunning baked-path fix must trigger a deploy");
  // The reason must name the IMAGE. "install behind origin/main" would send the reader to the
  // checkout, which is exactly what was healthy and correct throughout the incident.
  assert.match(d.reason, /running image predates 1 baked-path commit/);
  assert.match(d.reason, /published and not running/);
  assert.equal(d.satisfied, undefined, "a stale image must not satisfy and consume a deploy request");

  // CONTROL, same inputs but a current image: without this the case above proves only that the
  // fixture deploys, not that the IMAGE is what decided.
  const current = decideDeployTrigger({ ...HEALTHY_CHECKOUT, imageBakedCommitsBehind: 0 });
  assert.equal(current.deploy, false);
  assert.match(current.reason, /up-to-date/);
  assert.equal(current.satisfied, true);
});

test("W1-T3240: a mounted-source commit leaves the image current", () => {
  // The count is computed over BAKED paths only. `git rev-list --count <sha>..origin/main -- <paths>`
  // returns 0 when every intervening commit touched src/, test/, plan/ or scripts/ — all of which
  // reach the fleet through the bind mount the instant they merge.
  const calls: string[][] = [];
  const git = (args: readonly string[]): string => {
    calls.push([...args]);
    return "0\n";
  };
  assert.equal(bakedPathCommitsBehind("c6baa842", git), 0);

  // The pathspec is the whole point: without it, tens of mounted-source merges a day would each
  // read as image drift and train an operator to ignore the signal.
  const argv = calls[0]!;
  assert.ok(argv.includes("--"), "the paths must be passed as a pathspec, not as revisions");
  for (const p of IMAGE_BAKED_PATHS) assert.ok(argv.includes(p), `${p} must be in the pathspec`);
  assert.ok(argv.includes("c6baa842..origin/main"), "counted from the IMAGE's sha up to origin/main");
  assert.deepEqual([...IMAGE_BAKED_PATHS], ["deploy/Dockerfile", "deploy/entrypoint.sh"]);

  // And zero means CURRENT, which must not deploy — the mirror of the first case.
  assert.equal(decideDeployTrigger({ ...HEALTHY_CHECKOUT, imageBakedCommitsBehind: 0 }).deploy, false);

  // A real count still reads through: the measured incident was exactly 1.
  assert.equal(bakedPathCommitsBehind("c6baa842", () => "1\n"), 1);
});

test("W1-T3240: an unreadable image sha changes no decision", () => {
  // UNKNOWN, never zero. The sha is read via `docker exec ... cat /etc/rmd-build-sha`, which fails
  // exactly when the container is down — the crash-loop case this class of fix exists for.
  const thrower = () => {
    throw new Error("Error: No such container: remudero-daemon");
  };
  assert.equal(bakedPathCommitsBehind("c6baa842", thrower), undefined, "a git failure is UNKNOWN");
  assert.equal(bakedPathCommitsBehind(undefined, () => "9\n"), undefined, "an absent sha is UNKNOWN");
  assert.equal(bakedPathCommitsBehind("   ", () => "9\n"), undefined, "a blank sha is UNKNOWN");
  assert.equal(bakedPathCommitsBehind("c6baa842", () => "not a number"), undefined, "unparseable is UNKNOWN");

  // ...and UNKNOWN leaves the decision byte-identical to before this field existed.
  const withField = decideDeployTrigger({ ...HEALTHY_CHECKOUT, imageBakedCommitsBehind: undefined });
  const withoutField = decideDeployTrigger({ ...HEALTHY_CHECKOUT });
  assert.deepEqual(withField, withoutField);
  assert.equal(withField.deploy, false, "unknown must never read as stale — that is a restart storm");
  assert.equal(withField.satisfied, true, "nor may it withhold satisfaction from a healthy fleet");
});

test("W1-T3240: the image never overrides a STOP, and a genuinely behind checkout still names itself", () => {
  // STOP and the liveness branch outrank this, unchanged: a halted fleet must not be restarted by
  // image drift any more than by anything else.
  const stopped = decideDeployTrigger({
    ...HEALTHY_CHECKOUT,
    autoMode: false,
    markerPresent: false,
    imageBakedCommitsBehind: 5,
  });
  assert.equal(stopped.deploy, false, "no marker and no auto mode still means human-gated");
  assert.match(stopped.reason, /no operator marker/);

  // And when the checkout IS behind, the reason stays the checkout's — the image clause must not
  // capture a case it did not cause.
  const behind = decideDeployTrigger({
    ...HEALTHY_CHECKOUT,
    originMain: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    imageBakedCommitsBehind: 5,
  });
  assert.equal(behind.deploy, true);
  assert.match(behind.reason, /install behind origin\/main/);
  assert.doesNotMatch(behind.reason, /running image predates/);
});

// ── REACHABILITY: the producer exists and the SHIPPED closure runs ───────────────────────────
//
// A field the decision reads and nothing supplies is the #1066 shape this repo has paid for
// eleven times, and twice more in this same session (the revival log's prev_exit, lint-plan's
// credit projection). So this drives the closure `realDeployDeps` actually ships, with only
// `execFile` faked, rather than asserting on an injected fake that proves nothing about wiring.

test("W1-T3240: realDeployDeps SHIPS the image reader, and it runs the real docker + git calls", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}deploy-image-`));
  try {
    const calls: string[][] = [];
    const deps = realDeployDeps({
      installPath: root,
      stateRoot: root,
      daemonLabel: "com.remudero.daemon",
      serveLabel: "com.remudero.serve",
      servePort: 4317,
      uid: 501,
      ledgerPath: join(root, "ledger.ndjson"),
      log: () => {},
      execFile: (cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        if (cmd === "docker") return "c6baa842136dfd44502bed10d7d7ac7c8a92d0dd\n";
        if (cmd === "git") return "1\n";
        return "";
      },
    } as never);

    assert.ok(deps.imageBakedCommitsBehind !== undefined, "the producer must be SHIPPED, not only declared");
    assert.equal(deps.imageBakedCommitsBehind!(), 1, "the measured incident's own reading");

    // It read the image sha out of the container, from the SAME file the heartbeat publishes.
    const dockerCall = calls.find((c) => c[0] === "docker")!;
    assert.deepEqual(dockerCall, ["docker", "exec", IMAGE_SHA_CONTAINER, "cat", IMAGE_BUILD_SHA_PATH]);

    // ...and counted only BAKED-path commits from it.
    const gitCall = calls.find((c) => c[0] === "git" && c.includes("rev-list"))!;
    assert.ok(gitCall.includes("c6baa842136dfd44502bed10d7d7ac7c8a92d0dd..origin/main"));
    for (const p of IMAGE_BAKED_PATHS) assert.ok(gitCall.includes(p), `${p} must be in the pathspec`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3240: a container that is down makes the SHIPPED reader UNKNOWN, never zero", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}deploy-image-down-`));
  try {
    const deps = realDeployDeps({
      installPath: root,
      stateRoot: root,
      daemonLabel: "com.remudero.daemon",
      serveLabel: "com.remudero.serve",
      servePort: 4317,
      uid: 501,
      ledgerPath: join(root, "ledger.ndjson"),
      log: () => {},
      execFile: (cmd: string) => {
        if (cmd === "docker") throw new Error("Error: No such container: remudero-daemon");
        return "";
      },
    } as never);

    // This is the crash-loop case — the one this whole class of fix exists for. Reading it as
    // "current" restores the silence; reading it as "stale" restarts a host that may be fine.
    assert.equal(deps.imageBakedCommitsBehind!(), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
