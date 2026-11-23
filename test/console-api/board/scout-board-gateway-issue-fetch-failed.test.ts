import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBatchedGithub } from "#src/lib/status.js";

const issueUrl = "https://github.com/o/r/issues/101";
const fetchFailure = "board_gateway.issue_fetch_failed";

function unavailable(): Error {
  return Object.assign(new Error("gh api failed"), {
    status: 1,
    stderr: "gh: Service Unavailable (HTTP 503)",
  });
}

test("W1-T12431: board_gateway.issue_fetch_failed no longer recurs", () => {
  const pages: string[] = [];
  const events: string[] = [];
  const board = buildBatchedGithub("o", "r", {
    exec: ([command, endpoint]) => {
      assert.equal(command, "api");
      assert.match(endpoint, /^repos\/o\/r\/issues\?/);
      const page = endpoint.match(/&page=(\d+)$/)?.[1] ?? "";
      pages.push(page);
      if (page === "1") {
        return JSON.stringify(Array.from({ length: 100 }, (_, index) => ({
          number: index + 1,
          html_url: `https://github.com/o/r/issues/${index + 1}`,
          state: "open",
        })));
      }
      if (pages.length === 2) throw unavailable();
      return JSON.stringify([{ number: 101, html_url: issueUrl, state: "closed" }]);
    },
    log: (event) => events.push(event),
  });

  assert.deepEqual(board.issueByUrl?.(issueUrl), { state: "closed", title: undefined });
  assert.deepEqual(pages, ["1", "2", "2"]);
  assert.deepEqual(board.issueByUrl?.("https://github.com/o/r/issues/1"), { state: "open", title: undefined });
  assert.equal(board.issueReadFailed?.(), false);
  assert.ok(events.includes("board_gateway.issue_fetch_ok"));
  assert.ok(!events.includes(fetchFailure));
});

test("persistent issue page errors still surface after the bounded retries", (t) => {
  t.mock.method(console, "error", () => {});
  let calls = 0;
  const failures: unknown[] = [];
  const board = buildBatchedGithub("o", "r", {
    exec: () => {
      calls += 1;
      throw unavailable();
    },
    log: (event, fields) => {
      if (event === fetchFailure) failures.push(fields);
    },
  });

  assert.equal(board.issueByUrl?.(issueUrl), null);
  assert.equal(board.issueReadFailed?.(), true);
  assert.equal(calls, 3);
  assert.deepEqual(failures, [{ reason: "unknown", message: "gh api failed" }]);
});
