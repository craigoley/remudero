/**
 * W1-T14944: on the 2026-11-26 04:17Z Field Trials pass, `gh: Server Error (HTTP 502)` on PR-history pages ended each
 * read as github-read-failed on the first throw, so the snapshot went partial. A 5xx now waits with doubling backoff and
 * retries the same page; any other failure still returns github-read-failed at once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ghApiFetch } from "#src/lib/field-trials-github.js";

const PAGE = JSON.stringify([{ number: 1 }]);

function gh502(): Error {
  return Object.assign(new Error("Command failed: gh api repos/o/r/pulls"), { stderr: "gh: Server Error (HTTP 502)\n" });
}

test("W1-T14944 criterion 1: a page read that fails with HTTP 502 twice and then succeeds returns the page", async () => {
  const paths: string[][] = [];
  const sleeps: number[] = [];
  let calls = 0;
  const fetch = ghApiFetch(async (args) => {
    paths.push(args);
    calls += 1;
    if (calls <= 2) throw gh502();
    return PAGE;
  }, { sleep: async (ms) => { sleeps.push(ms); } });
  const page = await fetch("repos/o/r/pulls?state=all");
  assert.deepEqual(page, { ok: true, items: [{ number: 1 }] });
  assert.equal(calls, 3, "two failed reads, then the read that returned the page");
  assert.deepEqual(paths, Array(3).fill(["api", "repos/o/r/pulls?state=all"]), "every retry reads the same page");
  assert.deepEqual(sleeps, [1_000, 2_000], "the wait doubles from one second");
  // Every 5xx GitHub names as transient retries, and the wait stops doubling at a minute.
  for (const status of [500, 503, 504]) {
    let n = 0;
    const waits: number[] = [];
    const result = await ghApiFetch(async () => {
      n += 1;
      if (n <= 8) throw new Error(`gh: Server Error (HTTP ${status})`);
      return PAGE;
    }, { sleep: async (ms) => { waits.push(ms); } })("repos/o/r/commits");
    assert.equal(result.ok, true, `HTTP ${status} is retried until the page reads`);
    assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  }
});

test("W1-T14944 criterion 2: a non-5xx read failure is not retried", async () => {
  for (const message of ["HTTP 404: Not Found", "gh: Bad credentials (HTTP 401)", "HTTP 422: Unprocessable", "spawn gh ENOENT"]) {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await ghApiFetch(async () => { calls += 1; throw new Error(message); },
      { sleep: async (ms) => { sleeps.push(ms); } })("repos/o/r/pulls");
    assert.deepEqual(result, { ok: false, reason: "github-read-failed" }, message);
    assert.equal(calls, 1, `${message} is read once`);
    assert.deepEqual(sleeps, [], `${message} waits for nothing`);
  }
});
