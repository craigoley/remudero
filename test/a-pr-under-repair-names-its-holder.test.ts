import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readLedgerLines } from "../src/lib/status.js";
import {
  currentRepairLeaseHolder,
  postRepairLease,
  repairLeaseAllowsPush,
  type RepairLeaseRecord,
} from "../src/lib/review.js";

/**
 * W1-T3646: two lanes independently repairing the same PR could not see each other, so both
 * rediscovered one defect and wrote the same remedy twice (#5684, #5673, #5697/#5698,
 * #5699/#5704). This mirrors the reviewer's own `remudero-review: review in progress (owned by
 * run ...)` lock shape for the REPAIR half of a PR's lifecycle, as an advisory LEASE keyed to the
 * head sha it was taken against — never a mutex, never a gate.
 */

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-repair-lease-"));
}

test("W1-T3646 criterion 1: a repair lease names its holder on the head sha", async () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const posts: Array<{ owner: string; repo: string; sha: string; description?: string }> = [];

    const first = await postRepairLease({
      owner: "o",
      repo: "r",
      sha: "deadbee",
      taskId: "W1-T3646",
      runId: "run-lane-a",
      ledgerPath,
      post: (o) => {
        posts.push(o);
      },
    });
    assert.equal(first.posted, true);
    assert.equal(posts.length, 1, "exactly one status post for the first lane to claim this sha");
    assert.match(posts[0].description ?? "", /run-lane-a/, "the posted description must name the holder");

    const lines = readLedgerLines(ledgerPath);
    const leaseLine = lines.find((l) => l.step === "repair.lease_posted");
    assert.ok(leaseLine, "a successful lease post must be ledgered");
    assert.equal(leaseLine?.head_sha, "deadbee");
    assert.equal(leaseLine?.run_id, "run-lane-a");

    // A SECOND lane, reading the same PR, must be able to see the first lane's claim.
    const holder = currentRepairLeaseHolder(lines, "W1-T3646", "deadbee");
    assert.deepEqual(holder, { headSha: "deadbee", runId: "run-lane-a", postedAt: leaseLine?.ts });

    // The second lane attempting to take the lease itself observes the existing holder rather
    // than posting a second, competing claim.
    const second = await postRepairLease({
      owner: "o",
      repo: "r",
      sha: "deadbee",
      taskId: "W1-T3646",
      runId: "run-lane-b",
      ledgerPath,
      post: (o) => {
        posts.push(o);
      },
    });
    assert.equal(second.posted, false);
    assert.equal(posts.length, 1, "the second lane must not post a competing status");
    assert.equal(second.holder?.runId, "run-lane-a");
    assert.match(second.reason ?? "", /run-lane-a/, "the second lane's result must name the actual holder");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3646 criterion 2: a held repair lease does not refuse a push", async () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    await postRepairLease({
      owner: "o",
      repo: "r",
      sha: "cafef00d",
      taskId: "W1-T3646",
      runId: "run-lane-a",
      ledgerPath,
      post: () => {},
    });
    const lines = readLedgerLines(ledgerPath);
    const held = currentRepairLeaseHolder(lines, "W1-T3646", "cafef00d");
    assert.ok(held, "the lease must actually be held for this to be a meaningful check");

    // The world WITH a held holder and the world with NONE must answer identically: the lease is
    // advisory information for a lane deciding what to pick up next, never a permission check on
    // pushing (W1-T3646 design). A mutex-shaped implementation would answer differently here.
    assert.equal(repairLeaseAllowsPush(held), true);
    assert.equal(repairLeaseAllowsPush(undefined), true);

    // A second lane must be free to post its own repair-related ledger activity — e.g. record
    // that it pushed a fix — without postRepairLease throwing, timing out, or otherwise refusing
    // to let it proceed; it only reports the claim, never withholds anything from the caller.
    let threw = false;
    let secondResult: { posted: boolean } | undefined;
    try {
      secondResult = await postRepairLease({
        owner: "o",
        repo: "r",
        sha: "cafef00d",
        taskId: "W1-T3646",
        runId: "run-lane-b",
        ledgerPath,
        post: () => {},
      });
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "a held lease must never throw for a second lane");
    assert.equal(secondResult?.posted, false, "informational only — never an error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3646 criterion 3: a lease on a stale sha does not hold the new head", async () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    await postRepairLease({
      owner: "o",
      repo: "r",
      sha: "oldsha1",
      taskId: "W1-T3646",
      runId: "run-lane-a",
      ledgerPath,
      post: () => {},
    });
    const linesAfterFirst = readLedgerLines(ledgerPath);
    const holderOnOldSha = currentRepairLeaseHolder(linesAfterFirst, "W1-T3646", "oldsha1");
    assert.ok(holderOnOldSha, "the lease must actually hold its own sha");

    // A pushed fix moves the head sha; the OLD lease must not follow it.
    const holderOnNewSha = currentRepairLeaseHolder(linesAfterFirst, "W1-T3646", "newsha2");
    assert.equal(holderOnNewSha, undefined, "a lease taken against an older sha must not hold a new head");

    // A second lane finding no holder on the new head is free to take its own lease there.
    const second = await postRepairLease({
      owner: "o",
      repo: "r",
      sha: "newsha2",
      taskId: "W1-T3646",
      runId: "run-lane-b",
      ledgerPath,
      post: () => {},
    });
    assert.equal(second.posted, true, "the new head is unclaimed, so the second lane's post must succeed");
    const linesAfterSecond = readLedgerLines(ledgerPath);
    const holderOnNewShaAfter: RepairLeaseRecord | undefined = currentRepairLeaseHolder(
      linesAfterSecond,
      "W1-T3646",
      "newsha2",
    );
    assert.equal(holderOnNewShaAfter?.runId, "run-lane-b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the real (uninjected) `defaultPostRepairLeaseStatus` wrapper ───────────
// Every test above supplies its own `post` stub, so `postRepairLease`'s real default
// (`defaultPostRepairLeaseStatus`, which builds the `gh api` args and calls the shared
// `execGhStatusPost`) never ran behind them. PATH-stubbed exactly like
// review-status-gate.test.ts's `execGhStatusPost` coverage probes, so this one real
// invocation earns its own DA: hits instead of staying diff-coverage dead code.

test("postRepairLease: with no injected `post`, the real default wrapper posts through a PATH-stubbed gh", async () => {
  const dir = tmpDir();
  const bin = mkdtempSync(join(tmpdir(), "gh-repair-lease-stub-ok-"));
  const oldPath = process.env.PATH;
  try {
    writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.PATH = `${bin}:${oldPath}`;
    const ledgerPath = join(dir, "ledger.ndjson");

    const result = await postRepairLease({
      owner: "o",
      repo: "r",
      sha: "realpost1",
      taskId: "W1-T3646",
      runId: "run-real-gh",
      ledgerPath,
    });

    assert.equal(result.posted, true);
    const lines = readLedgerLines(ledgerPath);
    const leaseLine = lines.find((l) => l.step === "repair.lease_posted");
    assert.ok(leaseLine, "the real wrapper's success path must still ledger the lease");
    assert.equal(leaseLine?.head_sha, "realpost1");
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("postRepairLease: a failing gh stub is swallowed by the real default wrapper — the courtesy post never blocks the repair it narrates", async () => {
  const dir = tmpDir();
  const bin = mkdtempSync(join(tmpdir(), "gh-repair-lease-stub-fail-"));
  const oldPath = process.env.PATH;
  try {
    writeFileSync(join(bin, "gh"), '#!/bin/sh\necho "gh: Service Unavailable (HTTP 503)" >&2\nexit 1\n', {
      mode: 0o755,
    });
    process.env.PATH = `${bin}:${oldPath}`;
    const ledgerPath = join(dir, "ledger.ndjson");

    let threw = false;
    let result: { posted: boolean } | undefined;
    try {
      result = await postRepairLease({
        owner: "o",
        repo: "r",
        sha: "realpost2",
        taskId: "W1-T3646",
        runId: "run-real-gh-fail",
        ledgerPath,
      });
    } catch {
      threw = true;
    }

    assert.equal(threw, false, "a failing real gh post must never throw out of postRepairLease");
    assert.equal(result?.posted, true, "the ledger write and result still happen after the courtesy post fails");
    const lines = readLedgerLines(ledgerPath);
    const leaseLine = lines.find((l) => l.step === "repair.lease_posted");
    assert.ok(leaseLine, "the lease is still ledgered even though the real status post failed");
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
