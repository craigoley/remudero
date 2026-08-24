import assert from "node:assert/strict";
import { test } from "node:test";
import { LanePushForeignHeadError, gitPushEmptyCommit } from "../src/lib/git-push.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";

/**
 * W1-T1288 — A LANE PUSH CARRIES A LEASE NAMING THE HEAD IT BELIEVED IT WAS BUILDING ON.
 *
 * `gitPushEmptyCommit` is the leaf `sweepPostFixReverification`'s `redrive` calls with
 * `pr.headRefName`/`pr.headSha` — the PR's OWN branch, which other lanes (an operator lane,
 * or this same rung on a later poll) push too. The incident this task is filed against
 * (oper#lane-push-clobbered-a-shared-branch-2026-08-23, PR #2668) hit exactly the window a
 * plain push cannot guard: the ref was momentarily ABSENT when a stale-headed lane pushed, so
 * git reported `[new branch]` and silently replaced a concurrent lane's work rather than
 * rejecting a non-fast-forward — there was no ancestor to reject against.
 *
 * THE FAKE REMOTE below is what makes these tests observe the property rather than just the
 * argv: it is a tiny in-memory ref store that applies `--force-with-lease=<ref>:<expect>`'s
 * REAL semantics (reject unless the ref's current value equals `<expect>`, where an empty
 * `<expect>` means "the ref must not exist") — the same precondition git itself enforces, so a
 * test here is exercising the same decision a real remote would make, not a stand-in for it.
 */
function fakeRemote(initial: string | undefined): {
  push(args: string[]): void;
  lsRemote(): string;
  value(): string | undefined;
} {
  let value = initial;
  return {
    push(args: string[]) {
      const leaseArg = args.find((a) => a.startsWith("--force-with-lease="));
      assert.ok(leaseArg, "every push through this leaf must carry a lease");
      const leaseBody = leaseArg!.slice("--force-with-lease=".length);
      const sep = leaseBody.indexOf(":");
      const leaseRef = leaseBody.slice(0, sep);
      const expect = leaseBody.slice(sep + 1);
      const refspec = args[args.length - 1]!;
      const [pushedSha, targetRef] = refspec.split(":");
      assert.equal(leaseRef, targetRef, "the lease must name the SAME ref the refspec targets");
      const expectsPresence = expect !== "";
      const matches = expectsPresence ? value === expect : value === undefined;
      if (!matches) {
        // Mirrors real git: a stale/foreign/absent-when-not-expected ref is REJECTED, never
        // silently turned into a create or a replace.
        throw new Error(
          `! [rejected] ${targetRef} -> ${targetRef} (stale info)\n` +
            `error: failed to push some refs (lease on ${leaseRef} does not match)`,
        );
      }
      value = pushedSha;
    },
    lsRemote() {
      return value ? `${value}\trefs/heads/x\n` : "";
    },
    value() {
      return value;
    },
  };
}

function deps(remote: ReturnType<typeof fakeRemote>, pushSpy: string[][], captureSpy: string[][] = []) {
  return {
    capture: (_file: string, args: string[]) => {
      captureSpy.push(args);
      if (args[2] === "rev-parse") return "treeabc\n";
      if (args[2] === "commit-tree") return "newsha1\n";
      if (args[2] === "ls-remote") return remote.lsRemote();
      throw new Error(`unexpected capture: ${args.join(" ")}`);
    },
    exec: (_file: string, args: string[]) => {
      pushSpy.push(args);
      remote.push(args);
    },
  };
}

// ── (1) A LANE PUSH CARRIES A LEASE NAMING THE BELIEVED HEAD ────────────────────────────────

test("gitPushEmptyCommit's push carries --force-with-lease naming the believed head, and succeeds when the remote agrees", () => {
  const remote = fakeRemote("35d636d454cc");
  const pushed: string[][] = [];
  const newSha = withLiveWritesAllowed(() =>
    gitPushEmptyCommit("/repo", "run-W1-T253-1", "35d636d454cc", "chore(ci): re-trigger", deps(remote, pushed)),
  );

  assert.equal(newSha, "newsha1");
  assert.ok(
    pushed[0]!.includes("--force-with-lease=refs/heads/run-W1-T253-1:35d636d454cc"),
    "the lease names the exact ref and the exact head the caller believed it was building on",
  );
  assert.equal(remote.value(), "newsha1", "a matching lease lands the push");
});

// ── (2) AN EXPECTED HEAD THAT NO LONGER MATCHES IS REFUSED, NOT CREATED/REPLACED ────────────

test("a foreign head — the remote moved since the caller read it — refuses the push and leaves the remote untouched", () => {
  // A second lane already pushed 00867162 (PR #2668's own recorded shape) before this call's
  // `headSha` (its stale read) ever reaches the remote.
  const remote = fakeRemote("00867162");
  const pushed: string[][] = [];
  assert.throws(
    () =>
      withLiveWritesAllowed(() =>
        gitPushEmptyCommit("/repo", "run-W1-T253-1", "f9a9d30c", "chore(ci): re-trigger", deps(remote, pushed)),
      ),
    (err: unknown) => {
      assert.ok(err instanceof LanePushForeignHeadError, "a distinguishable refusal, not a generic throw");
      assert.equal(err.branch, "run-W1-T253-1");
      assert.equal(err.expectedHeadSha, "f9a9d30c");
      return true;
    },
  );
  assert.equal(pushed.length, 1, "exactly one push attempt — no retry against a re-read head");
  assert.equal(remote.value(), "00867162", "the OTHER lane's work is exactly as this call found it");
});

// ── (3) THE ABSENT-REF WINDOW IS REFUSED UNLESS ABSENCE WAS THE EXPECTATION ─────────────────

test("a push into the window where the ref is absent is refused when the lease expected a real head, not created as [new branch]", () => {
  // The exact PR #2668 shape: the branch ref is momentarily gone (a concurrent delete/replace),
  // and this lane's lease still names a real head — so absence must NOT read as "free to create".
  const remote = fakeRemote(undefined);
  const pushed: string[][] = [];
  assert.throws(
    () =>
      withLiveWritesAllowed(() =>
        gitPushEmptyCommit("/repo", "run-W1-T253-1", "f9a9d30c", "chore(ci): re-trigger", deps(remote, pushed)),
      ),
    LanePushForeignHeadError,
  );
  assert.equal(remote.value(), undefined, "the absent ref is never created out from under a lease that expected a head");
});

test("control: a lease whose expectation IS absence is honoured — the lease can create, it just never does so by accident", () => {
  // Not reachable through gitPushEmptyCommit today (it always builds on an existing `headSha`,
  // so it never asks for absence) — this proves the FAKE REMOTE's semantics are the real
  // `--force-with-lease=<ref>:` rule (matches `task-id-reservation.ts`'s own header) rather
  // than "absence always rejects", so criterion 3's refusal above is a genuine lease decision
  // and not an artifact of a remote double that only ever rejects.
  const remote = fakeRemote(undefined);
  assert.doesNotThrow(() => remote.push(["push", "--force-with-lease=refs/heads/x:", "origin", "abc123:refs/heads/x"]));
  assert.equal(remote.value(), "abc123");
});

// ── (4) A LEASE GIT ELIDES IS NOT READ AS SUCCESS — THE RESULTING REF IS VERIFIED ───────────

test("a lease git elides (exit 0, nothing actually checked) is caught by re-reading the resulting ref, not trusted from the exit code", () => {
  // Mirrors the measured trap task-id-reservation.ts's header records: `--force-with-lease`
  // against a ref already holding the value in question can exit 0 with the push ELIDED —
  // negotiated away before the lease is ever consulted. Simulated here by an `exec` that
  // always reports success while the remote it did NOT touch still carries a foreign value.
  const captureSpy: string[][] = [];
  const pushed: string[][] = [];
  assert.throws(
    () =>
      withLiveWritesAllowed(() =>
        gitPushEmptyCommit("/repo", "run-W1-T253-1", "35d636d454cc", "chore(ci): re-trigger", {
          capture: (_file, args) => {
            captureSpy.push(args);
            if (args[2] === "rev-parse") return "treeabc\n";
            if (args[2] === "commit-tree") return "newsha1\n";
            // The ELISION: the push below never actually landed anything, and the remote is
            // observed at a foreign value the exec call reported no problem with.
            if (args[2] === "ls-remote") return "foreignsha\trefs/heads/run-W1-T253-1\n";
            throw new Error(`unexpected capture: ${args.join(" ")}`);
          },
          exec: (_file, args) => {
            pushed.push(args); // exits 0 — no throw — exactly the elision's observable shape
          },
        }),
      ),
    (err: unknown) => {
      assert.ok(err instanceof LanePushForeignHeadError, "the elision must still surface as a refusal");
      return true;
    },
  );
  assert.equal(pushed.length, 1, "the push was attempted exactly once — the defect is in trusting its exit code");
  const lsRemoteCalls = captureSpy.filter((a) => a[2] === "ls-remote");
  assert.equal(lsRemoteCalls.length, 1, "the resulting ref value is actually re-read after the push");
});

// ── (5) A REFUSED PUSH RESTORES NOTHING — NO RETRY, NO FORCE-RECREATE ───────────────────────

test("a refused push makes no second attempt and issues no compensating write of any kind", () => {
  const remote = fakeRemote("someone-elses-sha");
  const pushed: string[][] = [];
  const captureSpy: string[][] = [];
  assert.throws(() =>
    withLiveWritesAllowed(() =>
      gitPushEmptyCommit("/repo", "run-W1-T253-1", "believed-sha", "m", deps(remote, pushed, captureSpy)),
    ),
  );
  // Exactly the calls needed to BUILD the commit and attempt the ONE lease-carrying push —
  // rev-parse, commit-tree, push. No ls-remote (the push itself never succeeded, so there is
  // no resulting value to verify) and nothing beyond that: no second push, no delete, no
  // recreate. Restoring a clobbered ref is an operator's call, never this leaf's (design iv).
  assert.deepEqual(
    captureSpy.map((a) => a[2]),
    ["rev-parse", "commit-tree"],
  );
  assert.equal(pushed.length, 1);
  assert.equal(remote.value(), "someone-elses-sha", "the ref this call found is the ref it left behind");
});
