/**
 * test/helpers/fake-github.ts — W1-T2903: the shared fake `GitHub` gateway.
 *
 * WHY THIS EXISTS. Audit recon-2026-09-05 R-41 counted 70 distinct fake-GitHub builder names
 * across 129 files (`function fakeGitHub(` alone in 41 of them) — nearly all of them the exact
 * same four-method literal:
 *
 *   function fakeGitHub(): GitHub {
 *     return { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined,
 *       prBody: () => undefined };
 *   }
 *
 * `GitHub` (src/lib/status.ts) declares those four as its only REQUIRED members; everything else
 * is optional. Measured 2026-09-08 over the same `test/*.test.ts` population, the three
 * next-most-faked optional members are `reviewState` (80 files), `autoMergeArmed` (76) and
 * `readFailed` (44) — an order of magnitude ahead of the rest of the interface. Together with the
 * four required members that is SEVEN domain-gateway methods answered by default, so a caller
 * overriding just one of the three optional ones does not also have to remember to restate the
 * four required ones.
 *
 * "A recording gateway" — the shape review tests need (asserting WHICH ref a status derivation
 * actually read) and daemon tests need (asserting a credit read happened exactly once, not per
 * poll). Recording is uniform: EVERY method on the returned object — the seven defaults above,
 * and any additional optional `GitHub` member a caller passes in `overrides` — is wrapped to push
 * onto `.calls` before returning, so overriding a method never silently opts it out of being
 * recorded.
 */
import type { GitHub } from "../../src/lib/status.js";

/** One recorded invocation: the method name and the exact arguments it was called with. */
export interface FakeGitHubCall {
  method: string;
  args: unknown[];
}

export interface FakeGitHub extends GitHub {
  /** Every call this gateway received, in call order — the recording half of "a recording
   *  gateway". Mutated in place, so a reference taken before a call still sees it. */
  readonly calls: FakeGitHubCall[];
}

type AnyFn = (...args: unknown[]) => unknown;

function recordingProxyOf<T extends Record<string, unknown>>(target: T, calls: FakeGitHubCall[]): T {
  const wrapped: Record<string, unknown> = {};
  for (const key of Object.keys(target)) {
    const value = target[key];
    if (typeof value === "function") {
      const fn = value as AnyFn;
      wrapped[key] = (...args: unknown[]) => {
        const result = fn(...args);
        calls.push({ method: key, args });
        return result;
      };
    } else {
      wrapped[key] = value;
    }
  }
  return wrapped as T;
}

/**
 * Build a fake `GitHub` gateway. The seven domain-gateway methods described in the module doc
 * answer with harmless defaults (no PR/ref ever resolves, no read ever "fails"); pass `overrides`
 * to replace any of those — or add any OTHER optional `GitHub` member (`changedFiles`, `warm`,
 * `issueByUrl`, …) — with a custom answer. Every method on the final object records to `.calls`
 * regardless of whether it came from the default table or from `overrides`.
 */
export function fakeGitHub(overrides: Partial<GitHub> = {}): FakeGitHub {
  const calls: FakeGitHubCall[] = [];
  const defaults: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    reviewState: () => "none",
    autoMergeArmed: () => false,
    readFailed: () => false,
  };
  const merged = { ...defaults, ...overrides } as Record<string, unknown>;
  const recorded = recordingProxyOf(merged, calls);
  return { ...recorded, calls } as FakeGitHub;
}
