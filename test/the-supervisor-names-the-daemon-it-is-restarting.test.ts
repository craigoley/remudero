import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { realDeployDeps, daemonInstanceStateDirs, instanceForStateRoot } from "../src/lib/deployer.js";

// ── W1-T3732 — THE DEPLOY SUPERVISOR COULD NOT RESTART ANY DAEMON ────────────────────────────
//
// MEASURED FROM THE LIVE LEDGER 2026-09-17T13:07:36Z, after the image had already been pulled:
//
//   {"step":"deploy.restart_refused","to":"a90f7ea53","backend":"recycle-container",
//    "message":"recycle-container: REFUSING -- no --instance given while
//      .../daemon-instances.yaml declares instances.\n  Declared: core site console"}
//
// `realDeployDeps`'s restart seam was `exec("bash", [recycleContainerScript])` — no `--instance`,
// and `RealDeployOpts` had no field that could supply one. W1-T3596's refusal is CORRECT (three
// daemons share this host, and the unscoped default targets core against a state directory that is
// not even core's own) but it was written for a human typing the command, and it also guarded a
// robot that had no way to answer it. #5888 merged at 13:02, the supervisor was refused at 13:07,
// and at 13:13 the reviewer was still three commits stale and skipping every pull request.
//
// WHAT IS REAL HERE: `realDeployDeps` is the production factory, given a real temp checkout with a
// real registry file on it. Only the subprocess runner is injected, so these tests observe the
// exact argv production would pass to bash.

/** A checkout shaped enough for the recycle backend to probe usable: the script must exist. */
function fakeInstall(registry?: string): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-deploy-instance-"));
  mkdirSync(join(root, "deploy"), { recursive: true });
  writeFileSync(join(root, "deploy", "recycle-container.sh"), "#!/usr/bin/env bash\n");
  if (registry !== undefined) {
    mkdirSync(join(root, ".remudero"), { recursive: true });
    writeFileSync(join(root, ".remudero", "daemon-instances.yaml"), registry);
  }
  return root;
}

const REGISTRY = [
  "# a comment, and a blank line, both of which the reader must skip",
  "",
  "instances:",
  "  core:",
  "    repo: remudero",
  "    container_name: remudero-daemon",
  "    state_dir: /home/craigoleyagent/rmd-state2",
  "  site:",
  "    repo: remudero-site",
  "    container_name: remudero-site-daemon",
  "    state_dir: /home/craigoleyagent/rmd-site-state",
  "  console:",
  "    repo: remudero-console",
  "    container_name: remudero-console-daemon",
  "    state_dir: /mnt/rmd/remudero-console-state",
  "",
].join("\n");

/** Drives the real factory and returns every argv the restart handed to bash. */
function restartArgv(o: { installPath: string; stateRoot: string; instance?: string }): string[][] {
  const calls: string[][] = [];
  const deps = realDeployDeps({
    installPath: o.installPath,
    stateRoot: o.stateRoot,
    daemonLabel: "com.remudero.daemon",
    serveLabel: "com.remudero.serve",
    servePort: 8080,
    uid: 501,
    ledgerPath: join(o.installPath, "ledger.ndjson"),
    instance: o.instance,
    log: () => {},
    execFile: (cmd, args) => {
      calls.push([cmd, ...args]);
      // `launchctl` must read ABSENT so the recycle backend is the one selected; `docker version`
      // must succeed so its own probe passes. Everything else is inert here.
      if (cmd === "launchctl") {
        const err = new Error("spawn launchctl ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return "";
    },
  });
  const backend = deps.restartBackends?.().find((b) => b.name === "recycle-container");
  assert.ok(backend, "the recycle-container backend must be wired");
  assert.equal(backend.probe(), true, "the fixture checkout must probe usable");
  calls.length = 0; // the probes above are not the subject
  backend.restart();
  return calls;
}

test("the recycle invocation carries the instance matching this deployment's state root", () => {
  // THE ASSERTION THE WHOLE TASK RESTS ON, and it is about the ARGV: a test that only checked a
  // resolver would pass for a supervisor that resolved the name and still invoked the script bare,
  // which is exactly the shape that was live.
  const root = fakeInstall(REGISTRY);
  const argv = restartArgv({ installPath: root, stateRoot: "/home/craigoleyagent/rmd-state2" });
  assert.equal(argv.length, 1);
  assert.deepEqual(argv[0].slice(1), [join(root, "deploy", "recycle-container.sh"), "--instance", "core"]);

  // The site daemon's own state root selects ITS instance, never core's — the misattribution
  // W1-T3596's registry exists to forbid, now on the automated path too.
  const site = restartArgv({ installPath: root, stateRoot: "/home/craigoleyagent/rmd-site-state" });
  assert.deepEqual(site[0].slice(2), ["--instance", "site"]);

  // A trailing separator is not a different directory.
  const slashed = restartArgv({ installPath: root, stateRoot: "/mnt/rmd/remudero-console-state/" });
  assert.deepEqual(slashed[0].slice(2), ["--instance", "console"]);
});

test("an unmatched state root invokes the script unchanged", () => {
  // The guard is never bypassed: with no answer the script is invoked exactly as it was before
  // this task and refuses exactly as it does today. A blanket `--instance core` fallback would
  // recycle the core daemon whenever the site or console supervisor ran.
  const root = fakeInstall(REGISTRY);
  const script = join(root, "deploy", "recycle-container.sh");
  const unmatched = restartArgv({ installPath: root, stateRoot: "/home/craigoleyagent/some-other-state" });
  assert.deepEqual(unmatched[0].slice(1), [script], "an unmatched state root must add no flag");

  // THE CORPUS CONTROL, and it is why this test discriminates rather than passing on any tree:
  // "adds no flag" is also true of a supervisor that never names an instance at all — which is
  // exactly the state this task found. The same fixture with a DECLARED state root must name one.
  const matched = restartArgv({ installPath: root, stateRoot: "/home/craigoleyagent/rmd-state2" });
  assert.deepEqual(matched[0].slice(1), [script, "--instance", "core"], "a declared state root must name its instance");
});

test("an unreadable registry names no instance", () => {
  // A fault must never select a daemon, and must never restore the unscoped default the registry
  // exists to forbid. Absent file, and a file that parses to nothing, both read as no match —
  // while the SAME state root against a readable registry names `core`, which is the control that
  // keeps this from being an assertion every tree satisfies.
  const stateRoot = "/home/craigoleyagent/rmd-state2";

  const absent = fakeInstall(undefined);
  assert.deepEqual(restartArgv({ installPath: absent, stateRoot })[0].slice(1), [
    join(absent, "deploy", "recycle-container.sh"),
  ]);

  const garbage = fakeInstall("this: is not\n  the registry: shape\n");
  assert.deepEqual(restartArgv({ installPath: garbage, stateRoot })[0].slice(1), [
    join(garbage, "deploy", "recycle-container.sh"),
  ]);

  const readable = fakeInstall(REGISTRY);
  assert.deepEqual(restartArgv({ installPath: readable, stateRoot })[0].slice(1), [
    join(readable, "deploy", "recycle-container.sh"),
    "--instance",
    "core",
  ]);
});

// ── Supporting coverage beyond the three named proofs ────────────────────────────────────────

test("the registry reader takes only the instances block, and an explicit instance overrides it", () => {
  assert.deepEqual(
    [...daemonInstanceStateDirs(REGISTRY)],
    [
      ["core", "/home/craigoleyagent/rmd-state2"],
      ["site", "/home/craigoleyagent/rmd-site-state"],
      ["console", "/mnt/rmd/remudero-console-state"],
    ],
  );
  // A sibling top-level section ends the block — never read as another instance's fields.
  assert.deepEqual([...daemonInstanceStateDirs(`${REGISTRY}other:\n  core:\n    state_dir: /wrong\n`)].length, 3);
  // Two instances on one state dir is AMBIGUOUS, and ambiguous is not a match.
  assert.equal(
    instanceForStateRoot("instances:\n  a:\n    state_dir: /same\n  b:\n    state_dir: /same\n", "/same"),
    undefined,
  );

  const root = fakeInstall(REGISTRY);
  assert.deepEqual(
    restartArgv({ installPath: root, stateRoot: "/home/craigoleyagent/rmd-state2", instance: "console" })[0].slice(2),
    ["--instance", "console"],
  );
});
