import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_GH_CALL_TIMEOUT_MS,
  ghJson,
  ghJsonAsync,
  ghOptionsWithDefaultTimeout,
  parseGhRateLimitHeaders,
} from "../src/lib/github-transport.js";
import { classifyGhFailure } from "../src/lib/status.js";

test("ghOptionsWithDefaultTimeout preserves caller options and adds the transport timeout", () => {
  const opts = ghOptionsWithDefaultTimeout({ encoding: "utf8" as const, maxBuffer: 12 });
  assert.equal(opts.timeout, DEFAULT_GH_CALL_TIMEOUT_MS);
  assert.equal(opts.encoding, "utf8");
  assert.equal(opts.maxBuffer, 12);
});

test("ghOptionsWithDefaultTimeout preserves an explicit tighter caller timeout", () => {
  assert.equal(ghOptionsWithDefaultTimeout({ timeout: 123 }).timeout, 123);
});

test("ghJson adds the default timeout to the single sync transport spawn", () => {
  const calls: Array<{ file: string; args: string[]; timeout: number }> = [];
  const body = ghJson(["api", "repos/o/r"], undefined, (file, args, opts) => {
    calls.push({ file, args, timeout: opts.timeout });
    return "HTTP/2 200\r\nX-Ratelimit-Remaining: 4\r\n\r\n{\"ok\":true}";
  });

  assert.deepEqual(body, { ok: true });
  assert.deepEqual(calls, [{ file: "gh", args: ["api", "repos/o/r", "-i"], timeout: DEFAULT_GH_CALL_TIMEOUT_MS }]);
});

test("ghJsonAsync adds the default timeout to the single async transport spawn", async () => {
  const calls: Array<{ file: string; args: readonly string[]; timeout: number }> = [];
  const body = await ghJsonAsync(["api", "repos/o/r"], async (file, args, opts) => {
    calls.push({ file, args, timeout: opts.timeout });
    return { stdout: "{\"ok\":true}", stderr: "" };
  });

  assert.deepEqual(body, { ok: true });
  assert.deepEqual(calls, [{ file: "gh", args: ["api", "repos/o/r"], timeout: DEFAULT_GH_CALL_TIMEOUT_MS }]);
});

test("a timed-out transport call keeps the named ETIMEDOUT failure shape", () => {
  assert.equal(classifyGhFailure(null, "", "ETIMEDOUT"), "transport");
});

test("parseGhRateLimitHeaders still reads the response headers used by ghJson", () => {
  assert.deepEqual(parseGhRateLimitHeaders("X-Ratelimit-Remaining: 0\r\nX-Ratelimit-Resource: core\r\n"), {
    remaining: 0,
    used: undefined,
    limit: undefined,
    reset: undefined,
    resource: "core",
  });
});
