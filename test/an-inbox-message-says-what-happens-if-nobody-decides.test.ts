/**
 * test/an-inbox-message-says-what-happens-if-nobody-decides.test.ts — W1-T8829.
 *
 * Every writer-made inbox message took its kind's template line for "if nothing happens", and a
 * machine-judge item (no template) told the operator "No decision or change is made by viewing this
 * summary." The decision card now carries an optional if_nothing_happens line the writer fills in.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { validateDecisionSummary } from "../src/lib/feedback.js";
import {
  backfillPlainMessages,
  checkPlainMessage,
  isNonAnswer,
  plainStorePath,
  plainTemplate,
  readPlainStore,
  TEMPLATED_KINDS,
  writePlainMessage,
} from "../src/lib/inbox-plain.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const proposal = { id: "machine-judge:W1-T5418", summary: "A parked fix is waiting for a ruling on whether to land it." };
const NON_ANSWER = "No decision or change is made by viewing this summary.";
const WRITER_LINE = "The fix stays parked and the build cost it targets keeps coming back.";

const card = (extra: Record<string, unknown> = {}) => ({
  headline: "A parked fix needs your ruling",
  what_happened: "A fix for a slow build is parked and waiting for a ruling.",
  decision: "Decide whether the fix should go ahead.",
  options: [
    { label: "Let it go ahead", consequence: "The fix is built and merged." },
    { label: "Drop it", consequence: "The fix is closed." },
  ],
  ...extra,
});

test("W1-T8829: the writer states what happens if nobody decides", async () => {
  const msg = await writePlainMessage(proposal, { summarize: () => card({ if_nothing_happens: WRITER_LINE }) });
  assert.equal(msg.source, "writer");
  assert.equal(msg.ifNothingHappens, WRITER_LINE);
  assert.notEqual(msg.ifNothingHappens, plainTemplate(proposal).ifNothingHappens, "not the template line");
});

test("W1-T8829: a non-answer about viewing the summary is refused", async () => {
  assert.equal(isNonAnswer(NON_ANSWER), true);
  assert.equal(isNonAnswer("No decision is made here."), true);
  assert.equal(isNonAnswer(WRITER_LINE), false, "control: a real consequence is not refused");
  const base = { ...plainTemplate(proposal), source: "writer" as const, ...{ options: card().options } };
  assert.equal(checkPlainMessage({ ...base, ifNothingHappens: WRITER_LINE }).ok, true, "control: the real line passes");
  assert.equal(checkPlainMessage({ ...base, ifNothingHappens: NON_ANSWER }).ok, false);

  // The writer is asked again with the problem named; a second non-answer falls to the template.
  const asked: string[] = [];
  const retried = await writePlainMessage(proposal, {
    summarize: ({ context }) => {
      asked.push(context);
      return card({ if_nothing_happens: asked.length === 1 ? NON_ANSWER : WRITER_LINE });
    },
  });
  assert.equal(asked.length, 2);
  assert.match(asked[1]!, /refused for/);
  assert.equal(retried.ifNothingHappens, WRITER_LINE);

  const stubborn = await writePlainMessage(proposal, { summarize: () => card({ if_nothing_happens: NON_ANSWER }) });
  assert.equal(stubborn.source, "template");
  assert.equal(isNonAnswer(stubborn.ifNothingHappens), false);
});

test("W1-T8829: every template states a real consequence of waiting", () => {
  const kinds = [...TEMPLATED_KINDS, "machine-judge", "something-unknown"];
  assert.ok(kinds.includes("verify-human") && kinds.includes("ruling"), "control: the non-answer kinds are covered");
  for (const kind of kinds) {
    const m = plainTemplate({ id: `${kind}:W1-T1`, summary: "W1-T1 was filed 5 days ago" });
    assert.equal(isNonAnswer(m.ifNothingHappens), false, `${kind}: ${m.ifNothingHappens}`);
    assert.doesNotMatch(m.ifNothingHappens, /viewing/i, kind);
    assert.deepEqual(checkPlainMessage(m).problems, [], kind);
  }
});

test("W1-T8829: a decision card without if_nothing_happens still validates", () => {
  const without = validateDecisionSummary(card());
  assert.ok(without);
  assert.equal("if_nothing_happens" in without, false, "the field is absent, not defaulted");
  const withLine = validateDecisionSummary(card({ if_nothing_happens: `  ${WRITER_LINE} ` }));
  assert.equal(withLine?.if_nothing_happens, WRITER_LINE);
  const malformed = validateDecisionSummary(card({ if_nothing_happens: 17 }));
  assert.ok(malformed, "a malformed optional line does not refuse the card");
  assert.equal("if_nothing_happens" in malformed, false);
});

test("W1-T8829: a message stored under the old contract is written again", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t8829-`)), "state");
  mkdirSync(dir);
  const oldFingerprint = (await import("node:crypto"))
    .createHash("sha256")
    .update(JSON.stringify(["inbox-plain-v2", proposal.id, proposal.summary]))
    .digest("hex");
  const stale = { ...plainTemplate(proposal), source: "writer", ifNothingHappens: NON_ANSWER, sourceFingerprint: oldFingerprint };
  writeFileSync(plainStorePath(dir), JSON.stringify({ [proposal.id]: stale }));
  let asks = 0;
  const deps = {
    stateDir: dir,
    readProposals: () => [{ ...proposal, id: "verify-human:W1-T5418" }, proposal].slice(1),
    summarize: () => {
      asks += 1;
      return card({ if_nothing_happens: WRITER_LINE });
    },
  };
  // machine-judge is not an operator-owned kind in every registry; pick the id the registry owns.
  const written = await backfillPlainMessages(deps, 1);
  assert.equal(written, 1, "the old-contract message is rewritten");
  assert.equal(asks, 1);
  assert.equal(readPlainStore(plainStorePath(dir))[proposal.id]?.ifNothingHappens, WRITER_LINE);
  assert.equal(await backfillPlainMessages(deps, 1), 0, "and the rewrite is current");
});
