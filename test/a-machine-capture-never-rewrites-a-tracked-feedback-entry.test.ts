/**
 * 2026-10-14 (LIVE-EDITS #11528): `plan/feedback/host-mem-2cb2457c8893de7c.yaml` was TRACKED on
 * main with `status: rejected`. The host-resource gardener's next memory episode skipped its
 * open-incident check (a rejected entry is not open) and handed the incident off again with the
 * same deterministic id, and `captureFeedback` rewrote the tracked file in core's live daemon
 * checkout (`status: new`, a fresh ts and evidence). The checkout went dirty, the live-edit ladder
 * preserved and later restored the edit, and core sat behind origin/main in between, three times
 * that day. The sre lane's `incident-<fp>` handoff has the same shape.
 *
 * The `id` option promises that a deterministic id dedups by existence. These tests hold it to that.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { captureFeedback, feedbackEntryPath, type FeedbackOrigin } from "#src/lib/feedback.js";
import { memoryIncidentOrigin } from "#src/lib/host-resource-gardener.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const ORIGIN = memoryIncidentOrigin("azure", "remudero-daemon");
const ID = `host-mem-${ORIGIN.slice("incident#".length, "incident#".length + 16)}`;
const REJECTED = [
  `id: ${ID}`,
  "ts: 2026-10-10T04:39:11.852Z",
  "raw: host-mem:azure:remudero-daemon",
  "attachments: []",
  `origin: ${ORIGIN}`,
  "status: rejected",
  "",
].join("\n");

const offline = () => {
  throw new Error("fixture: no network");
};

/** The gardener's handoff port, exactly: the same id shape, origin and capture call. */
function handoff(root: string): ReturnType<typeof captureFeedback> {
  return captureFeedback(root, { id: ID, origin: ORIGIN as FeedbackOrigin, raw: "host-mem:azure:remudero-daemon\n\nrefaulted again", land: { git: offline, gh: offline } });
}

test("a machine capture with an existing id returns the decided entry and leaves its bytes untouched", () => {
  const repo = gitRepo({ kind: "capture-existing-id" });
  mkdirSync(join(repo.dir, "plan", "feedback"), { recursive: true });
  writeFileSync(feedbackEntryPath(repo.dir, ID), REJECTED);
  const entry = handoff(repo.dir);
  assert.equal(entry.status, "rejected", "the decided entry is returned, not a fresh one");
  assert.equal(readFileSync(feedbackEntryPath(repo.dir, ID), "utf8"), REJECTED, "the file is byte-identical");
});

test("a machine capture never dirties a live checkout whose feedback entry is tracked", () => {
  const repo = gitRepo({ kind: "capture-tracked-entry" });
  mkdirSync(join(repo.dir, "plan", "feedback"), { recursive: true });
  writeFileSync(feedbackEntryPath(repo.dir, ID), REJECTED);
  repo.git("add", "plan/feedback");
  repo.git("commit", "--quiet", "-m", "triage rejects the incident");
  handoff(repo.dir);
  assert.equal(repo.git("status", "--porcelain", "--untracked-files=no"), "", "no tracked edit in the checkout");
});

test("a machine capture with a new id still files its entry", () => {
  const repo = gitRepo({ kind: "capture-new-id" });
  const entry = handoff(repo.dir);
  assert.equal(entry.status, "new");
  assert.match(readFileSync(feedbackEntryPath(repo.dir, ID), "utf8"), /refaulted again/);
});
