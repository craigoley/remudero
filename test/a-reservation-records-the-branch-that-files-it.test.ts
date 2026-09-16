import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  gitRemoteRefReserver,
  parseReservationHolderLine,
  taskIdReservationRef,
  type RemoteRefReserver,
} from "../src/lib/task-id-reservation.js";

// ── W1-T3640: FIX THE MINTER, NOT THE GATE ──────────────────────────────────────────────────────
//
// The fleet daemon mints from a detached HEAD — the run branch that will file the id does not
// exist yet — so `currentBranch` (src/lib/task-id-reservation.ts) can only ever record the literal
// `"unknown"` at mint time. `task-id-existence`'s holder check (scripts/task-id-existence-check.mjs)
// reads that as an unreadable holder, and MEASURED on PR #5703 alone, eight shards each needed the
// same hand-written `unknown -> <itself>` note before the gate would pass — ceremony that discriminates
// nothing, since every daemon-minted id produces the identical `branch=unknown` and so needs the
// identical note.
//
// The fix is `RemoteRefReserver.recordFilingBranch`: once the run branch that actually files the id
// exists (its own first push), calling it re-records the reservation's holder as that branch — a
// NEW commit chained via `-p` onto the anchor this reserver instance already won, pushed with the
// SAME plain refspec `attempt` uses for the very first claim (never `+`, never
// `--force-with-lease`), so the amendment is a genuine fast-forward CAS update, not a forced one.
//
// These tests drive the src/lib copy directly, and — for the parts of the falsifier that are the
// GATE's own decision, not the minter's — the gate's own copy of the parser and the holder-conflict
// evaluator (scripts/task-id-existence-check.mjs), dynamically imported exactly as
// test/a-reservation-names-its-holder.test.ts already does, so a divergence between the two shows up
// here rather than only in production.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const gate = await import(pathToFileURL(join(REPO_ROOT, "scripts", "task-id-existence-check.mjs")).href);

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "rmd-branch-files-it-"));
}

function occurrencesFor(id: string, file: string) {
  return new Map([[id, [{ file, line: 1 }]]]);
}

/** A fake git runner tracking every `commit-tree` message by the sha it "returns", so a test can
 *  parse the EXACT message that would land on the ref, and every call so it can assert the push
 *  refspec's shape. `detached` drives `currentBranch`'s two git reads the way a real detached HEAD
 *  does: `symbolic-ref` fails, and `rev-parse --abbrev-ref HEAD` answers the literal `HEAD`. */
function fakeGitRun(opts: { detached: boolean }): {
  run: (args: string[]) => { status: number; stdout: string; stderr: string };
  calls: string[][];
  messagesBySha: Map<string, string>;
} {
  const calls: string[][] = [];
  const messagesBySha = new Map<string, string>();
  let commitCounter = 0;
  const run = (args: string[]): { status: number; stdout: string; stderr: string } => {
    calls.push(args);
    if (args[0] === "hash-object") return { status: 0, stdout: "TREE\n", stderr: "" };
    if (args[0] === "symbolic-ref") {
      return opts.detached
        ? { status: 1, stdout: "", stderr: "fatal: ref HEAD is not a symbolic ref" }
        : { status: 0, stdout: "run-already-named\n", stderr: "" };
    }
    if (args[0] === "rev-parse") {
      return opts.detached ? { status: 0, stdout: "HEAD\n", stderr: "" } : { status: 0, stdout: "run-already-named\n", stderr: "" };
    }
    if (args[0] === "commit-tree") {
      commitCounter++;
      const sha = `SHA${commitCounter}`;
      const msgIndex = args.indexOf("-m");
      messagesBySha.set(sha, msgIndex === -1 ? "" : args[msgIndex + 1]);
      return { status: 0, stdout: `${sha}\n`, stderr: "" };
    }
    if (args[0] === "push") return { status: 0, stdout: "", stderr: "" };
    return { status: 1, stdout: "", stderr: `fakeGitRun: unexpected command ${args.join(" ")}` };
  };
  return { run, calls, messagesBySha };
}

/** Mints and claims one id exactly the way the fleet daemon does: on a detached HEAD, with
 *  `GITHUB_HEAD_REF` unset — the ordinary case the task's rationale measures. Restores the env var
 *  unconditionally so one test's fake HEAD never leaks into the next. */
function mintFromDetachedHead(taskId: string): {
  fake: ReturnType<typeof fakeGitRun>;
  reserver: RemoteRefReserver;
  anchor: string;
  mintMessage: string;
} {
  const previous = process.env.GITHUB_HEAD_REF;
  delete process.env.GITHUB_HEAD_REF;
  try {
    const fake = fakeGitRun({ detached: true });
    const reserver = gitRemoteRefReserver({ run: fake.run });
    const anchor = reserver.mintAnchor();
    assert.equal(reserver.attempt(taskId, anchor), "created", "the mint itself must succeed before this test proves anything about it");
    return { fake, reserver, anchor, mintMessage: fake.messagesBySha.get(anchor) ?? "" };
  } finally {
    if (previous === undefined) delete process.env.GITHUB_HEAD_REF;
    else process.env.GITHUB_HEAD_REF = previous;
  }
}

test("unit test: a detached-HEAD reservation records its filing branch", () => {
  const { fake, reserver, anchor, mintMessage } = mintFromDetachedHead("W1-T9401");

  // THE FALSIFIER'S FIRST HALF, pinned: a detached-HEAD mint, on its own, is exactly the state
  // measured on W1-T3539 and seven PR #5703 siblings — unreadable, and it would fail
  // "holder unreadable (missing branch)" if filed right now with no note.
  assert.deepEqual(parseReservationHolderLine(mintMessage), { status: "unreadable", reason: "missing branch" });

  // The run branch that actually files W1-T9401 now exists.
  const filingBranch = "run-W1-T9401-1789572123450";
  assert.equal(reserver.recordFilingBranch!("W1-T9401", filingBranch), true, "recording a REAL, now-known branch must succeed");

  const pushes = fake.calls.filter((c) => c[0] === "push");
  assert.equal(pushes.length, 2, "one push for the mint, one for the amendment — never more");
  const amendPush = pushes[1];
  assert.equal(amendPush[1], "origin");
  assert.ok(!amendPush[2].startsWith("+"), "never a forced refspec — a plain push is what keeps this a fast-forward CAS");
  assert.ok(!amendPush.includes("--force-with-lease"), "never --force-with-lease either — see the module's own CAS note");
  const [amendedSha, ref] = amendPush[2].split(":");
  assert.equal(ref, taskIdReservationRef("W1-T9401"));

  const amendCommit = fake.calls.find((c) => c[0] === "commit-tree" && c.includes(anchor));
  assert.ok(amendCommit, "the amendment must be built ON TOP of the original anchor");
  assert.equal(amendCommit![amendCommit!.indexOf("-p") + 1], anchor, "chained via -p — the push above is a genuine fast-forward, not a force");

  const amendedMessage = fake.messagesBySha.get(amendedSha) ?? "";
  const parsed = parseReservationHolderLine(amendedMessage);
  assert.equal(parsed.status, "known", "the holder is now READABLE — no hand-off note is needed to make sense of it");
  if (parsed.status === "known") assert.equal(parsed.holder.branch, filingBranch);
});

test("unit test: a reservation naming its filer needs no hand-off note", () => {
  const { fake, reserver } = mintFromDetachedHead("W1-T9402");
  const filerBranch = "run-W1-T9402-1789572123450";
  assert.equal(reserver.recordFilingBranch!("W1-T9402", filerBranch), true);

  const amendPush = fake.calls.filter((c) => c[0] === "push").at(-1)!;
  const [amendedSha] = amendPush[2].split(":");
  const amendedMessage = fake.messagesBySha.get(amendedSha) ?? "";

  // Read the amended holder through the GATE's OWN copy of the parser — the surface
  // `evaluateReservationHolderConflicts` actually consults — so this proves the real check, not an
  // analogous one.
  const gateHolder = gate.parseReservationHolderLine(amendedMessage);
  assert.deepEqual(gateHolder, { status: "known", branch: filerBranch });

  const root = scratch();
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  const shard = "plan/tasks.d/W1-T9402.yaml";
  // Deliberately NO `reservation hand-off:` note anywhere in this shard.
  writeFileSync(join(root, shard), '- id: W1-T9402\n  title: "files itself, no note required"\n');

  const reservation = { reachable: true, ids: new Set(["W1-T9402"]), holders: new Map([["W1-T9402", gateHolder]]) };
  const conflicts = gate.evaluateReservationHolderConflicts(["W1-T9402"], occurrencesFor("W1-T9402", shard), reservation, filerBranch, root);
  assert.deepEqual(conflicts, [], "the holder check passes with NO note at all — this is the ceremony the task removes");
});

test("unit test: an unattributable holder still accepts a recorded hand-off", () => {
  const { fake, reserver, mintMessage } = mintFromDetachedHead("W1-T9403");

  // The branch STILL cannot be determined (e.g. still detached) — recordFilingBranch must be a
  // no-op, never a corruption of the reservation, and `unknown` must stay representable.
  assert.equal(reserver.recordFilingBranch!("W1-T9403", "unknown"), false, "\"unknown\" is not NEW information — nothing to record");
  assert.equal(fake.calls.filter((c) => c[0] === "push").length, 1, "a no-op amendment must not push a second commit");

  assert.deepEqual(parseReservationHolderLine(mintMessage), { status: "unreadable", reason: "missing branch" });
  const gateHolder = gate.parseReservationHolderLine(mintMessage);
  assert.deepEqual(gateHolder, { status: "unreadable", reason: "missing branch", recordedBranch: "unknown" });

  const root = scratch();
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  const shard = "plan/tasks.d/W1-T9403.yaml";
  const shardPath = join(root, shard);
  const filerBranch = "run-W1-T9403-1789572123450";
  const reservation = { reachable: true, ids: new Set(["W1-T9403"]), holders: new Map([["W1-T9403", gateHolder]]) };

  // THE FALSIFIER'S THIRD PART: with no note, a genuinely unattributable holder still refuses —
  // the escape must not become a blanket pass.
  writeFileSync(shardPath, '- id: W1-T9403\n  title: "genuinely unattributable"\n');
  const refused = gate.evaluateReservationHolderConflicts(["W1-T9403"], occurrencesFor("W1-T9403", shard), reservation, filerBranch, root);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].reason, "missing branch");
  assert.equal(refused[0].recordedBranch, "unknown", "the value to hand off FROM still rides the row");

  // With the hand-off note, the GATE's OWN pre-existing escape still clears it — unchanged by this
  // task, which only stops the ORDINARY case from needing that escape at all.
  writeFileSync(shardPath, `- id: W1-T9403\n  title: "genuinely unattributable"\n  note: "reservation hand-off: unknown -> ${filerBranch}"\n`);
  const cleared = gate.evaluateReservationHolderConflicts(["W1-T9403"], occurrencesFor("W1-T9403", shard), reservation, filerBranch, root);
  assert.deepEqual(cleared, [], "the gate's existing hand-off escape still applies unchanged");
});

test("recordFilingBranch is a no-op for a taskId this reserver never won", () => {
  const fake = fakeGitRun({ detached: true });
  const reserver = gitRemoteRefReserver({ run: fake.run });
  assert.equal(
    reserver.recordFilingBranch!("W1-T9404", "run-W1-T9404-1789572123450"),
    false,
    "nothing was ever attempt()-ed through this reserver, so there is no anchor it is safe to amend",
  );
  assert.equal(fake.calls.filter((c) => c[0] === "push").length, 0, "no push at all — never guess at an anchor to amend");
});
