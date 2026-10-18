// W1-T9852: a feedback entry hand-landed without an `attachments:` key (fb-1789601878740-3711ab, #5838) threw
// "Cannot read properties of undefined (reading 'length')" in triagePrompt on every auto-triage fire.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FeedbackError, listFeedback, readFeedbackEntry } from "#src/lib/feedback.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { triagePrompt } from "#src/lib/triage.js";

const ID = "fb-1789601878740-3711ab";

/** The live entry's shape: id, ts, raw, origin and status, with no attachments key. */
function entryRoot(extra = ""): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fb-attach-`));
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  writeFileSync(
    join(root, "plan", "feedback", `${ID}.yaml`),
    `id: ${ID}\nts: 2026-09-16T23:37:58.756Z\nraw: "FOUR MEASURED SESSION TRAPS"\n` +
      `origin: operator-session#shift-left-audit-2026-09-16\nstatus: new\n${extra}`,
  );
  return root;
}

test("W1-T9852: a feedback entry with no attachments key reads as an empty list", () => {
  const root = entryRoot();
  try {
    assert.deepEqual(readFeedbackEntry(root, ID).attachments, []);
    const listed = listFeedback(root, { status: "new" });
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0]!.attachments, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T9852: the triage prompt renders an entry with no attachments key", () => {
  const root = entryRoot();
  try {
    const prompt = triagePrompt(readFeedbackEntry(root, ID), "TRIAGE-run");
    assert.match(prompt, /^attachments: \(none\)$/m);
    assert.match(prompt, /FOUR MEASURED SESSION TRAPS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T9852: a non-list attachments value is refused by name", () => {
  const root = entryRoot("attachments: shot.png\n");
  try {
    assert.throws(() => readFeedbackEntry(root, ID), (err: unknown) =>
      err instanceof FeedbackError && err.message.includes(ID) && err.message.includes("attachments"));
    assert.throws(() => listFeedback(root), FeedbackError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
