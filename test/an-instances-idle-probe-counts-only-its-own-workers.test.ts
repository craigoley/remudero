import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { daemonIsIdle, realDeployDeps } from "../src/lib/deployer.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

/**
 * W1-T6260 — deploy-run is started ON THE HOST by each instance's launcher, so a host-wide `pgrep`
 * saw every container's workers. Console's 2026-10-07 deploy.not_idle rows read zero locks of its
 * own with workers 2-4: core's. When the launcher names the instance's container
 * (RMD_RESOURCE_POLICY_CONTAINER), probeIdle now reads THAT container's process table instead.
 *
 * The fixture is a fake host: `docker top <name>` answers per container, and `pgrep` answers with
 * the whole host's matches, exactly as the live host did (core's one codex worker, seen twice).
 */

const CORE_TOP = [
  "PID                 PPID                COMMAND",
  "9001                1                   /sbin/tini -- node dist/daemon.js",
  "9100                9001                node /usr/local/bin/codex exec --json -",
  "9101                9100                /usr/local/lib/codex/codex-x86_64-unknown-linux-musl exec --json -",
  "",
].join("\n");
const CONSOLE_TOP = [
  "PID                 PPID                COMMAND",
  "8001                1                   /sbin/tini -- node dist/daemon.js",
  "8002                8001                node dist/serve.js",
  "",
].join("\n");
const HOST_PGREP = "9100\n9101\n";

function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}own-workers-`));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 2 });
  }
}

function withContainer(name: string | undefined, fn: () => void): void {
  const prior = process.env.RMD_RESOURCE_POLICY_CONTAINER;
  if (name === undefined) delete process.env.RMD_RESOURCE_POLICY_CONTAINER;
  else process.env.RMD_RESOURCE_POLICY_CONTAINER = name;
  try {
    fn();
  } finally {
    if (prior === undefined) delete process.env.RMD_RESOURCE_POLICY_CONTAINER;
    else process.env.RMD_RESOURCE_POLICY_CONTAINER = prior;
  }
}

function probe(root: string, execFile: (cmd: string, args: string[]) => string) {
  return realDeployDeps({
    installPath: "/inst",
    stateRoot: root,
    daemonLabel: "com.remudero.daemon",
    serveLabel: "com.remudero.serve",
    servePort: 4317,
    uid: 502,
    ledgerPath: join(root, "ledger.ndjson"),
    log: () => {},
    execFile,
    sleep: () => {},
  }).probeIdle();
}

/** A fake host: per-container `docker top`, and a host-wide `pgrep` that sees every container. */
function fakeHost(calls: string[][]) {
  return (cmd: string, args: string[]): string => {
    calls.push([cmd, ...args]);
    if (cmd === "pgrep") return HOST_PGREP;
    if (cmd === "docker" && args[0] === "top") {
      if (args[1] === "rmd-core") return CORE_TOP;
      if (args[1] === "rmd-console") return CONSOLE_TOP;
      throw Object.assign(new Error(`Error: No such container: ${args[1]}`), { status: 1 });
    }
    throw new Error(`unexpected exec ${cmd} ${args.join(" ")}`);
  };
}

test("W1-T6260: another container's worker does not make this instance busy", () => {
  withRoot((root) => {
    const calls: string[][] = [];
    withContainer("rmd-console", () => {
      const p = probe(root, fakeHost(calls));
      assert.equal(p.workers, 0, "core's codex worker is not console's");
      assert.deepEqual([...(p.unreadable ?? [])], []);
      assert.equal(daemonIsIdle(p), true, "console with no workers and no locks of its own is idle");
    });
    assert.deepEqual(calls.at(-1)?.slice(0, 3), ["docker", "top", "rmd-console"], "read its OWN container");
    assert.equal(calls.some(([cmd]) => cmd === "pgrep"), false, "never the host-wide table when a container is named");
  });
});

test("W1-T6260: its own container's worker makes it busy, counted once across the node wrapper", () => {
  withRoot((root) => {
    withContainer("rmd-core", () => {
      const p = probe(root, fakeHost([]));
      assert.equal(p.workers, 1, "the node wrapper and the musl binary it spawned are ONE worker");
      assert.equal(daemonIsIdle(p), false);
    });
  });
});

test("W1-T6260: an unreadable container read stays unreadable, never zero", () => {
  withRoot((root) => {
    withContainer("rmd-gone", () => {
      const p = probe(root, fakeHost([]));
      assert.deepEqual([...(p.unreadable ?? [])], ["workers"]);
      assert.equal(daemonIsIdle(p), false);
    });
    withContainer("rmd-empty", () => {
      const p = probe(root, () => "PID PPID COMMAND\n");
      assert.deepEqual([...(p.unreadable ?? [])], ["workers"], "a running container always has a process");
    });
  });
});

test("W1-T6260: with no container named, the host-wide pgrep still counts (single-instance path)", () => {
  withRoot((root) => {
    const calls: string[][] = [];
    withContainer(undefined, () => {
      const p = probe(root, fakeHost(calls));
      assert.equal(p.workers, 2);
    });
    assert.deepEqual(calls.map(([cmd]) => cmd), ["pgrep"]);
  });
});
