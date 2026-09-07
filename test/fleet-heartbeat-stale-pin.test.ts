/**
 * W1-T494 — THE STALE PIN, PUBLISHED WHERE AN OFF-HOST READER CAN SEE IT.
 *
 * The freshness guard (`daemonFreshnessFromService`, src/lib/self-sync.ts) declines to restart on a
 * DIRTY tree, and that is CORRECT: a restart returns on the same sha, reads the same staleness and
 * exits again — a crash loop. So the daemon stays up, correctly, running old code. It writes
 * `daemon.stale_code` (carrying BOTH shas) and `daemon.tree_dirty`, and until now NOTHING read
 * either: neither step appeared in any `scripts/` or `.github/` file. On the commissioning host
 * `daemon_boot_head_sha` and `install_head_sha` AGREED while both were ten commits behind, because
 * the install is what failed to advance — so comparing those two can never catch this.
 *
 * THE HARNESS IS IMPORTED, NOT COPIED. `runBeat` stubs the binaries on PATH and runs the REAL
 * committed script; duplicating it here is the shape W1-T2903 files (218 `git init` sites across
 * 130 files), so this exports it from the sibling suite instead of forking a second copy.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runBeat } from "./helpers/fleet-heartbeat-harness.js";

const BOOT = (ts: string, sha: string): string =>
  JSON.stringify({ ts, run_id: "DAEMON-1", task_id: "DAEMON", step: "daemon.boot", head_sha: sha });
const STALE = (ts: string, oldSha: string, newSha: string): string =>
  JSON.stringify({ ts, run_id: "DAEMON-1", task_id: "DAEMON", step: "daemon.stale_code", old_sha: oldSha, new_sha: newSha });
const DIRTY = (ts: string): string =>
  JSON.stringify({ ts, run_id: "DAEMON-1", task_id: "DAEMON", step: "daemon.tree_dirty" });

/** Read one `key=value` field out of the bytes the beat actually PUBLISHES. */
function field(published: string, key: string): string | undefined {
  for (const line of published.split("\n")) {
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1);
  }
  return undefined;
}

test("W1-T494: a stale pinned sha is published where an off-host reader can see it", () => {
  const beat = runBeat({
    ledger: [BOOT("2026-08-14T16:30:00Z", "66538eb"), STALE("2026-08-14T16:35:01Z", "66538eb", "50d039a")],
  });
  assert.match(field(beat.published, "stale_pin_verdict") ?? "", /^STALE:/);
  assert.equal(field(beat.published, "stale_pin_sha"), "66538eb");
  assert.equal(field(beat.published, "stale_pin_new_sha"), "50d039a");
  assert.equal(field(beat.published, "stale_pin_ts"), "2026-08-14T16:35:01Z");
  // The verdict must NAME both shas — a bare "STALE" sends the reader back to the host, which is
  // the very trip this field exists to remove.
  assert.match(field(beat.published, "stale_pin_verdict") ?? "", /66538eb/);
  assert.match(field(beat.published, "stale_pin_verdict") ?? "", /50d039a/);
});

test("W1-T494: a dirty tree is distinguishable from a healthy one in the published beat", () => {
  const dirty = runBeat({
    ledger: [BOOT("2026-08-14T16:30:00Z", "66538eb"), DIRTY("2026-08-14T16:35:01Z")],
  });
  assert.equal(field(dirty.published, "tree_dirty"), "yes");

  const clean = runBeat({ ledger: [BOOT("2026-08-14T16:30:00Z", "66538eb")] });
  assert.equal(field(clean.published, "tree_dirty"), "no");
});

test("W1-T494: the field derives from the ledger the beat already reads rather than adding a network fetch", () => {
  const beat = runBeat({
    ledger: [BOOT("2026-08-14T16:30:00Z", "66538eb"), STALE("2026-08-14T16:35:01Z", "66538eb", "50d039a")],
  });
  // BOTH shas are already in the row, so the distance needs no network call and no git plumbing.
  const sub = beat.calls.map((c) => c.argv[0]);
  assert.equal(sub.includes("fetch"), false, `the beat must not fetch: ${JSON.stringify(beat.calls)}`);
  assert.equal(sub.includes("rev-list"), false, `the beat must not shell rev-list: ${JSON.stringify(beat.calls)}`);
  assert.equal(sub.includes("ls-remote"), false, "the beat must not reach the network for this field");
});

test("W1-T494: a healthy up-to-date host publishes the field without it reading as a fault", () => {
  const beat = runBeat({ ledger: [BOOT("2026-08-14T16:30:00Z", "66538eb")] });
  // PRESENT AND BENIGN. A field that only appears when broken cannot be trusted when absent — the
  // reader could never tell "healthy" from "this beat predates the field".
  assert.equal(field(beat.published, "stale_pin_verdict"), "ok");
  assert.equal(field(beat.published, "stale_pin_sha"), "none");
  assert.equal(field(beat.published, "tree_dirty"), "no");
});

test("W1-T494: an unreadable ledger degrades to unknown, never to a literal that reads as healthy", () => {
  const beat = runBeat({});
  // The law the restart-count and build-sha probes already state, applied here.
  assert.match(field(beat.published, "stale_pin_verdict") ?? "", /^unknown/);
  assert.equal(field(beat.published, "tree_dirty"), "unknown");
});

test("W1-T494: a stale_code row OLDER than the current boot describes a previous incarnation and is not reported as the running pin", () => {
  const beat = runBeat({
    ledger: [STALE("2026-08-14T16:00:00Z", "aaaaaaa", "bbbbbbb"), BOOT("2026-08-14T16:30:00Z", "bbbbbbb")],
  });
  assert.equal(field(beat.published, "stale_pin_verdict"), "ok");
});

test("W1-T494 MUTANT: dropping the stale_code read makes the stale host report ok", () => {
  const beat = runBeat({
    ledger: [BOOT("2026-08-14T16:30:00Z", "66538eb"), STALE("2026-08-14T16:35:01Z", "66538eb", "50d039a")],
    mutate: [`STALE_LINE="$(grep -F '"step":"daemon.stale_code"' "$LEDGER" 2>/dev/null | tail -n 1)"`, `STALE_LINE=""`],
  });
  assert.equal(field(beat.published, "stale_pin_verdict"), "ok", "the guard is load-bearing: without the read a stale host looks healthy");
});

test("W1-T494 MUTANT: dropping the tree_dirty read makes a dirty tree report clean", () => {
  const beat = runBeat({
    ledger: [BOOT("2026-08-14T16:30:00Z", "66538eb"), DIRTY("2026-08-14T16:35:01Z")],
    mutate: [`DIRTY_LINE="$(grep -F '"step":"daemon.tree_dirty"' "$LEDGER" 2>/dev/null | tail -n 1)"`, `DIRTY_LINE=""`],
  });
  assert.equal(field(beat.published, "tree_dirty"), "no", "the guard is load-bearing: without the read a dirty tree looks clean");
});
