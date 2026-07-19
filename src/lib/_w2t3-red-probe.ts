// TEMPORARY — planted regression for the W2-T3 review-gate proof (MASTER-PLAN §3A/§5).
//
// This file exists ONLY to make the refactor-campaign CI check computably WORSE (complexity
// gate: +14, no other gate moves) so the gate-delta formula can be proven CI-red on a REAL run,
// not merely a unit-test fixture — the reviewer judged the fixture-only proof non-responsive to
// the acceptance criterion "a planted refactor that leaves mutation/complexity/dup unchanged or
// worse fails the campaign's delta check in CI — paste the red run, then revert". This file is
// reverted (deleted) in the very next commit on this branch, immediately after the red run's
// evidence is captured.
export function w2t3RedProbe(x: number, y: number): number {
  if (x > 0) {
    if (y > 0) {
      return x + y;
    } else if (y < 0) {
      return x - y;
    }
  } else if (x < 0) {
    for (let i = 0; i < y; i++) {
      if (i % 2 === 0) {
        continue;
      }
    }
  }
  while (x > 100) {
    x -= 1;
  }
  return x && y ? x : y || x;
}
