// W1-T2448: `squash_merge_commit_message: COMMIT_MESSAGES` is the only unasserted repo setting
// that fails SILENTLY — a UI flip to `PR_BODY` is invisible because `buildCommitTrailerIndex`
// (status.ts:626) FAILS CLOSED rather than erroring, unlike `allow_squash_merge`/
// `allow_auto_merge`/`delete_branch_on_merge`, which all announce themselves on the first
// attempt (task rationale, Q3). This file proves the four acceptance criteria: the setting is
// now compared against a recorded baseline like every other posture capability, a drift finding
// warns through the existing ledger row and never blocks, the gateway stays GET-only with no
// write ever issued, and an unreadable payload degrades to no finding rather than a false
// all-clear.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkGithubPosture,
  classifyGithubPosture,
  ghPostureGateway,
  readGithubPosture,
  GITHUB_POSTURE_CAPABILITIES,
  GITHUB_POSTURE_SQUASH_MERGE_COMMIT_MESSAGE_EXPECTED,
  type GithubPostureBaseline,
  type GithubPostureGateway,
} from "../src/lib/github-posture.js";

function repoPayload(squashMergeCommitMessage: string | undefined): unknown {
  const base: Record<string, unknown> = {
    security_and_analysis: {
      secret_scanning: { status: "enabled" },
    },
  };
  if (squashMergeCommitMessage !== undefined) base.squash_merge_commit_message = squashMergeCommitMessage;
  return base;
}

function fakeGateway(repo: unknown, enforceAdmins: unknown = { enabled: true }): GithubPostureGateway {
  return { getRepo: () => repo, getEnforceAdmins: () => enforceAdmins };
}

// ── the descriptor itself exists, and the expected value matches the live-measured setting ──

test("W1-T2448: squash_merge_commit_message is a declared capability sourced from merge_settings", () => {
  const descriptor = GITHUB_POSTURE_CAPABILITIES.find((d) => d.key === "squash_merge_commit_message");
  assert.ok(descriptor, "the descriptor exists in GITHUB_POSTURE_CAPABILITIES");
  assert.equal(descriptor?.source, "merge_settings", "sourced from the repo-root payload, not a new endpoint");
  assert.equal(
    GITHUB_POSTURE_SQUASH_MERGE_COMMIT_MESSAGE_EXPECTED,
    "COMMIT_MESSAGES",
    "the value measured live (task rationale Q1) is the one asserted as the expected baseline",
  );
});

// ── (1) compared against a recorded baseline like every other posture capability ────────────

test("W1-T2448: at the live-measured value, the capability reads enabled — no drift", () => {
  const snapshot = readGithubPosture("craigoley", "remudero", { gateway: fakeGateway(repoPayload("COMMIT_MESSAGES")) });
  assert.equal(snapshot?.squash_merge_commit_message, "enabled", "COMMIT_MESSAGES is the asserted, matching value");
  const findings = classifyGithubPosture(snapshot ?? {});
  assert.ok(
    !findings.some((f) => f.capability === "squash_merge_commit_message"),
    "an enabled (matching) capability never produces a finding",
  );
});

test("W1-T2448: a UI flip to PR_BODY reads disabled and is caught as drift against the baseline", () => {
  const t0 = new Date("2026-08-28T00:00:00.000Z");
  let baseline: GithubPostureBaseline | undefined = {
    checkedAt: t0.toISOString(),
    snapshot: { squash_merge_commit_message: "enabled" }, // recorded while it was still COMMIT_MESSAGES
  };
  const deps = {
    owner: "craigoley",
    repo: "remudero",
    configRoot: "/unused",
    minIntervalMinutes: 60,
    loadBaseline: () => baseline,
    saveBaseline: (_path: string, b: GithubPostureBaseline) => {
      baseline = b;
    },
    // The exact flip the task names: PR_BODY, invisible to buildCommitTrailerIndex's caller.
    read: () => ({ squash_merge_commit_message: "disabled" as const }),
  };
  const t1 = new Date(t0.getTime() + 61 * 60_000);
  const findings = checkGithubPosture({ ...deps, now: t1 });
  assert.ok(
    findings.some((f) => f.capability === "squash_merge_commit_message"),
    "the flip away from COMMIT_MESSAGES is reported the SAME way every other posture drift is — a finding, not a crash",
  );

  // And it settles: the same (now-recorded) flipped value on the next read emits nothing more —
  // change-only, exactly like every other capability this module already tracks.
  const t2 = new Date(t1.getTime() + 61 * 60_000);
  const settled = checkGithubPosture({ ...deps, now: t2 });
  assert.deepEqual(settled, [], "the SAME flipped posture on the next read emits nothing — it fired exactly once");
});

test("W1-T2448: PR_BODY and COMMIT_MESSAGES_AND_PR_BODY both read as drift, not only PR_BODY", () => {
  for (const flipped of ["PR_BODY", "COMMIT_MESSAGES_AND_PR_BODY", "BLANK"]) {
    const snapshot = readGithubPosture("craigoley", "remudero", { gateway: fakeGateway(repoPayload(flipped)) });
    assert.equal(snapshot?.squash_merge_commit_message, "disabled", `${flipped} is not the asserted value — reads disabled`);
  }
});

// ── (2) a drift finding warns through the existing ledger row and never blocks a dispatch ───

test("W1-T2448: the finding is a plain classifyGithubPosture entry — the SAME shape as every other capability, never a thrown/blocking value", () => {
  const findings = classifyGithubPosture({ squash_merge_commit_message: "disabled" });
  assert.equal(findings.length, 1);
  assert.deepEqual(
    findings[0],
    { capability: "squash_merge_commit_message", kind: "free" },
    "no allowlist entry exists for it, so it flags plainly like any other free-off capability — a ledger row, not an escalation",
  );
  // checkGithubPosture's own contract (module header: "IT MUST NOT BLOCK") is untouched by this
  // capability — it is folded through the exact same classify/return path as every other key,
  // never routed through escalate()/notify(), and never throws.
  assert.doesNotThrow(() => classifyGithubPosture({ squash_merge_commit_message: "disabled" }));
});

// ── (3) no setting is ever written and the gateway stays GET-only ───────────────────────────

test("W1-T2448: reading squash_merge_commit_message issues no new GET and no write flag/verb", () => {
  const calls: string[][] = [];
  const execSpy = (args: string[]): string => {
    calls.push(args);
    if (args[1]?.includes("branches/")) return JSON.stringify({ enabled: true });
    return JSON.stringify(repoPayload("PR_BODY"));
  };
  const snapshot = readGithubPosture("craigoley", "remudero", { gateway: ghPostureGateway(execSpy) });
  assert.equal(snapshot?.squash_merge_commit_message, "disabled", "the flipped value is still read off the SAME repo-root call");
  assert.equal(calls.length, 2, "still exactly the two GETs this module has ever issued — no third call for the merge setting");
  for (const args of calls) {
    assert.deepEqual(args.slice(0, 1), ["api"], "every call remains a bare `gh api` read");
    for (const flag of ["-X", "--method", "-f", "-F", "--input", "PUT", "POST", "PATCH", "DELETE"]) {
      assert.ok(!args.includes(flag), `no write flag/verb (${flag}) is ever passed for the merge-settings capability`);
    }
  }
  // The gateway's own type surface: still exactly the two GET methods — no write method was
  // added to carry this capability.
  const gateway = ghPostureGateway(execSpy);
  assert.deepEqual(Object.keys(gateway).sort(), ["getEnforceAdmins", "getRepo"], "the gateway interface gained no third (write) method");
});

// ── (4) an unreadable settings payload degrades to no finding rather than a false all-clear ─

test("W1-T2448: an unreadable repo-root payload drops squash_merge_commit_message entirely — never a manufactured enabled", () => {
  const snapshot = readGithubPosture("craigoley", "remudero", { gateway: fakeGateway(undefined) });
  assert.equal(snapshot, undefined, "the whole read degrades to undefined when the repo payload itself is unreadable");
});

test("W1-T2448: a malformed (non-string) squash_merge_commit_message field is simply absent, never defaulted to enabled", () => {
  const snapshot = readGithubPosture("craigoley", "remudero", { gateway: fakeGateway(repoPayload(undefined)) });
  assert.ok(snapshot, "the repo payload itself was readable");
  assert.equal(
    snapshot?.squash_merge_commit_message,
    undefined,
    "a missing/malformed field is omitted from the snapshot, never defaulted to a status either way",
  );
});

test("W1-T2448: checkGithubPosture reports nothing and leaves the baseline untouched when the whole read fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "github-posture-merge-settings-"));
  const priorBaseline: GithubPostureBaseline = {
    checkedAt: new Date("2026-08-26T00:00:00.000Z").toISOString(),
    snapshot: { squash_merge_commit_message: "enabled" },
  };
  let saved: GithubPostureBaseline | undefined;
  const findings = checkGithubPosture({
    owner: "craigoley",
    repo: "remudero",
    configRoot: dir,
    now: new Date("2026-08-28T00:00:00.000Z"),
    loadBaseline: () => priorBaseline,
    saveBaseline: (_path, b) => {
      saved = b;
    },
    read: () => undefined, // simulates a failed/unreachable `gh api` round-trip
  });
  assert.deepEqual(findings, [], "an unreadable read produces NO findings — not a false all-clear, and not a false drift either");
  assert.equal(saved, undefined, "the recorded baseline is left untouched — an outage can't manufacture tomorrow's clean-or-dirty diff");
});
