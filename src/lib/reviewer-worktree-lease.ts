import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { systemClock } from "./clock.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { createOrReadPublished, isHolderStale, reclaimStaleLock } from "./fs-race-safe.js";

interface ReviewerLease {
  version: "reviewer-worktree-lease-v1";
  pid: number;
  host: string;
  startedAt: string;
  run_id: string;
}

const borrowers = new Map<string, { owner: ReviewerLease; raw: string; count: number }>();

function staleLease(owner: ReviewerLease): boolean {
  return isHolderStale(owner, { isPidAlive: defaultIsPidAlive });
}

function parseLease(raw: string): ReviewerLease {
  const value = JSON.parse(raw) as ReviewerLease;
  if (value?.version !== "reviewer-worktree-lease-v1" || !Number.isInteger(value.pid) || value.pid <= 0
    || typeof value.host !== "string" || !value.host || typeof value.run_id !== "string" || !value.run_id
    || typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt)))
    throw new Error("reviewer worktree has an unknown or corrupt lease; preserving it");
  return value;
}

function assertDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("reviewer worktree is not a real directory");
}

function claim(path: string): { owner: ReviewerLease; raw: string; count: number } {
  const lock = `${path}.lock`;
  const owner: ReviewerLease = { version: "reviewer-worktree-lease-v1", pid: process.pid,
    host: hostname(), startedAt: systemClock.iso(), run_id: `reviewer-${randomUUID()}` };
  const raw = JSON.stringify(owner);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const stat = lstatSync(lock);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("reviewer lease path is not a regular file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const publication = createOrReadPublished(lock, 0o600);
    if (publication.created) {
      try { publication.publish(raw); }
      finally { publication.release(); }
      return { owner, raw, count: 0 };
    }
    const holder = parseLease(publication.raw);
    if (!staleLease(holder)) throw new Error("reviewer worktree is leased by another owner");
    const reclaimed = reclaimStaleLock(lock, { parseHolder: parseLease, isStale: staleLease,
      onReclaim: () => {}, onLostReclaim: () => {} });
    if (reclaimed.outcome === "live") throw new Error("reviewer worktree is leased by another owner");
  }
  throw new Error("reviewer worktree lease acquisition remained contested");
}

/** Keep the existing general reaper's run-lock token alive through every active borrow. */
export async function withReviewerWorktreeLease<T>(worktree: string, action: () => Promise<T>): Promise<T> {
  const path = resolve(worktree);
  assertDirectory(path);
  let held = borrowers.get(path);
  if (held === undefined) {
    held = claim(path);
    borrowers.set(path, held);
  } else if (readFileSync(`${path}.lock`, "utf8") !== held.raw) {
    throw new Error("reviewer worktree lease changed during an active borrow");
  }
  held.count++;
  let outcome: { kind: "passed"; value: T } | { kind: "failed"; error: unknown };
  try { outcome = { kind: "passed", value: await action() }; }
  catch (error) { outcome = { kind: "failed", error }; }
  let releaseFailure: { error: unknown } | undefined;
  try {
    assertDirectory(path);
    if (readFileSync(`${path}.lock`, "utf8") !== held.raw)
      throw new Error("reviewer worktree lease changed before release");
  } catch (error) { releaseFailure = { error: error }; }
  held.count--;
  if (held.count === 0) {
    borrowers.delete(path);
    try {
      const released = reclaimStaleLock(`${path}.lock`, { parseHolder: parseLease,
        isStale: (owner) => owner.run_id === held.owner.run_id && owner.pid === held.owner.pid,
        onReclaim: () => {}, onLostReclaim: () => {} });
      if (released.outcome !== "reclaimed") throw new Error("reviewer lease release did not remove its own claim");
    } catch (error) { releaseFailure ??= { error: error }; }
  }
  if (outcome.kind === "failed" && releaseFailure !== undefined)
    throw new AggregateError([outcome.error, releaseFailure.error], "review and lease release failed");
  if (outcome.kind === "failed") throw outcome.error;
  if (releaseFailure !== undefined) throw releaseFailure.error;
  return outcome.value;
}
