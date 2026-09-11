import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  formatHandMintReservationMessage,
  gitRemoteRefReserver,
  parseReservationHolderLine,
  taskIdReservationRef,
  type RemoteRefReserver,
  type RemoteReserveOutcome,
} from "../src/lib/task-id-reservation.js";
import { nextTaskIdCommand } from "../src/run-task.js";

const gate = await import("../scripts/task-id-existence-check.mjs");

const NO_OPEN_PRS = (): string[] => [];

function captureConsole(): { out: string[]; err: string[]; restore(): void } {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => void out.push(args.join(" "));
  console.error = (...args: unknown[]) => void err.push(args.join(" "));
  return {
    out,
    err,
    restore() {
      console.log = log;
      console.error = error;
    },
  };
}

function stubReserver(taken: Set<string>): RemoteRefReserver & { tried: string[] } {
  const tried: string[] = [];
  return {
    tried,
    mintAnchor: () => "ANCHOR",
    attempt(taskId: string): RemoteReserveOutcome {
      tried.push(taskId);
      return taken.has(taskId) ? "taken" : "created";
    },
  };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "rmd-holder-"));
}

function occurrencesFor(file: string) {
  return new Map([["W1-T9100", [{ file, line: 1 }]]]);
}

test("W1-T3100: automatic and hand-mint anchors carry the same parseable holder line", (t) => {
  const previousHeadRef = process.env.GITHUB_HEAD_REF;
  delete process.env.GITHUB_HEAD_REF;
  t.after(() => {
    if (previousHeadRef === undefined) delete process.env.GITHUB_HEAD_REF;
    else process.env.GITHUB_HEAD_REF = previousHeadRef;
  });
  const calls: string[][] = [];
  const reserver = gitRemoteRefReserver({
    run: (args) => {
      calls.push(args);
      if (args[0] === "hash-object") return { status: 0, stdout: "TREE\n", stderr: "" };
      if (args[0] === "symbolic-ref") return { status: 0, stdout: "run-W1-T3100-auto\n", stderr: "" };
      if (args[0] === "commit-tree") return { status: 0, stdout: "ORPHAN\n", stderr: "" };
      return { status: 1, stdout: "", stderr: "unexpected" };
    },
  });

  assert.equal(reserver.mintAnchor(), "ORPHAN");
  const commit = calls.find((args) => args[0] === "commit-tree");
  assert.ok(commit, "automatic mint must create an anchor commit");
  const autoMessage = commit!.at(-1) ?? "";
  const handMessage = formatHandMintReservationMessage("W1-T3100", {
    branch: "run-W1-T3100-hand",
    pid: 123,
    host: "operator-box",
    startedAt: "2026-09-11T00:00:00.000Z",
  });

  const auto = parseReservationHolderLine(autoMessage);
  assert.equal(auto.status, "known");
  if (auto.status === "known") {
    assert.equal(auto.holder.branch, "run-W1-T3100-auto");
    assert.equal(auto.holder.pid, process.pid);
    assert.equal(auto.holder.source, "automatic");
  }
  const hand = parseReservationHolderLine(handMessage);
  assert.equal(hand.status, "known");
  if (hand.status === "known") {
    assert.equal(hand.holder.branch, "run-W1-T3100-hand");
    assert.equal(hand.holder.pid, 123);
    assert.equal(hand.holder.host, "operator-box");
    assert.equal(hand.holder.startedAt, "2026-09-11T00:00:00.000Z");
    assert.equal(hand.holder.source, "hand-mint");
  }
});

test("W1-T3100: next-task-id prints the holder branch for every held id it reports", async () => {
  const control = captureConsole();
  let first = "";
  try {
    await nextTaskIdCommand(["--reserve"], {}, { reserver: stubReserver(new Set()), holderOf: () => "unknown", openPrTexts: NO_OPEN_PRS });
    first = /RESERVED (W1-T[0-9]+)/.exec(control.out.join("\n"))?.[1] ?? "";
  } finally {
    control.restore();
  }
  assert.ok(first, "control run must reserve an id before the contested run can hold it");

  const reserver = stubReserver(new Set([first]));
  const cap = captureConsole();
  try {
    await nextTaskIdCommand(["--reserve"], {}, {
      reserver,
      holderOf: () => ({ branch: "run-W1-T3100-other", source: "automatic" }),
      openPrTexts: NO_OPEN_PRS,
    });
  } finally {
    cap.restore();
  }

  const text = cap.out.join("\n");
  assert.equal(reserver.tried[0], first);
  assert.match(text, new RegExp(`\\(${first}: HELD BY run-W1-T3100-other \\(automatic\\)\\)`));
  assert.match(text, /RESERVED W1-T[0-9]+ on origin/);
});

test("W1-T3100: a differing reservation holder is refused unless the shard records the hand-off", () => {
  const root = scratch();
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  const shard = "plan/tasks.d/W1-T9100.yaml";
  const shardPath = join(root, shard);
  const occurrenceMap = occurrencesFor(shard);
  const reservation = {
    reachable: true,
    ids: new Set(["W1-T9100"]),
    holders: new Map([["W1-T9100", { status: "known", branch: "run-W1-T3100-holder" }]]),
  };

  writeFileSync(shardPath, '- id: W1-T9100\n  title: "held"\n');
  const refused = gate.evaluateReservationHolderConflicts(["W1-T9100"], occurrenceMap, reservation, "run-W1-T3100-filer", root);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].id, "W1-T9100");
  assert.equal(refused[0].holderBranch, "run-W1-T3100-holder");

  writeFileSync(
    shardPath,
    '- id: W1-T9100\n  title: "held"\n  note: "reservation hand-off: run-W1-T3100-holder -> run-W1-T3100-filer"\n',
  );
  const handedOff = gate.evaluateReservationHolderConflicts(["W1-T9100"], occurrenceMap, reservation, "run-W1-T3100-filer", root);
  assert.deepEqual(handedOff, []);
});

test("W1-T3100: an anchor with no holder line is UNKNOWN and exempt", () => {
  assert.deepEqual(gate.parseReservationHolderLine("reserve W1-T9100 host-pid-time"), { status: "legacy" });
  const root = scratch();
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  const shard = "plan/tasks.d/W1-T9100.yaml";
  writeFileSync(join(root, shard), '- id: W1-T9100\n  title: "legacy"\n');
  const reservation = {
    reachable: true,
    ids: new Set(["W1-T9100"]),
    holders: new Map([["W1-T9100", { status: "legacy" }]]),
  };
  const conflicts = gate.evaluateReservationHolderConflicts(["W1-T9100"], occurrencesFor(shard), reservation, "run-W1-T3100-filer", root);
  assert.deepEqual(conflicts, []);
  assert.equal(taskIdReservationRef("W1-T9100"), "refs/rmd-id/W1-T9100");
});
