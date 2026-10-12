/**
 * THE HEAD A FIX ROUND GUARDS IS THE ONE ITS WORKER BUILT ON, not the sweep's earlier snapshot.
 *
 * #10470 (2026-10-09): the sweep disposed the PR at `efe7d8f`, a fleet update-branch merged main
 * into it (`9c0d621`) seconds later, and the round's worktree was synced to `9c0d621`. The worker's
 * FIXED edit was refused "branch moved during fix round: expected efe7d8f, observed 9c0d621" — the
 * guard compared the live branch to the stale snapshot, so a correct fix was thrown away.
 *
 * When the branch tip the round started from DESCENDS from the snapshot (a merge-forward such as an
 * update-branch), the round guards and leases that tip instead. Anything else — an unreadable tip,
 * or a tip that rewrote the snapshot's history — keeps the snapshot, so the existing refusal still
 * protects a commit this round never saw.
 */
export interface FixRoundBaseInput {
  snapshotHeadSha: string;
  startedFromSha: string | undefined;
  isAncestor: (ancestor: string, descendant: string) => boolean;
}

export interface FixRoundBase {
  baseSha: string;
  advanced: boolean;
  reason: string;
}

export function fixRoundBaseHead(input: FixRoundBaseInput): FixRoundBase {
  const { snapshotHeadSha, startedFromSha } = input;
  if (startedFromSha === undefined || startedFromSha === "") {
    return { baseSha: snapshotHeadSha, advanced: false, reason: "the round's starting tip was unreadable" };
  }
  if (startedFromSha === snapshotHeadSha) {
    return { baseSha: snapshotHeadSha, advanced: false, reason: "the round started at the snapshot head" };
  }
  let descends: boolean;
  try {
    descends = input.isAncestor(snapshotHeadSha, startedFromSha);
  } catch (error) {
    return { baseSha: snapshotHeadSha, advanced: false, reason: `ancestry unreadable: ${String(error)}` };
  }
  if (!descends) {
    return { baseSha: snapshotHeadSha, advanced: false,
      reason: `the round's starting tip ${startedFromSha.slice(0, 7)} does not descend from ${snapshotHeadSha.slice(0, 7)}` };
  }
  return { baseSha: startedFromSha, advanced: true,
    reason: `the branch advanced ${snapshotHeadSha.slice(0, 7)} -> ${startedFromSha.slice(0, 7)} before the worker started` };
}
