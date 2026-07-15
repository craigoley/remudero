import assert from "node:assert/strict";
import { test } from "node:test";
import { notifyRecipient, type Config } from "../src/lib/config.js";

function config(over: Partial<Config> = {}): Config {
  return { claudeBin: "/usr/bin/claude", root: "/tmp/root", ...over };
}

test("notifyRecipient defaults to the operator's Apple ID email when unset", () => {
  assert.equal(notifyRecipient(config()), "craigoley@gmail.com");
});

test("notifyRecipient honors an explicit override in config.json", () => {
  assert.equal(notifyRecipient(config({ notifyRecipient: "+15555550123" })), "+15555550123");
});
