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

/** One answer a live head read gives after update-branch was accepted, in place of the true head: `{ stale }` is a
 *  lagging replica still naming an older head, `"unreadable"` an ok:false read, an `Error` a read that throws. */
export type FakePullHeadRead = { stale: string } | "unreadable" | Error;

export interface FakePullRequestOptions {
  /** The PR's head when the fake is built; its own parent list is `headParents` (default: one unnamed parent). */
  head: string;
  headParents?: readonly string[];
  /** What `PUT pulls/{n}/update-branch` does once accepted: GitHub writes the merge commit `merge` (parents: the head
   *  it was accepted for, then `mainTip`) `lagMs` of simulated time later — and drops it if the head moved first. */
  update: { merge: string; mainTip: string; lagMs: number };
  /** Answers the first live reads after the update was accepted give, before reads name the true head again. */
  readsAfterUpdate?: readonly FakePullHeadRead[];
}

/** W1-T15162 — ONE PULL REQUEST'S HEAD AS GITHUB'S REST API ANSWERS IT, OVER SIMULATED TIME. Update-branch is
 *  asynchronous: it is accepted at once and its merge commit lands later. `wait` is the only clock, so a test drives the
 *  poll's backoff without a real timer. `push` lands someone else's commit (an author, a fix round) at a simulated time.
 *  Every method records to `.calls`, like {@link fakeGitHub}. */
export interface FakePullRequest {
  readonly calls: FakeGitHubCall[];
  /** The true current head (no replica lag), for the test's own assertions. */
  head(): string;
  /** Simulated ms elapsed since the fake was built. */
  now(): number;
  updateBranch(expectedHead: string): "updated" | "head-moved";
  push(sha: string, parents: readonly string[], afterMs?: number): void;
  readLiveState(): { ok: boolean; state?: string; headSha?: string };
  /** `GET git/commits/{sha}`'s parent list; `undefined` for a commit GitHub does not have. */
  readCommitParents(sha: string): readonly string[] | undefined;
  wait(ms: number): Promise<void>;
}

export function fakeGitHubPullRequest(options: FakePullRequestOptions): FakePullRequest {
  const calls: FakeGitHubCall[] = [];
  const parents = new Map<string, readonly string[]>([[options.head, options.headParents ?? [`${options.head}^`]]]);
  let head = options.head;
  let clock = 0;
  let updated = false;
  const afterUpdate = [...(options.readsAfterUpdate ?? [])];
  const events: Array<{ at: number; apply: () => void }> = [];
  const settle = (): void => {
    events.sort((a, b) => a.at - b.at);
    while (events.length > 0 && events[0]!.at <= clock) events.shift()!.apply();
  };
  const land = (sha: string, commitParents: readonly string[]): void => {
    parents.set(sha, commitParents);
    head = sha;
  };
  const pr = {
    head: () => head,
    now: () => clock,
    updateBranch: (expectedHead: string) => {
      settle();
      if (expectedHead !== head) return "head-moved" as const;
      updated = true;
      const { merge, mainTip, lagMs } = options.update;
      events.push({ at: clock + lagMs, apply: () => { if (head === expectedHead) land(merge, [expectedHead, mainTip]); } });
      settle();
      return "updated" as const;
    },
    push: (sha: string, commitParents: readonly string[], afterMs = 0) => {
      events.push({ at: clock + afterMs, apply: () => land(sha, commitParents) });
      settle();
    },
    readLiveState: () => {
      settle();
      const answer = updated ? afterUpdate.shift() : undefined;
      if (answer instanceof Error) throw answer;
      if (answer === "unreadable") return { ok: false };
      return { ok: true, state: "OPEN", headSha: answer === undefined ? head : answer.stale };
    },
    readCommitParents: (sha: string) => parents.get(sha),
    wait: async (ms: number) => {
      clock += ms;
      settle();
    },
  };
  // Recorded on entry, not on return, so a read that throws is still a read the caller made.
  const recorded: Record<string, unknown> = {};
  for (const [method, fn] of Object.entries(pr as unknown as Record<string, AnyFn>)) {
    recorded[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return fn(...args);
    };
  }
  return { ...recorded, calls } as unknown as FakePullRequest;
}
