// src/lib/ci-failure-corpus.ts — W1-T2957.
//
// THE ONE FAILURE CORPUS THAT ARRIVES WITH ITS OWN FIX, retained instead of discarded.
//
// A red gate is the richest failure signal this repo produces: objective, dated, attributable, and
// uniquely accompanied by its own repair — the later commit on the SAME pull request that turns
// that SAME gate green. `fetchCiFailures` (run-task.ts) already reads red checks, per pull request
// and at fix time, to repair that one pull request; nothing keeps the pair.
//
// WHY THE ABSENCE MATTERS, MEASURED. `RULE_SIGNATURES` (`./rule-efficacy.js`) decides whether one of
// this repo's own rules is WORKING, and it matches `step` patterns against the LEDGER union. At
// filing it held 3 entries, 1 of them `measurable: true`, against 56 rule bullets in CLAUDE.md —
// and the one entry naming a CI gate, `diff-coverage-gate`, is `measurable: false`. That is not an
// oversight: `rule-efficacy.ts`'s own header states "HOST-SIDE, NOT A CI GATE: the ledger lives on
// the daemon host; nothing in CI can read it." A rule about a gate can never become measurable from
// a ledger row, because its failures are not ledger rows. This module supplies the missing corpus.
//
// PURE BY CONSTRUCTION, WHICH IS BOTH A TESTABILITY CHOICE AND LAW 5. It takes rollups already read
// and returns records; it opens no socket, writes no file, mints no id and files nothing. Law 5 is
// "records launder authority unless the author class rides the record" — a function that only
// returns data cannot launder anything, and the fetching lives at the call site where the existing
// pacing and gateway already are.

import { REQUIRED_CHECK_FAIL, REQUIRED_CHECK_OK, dedupeRollupByLatestAttempt, type RollupCheckEntry } from "./sweep.js";
import { checkRunsRestArgs, combinedStatusRestArgs, rollupFromRest } from "./open-prs-rest.js";

/** A gate's identity is its check-run NAME or its status CONTEXT — `remudero-review` is the latter,
 *  and a reader that knows only the former is blind to it (see {@link CorpusCommit.rollup}). */
function gateName(entry: RollupCheckEntry): string {
  return entry.name ?? entry.context ?? "";
}

/** The one state field a rollup entry actually carries, whichever shape it came from. */
function gateState(entry: RollupCheckEntry): string {
  return (entry.state ?? entry.conclusion ?? entry.status ?? "").toUpperCase();
}

/** One commit on a pull request, with the gate rollup read AT that sha. */
export interface CorpusCommit {
  sha: string;
  /**
   * The union of check runs and commit STATUSES at this sha — build it with `rollupFromRest`
   * (`./open-prs-rest.js`), never from `/check-runs` alone: that endpoint cannot see
   * `remudero-review`, and `rollupFromRest`'s own doc says reading only it "would drop
   * `remudero-review` entirely and make every reviewed PR look unreviewed".
   *
   * `undefined` means the rollup could NOT be read — never an empty rollup. The distinction is the
   * whole reason {@link CiFailureCorpus.status} has an `"unreadable"` member.
   */
  rollup?: RollupCheckEntry[];
  /** What this commit changed. When it turns a gate green this is the repair delta — the lesson. */
  changedFiles?: string[];
}

/** One pull request's commits, OLDEST FIRST: pairing walks forward in time and nothing else orders it. */
export interface CorpusPr {
  number: number;
  commits: CorpusCommit[];
}

export interface CiFailureCorpusInput {
  prs: CorpusPr[];
}

/** `"repaired"` — a later commit on the same pull request turned this same gate green.
 *  `"open"` — no repair was OBSERVED. Never "no repair exists": the window may simply end first. */
export type CiFailurePairState = "repaired" | "open";

/** A red gate and, when one was observed, the commit that repaired it. The PAIR is the unit: a bare
 *  failure count teaches nothing, because the lesson is in the delta. */
export interface CiFailurePair {
  pr: number;
  gate: string;
  redSha: string;
  greenSha?: string;
  repairFiles?: string[];
  state: CiFailurePairState;
}

/** `"clear"` — every rollup was read and no gate was red. `"unreadable"` — nothing was found AND at
 *  least one rollup could not be read, so the window was never actually seen. `"populated"` — at
 *  least one pair. A measured absence, never a bare zero (P48's no-naked-zero clause). */
export type CiFailureCorpusStatus = "clear" | "populated" | "unreadable";

export interface CiFailureCorpus {
  status: CiFailureCorpusStatus;
  prsScanned: number;
  /** Every sha whose rollup could not be read, NAMED rather than silently treated as green. */
  unreadableShas: string[];
  pairs: CiFailurePair[];
}

/**
 * Walk each pull request's commits oldest-first and pair every red gate with the later commit that
 * turned that same gate green.
 *
 * SCOPED TO ONE PULL REQUEST AND FORWARD IN TIME, both deliberately. A green on ANOTHER pull request
 * says nothing about this failure, and a green at an EARLIER sha preceded it — pairing either way
 * manufactures a repair that never happened, and this corpus exists to be learned from.
 *
 * DEDUPED PER SHA BEFORE JUDGING. A sha accumulates one rollup entry PER ATTEMPT, so a superseded
 * CANCELLED entry reads red forever beside its own SUCCESS successor — W1-T457 measured exactly that
 * pair 80 seconds apart, and W1-T2804 is the live shard about a third reader that still lacks this.
 * {@link dedupeRollupByLatestAttempt} is reused rather than re-derived so this reader cannot drift
 * from the two that already have it.
 */
export function collectCiFailureCorpus(input: CiFailureCorpusInput): CiFailureCorpus {
  const pairs: CiFailurePair[] = [];
  const unreadableShas: string[] = [];

  for (const pr of input.prs) {
    // Gate -> the pair still awaiting a repair on THIS pull request. Cleared when one is observed,
    // so a gate that reddens, is fixed, and reddens again yields two pairs rather than one.
    const openByGate = new Map<string, CiFailurePair>();
    for (const commit of pr.commits) {
      if (commit.rollup === undefined) {
        unreadableShas.push(commit.sha);
        continue; // NEVER read as green: an unread gate is not a passing one.
      }
      for (const entry of dedupeRollupByLatestAttempt(commit.rollup)) {
        const gate = gateName(entry);
        if (!gate) continue;
        const state = gateState(entry);
        if (REQUIRED_CHECK_FAIL.has(state)) {
          if (openByGate.has(gate)) continue; // already tracking this gate's red on this PR
          const pair: CiFailurePair = { pr: pr.number, gate, redSha: commit.sha, state: "open" };
          openByGate.set(gate, pair);
          pairs.push(pair);
        } else if (REQUIRED_CHECK_OK.has(state)) {
          const open = openByGate.get(gate);
          if (!open) continue; // a green with no earlier red on this PR repairs nothing
          open.state = "repaired";
          open.greenSha = commit.sha;
          if (commit.changedFiles) open.repairFiles = commit.changedFiles;
          openByGate.delete(gate);
        }
      }
    }
  }

  const status: CiFailureCorpusStatus =
    pairs.length > 0 ? "populated" : unreadableShas.length > 0 ? "unreadable" : "clear";
  return { status, prsScanned: input.prs.length, unreadableShas, pairs };
}

/** Read one gate rollup at `sha`, as the two endpoints that together see every gate. `undefined`
 *  when either read fails — never a partial rollup, which would read as "these gates were green".
 *  The fetcher is INJECTED: this module opens no socket and the caller owns pacing. */
export function rollupAtSha(
  owner: string,
  repo: string,
  sha: string,
  fetch: (args: string[]) => unknown,
): RollupCheckEntry[] | undefined {
  try {
    const runs = fetch(checkRunsRestArgs(owner, repo, sha)) as { check_runs?: unknown[] } | undefined;
    const combined = fetch(combinedStatusRestArgs(owner, repo, sha)) as { statuses?: unknown[] } | undefined;
    if (!runs || !combined) return undefined;
    return rollupFromRest(
      (runs.check_runs ?? []) as Parameters<typeof rollupFromRest>[0],
      (combined.statuses ?? []) as Parameters<typeof rollupFromRest>[1],
    );
  } catch {
    // A failed read is UNREADABLE, never green — the distinction `CiFailureCorpus.status` exists for.
    return undefined;
  }
}
