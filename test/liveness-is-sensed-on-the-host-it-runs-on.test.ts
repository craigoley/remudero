import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { queryProcessServiceSensed, statusCommand } from "../src/lib/report-commands.js";
import type { Config } from "../src/lib/config.js";

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-liveness-host-sensor-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
}

function fakeConfig(root: string): Config {
  return { claudeBin: "/nonexistent/claude", root } as Config;
}

function enoent(cmd: string): NodeJS.ErrnoException {
  const err = new Error(`spawn ${cmd} ENOENT`) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

async function statusTextWithExec(exec: (cmd: string, args: string[]) => string): Promise<string> {
  const root = tmpRoot();
  const lines: string[] = [];
  const rc = await statusCommand([], {
    loadConfig: () => fakeConfig(root),
    lifecycleExec: exec,
    ledgerPathFor: () => join(tmpdir(), "definitely-does-not-exist-ever.ndjson"),
    repoRoot: "/nonexistent/repo/for/tests",
    github: null,
    out: (line) => lines.push(line),
  });
  assert.equal(rc, 0);
  assert.equal(lines.length, 1);
  return lines[0];
}

test("on a host with no launchctl, a running daemon renders as running with process-table provenance", async () => {
  const calls: string[] = [];
  const text = await statusTextWithExec((cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd === "launchctl") throw enoent(cmd);
    if (cmd === "ps") {
      return [
        " 111 node /repo/src/run-task.ts drain --reason daemon",
        " 4242 node /repo/src/run-task.ts daemon --repo remudero",
      ].join("\n");
    }
    throw new Error(`unexpected command ${cmd}`);
  });

  assert.ok(calls.some((call) => call.startsWith("launchctl print ")), "the production path must try launchd first");
  assert.ok(calls.includes("ps -eo pid=,args="), "the production path must fall back to the host process table");
  assert.match(text, /daemon\s*:\s*running \(pid 4242; sensor: process table\)/);
  assert.doesNotMatch(text, /daemon\s*:\s*unknown/);
});

test("on a host with no launchctl, an absent resident service renders as not running", async () => {
  const text = await statusTextWithExec((cmd) => {
    if (cmd === "launchctl") throw enoent(cmd);
    if (cmd === "ps") return " 4242 node /repo/src/run-task.ts daemon --repo remudero\n";
    throw new Error(`unexpected command ${cmd}`);
  });

  assert.match(text, /serve\s*:\s*not running; sensor: process table/);
});

test("a host with neither launchctl nor ps still renders unknown instead of fabricating a state", async () => {
  const text = await statusTextWithExec((cmd) => {
    if (cmd === "launchctl" || cmd === "ps") throw enoent(cmd);
    throw new Error(`unexpected command ${cmd}`);
  });

  assert.match(text, /daemon\s*:\s*unknown — no liveness sensor on this host/);
  assert.match(text, /next action\s*:\s*no liveness sensor on this host/);
});

test("the process-table sensor keys on the rmd verb, not stray service words in another command", () => {
  const state = queryProcessServiceSensed("daemon", () =>
    [
      " 111 node /repo/src/run-task.ts drain --reason daemon",
      " 222 node /repo/src/run-task.ts daemon --repo remudero",
    ].join("\n"),
  );

  assert.deepEqual(state, { running: true, pid: 222, sensed: true, sensor: "process-table" });
});
