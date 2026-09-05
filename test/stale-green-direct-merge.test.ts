// W1-T2855 — a required-check success on an old base is not authority to merge after main moves.
// Every direct REST merge fallback must first prove, from fresh REST facts, that the PR is
// definitely MERGEABLE and zero commits behind. A behind head is updated once and left for the
// normal GitHub-event review cycle; unreadable or inconsistent facts fail closed.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import {
  armAndLogOutcome,
  armAutoMergeAtOpen,
  armAutoMergeDetailed,
  attemptArm,
  realArmDeps,
  type FixRebaseMergeFacts,
} from "../src/run-task.js";

const PR = "https://github.com/craigoley/remudero/pull/3997";
const HEAD = "8c2cd65e7f1069262ad17bb8d50ccb39a8c365ba";
const CLEAN = "Pull request is in clean status";
const RATE_LIMIT = "GraphQL: API rate limit already exceeded for user ID 4397075.";
const HTTP_405 = "HTTP 405: Pull Request is not mergeable";

const throwing = (msg: string) => () => {
  throw Object.assign(new Error("boom"), { stderr: msg });
};

type AttemptDeps = Parameters<typeof attemptArm>[1];
type PreflightEvidence = {
  priorHeadSha?: string;
  behindBy?: number;
  mergeable?: string;
  remedy?: string;
  error?: string;
};

function evidence(result: unknown): PreflightEvidence | undefined {
  return (result as { directMergePreflight?: PreflightEvidence }).directMergePreflight;
}

function harness(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const said: string[] = [];
  const base = {
    headSha: () => HEAD,
    armAuto: throwing(CLEAN),
    mergeDirect: () => void calls.push("mergeDirect"),
    readMergeFacts: () => ({ mergeable: "MERGEABLE", behindBy: 0 } as FixRebaseMergeFacts),
    updateBranch: () => {
      calls.push("updateBranch");
      return { ok: true };
    },
    say: (message: string) => void said.push(message),
  };
  // `updateBranch` is the new optional seam under test. Keep this cast so the red test compiles
  // against the pre-fix interface and fails on behavior rather than on a type declaration alone.
  return { deps: { ...base, ...over } as unknown as AttemptDeps, calls, said };
}

test("clean-status stale green: a behind head is updated once and never directly merged", () => {
  const { deps, calls } = harness({
    readMergeFacts: () => ({ mergeable: "MERGEABLE", behindBy: 2 }),
  });

  const result = attemptArm(PR, deps, HEAD);

  assert.equal(String(result.outcome), "direct-merge-updated");
  assert.deepEqual(calls, ["updateBranch"], "the stale head is updated exactly once; mergeDirect is never reached");
  assert.deepEqual(evidence(result), {
    priorHeadSha: HEAD,
    behindBy: 2,
    mergeable: "MERGEABLE",
    remedy: "update-branch",
  });
});

test("rate-limit fallback uses the same preflight and updates a behind head without attempting REST merge", () => {
  const { deps, calls } = harness({
    armAuto: throwing(RATE_LIMIT),
    readMergeFacts: () => ({ mergeable: "MERGEABLE", behindBy: 4 }),
  });

  const result = attemptArm(PR, deps, HEAD);

  assert.equal(String(result.outcome), "direct-merge-updated");
  assert.deepEqual(calls, ["updateBranch"]);
  assert.ok(result.rateLimit, "quota attribution survives a preflight that remedies the stale head");
});

test("settled 405 retry re-runs the shared preflight immediately before its second write", () => {
  const facts: FixRebaseMergeFacts[] = [
    { mergeable: "MERGEABLE", behindBy: 0 }, // initial fallback preflight
    { mergeable: "MERGEABLE", behindBy: 0 }, // W1-T1280 settlement read
    { mergeable: "MERGEABLE", behindBy: 3 }, // fresh preflight immediately before retry
  ];
  let reads = 0;
  let mergeAttempts = 0;
  const { deps, calls } = harness({
    armAuto: throwing(RATE_LIMIT),
    readMergeFacts: () => facts[reads++] ?? assert.fail("unexpected extra merge-facts read"),
    mergeDirect: () => {
      mergeAttempts++;
      calls.push("mergeDirect");
      throw Object.assign(new Error("boom"), { stderr: HTTP_405 });
    },
    isMerged: () => false,
    sleepSync: () => {},
  });

  const result = attemptArm(PR, deps, HEAD);

  assert.equal(String(result.outcome), "direct-merge-updated");
  assert.equal(reads, 3, "the settled retry performs its own fresh preflight rather than reusing the settlement read");
  assert.equal(mergeAttempts, 1, "only the initial current-base attempt ran; the now-behind retry did not write");
  assert.deepEqual(calls, ["mergeDirect", "updateBranch"]);
});

test("unreadable, UNKNOWN, conflicting, and inconsistent facts all fail closed", () => {
  const unsafe: FixRebaseMergeFacts[] = [
    {},
    { mergeable: "MERGEABLE" },
    { mergeable: "UNKNOWN", behindBy: 0 },
    { mergeable: "CONFLICTING", behindBy: 0 },
    { mergeable: "MERGEABLE", behindBy: -1 },
    { mergeable: "MERGEABLE", behindBy: 1.5 },
  ];

  for (const facts of unsafe) {
    const { deps, calls } = harness({ readMergeFacts: () => facts });
    const result = attemptArm(PR, deps, HEAD);
    assert.equal(String(result.outcome), "direct-merge-preflight-refused", JSON.stringify(facts));
    assert.deepEqual(calls, [], `${JSON.stringify(facts)} must reach neither update nor merge`);
    assert.equal(evidence(result)?.remedy, "retry-later");
  }

  const thrownRead = harness({ readMergeFacts: () => { throw new Error("REST read timed out"); } });
  const thrownResult = attemptArm(PR, thrownRead.deps, HEAD);
  assert.equal(String(thrownResult.outcome), "direct-merge-preflight-refused");
  assert.deepEqual(thrownRead.calls, [], "a thrown facts read also reaches neither update nor merge");

  const missingHead = harness({ headSha: () => { throw new Error("head read timed out"); } });
  const missingHeadResult = attemptArm(PR, missingHead.deps);
  assert.equal(String(missingHeadResult.outcome), "direct-merge-preflight-refused");
  assert.deepEqual(missingHead.calls, [], "production-shaped preflight refuses when it cannot attribute the prior head");
});

test("an update refusal stays unmerged and has its own outcome and evidence", () => {
  const { deps, calls } = harness({
    readMergeFacts: () => ({ mergeable: "MERGEABLE", behindBy: 2 }),
    updateBranch: () => {
      calls.push("updateBranch");
      return { ok: false, error: "HTTP 422: branch cannot be updated" };
    },
  });

  const result = attemptArm(PR, deps, HEAD);

  assert.equal(String(result.outcome), "direct-merge-update-failed");
  assert.deepEqual(calls, ["updateBranch"]);
  assert.deepEqual(evidence(result), {
    priorHeadSha: HEAD,
    behindBy: 2,
    mergeable: "MERGEABLE",
    remedy: "update-branch",
    error: "HTTP 422: branch cannot be updated",
  });
});

test("a current, definitely mergeable head retains direct squash completion and post-merge confirmation", () => {
  const current = harness();
  assert.equal(attemptArm(PR, current.deps, HEAD).outcome, "direct-merged");
  assert.deepEqual(current.calls, ["mergeDirect"]);

  const confirmed = harness({
    mergeDirect: throwing("merge landed; confirmation failed"),
    isMerged: () => true,
  });
  assert.equal(attemptArm(PR, confirmed.deps, HEAD).outcome, "direct-merged");

  const quota = harness({ armAuto: throwing(RATE_LIMIT) });
  const quotaResult = attemptArm(PR, quota.deps, HEAD);
  assert.equal(quotaResult.outcome, "direct-merged");
  assert.ok(quotaResult.rateLimit, "the existing quota evidence still rides a successful current-base merge");
});

test("preflight outcomes receive distinct ledger vocabulary with the old head and attempted remedy", () => {
  const cases = [
    ["direct-merge-updated", "automerge.arm_skipped", "automerge.direct_merge_updated", "update-branch"],
    ["direct-merge-preflight-refused", "automerge.arm_skipped", "automerge.direct_merge_preflight_refused", "retry-later"],
    ["direct-merge-update-failed", "automerge.arm_failed", "automerge.direct_merge_update_failed", "update-branch"],
  ] as const;

  for (const [outcome, genericStep, namedStep, remedy] of cases) {
    const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const result = {
      outcome,
      directMergePreflight: { priorHeadSha: HEAD, behindBy: 2, mergeable: "MERGEABLE", remedy },
    };
    armAndLogOutcome(
      PR,
      "W1-T2855",
      (step, extra) => void logged.push({ step, extra }),
      () => result as never,
      "sweep",
      HEAD,
    );

    assert.deepEqual(logged.map((row) => row.step), [genericStep, namedStep]);
    for (const row of logged) {
      assert.equal(row.extra?.pr_url, PR);
      assert.equal(row.extra?.prior_head_sha, HEAD);
      assert.equal(row.extra?.behind_by, 2);
      assert.equal(row.extra?.mergeability, "MERGEABLE");
      assert.equal(row.extra?.remedy, remedy);
    }
  }
});

test("production realArmDeps wires both fresh REST facts and the guarded update-branch write", () => {
  const source = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const start = source.indexOf("export function realArmDeps(");
  const end = source.indexOf("\n}\n\n/** Terminal outcome", start);
  const body = source.slice(start, end);
  assert.match(body, /readMergeFacts:\s*\(prUrl\).*fixRebaseMergeFactsFromRest/s);
  assert.match(body, /updateBranch:\s*\(prUrl\).*ghUpdateBranch\(/s);

  const bin = mkdtempSync(join(tmpdir(), "rmd-stale-green-update-"));
  const marker = join(bin, "called");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" > '${marker}'\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  try {
    const deps = realArmDeps();
    const outcome = withLiveWritesAllowed(() => (deps as unknown as { updateBranch: (prUrl: string) => { ok: boolean } }).updateBranch(PR));
    assert.deepEqual(outcome, { ok: true });
    assert.match(readFileSync(marker, "utf8"), /api --method PUT repos\/craigoley\/remudero\/pulls\/3997\/update-branch/);
  } finally {
    process.env.PATH = previousPath;
    rmSync(bin, { recursive: true, force: true });
  }
});

test("legacy fixtures may omit the optional preflight seam, but guards and ordinary arming remain unchanged", () => {
  const legacyCalls: string[] = [];
  const legacy = {
    armAuto: throwing(CLEAN),
    mergeDirect: () => void legacyCalls.push("mergeDirect"),
    say: () => {},
  } as AttemptDeps;
  assert.equal(attemptArm(PR, legacy).outcome, "direct-merged");
  assert.deepEqual(legacyCalls, ["mergeDirect"], "old deliberately narrow fixtures keep their pre-W1-T2855 behavior");

  const guarded = harness({
    ledgerLines: () => [{ step: "automerge.hold_engaged", pr_number: 3997, by: "craig", reason: "manual gate" }],
  });
  assert.equal(attemptArm(PR, guarded.deps, HEAD).outcome, "hold-refused");
  assert.deepEqual(guarded.calls, [], "an operator hold refuses before any preflight or write");

  const ordinary = harness({ armAuto: () => void ordinary.calls.push("armAuto") });
  assert.equal(attemptArm(PR, ordinary.deps, HEAD).outcome, "armed");
  assert.deepEqual(ordinary.calls, ["armAuto"], "a successful auto-arm never enters the direct fallback");

  const irreversible = harness();
  assert.equal(armAutoMergeAtOpen(PR, irreversible.deps, true), "irreversible-refused");
  assert.deepEqual(irreversible.calls, [], "irreversible work refuses before the direct fallback");

  const staleVerdict = harness({
    ledgerLines: () => [{ step: "review.posted", task_id: "W1-T2855", state: "success", head_sha: "old-head" }],
  });
  assert.equal(armAutoMergeDetailed(PR, "W1-T2855", staleVerdict.deps as never).outcome, "ledger-refused");
  assert.deepEqual(staleVerdict.calls, [], "the verdict/head gate still refuses before attemptArm");
});
