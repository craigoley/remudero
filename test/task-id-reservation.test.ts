import { strict as assert } from "node:assert";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  classifyPushFailure,
  firstUnreservedAtOrAbove,
  gitRemoteRefReserver,
  reserveTaskIdRemote,
  reserveTaskIdBlockRemote,
  taskIdReservationRef,
  type RemoteRefReserver,
  type RemoteReserveOutcome,
  liveReservedIds,
  readTaskIdReservation,
  reserveTaskIdFrom,
  taskIdReservationPath,
  taskIdReservationsDir,
  TaskIdReservationError,
  idReservationFailureFields,
  withIdReservationLogging,
} from "../src/lib/task-id-reservation.js";
import { DECISION_RELEVANT_LEDGER_STEPS, appendLedger, rotateLedger } from "../src/lib/ledger.js";
import { parseWhitelistedProof, narrowNameFilteredArgs } from "../src/lib/review.js";

/**
 * The property this module exists for: a minted id is unusable by anyone else from the moment it
 * is minted. Every test here drives the REAL filesystem — the atomicity being asserted is
 * `openSync(path, "wx")`'s, so a faked fs would assert nothing.
 */

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "rmd-idres-"));
}

const ALIVE = () => true;
const DEAD = () => false;

test("two concurrent mints of the SAME id get DIFFERENT ids — the core property", () => {
  const dir = join(scratch(), "task-id-reservations");
  // Both callers minted W1-T300 from the same snapshot, exactly the defect: neither source saw
  // the other because neither had pushed.
  const first = reserveTaskIdFrom(300, dir, { isPidAlive: ALIVE });
  const second = reserveTaskIdFrom(300, dir, { isPidAlive: ALIVE });

  assert.equal(first.id, 300, "the first minter keeps the id it derived");
  assert.equal(second.id, 301, "the second ADVANCES rather than colliding");
  assert.notEqual(first.id, second.id);
  // Both hold a real, separate file — not one overwriting the other.
  assert.ok(existsSync(first.path));
  assert.ok(existsSync(second.path));
  assert.notEqual(first.path, second.path);

  // A third caller minting the same stale number advances past BOTH.
  const third = reserveTaskIdFrom(300, dir, { isPidAlive: ALIVE });
  assert.equal(third.id, 302);
});

test("a reservation whose holder is DEAD is reclaimed, not burned", () => {
  const dir = join(scratch(), "task-id-reservations");
  mkdirSync(dir, { recursive: true });
  // A crashed minter's leftover: the file exists, its pid does not.
  writeFileSync(
    taskIdReservationPath(dir, 400),
    JSON.stringify({ id: 400, pid: 999999, host: "gone", startedAt: "2026-01-01T00:00:00Z", purpose: "crashed" }),
  );

  const handle = reserveTaskIdFrom(400, dir, { isPidAlive: DEAD });

  assert.equal(handle.id, 400, "the dead holder's id is REUSED, never skipped — no phantom id");
  assert.equal(readTaskIdReservation(handle.path)?.pid, process.pid, "the file now names the live claimant");
  assert.deepEqual(liveReservedIds(dir, { isPidAlive: DEAD }), [], "a dead holder is never reported as live");
});

test("a GARBAGE reservation file is reclaimed exactly like a dead pid — an unparseable holder is no holder", () => {
  const dir = join(scratch(), "task-id-reservations");
  mkdirSync(dir, { recursive: true });
  writeFileSync(taskIdReservationPath(dir, 500), "{ this is not json");

  assert.equal(readTaskIdReservation(taskIdReservationPath(dir, 500)), null);
  const handle = reserveTaskIdFrom(500, dir, { isPidAlive: ALIVE });
  assert.equal(handle.id, 500, "a torn write must not wedge an id shut forever");
});

test("a minter that CANNOT reserve throws TaskIdReservationError rather than proceeding", () => {
  // A path that cannot be a directory: its parent is a FILE. mkdirSync fails with ENOTDIR, which
  // is not contention and must never be swallowed into "carry on with the unreserved id" — the
  // caller spawns a paid worker immediately after this returns.
  const root = scratch();
  const blocker = join(root, "state");
  writeFileSync(blocker, "i am a file, not a directory");
  assert.throws(
    () => reserveTaskIdFrom(600, taskIdReservationsDir(root), { isPidAlive: ALIVE }),
    (e: unknown) => e instanceof TaskIdReservationError && /cannot create the task-id reservation directory/.test((e as Error).message),
    "an unwritable reservation store must be LOUD, never a silent fallback",
  );
});

test("the single-minter common case is unchanged — one reserve returns the minted id verbatim", () => {
  const dir = join(scratch(), "task-id-reservations");
  const handle = reserveTaskIdFrom(279, dir, { isPidAlive: ALIVE });
  assert.equal(handle.id, 279, "no contention ⇒ the mint's answer is used as-is");
  assert.deepEqual(liveReservedIds(dir, { isPidAlive: ALIVE }), [279]);

  handle.release();
  assert.equal(existsSync(handle.path), false, "release removes the file");
  assert.deepEqual(liveReservedIds(dir, { isPidAlive: ALIVE }), [], "and the id returns to the pool");

  handle.release(); // idempotent — a finally AND a signal handler may both call it
  assert.equal(existsSync(handle.path), false);
});

test("firstUnreservedAtOrAbove READS reservations without taking one — the advisory reader never burns an id", () => {
  const dir = join(scratch(), "task-id-reservations");
  const held = reserveTaskIdFrom(700, dir, { isPidAlive: ALIVE });

  const before = readdirSync(dir).length;
  assert.equal(firstUnreservedAtOrAbove(700, dir, { isPidAlive: ALIVE }), 701, "it skips the live reservation");
  assert.equal(firstUnreservedAtOrAbove(700, dir, { isPidAlive: ALIVE }), 701, "and is stable across calls");
  assert.equal(readdirSync(dir).length, before, "READING must create no file — otherwise every query burns an id");

  held.release();
  assert.equal(firstUnreservedAtOrAbove(700, dir, { isPidAlive: ALIVE }), 700, "released ⇒ reported free again");
});

// ── ADVISORY READ SEES THE REMOTE (W1-T518) ──────────────────────────────────
//
// `dir` is a worker sandbox's local, ephemeral directory — empty by construction on a fresh
// worker, whether or not the remote (`refs/rmd-id/*`) holds anything. Every test below leaves
// `dir` UNCREATED, exactly that sandbox state, and drives the injected `readRemoteHeld` reader
// to prove what the read sees and does not see.

test("the advisory read sees a reservation held on the remote", () => {
  const dir = join(scratch(), "task-id-reservations"); // never created — nothing held LOCALLY
  const readRemoteHeld = () => new Set([700]);

  assert.equal(
    firstUnreservedAtOrAbove(700, dir, { isPidAlive: ALIVE, readRemoteHeld }),
    701,
    "an id held ONLY on the remote is skipped, exactly as a local reservation would be",
  );
  assert.equal(existsSync(dir), false, "the read must not have created the local dir");
  // ADVISORY, PER THE FUNCTION'S OWN DOC CONTRACT: "Reporting a number and claiming it are
  // different acts, and only the caller that will actually FILE should claim." Seeing the remote
  // must not start claiming it — no ref, no file, nothing written by this call.
  assert.equal(
    firstUnreservedAtOrAbove(700, dir, { isPidAlive: ALIVE, readRemoteHeld }),
    701,
    "stable across calls — a read, not a claim",
  );
});

test("an unreachable remote degrades the advisory read instead of reporting free", () => {
  const dir = join(scratch(), "task-id-reservations"); // never created — the sandbox-empty case
  const readRemoteHeld = (): Set<number> | "unknown" => "unknown";

  assert.equal(
    firstUnreservedAtOrAbove(700, dir, { isPidAlive: ALIVE, readRemoteHeld }),
    "unknown",
    "a failed read of the remote must surface as unknown, never fold into a free number",
  );
});

test("a local only reader reports an id that the remote already holds", () => {
  // PINS THE DEFECT this task closes: with no `readRemoteHeld` injected — the exact call every
  // caller made before this change — an id reserved ONLY on the remote is invisible, and the read
  // reports it free. `rmd next-task-id` made this call unmodified in a worker sandbox, where `dir`
  // is empty by construction, and reported free for ids the remote already held.
  const dir = join(scratch(), "task-id-reservations"); // local dir has nothing
  assert.equal(
    firstUnreservedAtOrAbove(700, dir, { isPidAlive: ALIVE }),
    700,
    "a local-only reader is blind to a remote-held id — this is the collision input, not a fix",
  );
});

test("an id held nowhere — neither locally nor on the remote — is still returned unchanged", () => {
  // THE OTHER HALF OF THE FALSIFIER: a reader that skipped everything would pass the "sees the
  // remote" test above by accident if it also over-reported. This pins the false-positive side.
  const dir = join(scratch(), "task-id-reservations");
  const readRemoteHeld = () => new Set([701, 702]); // holds NEIGHBORS, not 700 itself
  assert.equal(
    firstUnreservedAtOrAbove(700, dir, { isPidAlive: ALIVE, readRemoteHeld }),
    700,
    "an id nobody holds must still be reported as itself",
  );
});

test("an exhausted scan window throws rather than looping forever", () => {
  const dir = join(scratch(), "task-id-reservations");
  // Fill the whole window with LIVE reservations, then ask for one more.
  reserveTaskIdFrom(800, dir, { isPidAlive: ALIVE, maxScan: 2 });
  reserveTaskIdFrom(800, dir, { isPidAlive: ALIVE, maxScan: 2 });
  assert.throws(
    () => reserveTaskIdFrom(800, dir, { isPidAlive: ALIVE, maxScan: 2 }),
    (e: unknown) => e instanceof TaskIdReservationError && /no free task id in W1-T800\.\.W1-T801/.test((e as Error).message),
    "the bound must fail loud — an unbounded loop inside a paid caller is worse than a refusal",
  );
});

test("a missing reservation directory reads as nothing reserved rather than throwing", () => {
  const dir = join(scratch(), "never-created");
  assert.deepEqual(liveReservedIds(dir), []);
  assert.equal(firstUnreservedAtOrAbove(42, dir), 42);
});

test("nextTaskIdCommand still exits 0 when the config — and so the reservation store — is unreadable", async (t) => {
  // THE CI REGRESSION (caught by `ci` on the first push of this change, missed by every scoped
  // local run because THIS host has a valid config): `loadConfig()` JSON.parses a file that a
  // fresh HOME leaves EMPTY, throwing "Unexpected end of JSON input". The reservation READ must
  // degrade to silence — an advisory verb that spawns nothing must never crash an operator's
  // query because the state directory is unreachable. The LOUD rule is for the caller about to
  // SPEND, and that path is deliberately not softened.
  const home = scratch();
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), ""); // exactly CI's shape
  const realHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = realHome;
  });

  const planDir = scratch();
  mkdirSync(join(planDir, "plan"), { recursive: true });
  const planPath = join(planDir, "plan", "tasks.yaml");
  writeFileSync(planPath, "- id: W1-T5\n");
  t.mock.method(console, "log", () => {});

  const { nextTaskIdCommand } = await import("../src/run-task.js");
  assert.equal(await nextTaskIdCommand(["--plan", planPath, "--offline"]), 0);
});

test("the reservation record is human-readable and names its purpose for the operator", () => {
  const dir = join(scratch(), "task-id-reservations");
  const handle = reserveTaskIdFrom(281, dir, { isPidAlive: ALIVE, info: { purpose: "rmd triage fb-abc (run R1)" } });
  const raw = readFileSync(handle.path, "utf8");
  assert.match(raw, /"purpose": "rmd triage fb-abc \(run R1\)"/, "an operator running `cat` must see WHO holds it and WHY");
  assert.match(raw, /"pid"/);
  assert.match(handle.path, /W1-T00281\.json$/, "zero-padded so `ls` sorts numerically");
});

// ── REMOTE RESERVATION (W1-T509) ─────────────────────────────────────────────
//
// THE ONLY TEST THAT MATTERS IS THE CONCURRENT ONE. A suite asserting that ONE reservation
// succeeds proves nothing here — the pre-W1-T509 allocator passes that, and passed it while eight
// id collisions landed in four days. Every test below drives TWO writers at the SAME candidate.

/** A fake remote whose ref store is a Map: create-if-absent, exactly what the real server does for
 *  an orphan payload. `taken` is returned for an occupied ref REGARDLESS of the anchor offered,
 *  which is the property falsification (1) shows `refs/tags/` does NOT have. */
function fakeRemote(): { refs: Map<string, string>; reserverFor: (anchor: string) => RemoteRefReserver } {
  const refs = new Map<string, string>();
  return {
    refs,
    reserverFor: (anchor: string) => ({
      mintAnchor: () => anchor,
      attempt: (taskId, offered): RemoteReserveOutcome => {
        const ref = taskIdReservationRef(taskId);
        const held = refs.get(ref);
        if (held === undefined) { refs.set(ref, offered); return "created"; }
        return "taken";
      },
    }),
  };
}

test("a second reservation of the same task id is refused", () => {
  const remote = fakeRemote();
  const a = reserveTaskIdRemote(700, remote.reserverFor("anchor-A"));
  const b = reserveTaskIdRemote(700, remote.reserverFor("anchor-B"));
  assert.equal(a.taskId, "W1-T700", "the first writer takes the candidate");
  assert.notEqual(b.taskId, a.taskId, "the second writer must NOT be handed the same id");
  assert.equal(b.taskId, "W1-T701", "contention advances rather than refusing — both writers leave with an id");
  assert.equal(b.attempts, 2, "the loser attempted the taken id once, then advanced exactly once");
  // SUFFIX-AWARE: the ref is the whole token, so a suffixed id is a different ref entirely.
  assert.notEqual(taskIdReservationRef("W1-T1"), taskIdReservationRef("W1-T1B"));
});

test("the reservation anchor differs per writer", () => {
  // THE REGRESSION GUARD FOR FALSIFICATION (1). A tag-shaped remote accepts a push whose sha
  // already matches — `Everything up-to-date`, rc=0 — so two writers sharing an anchor would BOTH
  // be told they won. This asserts the anchor is per-writer AND that a shared-anchor remote is
  // exactly what breaks, so nobody "simplifies" the payload back to a common commit.
  const remote = fakeRemote();
  const a = reserveTaskIdRemote(800, remote.reserverFor("anchor-A"));
  const b = reserveTaskIdRemote(800, remote.reserverFor("anchor-B"));
  assert.notEqual(a.anchor, b.anchor, "two writers must never present the same payload");
  assert.equal(remote.refs.get(a.ref), "anchor-A", "the ref holds the winner's own anchor");

  // A TAG-SHAPED remote: an occupied ref accepts an IDENTICAL sha and reports success. Under it,
  // the second writer is handed the FIRST writer's id — the silent double-allocation this task exists to stop.
  const tagRefs = new Map<string, string>();
  const tagLike = (anchor: string): RemoteRefReserver => ({
    mintAnchor: () => anchor,
    attempt: (taskId, offered): RemoteReserveOutcome => {
      const ref = taskIdReservationRef(taskId);
      const held = tagRefs.get(ref);
      if (held === undefined) { tagRefs.set(ref, offered); return "created"; }
      return held === offered ? "created" : "taken"; // <- `Everything up-to-date`
    },
  });
  const shared = "same-anchor-both-writers";
  const t1 = reserveTaskIdRemote(900, tagLike(shared));
  const t2 = reserveTaskIdRemote(900, tagLike(shared));
  assert.equal(t1.taskId, t2.taskId, "FALSIFICATION 1 REPRODUCED: a shared anchor hands both writers W1-T900");
});

test("an unreachable remote refuses to mint an id", () => {
  const dead: RemoteRefReserver = { mintAnchor: () => "anchor", attempt: () => "unreachable" };
  assert.throws(
    () => reserveTaskIdRemote(500, dead),
    (e: unknown) => {
      assert.ok(e instanceof TaskIdReservationError);
      assert.match((e as Error).message, /refusing to mint/);
      return true;
    },
    "an unreachable remote must refuse, never fall through to an optimistic mint",
  );
  // The classifier is what separates the two, and it defaults the UNKNOWN case to unreachable.
  assert.equal(classifyPushFailure("! [rejected] (non-fast-forward)"), "taken");
  assert.equal(classifyPushFailure("hint: Updates were rejected because the tag already exists"), "taken");
  assert.equal(classifyPushFailure("fatal: unable to access: Could not resolve host: github.com"), "unreachable");
  assert.equal(classifyPushFailure("ssh: connect to host github.com port 22: Operation timed out"), "unreachable");
});

test("reservation retries are bounded and name the attempted range", () => {
  const allTaken: RemoteRefReserver = { mintAnchor: () => "anchor", attempt: () => "taken" };
  assert.throws(
    () => reserveTaskIdRemote(600, allTaken, { maxScan: 5 }),
    (e: unknown) => {
      assert.ok(e instanceof TaskIdReservationError);
      assert.match((e as Error).message, /W1-T600\.\.W1-T604/, "the failure must NAME the range it attempted");
      return true;
    },
  );
});

test("the bounded loop stops at maxScan rather than hammering the remote", () => {
  let attempts = 0;
  const counting: RemoteRefReserver = { mintAnchor: () => "a", attempt: () => { attempts++; return "taken"; } };
  try { reserveTaskIdRemote(600, counting, { maxScan: 5 }); } catch { /* expected */ }
  assert.equal(attempts, 5, "an unbounded retry against a network service is the failure mode this bound exists for");
});

test("the git-backed reserver pushes an orphan payload to the id's own ref", () => {
  const calls: string[][] = [];
  const reserver = gitRemoteRefReserver({
    run: (args) => {
      calls.push(args);
      if (args[0] === "hash-object") return { status: 0, stdout: "TREE\n", stderr: "" };
      if (args[0] === "commit-tree") return { status: 0, stdout: "ORPHAN\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
    anchor: undefined,
  });
  const anchor = reserver.mintAnchor();
  assert.equal(anchor, "ORPHAN");
  const commitTree = calls.find((c) => c[0] === "commit-tree");
  assert.ok(commitTree, "the anchor must come from commit-tree");
  assert.ok(!commitTree!.includes("-p"), "NO parent — an orphan is what makes two writers' payloads unrelated");
  assert.equal(reserver.attempt("W1-T509", anchor), "created");
  const push = calls.find((c) => c[0] === "push");
  assert.deepEqual(push, ["push", "origin", "ORPHAN:refs/rmd-id/W1-T509"]);
});

// ── W1-T949: EVERY ID A FILING CREATES GETS A REF, NOT JUST THE FIRST ───────────────────────
//
// `reserveTaskIdRemote` alone has exactly one call site and reserves exactly one ref, while
// triage's own prompt tells the worker to "number them upward" for a second/third id, and the
// plan/approve lanes only ever reserved a block LOCALLY (a worker-sandbox path nobody else
// shares). `reserveTaskIdBlockRemote` is the remote-substrate twin of `reserveTaskIdBlock`,
// pushing one ref PER reserved id rather than one ref total.

test("W1-T949: a filing that creates N ids reserves N refs", () => {
  const remote = fakeRemote();
  const N = 4;
  const block = reserveTaskIdBlockRemote(1000, N, remote.reserverFor("writer-A"));

  assert.equal(block.ids.length, N);
  assert.equal(block.taskIds.length, N);
  assert.equal(block.refs.length, N);
  assert.deepEqual(block.ids, [1000, 1001, 1002, 1003], "contiguous from the start id — no contention here");
  assert.equal(
    remote.refs.size,
    N,
    `a filing that creates ${N} ids must push ${N} refs to the remote, one per id — not one fixed ref regardless of N`,
  );
  for (const id of block.ids) {
    assert.ok(remote.refs.has(taskIdReservationRef(`W1-T${id}`)), `W1-T${id}'s own ref must be pushed`);
  }
});

test("W1-T949: a filing that creates one id reserves exactly one ref", () => {
  // THE PAIRED FALSIFIER (design (v)): the test above alone is satisfied by an implementation
  // that always pushes a FIXED block regardless of the requested count — calling with count=1 is
  // what catches that: a fixed-N implementation would push N refs here too, not 1.
  const remote = fakeRemote();
  const block = reserveTaskIdBlockRemote(2000, 1, remote.reserverFor("writer-B"));

  assert.equal(block.ids.length, 1);
  assert.deepEqual(block.ids, [2000]);
  assert.equal(remote.refs.size, 1, "exactly one ref for a one-id filing — never a fixed block size regardless of N");
});

test("W1-T949: reserveTaskIdBlockRemote refuses a non-positive count instead of silently reserving nothing", () => {
  const remote = fakeRemote();
  assert.throws(() => reserveTaskIdBlockRemote(1, 0, remote.reserverFor("writer-C")), TypeError);
  assert.throws(() => reserveTaskIdBlockRemote(1, 1.5, remote.reserverFor("writer-C")), TypeError);
  assert.equal(remote.refs.size, 0);
});

// ── W1-T949 DESIGN (vi): THE FILE-SHA-BRACKETED MUTATION CHECK ───────────────────────────────
//
// "A positive test alone proves nothing here, and this is the trap." An implementation that
// reserves only the FIRST id and silently no-ops the rest would still show ONE ref landing —
// the check is: read the sha256 of the edited file, remove the per-id reservation, read the
// sha256 again and require it to DIFFER, run the suite and require the N-ref test to FAIL,
// restore, and require the sha to return to the original (design note (vi), verbatim).
//
// This mutates the REAL, checked-out `src/lib/task-id-reservation.ts` on disk (restored in a
// `finally`, verified byte-identical by its own sha256 afterward), then spawns a REAL child
// `node --test` process — the same house-dialect proof-execution shape `remudero-review`'s own
// `parseWhitelistedProof`/`narrowNameFilteredArgs` build for a bare `unit test: <name>`
// acceptance proof (test/dispatch-lifetime-breaker.test.ts's W1-T951 mutation test is the model
// this one follows) — narrowed via `--test-name-pattern` to ONLY the "N ids reserves N refs"
// test above, in this SAME file. That narrowing is what makes same-file safe: the pattern
// matches that one test's name and no other's, so THIS test (a different name) is never invoked
// by the child and no recursive re-entry occurs.

// ISOLATION (W1-T2291): THIS CHECK NO LONGER WRITES THE SHARED WORKSPACE. NOT A COVERAGE FIX.
// It used to write the REAL, checked-out `src/lib/task-id-reservation.ts` for the duration of a
// child spawn, restoring it in a `finally`. The restore always worked; the hazard was the
// WINDOW -- `node --test` runs files in parallel by default, so any other worker that read or
// instrumented `src/lib/task-id-reservation.ts` inside that window saw the per-id reservation
// loop already collapsed to one. A test must not edit its own subject in a workspace it shares
// with concurrent readers, whatever it restores afterwards. The mutation now lands on a COPY in
// a temp root and the child is pointed at that -- the exact shape test/ledger-rotation.test.ts's
// own W1-T964 check uses (fixed by #2881), reproduced here rather than re-derived.
test("W1-T949: removing the per id reservation fails the N ref test", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const srcRelPath = join("src", "lib", "task-id-reservation.ts");
  const srcPath = join(repoRoot, srcRelPath);
  const targetTestFile = "test/task-id-reservation.test.ts";
  const positiveTestName = "W1-T949: a filing that creates N ids reserves N refs";

  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

  const original = readFileSync(srcPath, "utf8");
  const originalSha = sha256(original);

  // THE PER-ID RESERVATION: reserveTaskIdBlockRemote's loop, which calls reserveTaskIdRemote
  // ONCE PER id in the block. Mutated to loop exactly once regardless of `count`, so a block of
  // N collapses to reserving only the first id — the exact defect this task exists to close,
  // reintroduced on purpose to prove the positive test actually catches it.
  const needle = "  for (let i = 0; i < count; i++) {\n    const h = reserveTaskIdRemote(next, reserver, opts);\n";
  const occurrences = original.split(needle).length - 1;
  assert.equal(
    occurrences,
    1,
    "sanity: the per-id remote-reservation loop must appear EXACTLY once, or this mutation is not targeting the real rung",
  );
  const mutated = original.replace(
    needle,
    "  for (let i = 0; i < 1; i++) { // W1-T949 MUTATION: per-id reservation removed, always reserves ONE\n" +
      "    const h = reserveTaskIdRemote(next, reserver, opts);\n",
  );

  const whitelisted = parseWhitelistedProof(`unit test: ${positiveTestName}`);
  assert.ok(whitelisted, "sanity: the proof text must parse as a name-filtered `unit test:` dialect proof");
  assert.ok(whitelisted!.nameFiltered, "sanity: it must be the name-filtered shape (carries --test-name-pattern)");
  const args = narrowNameFilteredArgs(whitelisted!.args, [targetTestFile]);

  // `src/`, `plan/` (loadDefaultPolicy's plan/policy.yaml, self-located from a copied module's
  // own install path -- see ledger-rotation.test.ts's identical note) and `test/setup/` are
  // copied into a temp sandbox; `node_modules` is symlinked so `tsx` resolves exactly as it does
  // in the real tree. The child runs with `cwd` set to the sandbox, so its own
  // `--test-name-pattern`-narrowed run of THIS file resolves `../src/lib/task-id-reservation.js`
  // to the MUTATED COPY while every concurrently-running worker in the real tree keeps reading
  // the committed file.
  const sandbox = mkdtempSync(join(tmpdir(), "w1-t949-mutation-sandbox-"));
  let childResult: ReturnType<typeof spawnSync> | undefined;
  try {
    cpSync(join(repoRoot, "src"), join(sandbox, "src"), { recursive: true });
    cpSync(join(repoRoot, "plan"), join(sandbox, "plan"), { recursive: true });
    cpSync(join(repoRoot, "test", "setup"), join(sandbox, "test", "setup"), { recursive: true });
    copyFileSync(join(repoRoot, targetTestFile), join(sandbox, targetTestFile));
    for (const f of ["package.json", "tsconfig.json"]) copyFileSync(join(repoRoot, f), join(sandbox, f));
    symlinkSync(join(repoRoot, "node_modules"), join(sandbox, "node_modules"));

    writeFileSync(join(sandbox, srcRelPath), mutated);
    const mutatedSha = sha256(readFileSync(join(sandbox, srcRelPath), "utf8"));
    assert.notEqual(mutatedSha, originalSha, "the mutation must actually change the sandbox copy's bytes");
    assert.equal(
      sha256(readFileSync(srcPath, "utf8")),
      originalSha,
      "the CHECKED-OUT task-id-reservation.ts must be untouched while the mutated child runs -- a " +
        "concurrent worker instrumenting it must never observe the per-id reservation already removed",
    );

    // `NODE_TEST_CONTEXT` (set by node's OWN test runner on the process running THIS test) is
    // inherited by a plain `spawnSync` env by default — node's test runner treats its presence
    // as "this is a recursive `run()` call" and SKIPS running any files at all, exiting 0 having
    // executed nothing. Strip it so the child is a genuinely independent `node --test`
    // invocation, not a silently-skipped no-op that would make this check pass for the wrong
    // reason (test/dispatch-lifetime-breaker.test.ts's W1-T951 mutation test notes the same trap).
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    childResult = spawnSync(process.execPath, args, { cwd: sandbox, encoding: "utf8", timeout: 90_000, env: childEnv });
  } finally {
    // The sandbox goes away regardless of what the child did. There is nothing to RESTORE: the
    // checked-out tree was never written, so a throw or a timeout cannot leave it mutated -- the
    // failure mode the old restore-in-finally existed to bound is now structurally absent.
    rmSync(sandbox, { recursive: true, force: true });
  }

  assert.equal(
    sha256(readFileSync(srcPath, "utf8")),
    originalSha,
    "the checked-out task-id-reservation.ts must be byte-identical after the check -- it is never written at all",
  );
  assert.ok(childResult, "sanity: the child process must actually have been spawned");
  assert.notEqual(
    childResult!.status,
    0,
    `removing the per-id reservation must fail the N-ref test — child exited ${childResult!.status}\n` +
      `stdout:\n${childResult!.stdout}\nstderr:\n${childResult!.stderr}`,
  );
});

// ── W1-T949 DESIGN (iv): A REFUSAL TO RESERVE MUST BE READABLE A WEEK LATER ──────────────────
//
// Before this, `reserveTaskIdRemote`'s `TaskIdReservationError` landed only as a stringified
// message inside a lane's generic `*.error` field — no id, no ref, no outcome discriminator —
// and `DECISION_RELEVANT_LEDGER_STEPS` carried zero `*.error` steps, so `rotateLedger` archived
// those rows on the ordinary schedule and the evidence a reservation was refused was gone
// (rationale (6)). This proves both halves: the thrown error carries the structured fields a
// lane's catch logs, and the ledger step each lane logs them under survives a rotation that
// archives everything around it.

test("W1-T949: a failed reservation leaves a durable ledger event", () => {
  const dead: RemoteRefReserver = { mintAnchor: () => "anchor", attempt: () => "unreachable" };

  let caught: TaskIdReservationError | undefined;
  try {
    reserveTaskIdBlockRemote(700, 3, dead);
    assert.fail("an unreachable remote must throw, never return a partial block");
  } catch (e) {
    assert.ok(e instanceof TaskIdReservationError);
    caught = e as TaskIdReservationError;
  }

  // THE STRUCTURE a lane's catch logs (run-task.ts's triage/plan/approve reservation catches) —
  // the id it could not reserve, the ref, and the classified outcome, never just the message.
  assert.equal(caught!.taskId, "W1-T700");
  assert.equal(caught!.ref, taskIdReservationRef("W1-T700"));
  assert.equal(caught!.outcome, "unreachable");

  // REGISTERED FOR RETENTION: each lane's own failure step is in DECISION_RELEVANT_LEDGER_STEPS,
  // so rotateLedger keeps it rather than archiving it away with the rest of the run's noise.
  for (const step of ["triage.id_reservation_failed", "plan.id_reservation_failed", "approve.id_reservation_failed"]) {
    assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has(step), `${step} must be retained across a ledger rotation`);
  }

  // DURABLE END TO END: append the exact shape a lane logs, pad well past the rotation ceiling
  // with ordinary polling noise, rotate, and read the live file back.
  const dir = mkdtempSync(join(tmpdir(), "rmd-idres-ledger-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  appendLedger(
    ledgerPath,
    {
      run_id: "r0",
      task_id: "TRIAGE-fb-durable-test",
      step: "triage.id_reservation_failed",
      id: caught!.taskId,
      ref: caught!.ref,
      outcome: caught!.outcome,
      error: caught!.message,
    },
    { ceilingBytes: Number.MAX_SAFE_INTEGER },
  );
  for (let n = 0; n < 250; n++) {
    writeFileSync(
      ledgerPath,
      JSON.stringify({ step: "ci.polling", run_id: `noise-${n}`, task_id: "W1-NOISE", detail: "x".repeat(64) }) + "\n",
      { flag: "a" },
    );
  }
  const ceiling = 2000;
  const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling });
  assert.equal(result.rotated, true, "sanity: the padded ledger must actually cross the rotation ceiling");

  const survivors = readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const failure = survivors.find((l) => l.step === "triage.id_reservation_failed");
  assert.ok(failure, "the reservation-refusal event must survive the rotation that archived the noise around it");
  assert.equal(failure!.id, "W1-T700");
  assert.equal(failure!.ref, taskIdReservationRef("W1-T700"));
  assert.equal(failure!.outcome, "unreachable");
});

// ── W1-T949 design (iv): THE REFUSAL RECORD IS ONE POLICY, NOT THREE COPIES ──────────────────
// Three filing lanes reserve remote ids — triage, plan and approve — and each needs the identical
// durable record when the reservation refuses: the id, the ref, the machine-classified outcome,
// and the message, never the message alone (an operator has to tell an unreachable origin from an
// exhausted range from a local store fault, and free text is not queryable). Written as a `catch`
// per lane it was three places to drift AND unreachable from a unit test, since each lived inside
// a `run-task.ts` lane body. Both arms are exercised directly here; `test/plan-lane-mint.test.ts`
// carries the end-to-end half, driving a real lane into a real remote refusal.

/** Records every ledger row a run emits, so a test asserts the CALL and its fields. */
function logRecorder(): { rows: Array<{ step: string; extra?: Record<string, unknown> }>; log: (step: string, extra?: Record<string, unknown>) => void } {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  return { rows, log: (step, extra) => void rows.push({ step, extra }) };
}

test("withIdReservationLogging returns the body's value and ledgers NOTHING when it does not throw", () => {
  const rec = logRecorder();
  assert.equal(withIdReservationLogging(rec.log, "triage.id_reservation_failed", () => 42), 42);
  assert.deepEqual(rec.rows, [], "a successful reservation must never write a refusal row");
});

test("withIdReservationLogging ledgers the id, ref and outcome and rethrows the SAME error", () => {
  const rec = logRecorder();
  const err = new TaskIdReservationError("cannot reach origin", {
    taskId: "W1-T7",
    ref: taskIdReservationRef("W1-T7"),
    outcome: "unreachable",
  });

  let thrown: unknown;
  try {
    withIdReservationLogging(rec.log, "triage.id_reservation_failed", () => {
      throw err;
    });
  } catch (e) {
    thrown = e;
  }

  assert.equal(thrown, err, "the SAME error object propagates — never swallowed, never re-wrapped");
  assert.equal(rec.rows.length, 1, "exactly one row per refusal");
  assert.equal(rec.rows[0].step, "triage.id_reservation_failed", "under the step the LANE names, not a shared one");
  assert.deepEqual(rec.rows[0].extra, {
    id: "W1-T7",
    ref: "refs/rmd-id/W1-T7",
    outcome: "unreachable",
    error: "cannot reach origin",
  });
});

test("withIdReservationLogging records an absent ref as null rather than omitting the key", () => {
  // The exhausted arm names a starting id but NO single ref — it is the range that ran out. The
  // key must still be present: to a later `zgrep` over the ledger, a missing key and a key that
  // is genuinely empty read identically, and only one of them is a fact about the failure.
  const rec = logRecorder();
  const exhausted = new TaskIdReservationError("no free task id in W1-T5..W1-T54", { taskId: "W1-T5", outcome: "exhausted" });
  assert.throws(() => withIdReservationLogging(rec.log, "plan.id_reservation_failed", () => {
    throw exhausted;
  }), TaskIdReservationError);
  assert.deepEqual(Object.keys(rec.rows[0].extra!).sort(), ["error", "id", "outcome", "ref"]);
  assert.equal(rec.rows[0].extra!.ref, null);
  assert.deepEqual(idReservationFailureFields(exhausted), {
    id: "W1-T5",
    ref: null,
    outcome: "exhausted",
    error: "no free task id in W1-T5..W1-T54",
  });
});

test("withIdReservationLogging leads with the caller's own field and never lets it shadow the error's", () => {
  const rec = logRecorder();
  const err = new TaskIdReservationError("cannot reach origin", { taskId: "W1-T7", outcome: "unreachable" });

  assert.throws(() => withIdReservationLogging(rec.log, "approve.id_reservation_failed", () => {
    throw err;
  }, { proposal_id: "P45" }), TaskIdReservationError);
  assert.deepEqual(Object.keys(rec.rows[0].extra!), ["proposal_id", "id", "ref", "outcome", "error"], "the lane's field leads the row");

  rec.rows.length = 0;
  assert.throws(() => withIdReservationLogging(rec.log, "approve.id_reservation_failed", () => {
    throw err;
  }, { id: "SHADOW" }), TaskIdReservationError);
  assert.equal(rec.rows[0].extra!.id, "W1-T7", "a colliding caller key must never displace the error's own id");
});

test("withIdReservationLogging passes any OTHER error through unlogged", () => {
  // The negative control for every assertion above. Without it they would all hold just as well
  // for a wrapper that ledgered a refusal for any failure at all — which would file a reservation
  // incident for, say, a filesystem error in the worktree, and send triage at the wrong organ.
  const rec = logRecorder();
  const other = new TypeError("something else entirely");

  let thrown: unknown;
  try {
    withIdReservationLogging(rec.log, "triage.id_reservation_failed", () => {
      throw other;
    });
  } catch (e) {
    thrown = e;
  }

  assert.equal(thrown, other, "it propagates unchanged");
  assert.deepEqual(rec.rows, [], "and is NOT ledgered as a reservation refusal");
});
