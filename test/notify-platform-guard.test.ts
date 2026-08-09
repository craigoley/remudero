import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { imessageChannel, notify, type NotifyChannel } from "../src/lib/notify.js";

/**
 * THE PLATFORM GUARD, PROVED IN BOTH DIRECTIONS — and the second direction is the point.
 *
 * A guard that simply swallowed every send would pass any test that only asserts "Linux does not
 * throw". So the darwin direction is asserted too, ON THIS SAME LINUX HOST, by forcing
 * `platform: "darwin"` and observing that the channel really does reach `osascript` — which is
 * absent here, so it fails LOUDLY with a spawn error naming that binary. A blanket swallow could
 * not produce that failure, so the pair of assertions pins the guard to the platform rather than
 * to "always quiet".
 *
 * `process.platform` is `linux` in this container and in CI (recorded here because it is exactly
 * what hid the original defect: no test ever constructed the real channel, so its one macOS
 * assumption was unreachable).
 */

function ledgerDir(): string {
  return join(mkdtempSync(join(tmpdir(), "notify-guard-")), "ledger.ndjson");
}

function rows(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("imessageChannel on a NON-darwin platform reports itself unavailable and never execs", () => {
  const ch = imessageChannel("+15550000000", "linux");
  const reason = ch.unavailable?.();
  assert.equal(typeof reason, "string");
  assert.match(String(reason), /macOS-only/);
  assert.match(String(reason), /linux/);
});

test("imessageChannel on DARWIN reports itself AVAILABLE — the guard is platform-keyed, not a blanket quiet", () => {
  const ch = imessageChannel("+15550000000", "darwin");
  assert.equal(ch.unavailable?.(), undefined);
});

test("the DARWIN path still really reaches osascript: forced darwin on this host fails naming that binary", () => {
  // THE ANTI-SWALLOW ASSERTION. If the guard had been written as "never exec", this would pass
  // silently. It must instead attempt the real spawn and fail on the missing macOS binary.
  const ch = imessageChannel("+15550000000", "darwin");
  assert.throws(
    () => ch.send("hello"),
    (e: unknown) => /osascript/.test(String((e as Error)?.message ?? e)),
    "forcing darwin must reach the real osascript spawn, not the guard branch",
  );
});

test("notify on an unavailable channel does NOT throw, does NOT send, and ledgers delivered:false with the reason", () => {
  const path = ledgerDir();
  let sends = 0;
  const channel: NotifyChannel = {
    send() {
      sends++;
    },
    unavailable() {
      return "no real-time channel on linux — osascript/Messages.app is macOS-only";
    },
  };
  notify("a message", { channel, ledgerPath: path, runId: "R1", taskId: "W1-T1" });
  assert.equal(sends, 0, "an unavailable channel must not be sent to");
  const [row] = rows(path);
  assert.equal(row.step, "notify.sent");
  assert.equal(row.delivered, false);
  assert.match(String(row.reason), /macOS-only/);
});

test("notify on an AVAILABLE channel sends and writes a row with NO delivered field — healthy rows unchanged", () => {
  const path = ledgerDir();
  const sent: string[] = [];
  const channel: NotifyChannel = {
    send(m) {
      sent.push(m);
    },
    unavailable() {
      return undefined;
    },
  };
  notify("a message", { channel, ledgerPath: path, runId: "R1", taskId: "W1-T1" });
  assert.deepEqual(sent, ["a message"]);
  const [row] = rows(path);
  assert.equal(row.step, "notify.sent");
  assert.ok(!("delivered" in row), "a delivered send must not carry a delivered field");
  assert.ok(!("reason" in row), "a delivered send must not carry a reason field");
});

test("a channel that does not implement unavailable() is sent to exactly as before — every existing fake is unaffected", () => {
  const path = ledgerDir();
  const sent: string[] = [];
  // No `unavailable` at all: the shape every pre-existing injected fake in this repo has.
  const channel: NotifyChannel = { send: (m) => void sent.push(m) };
  notify("a message", { channel, ledgerPath: path, runId: "R1", taskId: "W1-T1" });
  assert.deepEqual(sent, ["a message"]);
  const [row] = rows(path);
  assert.ok(!("delivered" in row));
});
