import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { statusCommand, type StatusDeps } from "../src/lib/report-commands.js";
import { boardSnapshotPath, createBoardSnapshotCache } from "#src/lib/board-snapshot-cache.js";
import { fixedClock } from "#src/lib/clock.js";
import type { BoardPrRest } from "#src/lib/open-prs-rest.js";
import type { Config } from "../src/lib/config.js";
import { ghShim } from "./helpers/gh-shim.js";
import { assertWallClockBound } from "./helpers/wall-clock-bound.js";

async function hungGithubStatus(
  seed?: (root: string) => void,
  extra: Partial<StatusDeps> = {},
  options: { gitFailure?: boolean } = {},
): Promise<{ elapsedMs: number; json: Record<string, any> }> {
  const root = mkdtempSync(join(tmpdir(), "rmd-status-json-deadline-"));
  seed?.(root);
  const shim = ghShim([{ when: "", delaySeconds: 5 }], { kind: "status-json-deadline" });
  const bin = join(root, "bin");
  if (options.gitFailure) {
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bin, "git"), 0o755);
  }
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
  process.env.PATH = `${options.gitFailure ? `${bin}:` : ""}${shim.dir}:${oldPath ?? ""}`;
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
      ...extra,
    });
    assert.equal(rc, 0);
    assert.equal(lines.length, 1);
    const elapsedMs = Date.now() - started;
    assertWallClockBound(elapsedMs, 1_500, `status JSON read held for ${elapsedMs}ms`);
    return { elapsedMs, json: JSON.parse(lines[0]) };
  } finally {
    process.env.PATH = oldPath;
  }
}

test("W1-T4208: status json returns within its deadline when a read hangs", async () => {
  await hungGithubStatus();
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
    assertWallClockBound(Date.now() - started, 1_500, "a hung Git remote must not hold status");
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

function closedRow(number: number): BoardPrRest {
  return {
    number,
    url: `https://github.com/example/repo/pull/${number}`,
    state: "MERGED",
    headRefName: `run-W1-T${number}-1700000000000`,
    headRefOid: `sha-${number}`,
    body: `Remudero-Task: W1-T${number}`,
    autoMergeRequest: null,
    title: `merged ${number}`,
    updatedAt: "2026-09-05T00:00:00Z",
  };
}

/** Run the real JSON status with an injected gateway builder; return the cache it was handed. */
async function snapshotCacheHandedToGateway(seed: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "rmd-status-json-snapshot-"));
  seed(root);
  const repo = join(root, "repo");
  mkdirSync(join(repo, "plan"), { recursive: true });
  writeFileSync(join(repo, "plan", "tasks.yaml"), "[]\n");
  let handed: unknown = "builder never called";
  const lines: string[] = [];
  await statusCommand(["--json"], {
    loadConfig: () => ({ root } as Config),
    queryService: () => ({ running: false, pid: null }),
    ledgerPathFor: () => join(root, "absent.ndjson"),
    readLedgerLines: () => [],
    repoRoot: repo,
    resolveOwnerRepo: () => ({ owner: "example", repo: "repo" }),
    jsonDeadlineMs: 400,
    buildBatchedGithub: ((_owner: string, _repo: string, opts?: { snapshotCache?: unknown }) => {
      handed = opts?.snapshotCache;
      throw new Error("stop after capturing the gateway options");
    }) as unknown as StatusDeps["buildBatchedGithub"],
    out: (line) => lines.push(line),
  });
  return handed as ReturnType<typeof createBoardSnapshotCache> | undefined;
}

test("W1-T11280 fresh snapshot: status JSON reuses a persisted GitHub snapshot", async () => {
  const cache = await snapshotCacheHandedToGateway((root) => {
    assert.equal(createBoardSnapshotCache(root, "example", "repo").commitClosed([closedRow(7)]), true);
  });
  assert.ok(cache && typeof cache === "object", "the JSON gateway must be handed the persisted snapshot cache");
  assert.deepEqual([...(cache.closedSeed()?.keys() ?? [])], [7]);
});

const unusableSnapshots: Array<[string, (root: string) => void]> = [
  ["missing", () => {}],
  ["truncated", (root) => {
    createBoardSnapshotCache(root, "example", "repo").commitClosed([closedRow(7), closedRow(8)]);
    const path = boardSnapshotPath(root, "example", "repo");
    writeFileSync(path, readFileSync(path, "utf8").slice(0, -20));
  }],
  ["unreadable", (root) => mkdirSync(boardSnapshotPath(root, "example", "repo"), { recursive: true })],
];

for (const [name, seed] of unusableSnapshots) {
  test(`W1-T11280 ${name} snapshot: the snapshot is never read as rows and the status read stays unavailable`, async () => {
    const cache = await snapshotCacheHandedToGateway(seed);
    assert.ok(cache && typeof cache === "object", "the JSON gateway must be handed the persisted snapshot cache");
    assert.equal(cache.closedSeed(), undefined);
    const { json } = await hungGithubStatus(seed);
    assert.equal(json.queueHead.status, "unavailable");
    assert.equal(json.queueHead.rows, null);
    assert.equal(json.inbox.status, "unavailable");
    assert.equal(json.inbox.readyCount, null);
  });
}

test("W1-T11280 stale snapshot: it does not fill an unfinished read and the status read stays unavailable", async () => {
  const stale = (root: string): void => {
    const clock = fixedClock(Date.parse("2020-01-01T00:00:00Z"));
    createBoardSnapshotCache(root, "example", "repo", { clock }).commitClosed([closedRow(7)]);
  };
  const { json } = await hungGithubStatus(stale);
  assert.equal(json.queueHead.status, "unavailable");
  assert.equal(json.queueHead.rows, null);
  assert.equal(json.inbox.status, "unavailable");
  assert.equal(json.inbox.readyCount, null);
});

test("W1-T11280 remote-ref failure: a read failure beside a fresh snapshot stays unavailable", async () => {
  const { json } = await hungGithubStatus((root) => {
    assert.equal(createBoardSnapshotCache(root, "example", "repo").commitClosed([closedRow(7)]), true);
  }, {}, { gitFailure: true });
  assert.equal(json.queueHead.status, "unavailable");
  assert.equal(json.queueHead.rows, null);
  assert.equal(json.externalReads.runBranches.status, "unavailable");
});
