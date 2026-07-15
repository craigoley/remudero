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

// ── PAYLOAD: criterion 2 is "sends VIA OSASCRIPT". The fake channel bypasses osascript
// entirely, so the osascript/AppleScript CONSTRUCTION must be proven directly here. ──
test("buildSendScript targets Messages.app over iMessage with the recipient + message embedded (the exact osascript payload)", () => {
  const script = buildSendScript("+15555550123", "hello there");
  assert.equal(
    script,
    'tell application "Messages" to send "hello there" to buddy "+15555550123" of (service 1 whose service type is iMessage)',
  );
});

// ── SECURITY: the message is attacker-influenceable content (ledger text) fed through
// osascript. escapeAppleScriptString MUST neutralise every character that could break
// out of the "…" AppleScript string literal — quotes, backslashes, AND newlines. ──
test("escapeAppleScriptString escapes NEWLINES and carriage returns (AppleScript-injection guard)", () => {
  assert.equal(escapeAppleScriptString("line1\nline2"), "line1\\nline2");
  assert.equal(escapeAppleScriptString("a\r\nb"), "a\\r\\nb");
  // a quote followed by a newline — both neutralised, so neither ends the literal:
  assert.equal(escapeAppleScriptString('"\n'), '\\"\\n');
});

test("buildSendScript: an injected message with a quote + newline cannot break out of the AppleScript string literal", () => {
  // An attacker-shaped ledger line: close the string, add a newline, inject a shell-out.
  const evil = '"\ndo shell script "rm -rf ~"';
  const script = buildSendScript("+15555550123", evil);
  // NO raw newline may survive — a raw \n in the -e literal would end/inject the command.
  assert.ok(!script.includes("\n"), "no raw newline survives into the osascript command");
  // the closing quote the attacker supplied is escaped, so the send-string never ends early:
  assert.doesNotMatch(script, /send "" /, "the leading quote must not terminate the send string");
  assert.match(script, /\\"/, "the injected quote is carried as an escaped literal, not a live delimiter");
  assert.match(script, /\\n/, "the injected newline is carried as an escaped literal");
});
