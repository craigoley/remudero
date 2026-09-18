import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TaskIdReservationError,
  gitRemoteRefReserver,
  parseReservationHolderLine,
  reservationHolderDrift,
  reserveTaskIdRemote,
  type RemoteRefReserver,
} from "../src/lib/task-id-reservation.js";

type GitResult = { status: number; stdout: string; stderr: string };

const filingBranch = "run-W1-T3674-1789741266306";
const staleHolder = "run-W1-T3000-1789000000000";

function result(status = 0, stdout = "", stderr = ""): GitResult {
  return { status, stdout, stderr };
}

function withNoHeadRef<T>(body: () => T): T {
  const previous = process.env.GITHUB_HEAD_REF;
  delete process.env.GITHUB_HEAD_REF;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.GITHUB_HEAD_REF;
    else process.env.GITHUB_HEAD_REF = previous;
  }
}

function remoteWithHolder(opts: { branchPresent: boolean; fail?: "branch" | "fetch" | "missing-ref" | "body" | "push" }): { run: (args: string[]) => GitResult; calls: string[][]; reclaimedMessage: () => string } {
  const calls: string[][] = [];
  let reclaimedMessage = "";
  const holderMessage = `rmd-id reservation 1@old-host 2026-09-01T00:00:00.000Z\n\nrmd-id holder branch=${staleHolder} source=automatic\n`;
  return {
    calls,
    run(args) {
      calls.push(args);
      if (args[0] === "symbolic-ref") return result(0, `${filingBranch}\n`);
      if (args[0] === "hash-object") return result(0, "TREE\n");
      if (args[0] === "commit-tree") {
        const message = args.at(-1) ?? "";
        if (args.includes("FETCH_HEAD")) {
          reclaimedMessage = message;
          return result(0, "RECLAIMED\n");
        }
        return result(0, "INITIAL\n");
      }
      if (args[0] === "push") {
        const refspec = args[2] ?? "";
        if (refspec === "INITIAL:refs/rmd-id/W1-T3674") return result(1, "", "rejected: non-fast-forward");
        if (opts.fail === "push") return result(1, "", "could not resolve host: github.com");
        return result(0);
      }
      if (args[0] === "fetch") {
        if (opts.fail === "fetch") return result(1, "", "could not resolve host: github.com");
        if (opts.fail === "missing-ref") return result(128, "", "fatal: couldn't find remote ref refs/rmd-id/W1-T3674");
        return result(0);
      }
      if (args[0] === "log") return opts.fail === "body" ? result(1, "", "cannot read object") : result(0, holderMessage);
      if (args[0] === "ls-remote") {
        if (opts.fail === "branch") throw new Error("branch lookup failed");
        return opts.branchPresent
          ? result(0, `abc\trefs/heads/${staleHolder}\n`)
          : result(2);
      }
      throw new Error(`unexpected git invocation: ${args.join(" ")}`);
    },
    reclaimedMessage: () => reclaimedMessage,
  };
}

test("unit test: a reservation whose holder branch no longer exists is reclaimable by the next filer and records what it took over from", () => {
  const remote = remoteWithHolder({ branchPresent: false });
  const held = withNoHeadRef(() => reserveTaskIdRemote(3674, gitRemoteRefReserver({ run: remote.run })));

  assert.equal(held.taskId, "W1-T3674");
  assert.match(remote.reclaimedMessage(), new RegExp(`taken_over_from=${staleHolder}`));
  const replacement = remote.calls.find((args) => args[0] === "commit-tree" && args.includes("FETCH_HEAD"));
  assert.ok(replacement, "the replacement must retain the old claim as its parent, never delete it");
  assert.deepEqual(replacement?.slice(0, 5), ["commit-tree", "TREE", "-p", "FETCH_HEAD", "-m"]);
});

test("unit test: a live holder still refuses the filer", () => {
  const remote = remoteWithHolder({ branchPresent: true });
  const held = withNoHeadRef(() => reserveTaskIdRemote(3674, gitRemoteRefReserver({ run: remote.run })));

  assert.equal(held.taskId, "W1-T3675", "the live holder keeps its id and the filer claims the next available one");
  assert.equal(remote.reclaimedMessage(), "", "a live foreign holder must not be overwritten");
  assert.equal(
    remote.calls.some((args) => args[0] === "commit-tree" && args.includes("FETCH_HEAD")),
    false,
    "no takeover child may be created for a live holder",
  );
});

test("unit test: a protected write with no created reservation ref remains contention and exhausts the bounded scan", () => {
  const remote = remoteWithHolder({ branchPresent: false, fail: "missing-ref" });

  assert.throws(
    () => withNoHeadRef(() => reserveTaskIdRemote(3674, gitRemoteRefReserver({ run: remote.run }), { maxScan: 1 })),
    (error: unknown) => {
      assert.ok(error instanceof TaskIdReservationError);
      assert.equal(error.outcome, "exhausted");
      assert.equal(error.ref, undefined, "the protected write did not create a holder ref");
      return true;
    },
  );
  assert.equal(
    remote.calls.some((args) => args[0] === "commit-tree" && args.includes("FETCH_HEAD")),
    false,
    "a confirmed-absent ref is not a holder and must never receive a takeover child",
  );
});

test("unit test: an unpushable claim is reported, not silently filed", () => {
  let attempts = 0;
  const reserver: RemoteRefReserver = {
    filingBranch: () => filingBranch,
    mintAnchor: () => "ANCHOR",
    attempt: () => {
      attempts++;
      return "unreachable";
    },
  };

  assert.throws(
    () => reserveTaskIdRemote(3674, reserver),
    (error: unknown) => {
      assert.ok(error instanceof TaskIdReservationError);
      assert.equal(error.outcome, "unreachable");
      assert.equal(error.taskId, "W1-T3674");
      assert.match(error.message, /refusing to mint/);
      return true;
    },
  );
  assert.equal(attempts, 1, "an unpushable claim must stop before a caller can report it reserved");
});

test("W1-T3674: reservationHolderDrift distinguishes reclaimable, live, unattributable, and unreadable holders", () => {
  const named = parseReservationHolderLine(`rmd-id holder branch=${staleHolder}`);
  assert.equal(reservationHolderDrift(named, "absent"), "reclaimable");
  assert.equal(reservationHolderDrift(named, "present"), "held");
  assert.equal(reservationHolderDrift(parseReservationHolderLine("rmd-id holder branch=main"), "present"), "unattributable");
  assert.equal(reservationHolderDrift(parseReservationHolderLine("rmd-id holder branch=unknown"), "unreadable"), "unattributable");
  assert.equal(reservationHolderDrift(parseReservationHolderLine("legacy reservation"), "unreadable"), "unreadable");
});

test("W1-T3674: main cannot create a reservation that no filing branch can match", () => {
  let minted = false;
  const reserver: RemoteRefReserver = {
    filingBranch: () => "main",
    mintAnchor: () => {
      minted = true;
      return "ANCHOR";
    },
    attempt: () => "created",
  };

  assert.throws(() => reserveTaskIdRemote(3674, reserver), /cannot reserve a task id from main/);
  assert.equal(minted, false, "the invalid holder is refused before an anchor exists to push");
});

test("W1-T3674: an unreadable repair surface refuses rather than guessing that a holder is stale", () => {
  for (const failure of ["branch", "fetch", "body", "push"] as const) {
    const remote = remoteWithHolder({ branchPresent: false, fail: failure });
    assert.throws(
      () => withNoHeadRef(() => reserveTaskIdRemote(3674, gitRemoteRefReserver({ run: remote.run }))),
      (error: unknown) => {
        assert.ok(error instanceof TaskIdReservationError);
        assert.ok(error.outcome === "unknown" || error.outcome === "unreachable");
        return true;
      },
      `${failure} failure must refuse the repair`,
    );
  }
});

test("W1-T3674: a detached reclaimer cannot turn an unattributable holder into another unattributable claim", () => {
  const calls: string[][] = [];
  const run = (args: string[]): GitResult => {
    calls.push(args);
    if (args[0] === "symbolic-ref" || args[0] === "rev-parse") return result(1);
    if (args[0] === "hash-object") return result(0, "TREE\n");
    if (args[0] === "commit-tree") return result(0, "INITIAL\n");
    if (args[0] === "push") return result(1, "", "rejected: non-fast-forward");
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };

  assert.throws(() => withNoHeadRef(() => reserveTaskIdRemote(3674, gitRemoteRefReserver({ run }))));
  assert.equal(calls.some((args) => args[0] === "fetch"), false, "an unknown filer must refuse before it reads or amends another claim");
});
