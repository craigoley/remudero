import { mintOptionLink, type EscalationOptionKind } from "./escalate.js";
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
  /**
   * A reason this channel CANNOT deliver right now, or `undefined` when it can — the same
   * three-valued shape `ShippedGithub.unavailable()` (retro.ts) already uses, and for the same
   * doctrine: unavailable is never silently read as absent, and it is never read as failure
   * either. OPTIONAL, so every existing injected fake is unaffected and keeps sending exactly
   * as before; only a channel that knows it cannot deliver implements it.
   */
  unavailable?(): string | undefined;
}

/**
 * Escape a string for embedding inside an AppleScript double-quoted literal.
 *
 * SECURITY: the message is attacker-influenceable content (ledger text) driven through
 * `osascript`, so this is an injection boundary — every character that could terminate
 * the `"…"` literal or the `-e` line must be neutralised, or a crafted message could
 * break out and run arbitrary AppleScript / `do shell script` on the host Mac. We
 * escape backslashes FIRST (so the escaping backslash isn't itself re-escaped), then
 * quotes, then carriage-returns and newlines — a RAW newline inside an AppleScript
 * string literal is not even legal, so it must become the two-char `\n` escape.
 */
export function escapeAppleScriptString(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

/** Build the AppleScript that sends `message` to `recipient` over iMessage. */
export function buildSendScript(recipient: string, message: string): string {
  const r = escapeAppleScriptString(recipient);
  const m = escapeAppleScriptString(message);
  return `tell application "Messages" to send "${m}" to buddy "${r}" of (service 1 whose service type is iMessage)`;
}

/**
 * Real channel: `osascript` against Messages.app. `recipient` is a phone number or Apple ID.
 *
 * MEASURED ON AZURE 2026-08-08: a two-lane drain completed BOTH lanes, recorded both verdicts,
 * printed its summary and its post-drain rundown, and then threw `spawnSync osascript ENOENT` out
 * of `drainCommand` — because `osascript` is macOS AppleScript and the container is Linux. The
 * drain's work was untouched; the PROCESS exited non-zero on a fully successful drain, which under
 * a restart policy reads as a crash and re-runs it.
 *
 * WHY NO TEST CAUGHT IT, which is the more useful half. Nothing constructs this channel: every
 * test injects a recording fake, so the seam's DEFAULT implementation was unreachable and its one
 * platform assumption was never exercised. That is the same shape already recorded against a
 * different seam in this repo — when every test supplies its own implementation, the real one is
 * covered by nothing.
 *
 * THE GUARD IS HERE, NOT IN `notify`, AND THE PLACEMENT IS LOAD-BEARING. `process.platform` is
 * `linux` in CI and in every agent container, so a platform check inside {@link notify} would skip
 * the INJECTED channel too — every existing fake would stop being called, and the fleet would
 * become untestable on the only platform its tests run on. Guarding the REAL channel leaves every
 * fake exactly as it was.
 *
 * `platform` is a parameter rather than a direct read so BOTH directions are provable on one host:
 * a test can force `"darwin"` on Linux and observe that this really does reach `osascript` (rather
 * than a guard that swallows everything), and force a non-darwin value and observe that it does not.
 */
export function imessageChannel(
  recipient: string,
  platform: NodeJS.Platform = process.platform,
): NotifyChannel {
  return {
    unavailable() {
      // DARWIN ONLY. `osascript` drives Messages.app and exists on no other platform, so this is
      // a property of the transport rather than a runtime condition worth probing for.
      return platform === "darwin"
        ? undefined
        : `no real-time channel on ${platform} — osascript/Messages.app is macOS-only`;
    },
    send(message) {
      execFileSync("osascript", ["-e", buildSendScript(recipient, message)], { stdio: "pipe" });
    },
  };
}

// ── W1-T2976: the second adapter, because the first cannot deliver here ───────
//
// `digestCadence` renders daily into `inboxNotifyChannel` (the console mailbox W1-T2497 has not
// built) while {@link imessageChannel} is unavailable off darwin — so the report reaches nobody.
// SHELLS A COMMAND THE OPERATOR NAMES rather than speaking SMTP: an SMTP client would be an async
// socket in a synchronous `send`, a second credential store, and a hand-rolled protocol
// `no-hand-rolled-fetch` refuses. Every credential stays OUTSIDE this module — the operator's
// command may read one, this code never sees it.

/** Env var naming the sendmail-compatible command, argv-split on spaces (e.g. `/usr/sbin/sendmail -t`). */
export const EMAIL_COMMAND_ENV = "RMD_MAIL_COMMAND";

/** The send seam: run `argv` and pipe `body` to its stdin. Injectable so no test opens a socket. */
export type EmailSpawn = (argv: string[], body: string) => void;

function defaultEmailSpawn(argv: string[], body: string): void {
  execFileSync(argv[0], argv.slice(1), { input: body, stdio: ["pipe", "ignore", "pipe"] });
}

/** RFC-5322-ish envelope a sendmail-compatible command reads from stdin (`-t` takes To: from here). */
function envelope(recipient: string, message: string): string {
  const subject = (message.split("\n").find((l) => l.trim() !== "") ?? "remudero report").slice(0, 120);
  return `To: ${recipient}\nSubject: ${subject}\n\n${message}\n`;
}

/**
 * Email channel (W1-T2976). ADDITIVE — `rmd digest` and the cadence's inbox write are unchanged.
 *
 * `readEnv` IS CALLED PER OPERATION, NEVER CAPTURED: a channel built before the operator sets a
 * command must work once they do, and capturing would freeze the first answer (#2248).
 */
export function emailChannel(
  recipient: string,
  opts: { spawn?: EmailSpawn; readEnv?: () => NodeJS.ProcessEnv } = {},
): NotifyChannel {
  const readEnv = opts.readEnv ?? (() => process.env);
  const spawn = opts.spawn ?? defaultEmailSpawn;
  const command = (): string => (readEnv()[EMAIL_COMMAND_ENV] ?? "").trim();
  return {
    unavailable() {
      // TWO MISSING HALVES, TWO DISTINCT ANSWERS. An operator reading this has to know which one
      // to fix, so these never collapse into one "not configured".
      if (recipient.trim() === "") return "no email recipient configured — set `notifyRecipient` in config.json";
      if (command() === "") return `no email transport configured — set ${EMAIL_COMMAND_ENV} to a sendmail-compatible command`;
      return undefined;
    },
    send(message) {
      // Only the command NAME and its flags cross this boundary; a credential the operator's
      // command reads is never loaded, logged or ledgered here.
      spawn(command().split(/\s+/), envelope(recipient, message));
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

/**
 * Send one message over the channel + log a ledger `notify.sent` line (a send is never silent).
 *
 * DEGRADE, NEVER THROW, AND NEVER LIE ABOUT IT. A channel that reports itself
 * {@link NotifyChannel.unavailable} is not sent to: the attempt is announced once on stderr and
 * the SAME ledger line is written carrying `delivered: false` and the reason. Three properties,
 * each chosen against a failure this repo has already paid for:
 *
 *   NOT A THROW, because a notification is a REPORT ABOUT work, never the work itself. Every
 *   caller sequences its real effect first — the escalation opens and ledgers its issue before the
 *   ping, the drain records both verdicts and prints its rundown before the push — so throwing
 *   here discards nothing but the message, while turning a successful command into a non-zero
 *   exit. `rmd notify` is the one caller whose whole purpose IS the message; it now reports the
 *   reason instead of a stack trace, which is the same answer with a usable explanation.
 *
 *   NOT SILENTLY ABSENT, which is the other precedent available here and the wrong one. A
 *   darwin-gated rung that is simply missing elsewhere suits a PRECONDITION FOR WORK; this is a
 *   channel an operator believes is paging them. Someone who thinks they will be pinged and will
 *   not be is worse off than someone told once that they will not be. The nearer precedent is the
 *   status verb, which degrades a missing binary to a warning plus a next action and still renders
 *   — rather than the review verb, which hard-crashes on the same condition.
 *
 *   NOT A FALSE `notify.sent`, which is why the line carries the outcome rather than the intent.
 *   A row asserting a send that never happened is the self-contradicting-record shape this fleet
 *   has been bitten by before; and note that TODAY there is no row at all, because the throw is
 *   sequenced BEFORE this append — so a failed ping currently loses even the evidence that it was
 *   attempted. `delivered` is present only when false, so every healthy row is byte-identical to
 *   the rows written before this change.
 */
export function notify(message: string, deps: NotifyDeps): void {
  const unavailable = deps.channel.unavailable?.();
  if (unavailable !== undefined) {
    // One line per attempt — bounded by the number of notifications, never a loop, and no
    // module-level "warn once" state that a test could not reset or a second run could inherit.
    console.error(`notify: NOT DELIVERED — ${unavailable}`);
  } else {
    deps.channel.send(message);
  }
  appendLedger(deps.ledgerPath, {
    run_id: deps.runId,
    task_id: deps.taskId,
    step: "notify.sent",
    channel: deps.channelName ?? "imessage",
    ...(unavailable !== undefined ? { delivered: false, reason: unavailable } : {}),
  });
}

// ── W1-T2696: the ping carries its own answer links ──────────────────────────
//
// The operator reads a MANUAL or HARD_STOP ping on a phone. Today answering means opening the
// console; the option kinds and routes already exist, so what was missing is a link carrying the
// operator's authority for exactly one option, once.
//
// INVARIANT: one link per EXECUTABLE option and none for an operator-only or untyped one, whose
// prose is unchanged. A link is never minted without a secret.
// FALSIFIER: test/escalation-answer-links.test.ts.

/** What the renderer needs about one option: its prose, and its kind if it has one. */
export interface PingOption {
  readonly label: string;
  readonly detail: string;
  readonly kind?: EscalationOptionKind;
}

export interface EscalationPingInput {
  readonly cls: string;
  readonly taskId: string;
  readonly summary: string;
  readonly issueUrl: string;
  readonly cardUrl: string;
  readonly options: readonly PingOption[];
}

/**
 * Render the real-time ping, appending one answer link per executable option.
 *
 * `secret` is optional and its absence is the degrade path, not an error: a deploy that has
 * never minted a link secret still pages the operator with exactly today's text. That mirrors
 * notify()'s own rule directly above — a notification is a report about work, never the work —
 * so a missing secret must never cost the operator the page itself.
 */
export function renderEscalationPing(
  input: EscalationPingInput,
  opts: { readonly secret?: string; readonly baseUrl: string; readonly nowMs: number },
): string {
  const head = `[${input.cls}] ${input.taskId}: ${input.summary}\n${input.issueUrl}\n${input.cardUrl}`;
  if (opts.secret === undefined) return head;
  const lines: string[] = [];
  for (const option of input.options) {
    if (option.kind === undefined) continue;
    const link = mintOptionLink(input.taskId, input.cls, option.kind, opts.secret, opts.nowMs, opts.baseUrl);
    if (link !== undefined) lines.push(`${option.label}: ${link}`);
  }
  return lines.length === 0 ? head : `${head}\n${lines.join("\n")}`;
}
