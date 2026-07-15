import { execFileSync } from "node:child_process";
import { appendLedger } from "./ledger.js";

/**
 * imessage-local notifier (W1-T8). Sends via `osascript` driving Messages.app on
 * THE HOST MAC — no BlueBubbles/relay dependency, per acceptance. Real-time pings
 * are reserved for MANUAL + HARD_STOP escalations (MASTER-PLAN §4); BLOCKED and
 * everything else collapse into the daily digest (digest.ts) instead of paging.
 */
export interface NotifyChannel {
  send(message: string): void;
}

/**
 * Escape a string for embedding inside an AppleScript double-quoted literal.
 * Backslashes first (so the escaping backslash itself isn't re-escaped), then quotes.
 */
export function escapeAppleScriptString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Build the AppleScript that sends `message` to `recipient` over iMessage. */
export function buildSendScript(recipient: string, message: string): string {
  const r = escapeAppleScriptString(recipient);
  const m = escapeAppleScriptString(message);
  return `tell application "Messages" to send "${m}" to buddy "${r}" of (service 1 whose service type is iMessage)`;
}

/** Real channel: `osascript` against Messages.app. `recipient` is a phone number or Apple ID. */
export function imessageChannel(recipient: string): NotifyChannel {
  return {
    send(message) {
      execFileSync("osascript", ["-e", buildSendScript(recipient, message)], { stdio: "pipe" });
    },
  };
}

export interface NotifyDeps {
  channel: NotifyChannel;
  ledgerPath: string;
  runId: string;
  taskId: string;
  /** Ledgered alongside the send; defaults to "imessage" (the only adapter W1-T8 ships). */
  channelName?: string;
}

/** Send one message over the channel + log a ledger `notify.sent` line (a send is never silent). */
export function notify(message: string, deps: NotifyDeps): void {
  deps.channel.send(message);
  appendLedger(deps.ledgerPath, {
    run_id: deps.runId,
    task_id: deps.taskId,
    step: "notify.sent",
    channel: deps.channelName ?? "imessage",
  });
}
