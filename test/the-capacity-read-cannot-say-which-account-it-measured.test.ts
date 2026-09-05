import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { claudeCapacityFromUsage, providerWindowConsumption, type ProviderCapacity } from "../src/lib/worker-provider.js";
import { readClaudeAccountLabel, readClaudeAccountLabelDetailed } from "../src/lib/worker.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(REPO_ROOT, "test", "fixtures", "account-usage", "claude-json.json");

/**
 * test/the-capacity-read-cannot-say-which-account-it-measured.test.ts — W1-T2828.
 *
 * The operator switches Claude subscriptions by hand and every instrument follows whatever Claude
 * Code is logged into, so two readings from two accounts are indistinguishable in the ledger.
 * `providerWindowConsumption` compares a before/after around every spawn and had no identity check
 * at all. What protected it was incidental: a window is comparable only when name AND resetsAt
 * match exactly, so a mid-spawn switch usually lands in `no-reset-stable-window` or
 * `counter-regressed`. Two accounts whose weekly windows share a reset timestamp would MATCH.
 * That is the case this suite pins.
 */

const A = "11111111-2222-3333-4444-555555555555";
const B = "99999999-8888-7777-6666-555555555555";

function snapshot(sessionPct: number, weeklyPct: number, resetsAt: string) {
  return {
    billingMode: "subscription",
    session: { percentUsed: sessionPct, resetsAt },
    weekly: [{ label: "all", percentUsed: weeklyPct, resetsAt }],
  } as never;
}

function root(): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}acct-label-`));
}

test("W1-T2828: two readings under different accounts produce DIFFERENT labels; repeated readings under one produce a STABLE label", () => {
  const one = claudeCapacityFromUsage(snapshot(10, 60, "2026-09-06T00:00:00Z"), A);
  const oneAgain = claudeCapacityFromUsage(snapshot(17, 61, "2026-09-06T00:00:00Z"), A);
  const other = claudeCapacityFromUsage(snapshot(2, 93, "2026-09-06T00:00:00Z"), B);

  assert.equal(one.accountLabel, A);
  assert.equal(oneAgain.accountLabel, A, "the label must be stable across readings from one account");
  assert.equal(other.accountLabel, B);
  assert.notEqual(one.accountLabel, other.accountLabel, "a switch must be visibly a different account");
  // The windows are unaffected by the label — it annotates a reading, it does not shape one.
  assert.deepEqual(
    one.windows.map((w) => w.name),
    ["session (5h)", "weekly (all)"],
  );
});

test("W1-T2828: providerWindowConsumption REFUSES a cross-account comparison whose window name AND resetsAt match", () => {
  const RESET = "2026-09-06T00:00:00Z";
  // The case incidental protection does NOT cover: same window name, same reset timestamp, a
  // forward delta — everything the comparison keys on agrees, and only the account differs.
  const before = claudeCapacityFromUsage(snapshot(10, 60, RESET), A);
  const after = claudeCapacityFromUsage(snapshot(20, 66, RESET), B);
  const guarded = providerWindowConsumption(before, after);
  assert.equal(guarded.percentConsumed, null);
  assert.equal(guarded.reason, "account-mismatch");

  // The control that makes that a result: the IDENTICAL pair with one account computes a delta,
  // so the refusal is the account differing and not the windows failing to line up.
  const sameAccount = providerWindowConsumption(before, claudeCapacityFromUsage(snapshot(20, 66, RESET), A));
  assert.equal(sameAccount.reason, undefined);
  assert.ok(sameAccount.percentConsumed !== null && sameAccount.percentConsumed > 0);
});

test("W1-T2828: a same-account comparison still computes its delta exactly as today, and an unlabelled pair is never refused", () => {
  const RESET = 1_760_000_000_000;
  const before = claudeCapacityFromUsage(snapshot(10, 60, RESET as never), A);
  const after = claudeCapacityFromUsage(snapshot(14, 63, RESET as never), A);
  const same = providerWindowConsumption(before, after);
  assert.equal(same.reason, undefined);
  assert.equal(same.percentConsumed, 4, "session 10 -> 14 is the tightest forward delta");

  // A host that has never had a label must keep attributing spend: only a KNOWN mismatch refuses.
  const noLabel = providerWindowConsumption(
    claudeCapacityFromUsage(snapshot(10, 60, RESET as never)),
    claudeCapacityFromUsage(snapshot(14, 63, RESET as never)),
  );
  assert.equal(noLabel.reason, undefined);
  assert.equal(noLabel.percentConsumed, 4);
  // And a HALF-labelled pair cannot establish a mismatch, so it must not refuse either.
  const half = providerWindowConsumption(
    claudeCapacityFromUsage(snapshot(10, 60, RESET as never), A),
    claudeCapacityFromUsage(snapshot(14, 63, RESET as never)),
  );
  assert.equal(half.reason, undefined);
  assert.equal(half.percentConsumed, 4);
});

test("W1-T2828: the label reads accountUuid from a real fixture, and fails open on absent, unparseable and shape-changed files", () => {
  // The repo's own captured block — proves the reader works against the real shape.
  assert.equal(readClaudeAccountLabel(FIXTURE), JSON.parse(readFileSync(FIXTURE, "utf8")).oauthAccount.accountUuid);

  const r = root();
  try {
    const write = (name: string, body: string): string => {
      const p = join(r, name);
      writeFileSync(p, body);
      return p;
    };
    assert.equal(readClaudeAccountLabel(join(r, "absent.json")), undefined, "absent must be undefined, never a throw");
    assert.equal(readClaudeAccountLabel(write("bad.json", "{not json")), undefined, "unparseable must fail open");
    assert.equal(readClaudeAccountLabel(write("null.json", "null")), undefined);
    assert.equal(readClaudeAccountLabel(write("arr.json", "[]")), undefined);
    assert.equal(readClaudeAccountLabel(write("no-account.json", '{"cachedUsageUtilization":{}}')), undefined);
    assert.equal(readClaudeAccountLabel(write("acct-null.json", '{"oauthAccount":null}')), undefined);
    assert.equal(readClaudeAccountLabel(write("uuid-num.json", '{"oauthAccount":{"accountUuid":7}}')), undefined, "a shape change must not yield a non-string label");
    assert.equal(readClaudeAccountLabel(write("uuid-blank.json", '{"oauthAccount":{"accountUuid":"  "}}')), undefined);
    // Positive control: the same reader DOES return a label from a well-formed file, so the
    // undefineds above are the guards firing and not a reader that never returns anything.
    assert.equal(readClaudeAccountLabel(write("ok.json", `{"oauthAccount":{"accountUuid":"${A}"}}`)), A);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("W1-T2828: the capacity read stays READABLE with its windows intact when the label is absent — the label is never a precondition", () => {
  const unlabelled = claudeCapacityFromUsage(snapshot(10, 60, "2026-09-06T00:00:00Z"), undefined);
  assert.equal(unlabelled.readable, true);
  assert.equal(unlabelled.accountLabel, undefined);
  assert.deepEqual(
    unlabelled.windows.map((w) => [w.name, w.usedPercent]),
    [["session (5h)", 10], ["weekly (all)", 60]],
  );
  // An unreadable snapshot is unchanged by this task: still unreadable, still no label.
  const none = claudeCapacityFromUsage(undefined, A);
  assert.equal(none.readable, false);
  assert.equal(none.accountLabel, undefined, "an unreadable capacity carries no label to compare");
});

test("W1-T2828: no identity field other than accountUuid is read or emitted", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const email = fixture.oauthAccount.emailAddress;
  const org = fixture.oauthAccount.organizationName;
  // Positive control: the fixture really does carry both, so their absence below is meaningful.
  assert.ok(typeof email === "string" && email.length > 0, "the fixture must carry emailAddress for this to test anything");
  assert.ok(typeof org === "string" && org.length > 0, "the fixture must carry organizationName for this to test anything");

  const label = readClaudeAccountLabel(FIXTURE);
  assert.equal(label, fixture.oauthAccount.accountUuid);
  assert.notEqual(label, email);
  assert.notEqual(label, org);

  // Neither field can reach a capacity reading, which is what the ledger row projects from.
  const capacity: ProviderCapacity = claudeCapacityFromUsage(snapshot(10, 60, "2026-09-06T00:00:00Z"), label);
  const serialized = JSON.stringify(capacity);
  assert.equal(serialized.includes(email), false, "emailAddress must never reach a capacity reading");
  assert.equal(serialized.includes(org), false, "organizationName must never reach a capacity reading");
  assert.ok(serialized.includes(fixture.oauthAccount.accountUuid), "positive control: the uuid IS there to be found");
});

test("W1-T2828: each way of having no label names its own cause — 'unreadable' and 'no uuid' are different facts", () => {
  const r = root();
  try {
    const write = (name: string, body: string): string => {
      const p = join(r, name);
      writeFileSync(p, body);
      return p;
    };
    // The catch-erasure ratchet refuses a catch that discards its reason, and it caught this
    // function's first shape: four distinct failures collapsed into one bare `undefined`.
    assert.equal(readClaudeAccountLabelDetailed(join(r, "absent.json")).label, undefined);
    assert.deepEqual(readClaudeAccountLabelDetailed(join(r, "absent.json")), { label: undefined, reason: "unreadable" });
    assert.deepEqual(readClaudeAccountLabelDetailed(write("b.json", "{oops")), { label: undefined, reason: "unparseable" });
    assert.deepEqual(readClaudeAccountLabelDetailed(write("n.json", "null")), { label: undefined, reason: "not-an-object" });
    assert.deepEqual(readClaudeAccountLabelDetailed(write("a.json", "{}")), { label: undefined, reason: "no-account" });
    assert.deepEqual(readClaudeAccountLabelDetailed(write("u.json", '{"oauthAccount":{}}')), { label: undefined, reason: "no-uuid" });
    // Positive control: a well-formed file returns a label and NO reason field at all.
    assert.deepEqual(readClaudeAccountLabelDetailed(write("ok.json", `{"oauthAccount":{"accountUuid":"${A}"}}`)), { label: A });
    // The five reasons are distinct — collapsing any two would make the read unable to tell a
    // missing file from a changed shape, which is the distinction this exists for.
    const reasons = ["absent.json", "b.json", "n.json", "a.json", "u.json"].map(
      (f) => (readClaudeAccountLabelDetailed(join(r, f)) as { reason?: string }).reason,
    );
    assert.equal(new Set(reasons).size, 5, `each cause must be distinguishable, saw ${JSON.stringify(reasons)}`);
    // And the projection every caller uses still flattens them all to undefined.
    for (const f of ["absent.json", "b.json", "n.json", "a.json", "u.json"]) {
      assert.equal(readClaudeAccountLabel(join(r, f)), undefined);
    }
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});
