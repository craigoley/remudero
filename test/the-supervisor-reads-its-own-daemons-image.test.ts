import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { IMAGE_SHA_CONTAINER, imageShaContainerFor, realDeployDeps } from "../src/lib/deployer.js";

// ── W1-T3733 — EVERY SUPERVISOR READ CORE'S IMAGE ────────────────────────────────────────────
//
// MEASURED ON THE LIVE HOST 2026-09-17, by `docker exec <container> cat /etc/rmd-build-sha`:
//
//   remudero-daemon          up TODAY       d83d60cbb   baked-path commits behind 0
//   remudero-site-daemon     up YESTERDAY   6549523aa   baked-path commits behind 1  (230 total)
//   remudero-console-daemon  up YESTERDAY   6549523aa   baked-path commits behind 1  (230 total)
//
// `IMAGE_SHA_CONTAINER` was the literal "remudero-daemon" at its ONE call site, so the site and
// console recycle ticks read CORE's image, saw 0, and declined — every five minutes, for a day.
// The image-side recycle has no other actor: nothing inside a container can replace the image it
// runs on, and the daemon's own freshness exit cannot see an image at all (W1-T3240).
//
// Both daemons had been SAYING so: 7 `daemon.image_drift` rows in the site ledger and 1 in the
// console's, each naming its own build sha and the baked commit it was missing.

function fakeInstall(registry?: string): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-image-sha-"));
  mkdirSync(join(root, "deploy"), { recursive: true });
  writeFileSync(join(root, "deploy", "recycle-container.sh"), "#!/usr/bin/env bash\n");
  if (registry !== undefined) {
    mkdirSync(join(root, ".remudero"), { recursive: true });
    writeFileSync(join(root, ".remudero", "daemon-instances.yaml"), registry);
  }
  return root;
}

const REGISTRY = [
  // SITE IS DECLARED FIRST, DELIBERATELY. With `core` first, "fell back to IMAGE_SHA_CONTAINER"
  // and "fell back to the first declared instance" both yield `remudero-daemon`, and the
  // unresolved-deployment assertion below cannot tell them apart. MEASURED: the falsifier for that
  // exact mistake stayed GREEN until this order changed.
  "instances:",
  "  site:",
  "    repo: remudero-site",
  "    container_name: remudero-site-daemon",
  "    state_dir: /home/craigoleyagent/rmd-site-state",
  "  core:",
  "    repo: remudero",
  "    container_name: remudero-daemon",
  "    state_dir: /home/craigoleyagent/rmd-state2",
  "  console:",
  "    repo: remudero-console",
  "    container_name: remudero-console-daemon",
  "    state_dir: /mnt/rmd/remudero-console-state",
  "",
].join("\n");

/** Drives the real factory and returns every `docker exec` argv the drift read performed. */
function driftRead(o: { installPath: string; stateRoot: string; sha?: string; throws?: boolean }) {
  const execs: string[][] = [];
  const deps = realDeployDeps({
    installPath: o.installPath,
    stateRoot: o.stateRoot,
    daemonLabel: "com.remudero.daemon",
    serveLabel: "com.remudero.serve",
    servePort: 8080,
    uid: 501,
    ledgerPath: join(o.installPath, "ledger.ndjson"),
    log: () => {},
    execFile: (cmd, args) => {
      execs.push([cmd, ...args]);
      if (cmd === "docker" && args[0] === "exec") {
        if (o.throws) throw new Error("Error: No such container");
        return `${o.sha ?? "d83d60cbb13f5abdd412e28ace3b984f622e37fd"}\n`;
      }
      if (cmd === "git") {
        // BEHAVE LIKE GIT: `rev-list <rev>..origin/main` EXITS NON-ZERO on a rev it cannot resolve,
        // which is what an unbuilt-arg image's literal "unknown" stamp produces. A fake that
        // answered 0 for it would report a stale image as current — the direction that restarts a
        // container that is down.
        const rev = (args.find((a) => a.includes("..origin/main")) ?? "").split("..")[0];
        if (!/^[0-9a-f]{40}$/.test(rev)) throw new Error(`fatal: bad revision '${rev}'`);
        return "0\n";
      }
      return "";
    },
  });
  const behind = deps.imageBakedCommitsBehind?.();
  const read = execs.find((e) => e[0] === "docker" && e[1] === "exec");
  return { container: read?.[2], behind };
}

test("the image sha is read from this deployment's own container", () => {
  // THE ASSERTION THE TASK RESTS ON, and it is about WHICH CONTAINER was asked — a test that only
  // checked the returned number would pass for a supervisor still reading core's image, which is
  // exactly the state this found.
  const root = fakeInstall(REGISTRY);
  assert.equal(driftRead({ installPath: root, stateRoot: "/home/craigoleyagent/rmd-state2" }).container, "remudero-daemon");
  assert.equal(driftRead({ installPath: root, stateRoot: "/home/craigoleyagent/rmd-site-state" }).container, "remudero-site-daemon");
  assert.equal(driftRead({ installPath: root, stateRoot: "/mnt/rmd/remudero-console-state" }).container, "remudero-console-daemon");
});

test("an unresolved deployment keeps reading the default container", () => {
  // Fail-closed, matching W1-T3732's restart seam exactly: no match, no registry, and a registry
  // that parses to nothing all leave the read where it has always been, so the core deployment is
  // byte-for-byte unchanged and no fault can point it at nothing.
  const withRegistry = fakeInstall(REGISTRY);
  assert.equal(driftRead({ installPath: withRegistry, stateRoot: "/home/craigoleyagent/elsewhere" }).container, IMAGE_SHA_CONTAINER);
  assert.equal(driftRead({ installPath: fakeInstall(undefined), stateRoot: "/home/craigoleyagent/rmd-state2" }).container, IMAGE_SHA_CONTAINER);
  assert.equal(driftRead({ installPath: fakeInstall("this: is not the registry shape\n"), stateRoot: "/home/craigoleyagent/rmd-state2" }).container, IMAGE_SHA_CONTAINER);

  // A row with a container_name but NO state_dir names an instance this deployment can never match.
  assert.equal(imageShaContainerFor("instances:\n  ghost:\n    container_name: nowhere\n", "/anything"), IMAGE_SHA_CONTAINER);
});

test("an unreadable image sha reports unknown drift", () => {
  // UNKNOWN, NEVER ZERO. The sha is unreadable exactly when the container is DOWN, which is the
  // crash-loop case W1-T3240 named — and `decideDeployTrigger` treats `undefined` as not-stale, so
  // pointing this read at the right container must not turn a stopped container into a storm.
  const root = fakeInstall(REGISTRY);
  const down = driftRead({ installPath: root, stateRoot: "/home/craigoleyagent/rmd-site-state", throws: true });
  assert.equal(down.container, "remudero-site-daemon", "it still asked the right container");
  assert.equal(down.behind, undefined, "and an unanswerable read is unknown");

  // A stamp that is not a sha is equally unknown — an unbuilt-arg image writes the literal "unknown".
  assert.equal(driftRead({ installPath: root, stateRoot: "/home/craigoleyagent/rmd-site-state", sha: "unknown" }).behind, undefined);
});
