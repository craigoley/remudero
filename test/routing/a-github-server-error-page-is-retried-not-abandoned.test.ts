/**
 * W1-T14944: on the 2026-11-26 04:17Z Field Trials pass, `gh: Server Error (HTTP 502)` on PR-history pages ended each
 * read as github-read-failed on the first throw, so the snapshot went partial. A 5xx now waits with doubling backoff and
 * retries the same page; any other failure still returns github-read-failed at once. The status is read from the
 * `gh api -i` response's own status line on stdout (`HTTP/2.0 502 Bad Gateway`), never from stderr's message text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ghApiFetch, isGhServerError } from "#src/lib/field-trials-github.js";

const PAGE = JSON.stringify([{ number: 1 }]);

/** What `gh api -i` prints on stdout: the response's status line and headers, a blank line, then the body. */
function included(status: string, body: string): string {
  return `HTTP/2.0 ${status}\r\nContent-Type: application/json\r\nX-Ratelimit-Remaining: 4000\r\n\r\n${body}`;
}

/** A failed `gh api -i` read as execFile rejects it: exit 1, the response on stdout, gh's message on stderr. */
function ghFailed(status: string, stderr: string, path = "repos/o/r/pulls"): Error {
  return Object.assign(new Error(`Command failed: gh api -i ${path}\n${stderr}`),
    { status: 1, stdout: included(status, '{"message":"x"}'), stderr });
}

function gh502(): Error {
  return ghFailed("502 Bad Gateway", "gh: Server Error (HTTP 502)\n");
}

test("W1-T14944 criterion 1: a page read that fails with HTTP 502 twice and then succeeds returns the page", async () => {
  const paths: string[][] = [];
  const sleeps: number[] = [];
  let calls = 0;
  const fetch = ghApiFetch(async (args) => {
    paths.push(args);
    calls += 1;
    if (calls <= 2) throw gh502();
    return included("200 OK", PAGE);
  }, { sleep: async (ms) => { sleeps.push(ms); } });
  const page = await fetch("repos/o/r/pulls?state=all");
  assert.deepEqual(page, { ok: true, items: [{ number: 1 }] });
  assert.equal(calls, 3, "two failed reads, then the read that returned the page");
  assert.deepEqual(paths, Array(3).fill(["api", "repos/o/r/pulls?state=all", "-i"]), "every retry reads the same page");
  assert.deepEqual(sleeps, [1_000, 2_000], "the wait doubles from one second");
  // Every 5xx GitHub names as transient retries, and the wait stops doubling at a minute.
  for (const status of [500, 503, 504]) {
    let n = 0;
    const waits: number[] = [];
    const result = await ghApiFetch(async () => {
      n += 1;
      if (n <= 8) throw ghFailed(`${status} Server Error`, `gh: Server Error (HTTP ${status})\n`, "repos/o/r/commits");
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
  for (const [label, error] of [
    ["a 404 status line", ghFailed("404 Not Found", "gh: Not Found (HTTP 404)\n")],
    ["a 401 status line", ghFailed("401 Unauthorized", "gh: Bad credentials (HTTP 401)\n")],
    ["stderr text naming 502 over a 404 status line", ghFailed("404 Not Found", "gh: Server Error (HTTP 502)\n")],
    ["stderr text naming 502 with no response at all", Object.assign(new Error("Command failed: gh api -i repos/o/r/pulls"),
      { status: 1, stdout: "", stderr: "gh: Server Error (HTTP 502)\n" })],
  ] as const) {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await ghApiFetch(async () => { calls += 1; if (calls > 3) return "[]"; throw error; },
      { sleep: async (ms) => { sleeps.push(ms); } })("repos/o/r/pulls");
    assert.deepEqual(result, { ok: false, reason: "github-read-failed" }, label);
    assert.equal(calls, 1, `${label} is read once`);
    assert.deepEqual(sleeps, [], `${label} waits for nothing`);
  }
});

test("W1-T14944 criterion 2: a non-5xx read failure is not retried, even when the endpoint text names HTTP 502", async () => {
  // `rmd field-trials --source trial=o/HTTP 502` puts that text in the command, which the error message repeats.
  const sleeps: number[] = [];
  let calls = 0;
  const result = await ghApiFetch(async () => {
    calls += 1;
    if (calls > 3) return "[]"; // a retrying build stops here instead of looping forever
    throw ghFailed("404 Not Found", "gh: Not Found (HTTP 404)\n", "repos/o/HTTP 502/pulls");
  }, { sleep: async (ms) => { sleeps.push(ms); } })("repos/o/HTTP 502/pulls");
  assert.deepEqual(result, { ok: false, reason: "github-read-failed" });
  assert.equal(calls, 1, "the 404 is read once");
  assert.deepEqual(sleeps, [], "and waits for nothing");
});

test("W1-T14944 criterion 2: a non-5xx read failure is not retried, when gh's URL parse error echoes HTTP 502", async () => {
  // `rmd field-trials --source 'trial=o/HTTP 502%zz'`: gh 2.89.0 refuses the malformed URL and echoes it on stderr.
  const sleeps: number[] = [];
  let calls = 0;
  const result = await ghApiFetch(async () => {
    calls += 1;
    if (calls > 3) return "[]"; // a retrying build stops here instead of looping forever
    // No request went out, so stdout holds no status line.
    throw Object.assign(new Error("Command failed: gh api -i repos/o/HTTP 502%zz/pulls"),
      { status: 1, stdout: "", stderr: 'parse "https://api.github.com/repos/o/HTTP 502%zz/pulls": invalid URL escape "%zz"\n' });
  }, { sleep: async (ms) => { sleeps.push(ms); } })("repos/o/HTTP 502%zz/pulls");
  assert.deepEqual(result, { ok: false, reason: "github-read-failed" });
  assert.equal(calls, 1, "the parse error is read once");
  assert.deepEqual(sleeps, [], "and waits for nothing");
});

test("W1-T14944 criterion 2: a non-5xx read failure is not retried, unless the response's own status line is the 5xx status", () => {
  const out = (stdout: string, stderr = "") => ({ stdout, stderr });
  for (const code of [500, 502, 503, 504]) {
    assert.equal(isGhServerError(out(included(`${code} Server Error`, "{}"))), true, `HTTP ${code}`);
  }
  assert.equal(isGhServerError(out("HTTP/1.1 502 Bad Gateway\r\n\r\n<html>")), true, "an HTTP/1.1 proxy's 502 with an HTML body");
  assert.equal(isGhServerError(out(Buffer.from(included("503 Service Unavailable", "")).toString())), true);
  assert.equal(isGhServerError({ stdout: Buffer.from(included("502 Bad Gateway", "")) }), true, "a Buffer stdout");
  assert.equal(isGhServerError(out(included("404 Not Found", "{}"), "gh: Server Error (HTTP 502)\n")), false, "stderr text is never read");
  assert.equal(isGhServerError(out("", "gh: HTTP 502\n")), false, "no response, no status");
  assert.equal(isGhServerError(out(included("501 Not Implemented", "{}"))), false, "501 is not transient");
  assert.equal(isGhServerError(out(included("429 Too Many Requests", "{}"))), false);
  assert.equal(isGhServerError(out("HTTP/2.0 5020 x\r\n\r\n")), false);
  assert.equal(isGhServerError(out('{"message":"HTTP/2.0 502 Bad Gateway"}')), false, "a body naming 502 is not a status line");
  assert.equal(isGhServerError(out(`HTTP/2.0 200 OK\r\n\r\nHTTP/2.0 502 Bad Gateway`)), false, "only the first line counts");
  assert.equal(isGhServerError(new Error("HTTP/2.0 502 Bad Gateway")), false, "the message alone is caller text");
  assert.equal(isGhServerError(undefined), false);
});

test("W1-T14944 criterion 1: a page read that fails with HTTP 502 twice and then succeeds returns the page, in gh 2.63.2's bare form", async () => {
  // deploy/Dockerfile pins gh 2.63.2, which prints `gh: HTTP 502` when GitHub's 502 body is not JSON.
  for (const stderr of ["gh: HTTP 502\n", "gh: HTTP 500\n", "gh: HTTP 503\n", "gh: HTTP 504\n"]) {
    const status = `${stderr.slice(9, 12)} Server Error`;
    const sleeps: number[] = [];
    let calls = 0;
    const page = await ghApiFetch(async () => {
      calls += 1;
      if (calls > 4) return "[]"; // a non-retrying build stops on its first throw; this guards a looping one
      if (calls <= 2) throw ghFailed(status, stderr);
      return included("200 OK", PAGE);
    }, { sleep: async (ms) => { sleeps.push(ms); } })("repos/o/r/pulls");
    assert.deepEqual(page, { ok: true, items: [{ number: 1 }] }, stderr);
    assert.equal(calls, 3, `${stderr.trim()} is retried twice, then the page reads`);
    assert.deepEqual(sleeps, [1_000, 2_000]);
  }
});
