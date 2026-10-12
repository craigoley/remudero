import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  applyOperatorMergeHold,
  authorizeMergeHoldWrite,
  gatherMergeHoldActor,
  humanTerminalActorProbe,
  realMergeHoldActorProbe,
  type MergeHoldActorProbe,
  type OperatorMergeHoldInput,
} from "../src/lib/operator-merge-hold.js";
import { automergeHoldFromLedger, describeHoldSetter } from "../src/lib/review.js";
import { deriveBlockedPrSections } from "../src/lib/status-board.js";
import { readLedgerLines } from "../src/lib/status.js";
import { diagnoseCappedRoutingBlock, type OpenPrView } from "./helpers/sweep-test.js";
import { mergeHoldCommand } from "../src/run-task.js";

const SESSION = "954513d4-fb16-405c-a008-874081e11477";

function agentProbe(): MergeHoldActorProbe {
  return {
    env: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: SESSION, PATH: "/usr/bin" },
    osUser: () => "node",
    host: () => "fa3e9bb4d422",
    containerId: () => "fa3e9bb4d422",
    stdinIsTTY: () => true,
    stdoutIsTTY: () => true,
    parents: () => ["claude", "bash"],
  };
}

function humanProbe(): MergeHoldActorProbe {
  return {
    env: { PATH: "/usr/bin" },
    osUser: () => "craig",
    host: () => "workstation",
    containerId: () => undefined,
    stdinIsTTY: () => true,
    stdoutIsTTY: () => true,
    parents: () => ["zsh"],
  };
}

function engage(by: string): OperatorMergeHoldInput {
  return { action: "engage", by, reason: "hold for a manual read", authority: "interactive-cli", prNumber: 10339 };
}

function scratchDir(): { dir: string; ledgerPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-who-set-hold-"));
  return { dir, ledgerPath: join(dir, "ledger.ndjson") };
}

async function quietly<T>(fn: () => T): Promise<{ result: T; err: string }> {
  const errs: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...a: unknown[]) => void errs.push(a.join(" "));
  console.log = () => {};
  try {
    return { result: fn(), err: errs.join("\n") };
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
}

test("W1-T7721: a merge-hold row records the verifiable actor beside the claimed name", () => {
  const { dir, ledgerPath } = scratchDir();
  try {
    const actor = gatherMergeHoldActor(humanProbe());
    applyOperatorMergeHold(ledgerPath, engage("Craig Oley"), { now: () => 1, actor });
    const row = readLedgerLines(ledgerPath)[0]!;
    assert.equal(row.by, "Craig Oley");
    assert.deepEqual(row.hold_actor, actor, "the row carries the writer-gathered actor object");
    assert.equal((row.hold_actor as { os_user: string }).os_user, "craig");
    assert.equal((row.hold_actor as { host: string }).host, "workstation");
    assert.deepEqual(automergeHoldFromLedger(readLedgerLines(ledgerPath), 10339)?.actor, actor);

    // The agent probe is classified as an agent from its markers and its container, and keeps both as evidence.
    const agent = gatherMergeHoldActor(agentProbe());
    assert.equal(agent.kind, "agent");
    assert.deepEqual(agent.agent_markers, ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID"]);
    assert.equal(agent.container_id, "fa3e9bb4d422");
    assert.equal(agent.session, SESSION);

    // The one real-default probe reads this process, and always names a user and a host.
    const real = gatherMergeHoldActor(realMergeHoldActorProbe());
    assert.ok(real.os_user.length > 0 && real.host.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T7721: an agent caller naming a human in --by is refused", async () => {
  const { dir, ledgerPath } = scratchDir();
  try {
    const agent = gatherMergeHoldActor(agentProbe());
    const verdict = authorizeMergeHoldWrite(engage("Craig Oley"), agent);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.match(verdict.error, /CLAUDECODE/);

    const { result, err } = await quietly(() =>
      mergeHoldCommand(["engage", "--pr", "10339", "--by", "Craig Oley", "--reason", "x", "--confirm"], {
        ledgerPath,
        isInteractive: () => true,
        actorProbe: agentProbe(),
      }),
    );
    assert.equal(result, 2);
    assert.match(err, /non-human caller/);
    assert.equal(readLedgerLines(ledgerPath).length, 0, "and NOTHING was written");

    const release = authorizeMergeHoldWrite({ ...engage("agent:abc"), action: "release" }, agent);
    assert.equal(release.ok, false, "an agent cannot lift a hold either");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T7721: an agent hold is never read as a confirmed human hold", async () => {
  const { dir, ledgerPath } = scratchDir();
  try {
    const { result } = await quietly(() =>
      mergeHoldCommand(["engage", "--pr", "10339", "--by", `agent:${SESSION}`, "--reason", "agent note", "--confirm"], {
        ledgerPath,
        isInteractive: () => true,
        actorProbe: agentProbe(),
      }),
    );
    assert.equal(result, 0);
    const lines = readLedgerLines(ledgerPath);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.authority, "agent-cli");
    assert.equal(automergeHoldFromLedger(lines, 10339), undefined, "agent-cli never stands as a hold");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const HELD_PR: OpenPrView = {
  prNumber: 10339, prUrl: "https://github.com/acme/remudero/pull/10339", taskId: "W1-T1", reviewState: "success",
  checksState: "green", unmetCriteria: [], priorStrikes: 0, lastActivityAt: "2026-10-09T11:00:00.000Z", // expiring-fixture: exempt -- never compared to the wall clock
  headSha: "abc123", autoMergeArmed: false,
};

test("W1-T7721: the sweep and the board show who really set a hold", () => {
  // A forged legacy-shaped row: a human name and a confirmed authority, but an agent actor.
  const forged = {
    run_id: "OPERATOR-MERGE-HOLD-1", task_id: "PR-10339", step: "automerge.hold_engaged", lane: "operator",
    by: "Craig Oley", reason: "hold", authority: "interactive-cli", pr_number: 10339, hold_actor: gatherMergeHoldActor(agentProbe()),
  };
  const hold = automergeHoldFromLedger([forged], 10339)!;
  const label = describeHoldSetter(hold);
  assert.match(label, /Craig Oley \(claimed\); written by agent session 954513d4/);
  assert.match(label, /fa3e9bb4d422/);

  const diagnosis = diagnoseCappedRoutingBlock(HELD_PR, "mergeable", [forged]);
  assert.equal(diagnosis.blocked, true);
  assert.match(diagnosis.detail, /Craig Oley \(claimed\); written by agent session/);

  const row = deriveBlockedPrSections([forged]).mergeHeld[0]!;
  assert.equal(row.claimMismatch, true);
  assert.equal(row.actor?.kind, "agent");
  assert.match(row.setter ?? "", /\(claimed\); written by agent session/);

  // An older row with no actor reads as unrecorded, never as a mismatch.
  const { hold_actor: _drop, ...legacy } = forged;
  const old = deriveBlockedPrSections([legacy]).mergeHeld[0]!;
  assert.equal(old.claimMismatch, false);
  assert.match(old.setter ?? "", /Craig Oley \(actor unrecorded\)/);
});

test("W1-T7721: a human at a real terminal is unchanged", async () => {
  const { dir, ledgerPath } = scratchDir();
  try {
    const human = gatherMergeHoldActor(humanProbe());
    assert.equal(human.kind, "human");
    assert.deepEqual(authorizeMergeHoldWrite(engage("craig"), human), { ok: true, input: engage("craig") });
    assert.equal(gatherMergeHoldActor(humanTerminalActorProbe()).kind, "human");

    const { result } = await quietly(() =>
      mergeHoldCommand(["engage", "--pr", "10339", "--by", "craig", "--reason", "manual read", "--confirm"], {
        ledgerPath,
        isInteractive: () => true,
        actorProbe: humanProbe(),
      }),
    );
    assert.equal(result, 0);
    const lines = readLedgerLines(ledgerPath);
    assert.equal(lines[0]!.authority, "interactive-cli");
    const hold = automergeHoldFromLedger(lines, 10339)!;
    assert.equal(hold.by, "craig");
    assert.match(describeHoldSetter(hold), /craig \(human craig on workstation\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T7721: a recorded actor that is not well-formed is dropped, so the hold reads as unrecorded", () => {
  const rows = (hold_actor: unknown) => [
    { step: "automerge.hold_engaged", pr_number: 10339, by: "craig", reason: "manual read", authority: "interactive-cli", hold_actor },
  ];
  const malformed = [
    { kind: "robot", os_user: "craig", host: "workstation" },
    { kind: "human", os_user: 7, host: "workstation" },
    { kind: "agent", os_user: "node" },
  ];
  for (const bad of malformed) {
    const hold = automergeHoldFromLedger(rows(bad), 10339)!;
    assert.equal(hold.by, "craig", "the hold itself is still read");
    assert.equal(hold.actor, undefined, `${JSON.stringify(bad)} is not a recorded actor`);
    assert.match(describeHoldSetter(hold), /craig \(actor unrecorded\)/);
  }
});

test("W1-T7721: the real probe reports no parents when a parent's process entry cannot be read", () => {
  // A getter, because process.ppid ignores a redefinition by value. The pid below is past any real process table.
  const realPpid = process.ppid;
  Object.defineProperty(process, "ppid", { get: () => 2 ** 31 - 2, configurable: true });
  try {
    assert.deepEqual(realMergeHoldActorProbe().parents(), []);
  } finally {
    Object.defineProperty(process, "ppid", { get: () => realPpid, configurable: true });
  }
});
