import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { ghStdoutOfHttpRead, configureGithubHttpRead, githubHttpRead, parseGhApiRead } from "#src/lib/github-http-read.js";
import { fetchBoardPrsRestAsync } from "#src/lib/open-prs-rest.js";
import { buildBatchedGithub } from "#src/lib/status.js";

/**
 * W1-T9944: a transient 5xx on a paginated board read used to discard the whole snapshot. The bounded
 * retry in the shared GitHub HTTP reader lets that page recover; persistent failures still fail closed
 * and retain the gateway's classified failure marker.
 */
test("W1-T9944: board_gateway.fetch_failed no longer recurs", async () => {
  const paths: string[] = [];
  let attempts = 0;
  const server = createServer((req, res) => {
    attempts += 1;
    paths.push(req.url ?? "");
    if (attempts === 1) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "transient GitHub outage" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("[]");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  configureGithubHttpRead({ origin: `http://127.0.0.1:${address.port}` });
  try {
    const fetched = await fetchBoardPrsRestAsync("o", "r", async (args) => {
      const read = parseGhApiRead(args);
      assert.ok(read, "board page uses the supported GitHub API read form");
      const response = await githubHttpRead(read, "fixture-token");
      return JSON.parse(ghStdoutOfHttpRead(read, response));
    }, undefined, "open");
    assert.deepEqual(fetched.rows, [], "the transient response recovers before the board treats the page as failed");
    assert.equal(fetched.calls, 1);
    assert.equal(attempts, 2, "the page is retried once after a transient 503");
    assert.equal(paths[0], paths[1], "both attempts read the same board page");
  } finally {
    configureGithubHttpRead(undefined);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // A persistent failure still remains visible and fail-closed at the gateway boundary.
  const logged: Array<{ event: string; extra?: Record<string, unknown> }> = [];
  const quiet = console.error;
  console.error = () => {};
  try {
    const board = buildBatchedGithub("o", "r", {
      fetchAll: () => {
        throw Object.assign(new Error("boom"), { status: 1, stderr: "API rate limit exceeded" });
      },
      log: (event, extra) => logged.push({ event, extra }),
    });
    board.findMergedByTrailer("W1-T1");
    const rows = logged.filter((l) => l.event === "board_gateway.fetch_failed");
    assert.ok(rows.length >= 1, "a failed read is logged, never silent");
    assert.equal(rows[0]?.extra?.reason, "rate_limit", "the row carries a classified reason, not unknown");
    assert.equal(board.readFailed?.(), true, "the empty result is paired with a failure marker");
  } finally {
    console.error = quiet;
  }
});
