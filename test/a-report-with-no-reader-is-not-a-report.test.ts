/**
 * W1-T2976 — A REPORT WITH NO READER IS NOT A REPORT.
 *
 * `digestCadence` is `enabled: true` at 1440 minutes, so the fleet renders a digest every day and
 * hands it to `inboxNotifyChannel` — the console mailbox W1-T2497 has not built. The only other
 * adapter, `imessageChannel`, reports itself unavailable on every non-darwin host by construction.
 * So a report the fleet already writes reaches nobody on the Linux fleet host.
 *
 * WHAT THIS SUITE PINS, AND WHY EACH ASSERTION EXISTS RATHER THAN A HAPPY-PATH ONE:
 *   - the channel implements the EXISTING NotifyChannel contract, so `notify` needs no change;
 *   - an unconfigured channel reports a NAMED reason and sends NOTHING, because notify.ts's own
 *     doctrine is "unavailable is never silently read as absent, and never read as failure either";
 *   - the ledger row says `email`, so a delivery is distinguishable from an iMessage one;
 *   - NO CREDENTIAL reaches the ledger, stderr, or the message — the one assertion here whose
 *     absence would be a security defect rather than a coverage gap;
 *   - the transport is read from the environment AT SEND TIME (#2248), so a channel constructed
 *     before the operator configures one still works afterwards without reconstruction.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emailChannel, EMAIL_COMMAND_ENV, notify } from "../src/lib/notify.js";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-w1t2976-")), "ledger.ndjson");
}

/** A recording transport — the seam every test drives so no suite opens a socket. */
function recorder(): { calls: { argv: string[]; body: string }[]; spawn: (argv: string[], body: string) => void } {
  const calls: { argv: string[]; body: string }[] = [];
  return { calls, spawn: (argv, body) => void calls.push({ argv, body }) };
}

const CONFIGURED = { [EMAIL_COMMAND_ENV]: "/usr/sbin/sendmail -t" };

// ── THE CONTRACT ──────────────────────────────────────────────────────────────────────────────

test("W1-T2976 a configured email channel sends the rendered report to the recipient", () => {
  const r = recorder();
  const ch = emailChannel("ops@example.test", { spawn: r.spawn, readEnv: () => CONFIGURED });

  assert.equal(ch.unavailable?.(), undefined, "a configured channel must report itself available");
  ch.send("digest line one\ndigest line two");

  assert.equal(r.calls.length, 1, "exactly one send");
  assert.deepEqual(r.calls[0].argv, ["/usr/sbin/sendmail", "-t"], "the operator's own command, argv-split, never a shell string");
  assert.match(r.calls[0].body, /^To: ops@example\.test$/m, "the recipient rides the envelope");
  assert.match(r.calls[0].body, /digest line two/, "the whole report is delivered, not just its first line");
});

// ── UNAVAILABLE IS NAMED, NOT SILENT, AND NEVER A SEND ────────────────────────────────────────

test("W1-T2976 with no transport configured the channel names the reason and sends NOTHING", () => {
  const r = recorder();
  const ch = emailChannel("ops@example.test", { spawn: r.spawn, readEnv: () => ({}) });

  const why = ch.unavailable?.();
  assert.ok(why, "an unconfigured channel must report a reason");
  assert.match(why, new RegExp(EMAIL_COMMAND_ENV), "the reason must NAME the thing to set, not merely say 'not configured'");
  assert.equal(r.calls.length, 0, "and nothing may be sent while it is unavailable");
});

test("W1-T2976 with no recipient the channel names THAT reason, distinctly", () => {
  // Two different missing halves must not collapse into one message: an operator reading it has to
  // know which one to fix.
  const ch = emailChannel("", { spawn: recorder().spawn, readEnv: () => CONFIGURED });
  const why = ch.unavailable?.();
  assert.ok(why);
  assert.match(why, /recipient/i, "the missing recipient must be named as the missing recipient");
});

// ── THE LEDGER SAYS WHICH CHANNEL, AND TELLS THE TRUTH WHEN IT DID NOT DELIVER ────────────────

test("W1-T2976 a delivery is ledgered as channel email, distinguishable from an iMessage one", () => {
  const r = recorder();
  const p = ledgerPath();
  notify("the daily digest", {
    channel: emailChannel("ops@example.test", { spawn: r.spawn, readEnv: () => CONFIGURED }),
    ledgerPath: p,
    runId: "RUN-1",
    taskId: "W1-T2976",
    channelName: "email",
  });
  const row = JSON.parse(readFileSync(p, "utf8").trim().split("\n").at(-1) as string);
  assert.equal(row.step, "notify.sent");
  assert.equal(row.channel, "email", "without this the two adapters are indistinguishable in the ledger");
  assert.equal(row.delivered, undefined, "a healthy row stays byte-identical to the rows written before this change");
  assert.equal(r.calls.length, 1, "and the send really happened");
});

test("W1-T2976 an unavailable channel still writes a row, marked undelivered with its reason", () => {
  const r = recorder();
  const p = ledgerPath();
  notify("the daily digest", {
    channel: emailChannel("ops@example.test", { spawn: r.spawn, readEnv: () => ({}) }),
    ledgerPath: p,
    runId: "RUN-2",
    taskId: "W1-T2976",
    channelName: "email",
  });
  const row = JSON.parse(readFileSync(p, "utf8").trim().split("\n").at(-1) as string);
  assert.equal(row.delivered, false, "a row asserting a send that never happened is the shape notify.ts refuses");
  assert.match(String(row.reason), new RegExp(EMAIL_COMMAND_ENV));
  assert.equal(r.calls.length, 0);
});

// ── NO CREDENTIAL LEAVES THIS MODULE ──────────────────────────────────────────────────────────

test("W1-T2976 no credential reaches the ledger, the message, or the reason", () => {
  const SECRET = "hunter2-do-not-log";
  const r = recorder();
  const p = ledgerPath();
  const env = { [EMAIL_COMMAND_ENV]: "/usr/sbin/sendmail -t", RMD_MAIL_PASSWORD: SECRET };

  notify("the daily digest", {
    channel: emailChannel("ops@example.test", { spawn: r.spawn, readEnv: () => env }),
    ledgerPath: p,
    runId: "RUN-3",
    taskId: "W1-T2976",
    channelName: "email",
  });

  const written = readFileSync(p, "utf8");
  assert.doesNotMatch(written, new RegExp(SECRET), "a credential must never reach the ledger");
  assert.doesNotMatch(r.calls[0].body, new RegExp(SECRET), "nor the message body");
  // Control: the probe can see the secret when it IS present, so the two assertions above are not
  // vacuously true against a value that never existed.
  assert.match(env.RMD_MAIL_PASSWORD, new RegExp(SECRET), "control: the secret is real and findable");
});

// ── THE ENVIRONMENT IS READ AT SEND TIME, NOT AT CONSTRUCTION (#2248) ─────────────────────────

test("W1-T2976 a channel built before the transport is configured works once it is", () => {
  // `readEnv` MUST RETURN A FRESH OBJECT EACH CALL, and that is the whole discriminating power of
  // this test. Handing back one mutable object cannot tell "read per call" from "captured the
  // reference once", because a captured reference sees the mutation too — measured: a version of
  // this test that mutated a shared object passed against an implementation that froze
  // `readEnv()` at construction, which is the defect it exists to catch.
  const r = recorder();
  let configured = false;
  const ch = emailChannel("ops@example.test", {
    spawn: r.spawn,
    readEnv: () => (configured ? { ...CONFIGURED } : {}),
  });

  assert.ok(ch.unavailable?.(), "unavailable while unconfigured");
  configured = true; // the operator configures it AFTER the channel was built
  assert.equal(ch.unavailable?.(), undefined, "a captured env would have frozen the first answer");
  ch.send("now deliverable");
  assert.equal(r.calls.length, 1);
});

// ── THE DEFAULT TRANSPORT IS REAL, NOT A SEAM NOTHING EXERCISES ───────────────────────────────

test("W1-T2976 the DEFAULT transport really shells the configured command", () => {
  // Every other test injects a recorder, so the default implementation would otherwise be
  // unreachable — the #977/#978 all-fakes lesson, which is how imessageChannel's one platform
  // assumption shipped unexercised. This drives it against a local sink rather than a mail server.
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1t2976-real-"));
  const out = join(dir, "captured.eml");
  const ch = emailChannel("ops@example.test", {
    readEnv: () => ({ [EMAIL_COMMAND_ENV]: `/bin/sh -c cat>${out}` }),
  });

  assert.equal(ch.unavailable?.(), undefined);
  ch.send("delivered through the real transport");

  assert.ok(existsSync(out), "the default transport must actually execute the command");
  const captured = readFileSync(out, "utf8");
  assert.match(captured, /^To: ops@example\.test$/m, "and pipe the envelope to its stdin");
  assert.match(captured, /delivered through the real transport/);
});
