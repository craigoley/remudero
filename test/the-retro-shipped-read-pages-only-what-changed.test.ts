import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { boardOpenSnapshotPath, boardSnapshotPath, createBoardSnapshotCache, type BoardSnapshotCache } from "../src/lib/board-snapshot-cache.js";
import { loadConfig } from "../src/lib/config.js";
import type { GhAsyncExecutor } from "../src/lib/github-transport.js";
import { ledgerPathFor } from "../src/lib/ledger-path.js";
import { mapBoardPr, type RestPullRow } from "../src/lib/open-prs-rest.js";
import { ShippedReadPending } from "../src/lib/retro.js";
import { retroShippedGithubGateway, retroShippedGithubGatewayAsync } from "../src/run-task.js";

const OWNER_REPO = { owner: "retro-fixture", repo: "snapshot" };
const url = (number: number): string => `https://github.com/retro-fixture/snapshot/pull/${number}`;
const wire = (number: number, updatedAt = "2026-10-01T00:00:00Z"): RestPullRow => ({
  number, html_url: url(number), state: "closed", merged_at: updatedAt, updated_at: updatedAt,
  head: { ref: `run-W1-T${number}-1`, sha: `sha-${number}` },
  title: `pr ${number}`, body: `Remudero-Task: W1-T${number}`,
});
const CLOSED = Array.from({ length: 121 }, (_, index) => wire(index + 1));
const CHANGED = [wire(500, "2026-10-15T00:00:00Z"), {
  ...wire(1, "2026-10-14T00:00:00Z"), head: { ref: "changed-head", sha: "changed-sha" },
}, ...CLOSED.slice(1)];
const OPEN: RestPullRow[] = [{ ...wire(900), state: "open", merged_at: null }];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-retro-snapshot-"));
  const snapshot = createBoardSnapshotCache(root, OWNER_REPO.owner, OWNER_REPO.repo);
  assert.equal(snapshot.commitClosed(CLOSED.map(mapBoardPr)), true);
  return { root, snapshot };
}

function pages(closed = CHANGED) {
  const calls: string[][] = [];
  const exec = (args: readonly string[]): string => {
    calls.push([...args]);
    assert.equal(args[0], "api");
    const query = new URL(`https://fixture/${args[1]}`).searchParams;
    const rows = query.get("state") === "open" ? OPEN : closed;
    const page = Number(query.get("page"));
    const size = Number(query.get("per_page"));
    assert.ok(page > 0 && size > 0, "every read names its page and size");
    return JSON.stringify(rows.slice((page - 1) * size, page * size));
  };
  const execAsync: GhAsyncExecutor = async (_file, args) => ({ stdout: exec(args), stderr: "" });
  const requested = (half: string) => calls.filter((args) => args[1].includes(`state=${half}&`)).map((args) => {
    const query = new URL(`https://fixture/${args[1]}`).searchParams;
    return [Number(query.get("page")), Number(query.get("per_page"))];
  });
  return { exec, execAsync, requested, calls };
}

async function read<T>(query: () => T): Promise<T> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return query();
    } catch (error) {
      if (!(error instanceof ShippedReadPending)) throw error;
      await error.load();
    }
  }
  throw new Error("the async load and replay never agreed on their pages");
}

const quiet = () => {};

test("W1-T9113: a seeded retro read pages only what changed", async () => {
  const { snapshot } = fixture();
  let captures = 0;
  let seeds = 0;
  const snapshotFor = (owner: string, repo: string): BoardSnapshotCache => {
    assert.deepEqual({ owner, repo }, OWNER_REPO);
    captures++;
    return { ...snapshot, closedSeed: () => {
      seeds++;
      assert.equal(seeds, 1, "load and every replay reuse the captured seed");
      return snapshot.closedSeed();
    } };
  };
  const rest = pages();
  const gateway = await retroShippedGithubGatewayAsync({ ownerRepo: OWNER_REPO, snapshotFor, execAsync: rest.execAsync, log: quiet });
  assert.equal(captures, 1, "capture the snapshot when the gateway is built");
  assert.equal(seeds, 1);
  assert.equal(await read(() => gateway.headRefName(url(500))), "run-W1-T500-1");
  assert.equal(await read(() => gateway.headRefName(url(1))), "changed-head");
  assert.equal(await read(() => gateway.headRefName(url(121))), "run-W1-T121-1", "retain the unvisited snapshot tail");
  assert.equal((await read(() => gateway.findMergedByTrailer("W1-T500")))?.url, url(500));
  assert.equal(await read(() => gateway.headRefName(url(900))), "run-W1-T900-1");
  assert.deepEqual(rest.requested("closed"), [[1, 30]]);
  assert.deepEqual(rest.requested("open"), [[1, 100]], "the open half never inherits the closed seed");
  assert.equal(seeds, 1);
});

test("W1-T9113: the sync retro gateway reads the board snapshot", () => {
  const { snapshot } = fixture();
  let captures = 0;
  let seeds = 0;
  const rest = pages();
  const gateway = retroShippedGithubGateway({ ownerRepo: OWNER_REPO, exec: rest.exec, snapshotFor: () => {
    captures++;
    return { ...snapshot, closedSeed: () => { seeds++; return snapshot.closedSeed(); } };
  } });
  assert.equal(captures, 1);
  assert.equal(seeds, 1);
  assert.equal(gateway.headRefName(url(500)), "run-W1-T500-1");
  assert.equal(gateway.headRefName(url(1)), "changed-head");
  assert.equal(gateway.headRefName(url(121)), "run-W1-T121-1");
  assert.equal(gateway.findMergedByTrailer("W1-T500")?.url, url(500));
  assert.deepEqual(rest.requested("closed"), [[1, 30]]);
  assert.deepEqual(rest.requested("open"), [[1, 100]]);
});

test("W1-T9113: with no snapshot the retro read walks in full", async () => {
  for (const corrupt of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "rmd-retro-no-snapshot-"));
    if (corrupt) {
      const path = boardSnapshotPath(root, OWNER_REPO.owner, OWNER_REPO.repo);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "unreadable snapshot\n");
    }
    const snapshotFor = () => createBoardSnapshotCache(root, OWNER_REPO.owner, OWNER_REPO.repo);
    const sync = pages();
    assert.equal(retroShippedGithubGateway({ ownerRepo: OWNER_REPO, snapshotFor, exec: sync.exec }).headRefName(url(121)), "run-W1-T121-1");
    const async = pages();
    const rows: Record<string, unknown>[] = [];
    const gateway = await retroShippedGithubGatewayAsync({ ownerRepo: OWNER_REPO, snapshotFor, execAsync: async.execAsync,
      log: (step, fields) => rows.push({ step, ...fields }) });
    assert.equal(await read(() => gateway.headRefName(url(121))), "run-W1-T121-1");
    for (const rest of [sync, async]) {
      assert.deepEqual(rest.requested("closed"), [[1, 100], [2, 100]]);
      assert.deepEqual(rest.requested("open"), [[1, 100]]);
    }
    assert.deepEqual(rows, [
      { step: "retro_trigger.shipped_read", half: "open", mode: "full", calls: 1, seeded: 0 },
      { step: "retro_trigger.shipped_read", half: "closed", mode: "full", calls: 2, seeded: 0 },
    ]);
  }
});

test("W1-T9113: a retro read never writes the board snapshot", async () => {
  const { root, snapshot } = fixture();
  const path = boardSnapshotPath(root, OWNER_REPO.owner, OWNER_REPO.repo);
  const original = readFileSync(path);
  const commits: string[] = [];
  const snapshotFor = (): BoardSnapshotCache => ({ ...snapshot,
    commitClosed: (rows) => { commits.push("closed"); return snapshot.commitClosed(rows); },
    commitIssues: (rows) => { commits.push("issues"); return snapshot.commitIssues(rows); },
    commitOpen: (rows, at) => { commits.push("open"); return snapshot.commitOpen!(rows, at); },
  });
  const sync = pages();
  assert.equal(retroShippedGithubGateway({ ownerRepo: OWNER_REPO, snapshotFor, exec: sync.exec }).headRefName(url(500)), "run-W1-T500-1");
  const async = pages();
  const gateway = await retroShippedGithubGatewayAsync({ ownerRepo: OWNER_REPO, snapshotFor, execAsync: async.execAsync, log: quiet });
  assert.equal(await read(() => gateway.headRefName(url(500))), "run-W1-T500-1");
  assert.deepEqual(commits, []);
  assert.deepEqual(readFileSync(path), original);
  assert.equal(existsSync(boardOpenSnapshotPath(root, OWNER_REPO.owner, OWNER_REPO.repo)), false);
});

test("W1-T9113: async board loads ledger their mode and page count", async () => {
  const { snapshot } = fixture();
  const rest = pages();
  const path = ledgerPathFor(loadConfig());
  const before = existsSync(path) ? readFileSync(path, "utf8").length : 0;
  const gateway = await retroShippedGithubGatewayAsync({ ownerRepo: OWNER_REPO, snapshotFor: () => snapshot, execAsync: rest.execAsync });
  assert.equal(await read(() => gateway.headRefName(url(500))), "run-W1-T500-1");
  assert.equal(await read(() => gateway.headRefName(url(121))), "run-W1-T121-1");
  const rows = readFileSync(path, "utf8").slice(before).trim().split("\n").map((line) => JSON.parse(line))
    .filter((row) => row.step === "retro_trigger.shipped_read")
    .map(({ step, half, mode, calls, seeded }) => ({ step, half, mode, calls, seeded }));
  assert.deepEqual(rows, [
    { step: "retro_trigger.shipped_read", half: "open", mode: "full", calls: 1, seeded: 0 },
    { step: "retro_trigger.shipped_read", half: "closed", mode: "delta", calls: 1, seeded: 121 },
  ]);
});

test("W1-T9113: default gateways capture the configured durable snapshot before a board rewrite", async () => {
  const root = loadConfig().root;
  const snapshot = createBoardSnapshotCache(root, OWNER_REPO.owner, OWNER_REPO.repo);
  assert.equal(snapshot.commitClosed(CLOSED.map(mapBoardPr)), true);
  const sync = pages();
  const async = pages();
  const syncGateway = retroShippedGithubGateway({ ownerRepo: OWNER_REPO, exec: sync.exec });
  const asyncGateway = await retroShippedGithubGatewayAsync({ ownerRepo: OWNER_REPO, execAsync: async.execAsync, log: quiet });
  assert.equal(snapshot.commitClosed([]), true, "the board can replace its durable snapshot after capture");
  const rewritten = readFileSync(boardSnapshotPath(root, OWNER_REPO.owner, OWNER_REPO.repo));
  assert.equal(syncGateway.headRefName(url(121)), "run-W1-T121-1");
  assert.equal(await read(() => asyncGateway.headRefName(url(121))), "run-W1-T121-1");
  for (const rest of [sync, async]) assert.deepEqual(rest.requested("closed"), [[1, 30]]);
  assert.deepEqual(readFileSync(boardSnapshotPath(root, OWNER_REPO.owner, OWNER_REPO.repo)), rewritten);
});
