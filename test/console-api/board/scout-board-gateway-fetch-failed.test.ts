import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildBatchedGithub } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

/** W1-T9944: the board's synchronous gh API page read retries a transient GitHub server failure. */
test("W1-T9944: board_gateway.fetch_failed no longer recurs", () => {
  const calls: string[][] = [];
  const logged: Array<{ event: string; extra?: Record<string, unknown> }> = [];
  const quiet = console.error;
  console.error = () => {};
  try {
    const board = buildBatchedGithub("o", "r", {
      ttlMs: 0,
      exec: (args) => {
        calls.push([...args]);
        if (calls.length === 1) {
          throw Object.assign(new Error("Command failed: gh api -i (HTTP 503)"), {
            status: 1,
            stderr: "gh: Service Unavailable (HTTP 503)\n",
          });
        }
        return "[]";
      },
      log: (event, extra) => logged.push({ event, extra }),
    });

    assert.deepEqual(board.listOpenHeadBranches(), [], "the board returns the successful retry's empty open set");
    assert.equal(calls.length, 2, "the failed API page is retried once");
    assert.deepEqual(calls[0], calls[1], "both calls read the same idempotent API page");
    assert.equal(logged.some((row) => row.event === "board_gateway.fetch_failed"), false,
      "a recovered transient page never becomes a failed board refresh");
    assert.equal(board.readFailed?.(), false);
  } finally {
    console.error = quiet;
  }

  // Persistent 5xx responses still reach the gateway failure boundary and remain visible.
  const persistentLog: Array<{ event: string; extra?: Record<string, unknown> }> = [];
  console.error = () => {};
  try {
    const board = buildBatchedGithub("o", "r", {
      ttlMs: 0,
      exec: () => {
        throw Object.assign(new Error("Command failed: gh api -i (HTTP 503)"), {
          status: 1,
          stderr: "gh: Service Unavailable (HTTP 503)\n",
        });
      },
      log: (event, extra) => persistentLog.push({ event, extra }),
    });
    assert.equal(board.listOpenHeadBranches(), null, "a sustained outage stays unreadable");
    assert.equal(persistentLog.filter((row) => row.event === "board_gateway.fetch_failed").length, 1);
    assert.equal(board.readFailed?.(), true);
  } finally {
    console.error = quiet;
  }
});

test("W1-T9944: prewarm worker retries its synchronous gh API page", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t9944-`));
  const callFile = join(dir, "calls");
  const ghBin = join(dir, "gh");
  writeFileSync(ghBin, `#!/usr/bin/env node
    const fs = require("node:fs");
    const path = ${JSON.stringify(callFile)};
    const calls = Number(fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "0") + 1;
    fs.writeFileSync(path, String(calls));
    if (calls === 1) { console.error("gh: Service Unavailable (HTTP 503)"); process.exit(1); }
    process.stdout.write("HTTP/1.1 200 OK\\r\\n\\r\\n[]");
  `, { mode: 0o755 });
  const logged: Array<{ event: string; extra?: Record<string, unknown> }> = [];
  const quiet = console.error;
  console.error = () => {};
  const board = buildBatchedGithub("o", "r", {
    ghBin,
    ttlMs: 1,
    log: (event, extra) => logged.push({ event, extra }),
  });
  try {
    board.warm?.();
    for (let i = 0; i < 2_000 && board.readState?.() === "in_flight"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.notEqual(board.readState?.(), "in_flight", "the prewarm worker settles");
    assert.equal(Number(readFileSync(callFile, "utf8")), 4,
      "the transient page is retried, then the other board half and issue batch are fetched");
    assert.deepEqual(logged.filter((row) => row.event === "board_gateway.fetch_ok").map((row) => row.extra?.channel), ["open", "merged"]);
    assert.equal(logged.some((row) => row.event === "board_gateway.fetch_failed"), false);
    assert.equal(board.readFailed?.(), false);
  } finally {
    console.error = quiet;
    rmSync(dir, { recursive: true, force: true });
  }
});
