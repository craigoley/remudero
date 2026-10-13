/**
 * #8429: a supervised cold start sat at `board_computed: false` for its whole 330 s bound, and the
 * readiness report said nothing else, so nobody could tell a projection still running from one that
 * had failed, crashed or gone stale. The criterion keeps its verdict and now says why beside it.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBoardProjectionWorker } from "../src/lib/board-worker.js";
import { fixedClock } from "../src/lib/clock.js";
import { BOARD_REASON_BOUND, boardComputedProbe, listenReadiness } from "../src/lib/serve-generation.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { fakeGitHub } from "./helpers/fake-github.js";

const BOOT = Date.parse("2026-10-01T16:00:00.000Z");
const query = new URLSearchParams();

function boardPaths() {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}board-why-`));
  return { planPath: join(root, "tasks.yaml"), ledgerPath: join(root, "ledger.ndjson"), inflightDir: join(root, "inflight") };
}

function overSocket(socketPath: string, path: string): Promise<{ status?: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, agent: false }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("a board whose first projection has not finished reads as still computing since its build started, not as a failure", () => {
  const worker = createBoardProjectionWorker(fakeGitHub(), boardPaths(), { clock: fixedClock(BOOT) });
  try {
    const criterion = boardComputedProbe(worker, fixedClock(BOOT + 330_000))(query);
    assert.equal(criterion.ok, false, "the verdict is unchanged: no snapshot, not computed");
    assert.deepEqual(criterion.detail, {
      state: "unavailable",
      reason: "not_ready",
      buildStartedAt: "2026-10-01T16:00:00.000Z",
      msSinceBuildStarted: 330_000,
    });
  } finally {
    worker.stop();
  }
});

test("a board worker that could not start names its error beside board_computed false on the private socket", async () => {
  const worker = createBoardProjectionWorker(fakeGitHub(), boardPaths(), { workerUrl: new URL("https://example.invalid/worker.js") });
  worker.start();
  const real = createServer((_req, res) => res.end("real route"));
  const socketPath = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}board-why-sock-`)), "gen.sock");
  const priv = await listenReadiness(real, socketPath, () => [boardComputedProbe(worker)]);
  try {
    const ready = await overSocket(socketPath, "/v1/ready");
    assert.equal(ready.status, 503, "a failed projection never reads as ready");
    const board = (JSON.parse(ready.body) as { criteria: Array<{ name: string; ok: boolean; detail?: { state?: string; reason?: string } }> }).criteria[0];
    assert.equal(board.name, "board_computed");
    assert.equal(board.ok, false);
    assert.equal(board.detail?.state, "unavailable");
    assert.match(String(board.detail?.reason), /^worker_spawn_failed: /, "the failing stage and its error are named, so a failure reads differently from a stall");
  } finally {
    worker.stop();
    real.emit("close");
  }
  await new Promise((resolve) => priv.once("close", resolve));
});

test("a long failure reason is bounded so one verbose error cannot bloat every readiness poll", () => {
  const reason = `worker_projection_failed: ${"x".repeat(10_000)}`;
  const board = { isReady: () => false, current: () => ({ state: "unavailable" as const, buildStartedAt: new Date(BOOT).toISOString(), checkedAt: "", reason }) };
  const detail = boardComputedProbe(board, fixedClock(BOOT))(query).detail as { reason: string };
  assert.equal(detail.reason.length, BOARD_REASON_BOUND);
  assert.ok(detail.reason.startsWith("worker_projection_failed: xxx"), "the stage that failed survives the cut");
  assert.ok(detail.reason.endsWith("…"), "a cut reason says it was cut");
});

test("a computed board stays ready and says how old its snapshot is", () => {
  const board = { isReady: () => true, current: () => ({ state: "ready" as const, snapshot: { generated_at: new Date(BOOT).toISOString() } as never }) };
  const criterion = boardComputedProbe(board, fixedClock(BOOT + 1_500))(query);
  assert.equal(criterion.ok, true);
  assert.deepEqual(criterion.detail, { state: "ready", generatedAt: "2026-10-01T16:00:00.000Z", snapshotAgeMs: 1_500 });
});

test("a board gate that cannot say why keeps its bare verdict and is marked unmeasurable, never ready", () => {
  const criterion = boardComputedProbe({ isReady: () => false })(query);
  assert.deepEqual(criterion, { name: "board_computed", ok: false, detail: { measurable: false } });
});
