/**
 * W1-T3000 — THE EMAIL CHANNEL IS BUILT AND THE DIGEST STILL GOES NOWHERE.
 *
 * W1-T2976 merged `emailChannel` so a daily report could reach an operator while the console
 * mailbox W1-T2497 is unbuilt. MEASURED after that merge: `git grep -n emailChannel -- src/`
 * returned its own definition and nothing else — no caller. `buildDigestCadenceDaemonHooks` still
 * constructed `inboxNotifyChannel` alone, so the digest kept rendering daily into the one surface
 * nobody can read while the adapter's existence read as "the email path is done".
 *
 * THE ASSERTION THAT MAKES THIS NON-VACUOUS is the two-ledger-rows one. A fan-out channel would
 * satisfy "both channels received the text" just as happily, and would then write ONE
 * `notify.sent` row for TWO outcomes — so an inbox write that succeeded and an email that could
 * not deliver would collapse into a single verdict. notify.ts refuses that shape by name. These
 * tests therefore assert on the LEDGER, not only on what the channels saw.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDigestCadenceDaemonHooks } from "../src/run-task.js";
import type { NotifyChannel } from "../src/lib/notify.js";
import type { Config } from "../src/lib/config.js";

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t3000-"));
  mkdirSync(join(root, "state"), { recursive: true });
  // One harmless rotation, so the ledger union is COMPLETE and the digest renders a real report
  // rather than refusing on a bare fixture — the same fixture shape the verb-census suite uses.
  writeFileSync(
    join(root, "state", "ledger.2026-08-01T00-00-00-000Z.ndjson"),
    `${JSON.stringify({ step: "unrelated.thing" })}\n`,
  );
  return root;
}

/** Every `notify.sent` row the run wrote, in order. */
function notifyRows(root: string): { channel?: string; delivered?: boolean; reason?: string }[] {
  const p = join(root, "state", "ledger.ndjson");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => r.step === "notify.sent") as { channel?: string; delivered?: boolean; reason?: string }[];
}

function recorder(): { got: string[]; channel: NotifyChannel } {
  const got: string[] = [];
  return { got, channel: { send: (m: string) => void got.push(m) } };
}

/** A channel that knows it cannot deliver — the unconfigured-transport case. */
function unavailableChannel(reason: string): NotifyChannel {
  return {
    unavailable: () => reason,
    send: () => assert.fail("an unavailable channel must never be sent to"),
  };
}

test("W1-T3000 a digest fire delivers the report to the email channel as well as the console inbox", async () => {
  const root = fixtureRoot();
  try {
    const inbox = recorder();
    const email = recorder();
    const hooks = buildDigestCadenceDaemonHooks({
      config: { root } as Config,
      now: () => new Date("2026-08-30T12:00:00Z"),
      channel: inbox.channel,
      emailChannel: email.channel,
    });

    await hooks.runDigestCadence();

    assert.equal(inbox.got.length, 1, "the existing console-inbox delivery is unchanged");
    assert.equal(email.got.length, 1, "and the email channel now receives the same report");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3000 the digest is rendered ONCE and the identical text goes to both", async () => {
  // A second render would re-read the ledger union at a different instant and could disagree with
  // the first, so the two deliveries could describe different fleets.
  const root = fixtureRoot();
  try {
    const inbox = recorder();
    const email = recorder();
    const hooks = buildDigestCadenceDaemonHooks({
      config: { root } as Config,
      now: () => new Date("2026-08-30T12:00:00Z"),
      channel: inbox.channel,
      emailChannel: email.channel,
    });

    const result = await hooks.runDigestCadence();

    assert.equal(email.got[0], inbox.got[0], "both deliveries must carry byte-identical text");
    assert.equal(email.got[0], result.text, "and it must be the text the run reported, not a re-render");
    assert.ok(result.text.length > 0, "control: the compared text is not the empty string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3000 each delivery writes its OWN ledger row, so two outcomes are never one verdict", async () => {
  // THE LOAD-BEARING TEST. A fan-out channel passes every assertion above and fails this one: it
  // would write a single `notify.sent` row for both sends.
  const root = fixtureRoot();
  try {
    const hooks = buildDigestCadenceDaemonHooks({
      config: { root } as Config,
      now: () => new Date("2026-08-30T12:00:00Z"),
      channel: recorder().channel,
      emailChannel: recorder().channel,
    });

    await hooks.runDigestCadence();

    const rows = notifyRows(root);
    assert.equal(rows.length, 2, "one row per delivery, never one row for two");
    assert.deepEqual(
      rows.map((r) => r.channel).sort(),
      ["email", "inbox"],
      "and each row must name its own channel, or the two are indistinguishable in the ledger",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3000 an unconfigured email channel is ledgered undelivered with its reason, and the cadence still completes", async () => {
  // The fleet host with no RMD_MAIL_COMMAND set. The inbox digest must survive, the gap must be
  // recorded, and the rung must not throw — notify.ts's "degrade, never throw, and never lie
  // about it" doctrine, inherited rather than re-implemented here.
  const root = fixtureRoot();
  try {
    const inbox = recorder();
    const hooks = buildDigestCadenceDaemonHooks({
      config: { root } as Config,
      now: () => new Date("2026-08-30T12:00:00Z"),
      channel: inbox.channel,
      emailChannel: unavailableChannel("no email transport configured — set RMD_MAIL_COMMAND"),
    });

    const result = await hooks.runDigestCadence();

    assert.ok(result.delivered, "the inbox delivery is unaffected by the email channel's state");
    assert.equal(inbox.got.length, 1, "and the operator still gets the inbox digest");

    const rows = notifyRows(root);
    const emailRow = rows.find((r) => r.channel === "email");
    assert.ok(emailRow, "an undeliverable email must still leave a row — silence would lose the evidence");
    assert.equal(emailRow.delivered, false);
    assert.match(String(emailRow.reason), /RMD_MAIL_COMMAND/, "the row must carry the reason, not just the failure");

    const inboxRow = rows.find((r) => r.channel === "inbox");
    assert.ok(inboxRow);
    assert.equal(inboxRow.delivered, undefined, "a healthy row stays byte-identical to the rows written before this change");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
