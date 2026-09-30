import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { statusCommand } from "../src/lib/report-commands.js";
import type { Config } from "../src/lib/config.js";
import { ghShim } from "./helpers/gh-shim.js";

async function hungGithubStatus(): Promise<{ elapsedMs: number; json: Record<string, any> }> {
  const root = mkdtempSync(join(tmpdir(), "rmd-status-json-deadline-"));
  const shim = ghShim([{ when: "", delaySeconds: 5 }], { kind: "status-json-deadline" });
  const repo = join(root, "repo");
  mkdirSync(join(repo, "plan"), { recursive: true });
  writeFileSync(join(repo, "plan", "tasks.yaml"), [
    "- id: W1-T4208-FIXTURE",
    "  title: a runnable task",
    "  repo: remudero",
    "  type: implement",
    "  verify: auto",
    "  depends_on: []",
    "  status: queued",
    "",
  ].join("\n"));
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  const lines: string[] = [];
  const started = Date.now();
  try {
    const rc = await statusCommand(["--json"], {
      loadConfig: () => ({ root } as Config),
      queryService: () => ({ running: false, pid: null }),
      ledgerPathFor: () => join(root, "absent.ndjson"),
      readLedgerLines: () => [],
      repoRoot: repo,
      resolveOwnerRepo: () => ({ owner: "example", repo: "repo" }),
      jsonDeadlineMs: 400,
      out: (line) => lines.push(line),
    });
    assert.equal(rc, 0);
    assert.equal(lines.length, 1);
    return { elapsedMs: Date.now() - started, json: JSON.parse(lines[0]) };
  } finally {
    process.env.PATH = oldPath;
  }
}

test("W1-T4208: status json returns within its deadline when a read hangs", async () => {
  const result = await hungGithubStatus();
  assert.ok(result.elapsedMs < 1_500, `hung gh held status for ${result.elapsedMs}ms`);
});

test("W1-T4208: an unfinished read is reported as unavailable, not empty", async () => {
  const { json } = await hungGithubStatus();
  assert.equal(json.queueHead.status, "unavailable");
  assert.match(json.queueHead.unknownReason, /GitHub gateway unreachable/);
  assert.equal(json.queueHead.rows, null);
  assert.equal(json.queueHead.refused, null);
  assert.equal(json.inbox.status, "unavailable");
  assert.equal(json.inbox.readyCount, null);
  assert.equal(json.inbox.notReadyCount, null);
});

test("status JSON bounds Git remote reads on the same deadline and reports unknown claims", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-status-json-git-deadline-"));
  const bin = join(root, "bin");
  const repo = join(root, "repo");
  mkdirSync(bin);
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "plan"));
  writeFileSync(join(repo, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(bin, "git"), "#!/bin/sh\nexec sleep 5\n");
  chmodSync(join(bin, "git"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  const lines: string[] = [];
  const started = Date.now();
  try {
    const rc = await statusCommand(["--json"], {
      loadConfig: () => ({ root } as Config),
      queryService: () => ({ running: false, pid: null }),
      ledgerPathFor: () => join(root, "absent.ndjson"),
      readLedgerLines: () => [],
      repoRoot: repo,
      github: null,
      jsonDeadlineMs: 400,
      out: (line) => lines.push(line),
    });
    assert.equal(rc, 0);
    assert.ok(Date.now() - started < 1_500);
    const json = JSON.parse(lines[0]);
    assert.equal(json.queueHead.status, "unavailable");
    assert.match(json.queueHead.unknownReason, /run-branch lookup unavailable/);
    assert.equal(json.externalReads.runBranches.status, "unavailable");
    assert.equal(json.externalReads.dispatchClaims.reason, "deadline");
    assert.ok(json.latches.rows.some((row: { name: string; consequence: string }) =>
      row.name === "DISPATCH_CLAIMS" && /cannot reach origin/.test(row.consequence)));
  } finally {
    process.env.PATH = oldPath;
  }
});

test("status JSON bounds lifecycle probes and keeps an expired sensor unknown", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-status-json-lifecycle-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "launchctl"), "#!/bin/sh\nexit 1\n");
  writeFileSync(join(bin, "ps"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "launchctl"), 0o755);
  chmodSync(join(bin, "ps"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  try {
    const run = async (expireBeforeProbe: boolean) => {
      const lines: string[] = [];
      await statusCommand(["--json"], {
        loadConfig: () => {
          if (expireBeforeProbe) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
          return { root } as Config;
        },
        ledgerPathFor: () => join(root, "absent.ndjson"),
        readLedgerLines: () => [],
        repoRoot: root,
        github: null,
        jsonDeadlineMs: expireBeforeProbe ? 30 : 400,
        out: (line) => lines.push(line),
      });
      return JSON.parse(lines[0]);
    };
    const measured = await run(false);
    assert.equal(measured.liveness.services[0].sensed, true);
    const expired = await run(true);
    assert.equal(expired.liveness.services[0].sensed, false);
    assert.deepEqual(expired.externalReads.lifecycle, { status: "unavailable", reason: "deadline" });
  } finally {
    process.env.PATH = oldPath;
  }
});

test("status JSON decodes a successful dispatch-claim read without losing its holder", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-status-json-claims-"));
  const bin = join(root, "bin");
  const repo = join(root, "repo");
  mkdirSync(bin);
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "plan"));
  writeFileSync(join(repo, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(bin, "git"), [
    "#!/bin/sh",
    "case \"$*\" in",
    "  *rev-parse*) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;",
    "  *refs/rmd-dispatch/*) printf 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\trefs/rmd-dispatch/W1-T99\\ninvalid\\n' ;;",
    "  *) exit 0 ;;",
    "esac",
    "",
  ].join("\n"));
  chmodSync(join(bin, "git"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  const lines: string[] = [];
  try {
    const rc = await statusCommand(["--json"], {
      loadConfig: () => ({ root } as Config),
      queryService: () => ({ running: false, pid: null }),
      ledgerPathFor: () => join(root, "absent.ndjson"),
      readLedgerLines: () => [],
      repoRoot: repo,
      github: null,
      jsonDeadlineMs: 400,
      out: (line) => lines.push(line),
    });
    assert.equal(rc, 0);
    const json = JSON.parse(lines[0]);
    assert.ok(json.latches.rows.some((row: { name: string; consequence: string }) =>
      row.name === "dispatch-claim:W1-T99" && row.consequence.includes("bbbbbbbb")));
    assert.deepEqual(json.externalReads, {});
  } finally {
    process.env.PATH = oldPath;
  }
});
