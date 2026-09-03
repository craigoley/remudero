import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  claimRepair,
  gitRepairClaimReserver,
  repairClaimRef,
  type RepairClaim,
  type RepairClaimReserver,
} from "../src/lib/dispatch-claim.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "remudero-test",
  GIT_AUTHOR_EMAIL: "test@remudero.invalid",
  GIT_COMMITTER_NAME: "remudero-test",
  GIT_COMMITTER_EMAIL: "test@remudero.invalid",
};

function fakeRemote(): { refs: Map<string, RepairClaim>; reserver: RepairClaimReserver } {
  const refs = new Map<string, RepairClaim>();
  const minted = new Map<string, Omit<RepairClaim, "anchor">>();
  let serial = 0;
  return {
    refs,
    reserver: {
      mintAnchor(input) {
        const anchor = (++serial).toString(16).padStart(40, "0");
        minted.set(anchor, input);
        return anchor;
      },
      attempt(prNumber, anchor) {
        const ref = repairClaimRef(prNumber);
        if (refs.has(ref)) return "taken";
        refs.set(ref, { ...minted.get(anchor)!, anchor });
        return "created";
      },
      read(prNumber) {
        const claim = refs.get(repairClaimRef(prNumber));
        return claim ? { state: "present", claim } : { state: "absent" };
      },
      replace(prNumber, anchor, expectedAnchor) {
        const ref = repairClaimRef(prNumber);
        if (refs.get(ref)?.anchor !== expectedAnchor) return "lost";
        refs.set(ref, { ...minted.get(anchor)!, anchor });
        return "replaced";
      },
      drop(prNumber, expectedAnchor) {
        const ref = repairClaimRef(prNumber);
        if (refs.get(ref)?.anchor !== expectedAnchor) return false;
        return refs.delete(ref);
      },
    },
  };
}

test("W1-T2677: two claimants cannot both hold one active PR repair, and contention names holder plus age", () => {
  const remote = fakeRemote();
  const first = claimRepair(remote.reserver, { prNumber: 3743, holder: "daemon@azure", nowMs: 1_000, ttlMs: 60_000 });
  const second = claimRepair(remote.reserver, { prNumber: 3743, holder: "codex@operator", nowMs: 11_000, ttlMs: 60_000 });

  assert.equal(first.claimed, true);
  assert.equal(first.outcome, "created");
  assert.equal(second.claimed, false);
  assert.equal(second.outcome, "taken");
  assert.equal(second.holder, "daemon@azure");
  assert.equal(second.ageMs, 10_000);
  assert.match(second.reason, /daemon@azure/);
  assert.match(second.reason, /10000ms/);
  assert.equal(remote.refs.get(repairClaimRef(3743))?.holder, "daemon@azure", "the loser never steals the live claim");
});

test("W1-T2677: an expired repair claim is reclaimed with CAS, while a losing reclaimer stands down", () => {
  const remote = fakeRemote();
  const first = claimRepair(remote.reserver, { prNumber: 88, holder: "dead-worker", nowMs: 5_000, ttlMs: 30_000 });
  assert.equal(first.claimed, true);

  const staleAnchor = first.anchor!;
  const reclaimed = claimRepair(remote.reserver, { prNumber: 88, holder: "replacement", nowMs: 35_001, ttlMs: 30_000 });
  assert.equal(reclaimed.claimed, true);
  assert.equal(reclaimed.outcome, "reclaimed");
  assert.equal(reclaimed.previousHolder, "dead-worker");
  assert.equal(reclaimed.ageMs, 30_001);
  assert.equal(remote.refs.get(repairClaimRef(88))?.holder, "replacement");
  assert.equal(remote.reserver.drop(88, staleAnchor), false, "the old holder cannot delete the replacement's claim");

  const loser = claimRepair(remote.reserver, { prNumber: 88, holder: "late-third", nowMs: 35_002, ttlMs: 30_000 });
  assert.equal(loser.claimed, false);
  assert.equal(loser.holder, "replacement");
});

test("W1-T2677: unreadable or malformed claim evidence fails closed rather than inventing expiry", () => {
  const base = fakeRemote();
  const unreachable: RepairClaimReserver = { ...base.reserver, read: () => ({ state: "unreachable", reason: "network down" }) };
  claimRepair(base.reserver, { prNumber: 99, holder: "first", nowMs: 0, ttlMs: 1 });
  const unreadable = claimRepair(unreachable, { prNumber: 99, holder: "second", nowMs: 999_999, ttlMs: 1 });
  assert.equal(unreadable.claimed, false);
  assert.equal(unreadable.outcome, "unreachable");
  assert.match(unreadable.reason, /network down/);

  const malformed: RepairClaimReserver = {
    ...base.reserver,
    read: () => ({
      state: "present",
      claim: { anchor: "a".repeat(40), prNumber: 99, holder: "unknown", claimedAtIso: "not-a-date" },
    }),
  };
  const refused = claimRepair(malformed, { prNumber: 99, holder: "second", nowMs: 999_999, ttlMs: 1 });
  assert.equal(refused.claimed, false);
  assert.equal(refused.outcome, "unreadable");
  assert.match(refused.reason, /invalid timestamp/);
});

test("W1-T2677 real Git: any checkout can claim, an active peer observes it, expiry is reclaimable, and normal pushes remain independent", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-repair-claim-"));
  const bare = join(root, "remote.git");
  const firstDir = join(root, "first");
  const secondDir = join(root, "second");
  try {
    execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { env: GIT_ENV });
    execFileSync("git", ["init", "--quiet", "-b", "main", firstDir], { env: GIT_ENV });
    writeFileSync(join(firstDir, "seed.txt"), "seed\n");
    execFileSync("git", ["-C", firstDir, "add", "seed.txt"], { env: GIT_ENV });
    execFileSync("git", ["-C", firstDir, "commit", "--quiet", "-m", "chore: seed"], { env: GIT_ENV });
    execFileSync("git", ["-C", firstDir, "remote", "add", "origin", bare], { env: GIT_ENV });
    execFileSync("git", ["-C", firstDir, "push", "--quiet", "-u", "origin", "main"], { env: GIT_ENV });
    execFileSync("git", ["clone", "--quiet", bare, secondDir], { env: GIT_ENV });

    const factory = (dir: string): RepairClaimReserver =>
      gitRepairClaimReserver({
        run(args) {
          const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
          return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
        },
      });

    const first = claimRepair(factory(firstDir), { prNumber: 3743, holder: "outside-rmd", nowMs: 10_000, ttlMs: 60_000 });
    assert.equal(first.claimed, true, first.reason);
    const activePeer = claimRepair(factory(secondDir), { prNumber: 3743, holder: "fleet-fix", nowMs: 20_000, ttlMs: 60_000 });
    assert.equal(activePeer.claimed, false);
    assert.equal(activePeer.holder, "outside-rmd", "the second checkout reads metadata from the remote anchor");
    assert.equal(activePeer.ageMs, 10_000);

    writeFileSync(join(secondDir, "ordinary.txt"), "ordinary branch work\n");
    execFileSync("git", ["-C", secondDir, "add", "ordinary.txt"], { env: GIT_ENV });
    execFileSync("git", ["-C", secondDir, "commit", "--quiet", "-m", "fix: ordinary branch push"], { env: GIT_ENV });
    execFileSync("git", ["-C", secondDir, "push", "--quiet", "origin", "HEAD:refs/heads/ordinary"], { env: GIT_ENV });

    const replacement = claimRepair(factory(secondDir), { prNumber: 3743, holder: "fleet-fix", nowMs: 70_001, ttlMs: 60_000 });
    assert.equal(replacement.claimed, true, replacement.reason);
    assert.equal(replacement.outcome, "reclaimed");
    assert.equal(replacement.previousHolder, "outside-rmd");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
