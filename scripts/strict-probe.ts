// W1-T98 -- Quality tier 4/4: TS-strict proven ACTIVE by a planted probe.
//
// MASTER-PLAN §5 TIER 2: "TypeScript strict -- VERIFIED ACTIVE, not assumed. A planted probe
// (the neon-drift `_probe(x)` lesson) must FAIL the gate: '0 violations' from a fresh strict
// gate is suspicious until falsified." This file IS that probe: it is deliberately, permanently
// broken under TypeScript strict mode (an implicit-any parameter and an unchecked-nullable
// property access -- two of the checks `strict: true` bundles: `noImplicitAny` and
// `strictNullChecks`). See test/strict-probe.test.ts for the falsifier assertions that drive
// the real `tsc` binary against this file and prove strict mode rejects it while non-strict
// mode accepts it unchanged.
//
// THIS FILE MUST NEVER COMPILE CLEAN, AND MUST NEVER JOIN THE REAL BUILD. tsconfig.json's
// `include` is `["src/**/*.ts", "test/**/*.ts"]` -- `scripts/**` is out of scope, so `npx tsc -p
// tsconfig.json --noEmit` (the `ci` job's typecheck step in .github/workflows/ci.yml) never
// touches this file. It is compiled ONLY by test/strict-probe.test.ts, directly, outside the
// project config.

export function strictProbe(value) {
  // No type annotation on `value` -> implicit `any`. Rejected by `noImplicitAny` (bundled in
  // `strict`), accepted when strict is off.
  const length: number = value.length;
  return length;
}

export function nullProbe(maybe: string | null): number {
  // `maybe` is typed nullable; strict off allows reading `.length` off it anyway. Rejected by
  // `strictNullChecks` (bundled in `strict`), accepted when strict is off.
  return maybe.length;
}
