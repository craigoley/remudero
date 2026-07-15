import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSendScript, escapeAppleScriptString, notify, type NotifyChannel } from "../src/lib/notify.js";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-notify-")), "ledger.ndjson");
}

function fakeChannel(): NotifyChannel & { sent: string[] } {
  const sent: string[] = [];
  return { sent, send: (m) => sent.push(m) };
}

test("notify sends over the channel and logs a notify.sent ledger line", () => {
  const channel = fakeChannel();
  const path = ledgerPath();
  notify("[MANUAL] W1-T10: fine-grained PAT prerequisite", {
    channel,
    ledgerPath: path,
    runId: "RUN-1",
    taskId: "W1-T10",
  });

  assert.deepEqual(channel.sent, ["[MANUAL] W1-T10: fine-grained PAT prerequisite"]);
  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "notify.sent");
  assert.equal(lines[0].channel, "imessage");
  assert.equal(lines[0].task_id, "W1-T10");
});

test("notify never sends silently — the ledger line is written even for a one-line message", () => {
  const channel = fakeChannel();
  const path = ledgerPath();
  notify("hi", { channel, ledgerPath: path, runId: "RUN-1", taskId: "T" });
  assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 1);
});

test("escapeAppleScriptString escapes backslashes before quotes (order matters)", () => {
  assert.equal(escapeAppleScriptString('say "hi"'), 'say \\"hi\\"');
  assert.equal(escapeAppleScriptString("back\\slash"), "back\\\\slash");
  // A message containing both must not let quote-escaping re-mangle backslashes.
  assert.equal(escapeAppleScriptString('a\\"b'), 'a\\\\\\"b');
});

test("buildSendScript embeds the escaped recipient and message into an osascript one-liner", () => {
  const script = buildSendScript('+1 555 "boss"', 'blocked: needs "you"');
  assert.match(script, /tell application "Messages" to send/);
  assert.match(script, /to buddy "\+1 555 \\"boss\\"" of \(service 1 whose service type is iMessage\)/);
  assert.match(script, /send "blocked: needs \\"you\\""/);
});
