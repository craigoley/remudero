// W1-T945: THERE IS NO WAY TO READ A LIVE WORKER'S OUTPUT — this proves the READERS this task
// adds over W1-T942's retained tail (`state/runs/<runId>.tail`), and only readers.
//
// Six acceptance claims (task record's own numbering), five proven here (the sixth, docs,
// is a grep proof):
//   1. `rmd peek <runId>` prints the last N lines and exits 0, stating LIVE/FINISHED off the
//      SAME `liveInflightRuns` pid-checked read every other liveness decision uses.
//   2. peek works on a FINISHED run's retained tail.
//   3. an unknown run id or an absent tail prints a NAMED reason and exits 0 — never silent
//      empty output.
//   4. the surface is read-only by construction — no parameter writes/signals/resumes/kills.
//   5. the run id is validated against the known shape before any path is built, so no id can
//      escape the tail directory, and the response is byte- and line-capped.
// (6. "rmd peek" appears in docs/operator-guide.md's command table — grep proof, not here.)

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import { buildPeekRoute } from "../src/lib/serve.js";
import {
  capWorkerTailLines,
  isValidRunId,
  peekCommand,
  readWorkerTail,
  RUN_ID_SHAPE,
  WORKER_TAIL_MAX_BYTES,
  WORKER_TAIL_MAX_LINES,
  type PeekTailResult,
} from "../src/run-task.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-peek-"));
}

function writeTail(root: string, runId: string, lines: string[]): void {
  const dir = join(root, "state", "runs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.tail`), lines.length ? lines.join("\n") + "\n" : "");
}

function writeInflightLock(root: string, taskId: string, info: { pid: number; run_id: string }): void {
  const dir = join(root, "state", "inflight");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${taskId}.lock`), JSON.stringify({ ...info, host: "h", startedAt: "2026-08-01T00:00:00.000Z" }));
}

// ── run-id shape (claim 5, path-safety half) ────────────────────────────────────────────────

test("isValidRunId accepts every id shape this codebase actually mints, rejects anything that could reach outside state/runs/", () => {
  for (const ok of [
    "W1-T945-1786970059043",
    "RETRO-1786867677764",
    "review-PR2049-1786867677764",
    "dep-review-PR12-1786867677764",
    "SERVE-1786867677764",
    "COVERAGE-IMPROVE-1786867677764",
    "a",
  ]) {
    assert.ok(isValidRunId(ok), `expected ${ok} to be a valid run id`);
  }
  for (const bad of ["../etc/passwd", "a/b", "..", "", ".", "a b", "a\0b", "a.tail", "/etc/passwd"]) {
    assert.equal(isValidRunId(bad), false, `expected ${JSON.stringify(bad)} to be rejected`);
  }
  // the exported RUN_ID_SHAPE is the same regex isValidRunId tests against — no second definition.
  assert.equal(RUN_ID_SHAPE.test("../x"), false);
});

// ── readWorkerTail: the shared primitive both the CLI and the route read through ───────────

test("readWorkerTail: an invalid run-id shape is refused BEFORE any path is built — the injected readFile is never called", () => {
  const root = tmpRoot();
  try {
    let called = false;
    const result = readWorkerTail(root, "../etc/passwd", { readFile: () => ((called = true), "") });
    assert.equal(result.found, false);
    assert.match(result.reason ?? "", /invalid run id/);
    assert.equal(called, false, "no path was ever opened for an invalid id");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readWorkerTail: an unknown run id / absent tail reports found:false with a NAMED reason, never silent empty output (claim 3)", () => {
  const root = tmpRoot();
  try {
    const result = readWorkerTail(root, "W1-T999-1786970000000", {});
    assert.equal(result.found, false);
    assert.equal(result.reason, "no tail recorded for W1-T999-1786970000000");
    assert.deepEqual(result.lines, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readWorkerTail: reads a retained tail off a FINISHED run (no live in-flight lock at all) — claim 2", () => {
  const root = tmpRoot();
  try {
    writeTail(root, "W1-T100-1786000000000", ["line one", "line two", "the verdict was X"]);
    const result = readWorkerTail(root, "W1-T100-1786000000000", {});
    assert.equal(result.found, true);
    assert.equal(result.live, false);
    assert.deepEqual(result.lines, ["line one", "line two", "the verdict was X"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readWorkerTail: LIVE/FINISHED comes from the SAME liveInflightRuns pid-checked read — a dead pid's lock is stale debris, not liveness (claim 1)", () => {
  const root = tmpRoot();
  try {
    writeTail(root, "W1-T200-1786000000000", ["still going"]);
    writeInflightLock(root, "W1-T200", { pid: 424242, run_id: "W1-T200-1786000000000" });

    const live = readWorkerTail(root, "W1-T200-1786000000000", { isPidAlive: (pid) => pid === 424242 });
    assert.equal(live.live, true);

    const deadPidStaleLock = readWorkerTail(root, "W1-T200-1786000000000", { isPidAlive: () => false });
    assert.equal(deadPidStaleLock.live, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readWorkerTail: response is line- and byte-capped regardless of the requested --lines (claim 5)", () => {
  const root = tmpRoot();
  try {
    const many = Array.from({ length: WORKER_TAIL_MAX_LINES + 100 }, (_, i) => `line-${i}`);
    writeTail(root, "W1-T300-1786000000000", many);
    const result = readWorkerTail(root, "W1-T300-1786000000000", { maxLines: 10_000 });
    assert.ok(result.lines.length <= WORKER_TAIL_MAX_LINES, "never more than the ring ceiling, however much is requested");
    assert.ok(Buffer.byteLength(result.lines.join("\n"), "utf8") <= WORKER_TAIL_MAX_BYTES);
    assert.equal(result.lines[result.lines.length - 1], `line-${many.length - 1}`, "newest lines survive capping");

    // and a small explicit request is honored, capped by capWorkerTailLines (the SAME capper
    // W1-T942's writer uses — never a second capping rule).
    const small = readWorkerTail(root, "W1-T300-1786000000000", { maxLines: 3 });
    assert.deepEqual(small.lines, capWorkerTailLines(many, 3, WORKER_TAIL_MAX_BYTES));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readWorkerTail: a tail file that exists but is empty is FOUND, not reported as an unknown/absent tail — honest emptiness distinguishes the two", () => {
  const root = tmpRoot();
  try {
    writeTail(root, "W1-T400-1786000000000", []);
    const result = readWorkerTail(root, "W1-T400-1786000000000", {});
    assert.equal(result.found, true);
    assert.deepEqual(result.lines, []);
    assert.equal(result.reason, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── `rmd peek` CLI ───────────────────────────────────────────────────────────────────────────

test("rmd peek <runId>: prints the last N lines and exits 0, stating LIVE/FINISHED off liveInflightRuns (claim 1)", async () => {
  const root = tmpRoot();
  try {
    writeTail(root, "W1-T500-1786000000000", ["alpha", "beta", "gamma"]);
    writeInflightLock(root, "W1-T500", { pid: 777, run_id: "W1-T500-1786000000000" });

    let code = -1;
    const realLog = console.log;
    const logs: string[] = [];
    console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
    try {
      code = await peekCommand(["W1-T500-1786000000000"], { root, isPidAlive: (pid) => pid === 777 });
    } finally {
      console.log = realLog;
    }
    assert.equal(code, 0);
    const out = logs.join("\n");
    assert.match(out, /LIVE/);
    assert.match(out, /alpha/);
    assert.match(out, /beta/);
    assert.match(out, /gamma/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rmd peek <runId>: works identically on a FINISHED run's retained tail (claim 2) — the surviving half of fb-1784821673624-321a4b", async () => {
  const root = tmpRoot();
  try {
    writeTail(root, "W1-T600-1786000000000", ["the merge failed because X", "verdict: blocked"]);
    // no in-flight lock at all — the run is over and its lock has long since been released.
    const realLog = console.log;
    const logs: string[] = [];
    console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
    let code = -1;
    try {
      code = await peekCommand(["W1-T600-1786000000000"], { root });
    } finally {
      console.log = realLog;
    }
    assert.equal(code, 0);
    const out = logs.join("\n");
    assert.match(out, /FINISHED/);
    assert.match(out, /verdict: blocked/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rmd peek <runId>: an unknown run id prints a NAMED reason and still exits 0 — never silent empty output (claim 3)", async () => {
  const root = tmpRoot();
  try {
    const realLog = console.log;
    const logs: string[] = [];
    console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
    let code = -1;
    try {
      code = await peekCommand(["W1-T-nonexistent-9999"], { root });
    } finally {
      console.log = realLog;
    }
    assert.equal(code, 0);
    assert.match(logs.join("\n"), /no tail recorded for W1-T-nonexistent-9999/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rmd peek: missing <runId> refuses with a usage error and exit 2, spawning/printing no tail", async () => {
  const realErr = console.error;
  const errs: string[] = [];
  console.error = (...a: unknown[]) => void errs.push(a.map(String).join(" "));
  let code = -1;
  try {
    code = await peekCommand([], { root: tmpRoot() });
  } finally {
    console.error = realErr;
  }
  assert.equal(code, 2);
  assert.match(errs.join("\n"), /<runId> is required/);
});

// ── read-only by construction (claim 4) ─────────────────────────────────────────────────────

test("rmd peek: no flag beyond --lines/--follow is accepted — an attempted steering flag (e.g. --kill, --input, --signal) is refused, spawning/signaling nothing", async () => {
  for (const bogus of ["--kill", "--input", "--signal", "--resume", "--stdin"]) {
    const realErr = console.error;
    console.error = () => {};
    let code = -1;
    try {
      code = await peekCommand(["W1-T1-1786000000000", bogus], { root: tmpRoot() });
    } finally {
      console.error = realErr;
    }
    assert.equal(code, 2, `expected ${bogus} to be refused`);
  }
});

test("rmd peek: --lines must be a positive integer, refused otherwise (exit 2) — bounds how MUCH is read, never a write/steer channel", async () => {
  const root = tmpRoot();
  try {
    writeTail(root, "W1-T1-1786000000000", ["x"]);
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      const realErr = console.error;
      console.error = () => {};
      let code = -1;
      try {
        code = await peekCommand(["W1-T1-1786000000000", "--lines", bad], { root });
      } finally {
        console.error = realErr;
      }
      assert.equal(code, 2, `expected --lines ${bad} to be refused`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rmd peek --follow: polls until the run stops being live, then stops on its own — never hangs on an already-finished run", async () => {
  const root = tmpRoot();
  try {
    writeTail(root, "W1-T700-1786000000000", ["still working"]);
    writeInflightLock(root, "W1-T700", { pid: 111, run_id: "W1-T700-1786000000000" });

    let ticks = 0;
    const realLog = console.log;
    console.log = () => {};
    let code = -1;
    try {
      code = await peekCommand(["W1-T700-1786000000000", "--follow"], {
        root,
        isPidAlive: () => true,
        maxFollowIterations: 20,
        pollMs: 0,
        sleep: async () => {
          ticks++;
          // the run "finishes" mid-follow: its in-flight lock is released.
          if (ticks === 2) rmSync(join(root, "state", "inflight", "W1-T700.lock"));
        },
      });
    } finally {
      console.log = realLog;
    }
    assert.equal(code, 0);
    assert.ok(ticks <= 4, `expected the follow loop to stop shortly after liveness flips, got ${ticks} ticks`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rmd peek --follow: an already-FINISHED run never enters the poll loop at all (sleep is never called)", async () => {
  const root = tmpRoot();
  try {
    writeTail(root, "W1-T800-1786000000000", ["done"]);
    let slept = false;
    const realLog = console.log;
    console.log = () => {};
    let code = -1;
    try {
      code = await peekCommand(["W1-T800-1786000000000", "--follow"], {
        root,
        sleep: async () => void (slept = true),
      });
    } finally {
      console.log = realLog;
    }
    assert.equal(code, 0);
    assert.equal(slept, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── GET /v1/peek — the console's read-only route (claims 4, 5, and "inherits existing auth") ──

const READ_TOKEN = "peek-read-token";
const WRITE_TOKEN = "peek-write-token";

async function withPeekServer<T>(
  deps: { root: string; isLive?: (runId: string) => boolean },
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const server = createService({
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    routes: [buildPeekRoute({ root: deps.root, isLive: deps.isLive ?? (() => false) })],
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function get(base: string, path: string, token?: string) {
  return fetch(`${base}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
}

test("buildPeekRoute declares itself GET-only, read-scoped — no write tier, no steering method", () => {
  const route = buildPeekRoute({ root: tmpRoot(), isLive: () => false });
  assert.equal(route.method, "GET");
  assert.equal(route.path, "/v1/peek");
  assert.equal(route.scope, "read");
  assert.equal(route.tier, undefined, "a read-scoped route carries no write tier");
  assert.equal(route.allowQueryToken, undefined, "an API/data route stays header-only, never ?token=");
});

test("GET /v1/peek inherits the console's EXISTING auth — no token 401s, the read token 200s (no new auth path)", async () => {
  const root = tmpRoot();
  try {
    writeTail(root, "W1-T900-1786000000000", ["hello"]);
    await withPeekServer({ root }, async (base) => {
      assert.equal((await get(base, "/v1/peek?runId=W1-T900-1786000000000")).status, 401);
      assert.equal((await get(base, "/v1/peek?runId=W1-T900-1786000000000", "wrong-token")).status, 401);
      assert.equal((await get(base, "/v1/peek?runId=W1-T900-1786000000000", READ_TOKEN)).status, 200);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GET /v1/peek: a missing/invalid-shape runId 400s BEFORE any path is built — never reads outside state/runs/ (claim 5)", async () => {
  const root = tmpRoot();
  try {
    await withPeekServer({ root }, async (base) => {
      assert.equal((await get(base, "/v1/peek", READ_TOKEN)).status, 400);
      const traversal = await get(base, `/v1/peek?runId=${encodeURIComponent("../secret")}`, READ_TOKEN);
      assert.equal(traversal.status, 400);
      const dotdot = await get(base, `/v1/peek?runId=${encodeURIComponent("..")}`, READ_TOKEN);
      assert.equal(dotdot.status, 400);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GET /v1/peek: an unknown run id 200s with a NAMED reason, never silent empty output (claim 3)", async () => {
  const root = tmpRoot();
  try {
    await withPeekServer({ root }, async (base) => {
      const res = await get(base, "/v1/peek?runId=W1-T999-1786000000000", READ_TOKEN);
      assert.equal(res.status, 200);
      const body = (await res.json()) as PeekTailResult;
      assert.equal(body.found, false);
      assert.equal(body.reason, "no tail recorded for W1-T999-1786000000000");
      assert.deepEqual(body.lines, []);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GET /v1/peek: returns the retained tail for a run, LIVE/FINISHED from the INJECTED isLive predicate (claim 1/2)", async () => {
  const root = tmpRoot();
  try {
    writeTail(root, "W1-T910-1786000000000", ["one", "two", "three"]);
    await withPeekServer({ root, isLive: (runId) => runId === "W1-T910-1786000000000" }, async (base) => {
      const res = await get(base, "/v1/peek?runId=W1-T910-1786000000000", READ_TOKEN);
      const body = (await res.json()) as PeekTailResult;
      assert.equal(body.found, true);
      assert.equal(body.live, true);
      assert.deepEqual(body.lines, ["one", "two", "three"]);
    });

    // a DIFFERENT run id under the same server: isLive returns false -> FINISHED.
    writeTail(root, "W1-T911-1786000000000", ["done"]);
    await withPeekServer({ root, isLive: (runId) => runId === "W1-T910-1786000000000" }, async (base) => {
      const res = await get(base, "/v1/peek?runId=W1-T911-1786000000000", READ_TOKEN);
      const body = (await res.json()) as PeekTailResult;
      assert.equal(body.live, false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GET /v1/peek: the response is line- AND byte-capped, and ?lines= cannot request more than the ring ceiling (claim 5)", async () => {
  const root = tmpRoot();
  try {
    const many = Array.from({ length: WORKER_TAIL_MAX_LINES + 250 }, (_, i) => `row-${i}`);
    writeTail(root, "W1-T920-1786000000000", many);
    await withPeekServer({ root }, async (base) => {
      const res = await get(base, "/v1/peek?runId=W1-T920-1786000000000&lines=999999", READ_TOKEN);
      const body = (await res.json()) as PeekTailResult;
      assert.ok(body.lines.length <= WORKER_TAIL_MAX_LINES);
      assert.ok(Buffer.byteLength(body.lines.join("\n"), "utf8") <= WORKER_TAIL_MAX_BYTES);
      assert.equal(body.lines[body.lines.length - 1], `row-${many.length - 1}`);

      const small = await get(base, "/v1/peek?runId=W1-T920-1786000000000&lines=2", READ_TOKEN);
      const smallBody = (await small.json()) as PeekTailResult;
      assert.deepEqual(smallBody.lines, [`row-${many.length - 2}`, `row-${many.length - 1}`]);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
