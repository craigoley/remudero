import assert from "node:assert/strict";
import { test } from "node:test";
import { consoleUrl, notifyRecipient, type Config } from "../src/lib/config.js";

function config(over: Partial<Config> = {}): Config {
  return { claudeBin: "/usr/bin/claude", root: "/tmp/root", ...over };
}

test("notifyRecipient defaults to the operator's Apple ID email when unset", () => {
  assert.equal(notifyRecipient(config()), "craigoley@gmail.com");
});

test("notifyRecipient honors an explicit override in config.json", () => {
  assert.equal(notifyRecipient(config({ notifyRecipient: "+15555550123" })), "+15555550123");
});

// ── W1-T144: console push deep-link base URL ──────────────────────────────────────

test("consoleUrl defaults to serve's own default port when unset", () => {
  assert.equal(consoleUrl(config()), "http://localhost:4317");
});

test("consoleUrl honors an explicit override in config.json (e.g. a tailnet address)", () => {
  assert.equal(consoleUrl(config({ consoleUrl: "http://100.64.1.2:4317" })), "http://100.64.1.2:4317");
});
