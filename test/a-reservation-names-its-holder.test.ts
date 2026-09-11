import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  formatHandMintReservationMessage,
  gitRemoteRefReserver,
  parseReservationHolderLine,
  taskIdReservationRef,
  type RemoteRefReserver,
  type RemoteReserveOutcome,
} from "../src/lib/task-id-reservation.js";
import { nextTaskIdCommand } from "../src/run-task.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const gate = await import(pathToFileURL(join(REPO_ROOT, "scripts", "task-id-existence-check.mjs")).href);

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

// ── W1-T3100: the GATE's own copy of the holder parser ───────────────────────────────────────────
//
// `parseReservationHolderLine` exists TWICE: once in src/lib/task-id-reservation.ts, which the tests
// above drive, and once in scripts/task-id-existence-check.mjs, because that gate runs on a node with
// no tsx and cannot import the TypeScript one. Only the `legacy` arm of the script's copy was ever
// exercised, so `diff-coverage` reported lines 160-180 of it as added-and-uncovered — a second
// implementation of a refusal rule, shipping untested. These drive every arm of THAT copy through
// `gate.*`, never the src/ twin, so a divergence between the two shows up here instead of in
// production.

test("W1-T3100 (gate copy): a well-formed holder line yields the branch, percent- and plus-decoded", () => {
  const known = gate.parseReservationHolderLine(
    "rmd-id reservation 123@host\n\nrmd-id holder branch=run-W1-T9100-1789%2F0001+beta host=h pid=7",
  );
  // `+` is a space and %2F is a slash: the anchor encodes both, so a parser that handled only one
  // would hand a caller a branch name that does not exist.
  assert.deepEqual(known, { status: "known", branch: "run-W1-T9100-1789/0001 beta" });
});

test("W1-T3100 (gate copy): a token with no `=` is UNREADABLE and names the token", () => {
  const v = gate.parseReservationHolderLine("rmd-id holder branch=run-x notanassignment");
  assert.equal(v.status, "unreadable");
  assert.match(String(v.reason), /malformed token notanassignment/);
});

test("W1-T3100 (gate copy): a token whose `=` is FIRST is malformed — an empty key is not a key", () => {
  const v = gate.parseReservationHolderLine("rmd-id holder =novalue");
  assert.equal(v.status, "unreadable");
  assert.match(String(v.reason), /malformed token =novalue/);
});

test("W1-T3100 (gate copy): an undecodable value is UNREADABLE and names the key, not the value", () => {
  // `%zz` is not valid percent-encoding; decodeURIComponent throws and the catch must name the key
  // so an operator can see WHICH field of the anchor is corrupt.
  const v = gate.parseReservationHolderLine("rmd-id holder branch=%zz");
  assert.equal(v.status, "unreadable");
  assert.match(String(v.reason), /malformed value for branch/);
});

test("W1-T3100 (gate copy): a holder line with no branch, or a literal `unknown`, is UNREADABLE", () => {
  const missing = gate.parseReservationHolderLine("rmd-id holder host=h pid=7");
  assert.equal(missing.status, "unreadable");
  assert.match(String(missing.reason), /missing branch/);

  // `unknown` is what the minter writes when it cannot resolve a branch; treating it as a real name
  // would make every such anchor look like a held branch called "unknown".
  const unknown = gate.parseReservationHolderLine("rmd-id holder branch=unknown host=h");
  assert.equal(unknown.status, "unreadable");
  assert.match(String(unknown.reason), /missing branch/);
});

test("W1-T3100 (gate copy): the holder line is found anywhere in the message, and blank tokens are skipped", () => {
  const v = gate.parseReservationHolderLine(
    ["subject line", "", "some other trailer: x", "rmd-id holder   branch=run-W1-T9100-1   host=h  ", ""].join("\n"),
  );
  assert.deepEqual(v, { status: "known", branch: "run-W1-T9100-1" });
});

test("W1-T3100 (gate copy): the two copies never disagree on READABILITY or on WHICH branch holds", () => {
  // The two are NOT interchangeable and must not be asserted as such: the src/ copy returns a rich
  // `holder` ({branch, host, pid, source, startedAt}) and the gate's returns `{branch}`, because the
  // gate needs only the branch. A first draft of this test compared the whole object and "failed",
  // which would have been a false alarm about a divergence that does not exist.
  //
  // What they MUST agree on is the decision: whether an anchor is legacy / unreadable / known, and
  // when known, which branch holds it. That is the half a drift would break silently, since both
  // copies gate the same refusal.
  const branchOf = (v: { status: string; branch?: string; holder?: { branch?: string } }): string | undefined =>
    v.branch ?? v.holder?.branch;

  const cases = [
    "reserve W1-T9100 host-pid-time",
    "rmd-id holder branch=run-W1-T9100-1 host=h pid=7",
    "rmd-id holder branch=run-W1-T9100-1789%2F0001+beta host=h pid=7",
    "rmd-id holder host=h pid=7",
    "rmd-id holder branch=unknown",
    "rmd-id holder bad",
    "rmd-id holder =novalue",
  ];
  // POSITIVE CONTROL: the cases must actually reach more than one status, or "they agree" is a
  // statement about one arm repeated seven times.
  const statuses = new Set(cases.map((m) => gate.parseReservationHolderLine(m).status));
  assert.ok(statuses.size >= 3, `expected legacy/unreadable/known among the cases; got ${[...statuses].join(",")}`);

  for (const message of cases) {
    const a = gate.parseReservationHolderLine(message);
    const b = parseReservationHolderLine(message) as { status: string; holder?: { branch?: string } };
    assert.equal(a.status, b.status, `status disagrees on: ${message}`);
    assert.equal(branchOf(a), branchOf(b), `holding branch disagrees on: ${message}`);
  }
});
