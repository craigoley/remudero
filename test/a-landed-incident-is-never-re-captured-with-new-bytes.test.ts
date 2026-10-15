import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stringify as stringifyYaml } from "yaml";
import { captureFeedback, feedbackEntryPath, listFeedback, readLandedFeedbackEntry, type FeedbackEntry } from "../src/lib/feedback.js";
import { incidentFeedbackId, incidentFeedbackOrigin, landedIncidentOpen, runSreLanePass, type IncidentLedgerEvent } from "../src/lib/sre-lane.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

/**
 * W1-T9624 — 2026-10-15: the core daemon ran on boot sha 52c19d0 for hours while #11901/#11946 landed
 * its incident files on main. The landed copies were acknowledged out of the working tree, HEAD never
 * had them, so the SRE lane's open check and captureFeedback's explicit-id guard (both working-tree
 * reads) missed them, and each recurrence re-wrote the same incident-<fp>.yaml with a new ts and Count.
 * Those 45 divergent untracked files refused every boot checkout for 2 h 6 m (W1-T9623).
 *
 * The fixture is that shape: a checkout whose HEAD lacks the entry while its fetched origin/main has it.
 */

const FINGERPRINT = "fc02119ad9d1b7578aad7dbfa1f5d5c4bfdac61d48e0841d268c64847c569034";
const ID = incidentFeedbackId(FINGERPRINT);
const REL = `plan/feedback/${ID}.yaml`;

function landedEntry(status: FeedbackEntry["status"]): FeedbackEntry {
  return {
    id: ID,
    ts: "2026-10-15T06:17:14.586Z",
    raw: "Incident fc02119ad9d1: flow idle-capacity\n\nCount: 1, burn: 1.00/hr",
    attachments: [],
    origin: incidentFeedbackOrigin(FINGERPRINT),
    status,
    reply_to: null,
    proposal_pr: null,
    summary: null,
    expansion: null,
    submission_key: null,
    thread_id: null,
  };
}

/** A checkout at an OLD HEAD whose fetched origin/main has landed `entry` — the daemon's 10-15 tree. */
function landedEntryFixture(entry: FeedbackEntry): string {
  const origin = gitRepo({ bare: true, kind: "landed-incident-origin" });
  const writer = gitRepo({ cloneFrom: origin.dir, kind: "landed-incident-writer" });
  writer.git("commit", "--quiet", "--allow-empty", "-m", "chore: seed");
  writer.git("push", "--quiet", "origin", "HEAD:main");
  const checkout = gitRepo({ cloneFrom: origin.dir, kind: "landed-incident-checkout" });
  mkdirSync(join(writer.dir, "plan", "feedback"), { recursive: true });
  writeFileSync(join(writer.dir, REL), stringifyYaml(entry));
  writer.git("add", REL);
  writer.git("commit", "--quiet", "-m", "chore(feedback): land pending filings");
  writer.git("push", "--quiet", "origin", "HEAD:main");
  checkout.git("fetch", "--quiet", "origin");
  assert.equal(existsSync(join(checkout.dir, REL)), false, "fixture: the working tree lacks the landed entry");
  assert.equal(checkout.git("show", `origin/main:${REL}`).includes(ID), true, "fixture: fetched origin/main holds it");
  return checkout.dir;
}

test("a landed incident is never re-captured with new bytes: the capture returns origin/main's entry and writes nothing", () => {
  const root = landedEntryFixture(landedEntry("new"));

  const entry = captureFeedback(root, {
    id: ID,
    raw: "Incident fc02119ad9d1: flow idle-capacity\n\nCount: 8, burn: 8.00/hr",
    origin: incidentFeedbackOrigin(FINGERPRINT),
  });

  assert.equal(existsSync(feedbackEntryPath(root, ID)), false, "no copy with new bytes may appear in the working tree");
  assert.equal(entry.ts, "2026-10-15T06:17:14.586Z", "the landed entry is returned untouched");
  assert.match(entry.raw, /Count: 1,/);
});

test("a landed incident is never re-captured with new bytes: the SRE lane reads a landed open entry as already open", () => {
  const root = landedEntryFixture(landedEntry("new"));
  assert.equal(landedIncidentOpen(FINGERPRINT, (id) => readLandedFeedbackEntry(root, id)), true);
  assert.equal(landedIncidentOpen("0".repeat(64), (id) => readLandedFeedbackEntry(root, id)), false, "another fingerprint is not open");
});

test("a landed incident is never re-captured with new bytes: a rejected landed entry is closed, so a recurrence may file again", () => {
  const root = landedEntryFixture(landedEntry("rejected"));
  assert.equal(landedIncidentOpen(FINGERPRINT, (id) => readLandedFeedbackEntry(root, id)), false);
});

test("a landed incident is never re-captured with new bytes: an unreadable origin/main is absent, never present, so capture writes as before", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}landed-incident-nogit-`));
  assert.equal(readLandedFeedbackEntry(root, ID), null);
  const entry = captureFeedback(root, { id: ID, raw: "Incident: recurring", origin: incidentFeedbackOrigin(FINGERPRINT) });
  assert.equal(entry.id, ID);
  assert.match(readFileSync(feedbackEntryPath(root, ID), "utf8"), /Incident: recurring/, "with no landed entry the capture is written");
});

test("a landed incident is never re-captured with new bytes: a pass skips the landed fingerprint and files the next one", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}landed-incident-pass-`));
  mkdirSync(join(root, "state"), { recursive: true });
  const other = "b".repeat(64);
  const at = (minutesAgo: number) => Date.now() - minutesAgo * 60_000;
  const ev = (fingerprint: string, minutesAgo: number): IncidentLedgerEvent =>
    ({ fingerprint, ts: at(minutesAgo), kind: "exception", name: "TypeError", message: "boom", instance: "core" }) as IncidentLedgerEvent;
  // The landed fingerprint burns hotter, so it would be the worst one filed if the lane missed the landed entry.
  const events = [ev(FINGERPRINT, 30), ev(FINGERPRINT, 20), ev(FINGERPRINT, 10), ev(FINGERPRINT, 5), ev(other, 15)];
  const landed = landedEntry("new");

  const pass = await runSreLanePass({
    stateDir: join(root, "state"),
    root,
    readEvents: () => events,
    hasOpenTask: () => false,
    framesFor: () => [],
    mergedPrsSince: () => [],
    mergedLastDay: () => 10,
    log: () => {},
    readLandedEntry: (id) => (id === ID ? landed : null),
  });

  assert.equal(pass.filed, other, "the landed fingerprint is open upstream, so the next-worst one is filed");
  assert.deepEqual(listFeedback(root).map((e) => e.id), [incidentFeedbackId(other)], "and the landed one is never re-written");
});
