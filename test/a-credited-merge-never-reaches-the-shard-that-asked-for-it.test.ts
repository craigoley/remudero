// W1-T3043 — 253 of 254 shards carrying a durable merged credit still read `status: queued`,
// because the credit projection is the only completion signal and nothing writes it back. These
// tests drive the reconciler's real decision table; the credit predicate is injected, so every arm
// is exercised without a repo or a GitHub gateway.
//
// THE ONE-WAY PROPERTY IS THE POINT. A symmetric reconciler run during a GitHub outage would read
// every task as uncredited and silently reopen the whole plan.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RECONCILE_TO_STATUS,
  reconcilePlan,
  reconcileShardStatus,
} from "../src/lib/plan-reconcile.js";
import { planReconcileCommand, renderPlanReconcile } from "../src/run-task.js";

/** A shard with the real field order, so the byte-identity assertions mean something. */
function shard(over: { status?: string; retirement?: string; extra?: string } = {}): string {
  return [
    "- id: W1-T1234",
    '  title: "A TASK THAT SHIPPED — with a $ sign and a `backtick` in its prose"',
    "  repo: remudero",
    "  type: implement",
    "  verify: auto",
    "  risk: medium",
    "  budget_usd: 10.00",
    "  files: [src/lib/x.ts, test/x.test.ts]",
    `  status: ${over.status ?? "queued"}`,
    ...(over.retirement ? [`  retirement: ${over.retirement}`] : []),
    "  attempts: 3",
    "  acceptance:",
    '    - claim: "it works"',
    '      proof: "unit test: test/x.test.ts"',
    "  note: |",
    "    A note mentioning status: queued in prose, which must NOT be rewritten.",
    ...(over.extra ? [`    ${over.extra}`] : []),
    "",
  ].join("\n");
}

const merged = () => true;
const notMerged = () => false;

test("W1-T3043 criterion 1: a queued shard with a positive credit becomes merged", () => {
  const out = reconcileShardStatus(shard(), "W1-T1234", merged);
  assert.ok(out.text, "a credited queued shard must be rewritten");
  assert.match(out.text, /^ {2}status: merged$/m);
  assert.equal(RECONCILE_TO_STATUS, "merged", "the vocabulary matches the ledger verdict");
});

test("W1-T3043 criterion 4: EVERY OTHER BYTE IS UNCHANGED", () => {
  // Not merely "the status line changed" — the whole rest of the shard must be identical, because
  // a criterion edit across a 253-file diff would trip Standing rule 15 on every shard at once.
  const before = shard();
  const after = reconcileShardStatus(before, "W1-T1234", merged).text!;
  assert.equal(after, before.replace("  status: queued", "  status: merged"));
  // and the prose mentioning "status: queued" inside the note survives verbatim
  assert.match(after, /A note mentioning status: queued in prose/);
  assert.match(after, /\$ sign and a `backtick`/, "a $ in prose must survive String.replace");
  assert.match(after, /^ {2}attempts: 3$/m, "attempts must not move");
});

test("W1-T3043 criterion 3 (falsifier): THE REVERSE DIRECTION IS IMPOSSIBLE", () => {
  // THE ROW THAT MATTERS. If this function were symmetric, a GitHub outage reading every task as
  // uncredited would reopen the entire plan.
  const alreadyMerged = shard({ status: "merged" });
  assert.deepEqual(reconcileShardStatus(alreadyMerged, "W1-T1234", notMerged), {
    skipped: "status-not-queued",
  });
  assert.deepEqual(reconcileShardStatus(alreadyMerged, "W1-T1234", merged), {
    skipped: "status-not-queued",
  });
});

test("W1-T3043 criterion 3: blocked and retired shards are never rewritten", () => {
  assert.deepEqual(reconcileShardStatus(shard({ status: "blocked" }), "W1-T1234", merged), {
    skipped: "status-not-queued",
  });
  // A retirement is an operator act; a credit must never overwrite one.
  assert.deepEqual(reconcileShardStatus(shard({ retirement: "retired" }), "W1-T1234", merged), {
    skipped: "retired",
  });
});

test("W1-T3043 criterion 2 (falsifier): DARKNESS IS INERT IN EVERY FORM", () => {
  const s = shard();
  const cases: Array<[string, () => boolean | undefined]> = [
    ["a negative credit", notMerged],
    ["an undefined credit", () => undefined],
    ["a throwing predicate", () => { throw new Error("github unreachable"); }],
  ];
  for (const [label, predicate] of cases) {
    const out = reconcileShardStatus(s, "W1-T1234", predicate);
    assert.equal(out.text, undefined, `${label}: must not rewrite`);
    assert.ok(out.skipped, `${label}: must name why it declined`);
  }
});

test("W1-T3043 criterion 2: a shard with no status field is declined, not defaulted", () => {
  const noStatus = shard().replace(/^ {2}status: queued$/m, "");
  assert.deepEqual(reconcileShardStatus(noStatus, "W1-T1234", merged), { skipped: "no-status-field" });
});

test("W1-T3043: the fold reports what it did and what it declined, per cause", () => {
  const { summary, writes } = reconcilePlan(
    [
      { taskId: "A", text: shard() },
      { taskId: "B", text: shard() },
      { taskId: "C", text: shard({ status: "merged" }) },
      { taskId: "D", text: shard({ retirement: "retired" }) },
    ],
    (id) => id !== "B",
  );
  assert.deepEqual(summary.rewritten, ["A"]);
  assert.equal(writes.length, 1);
  assert.equal(summary.skipped["not-credited-merged"], 1);
  assert.equal(summary.skipped["status-not-queued"], 1);
  assert.equal(summary.skipped.retired, 1);
});

test("W1-T3043: the dry run and the real run share ONE decision path", () => {
  // reconcilePlan is pure and returns the writes rather than performing them, so a preview cannot
  // disagree with what a subsequent apply would do — they are the same call.
  const shards = [{ taskId: "A", text: shard() }];
  const first = reconcilePlan(shards, merged);
  const second = reconcilePlan(shards, merged);
  assert.deepEqual(first.writes, second.writes);
  assert.deepEqual(first.summary, second.summary);
});

// ═══════════ THE VERB — the call site that makes the module above reachable ═══════════════════
// An unwired module is dead code, and `lint-plan`'s own [call-site] check says so. These drive the
// REAL command with injected seams, so no repo, plan or GitHub gateway is touched.

test("W1-T3043 (wiring): the command CALLS the reconciler and rewrites only the credited queued shard", async () => {
  const written: Array<{ path: string; text: string }> = [];
  const code = await planReconcileCommand(["--write"], {
    readShards: () => [
      { taskId: "A", path: "/p/A.yaml", text: shard() },
      { taskId: "B", path: "/p/B.yaml", text: shard() },
      { taskId: "C", path: "/p/C.yaml", text: shard({ status: "merged" }) },
    ],
    creditedMergedIds: () => new Set(["A", "C"]),
    writeShard: (path, text) => written.push({ path, text }),
  });
  assert.equal(code, 0);
  assert.deepEqual(written.map((w) => w.path), ["/p/A.yaml"], "only the credited QUEUED shard is written");
  assert.match(written[0].text, /^ {2}status: merged$/m);
});

test("W1-T3043 (wiring): DRY RUN IS THE DEFAULT and writes nothing", async () => {
  const written: string[] = [];
  const code = await planReconcileCommand([], {
    readShards: () => [{ taskId: "A", path: "/p/A.yaml", text: shard() }],
    creditedMergedIds: () => new Set(["A"]),
    writeShard: (path) => written.push(path),
  });
  assert.equal(code, 0);
  assert.deepEqual(written, [], "no --write means no file is touched");
});

/** A HOME whose `~/.config/remudero/config.json` is exactly `body` — the same lever
 *  test/credited-proof-visibility-seam-defaults.test.ts uses, because `configPath()` is
 *  `join(homedir(), ".config", "remudero", "config.json")` and node's `os.homedir()` reads `$HOME`. */
function homeWithConfig(body: string): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-reconcile-home-"));
  const root = mkdtempSync(join(tmpdir(), "rmd-reconcile-root-"));
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), body, "utf8");
  mkdirSync(join(root, "state"), { recursive: true });
  return { home, root };
}

async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prior = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.HOME;
    else process.env.HOME = prior;
  }
}

test("W1-T3043 (wiring): with NO projection injected the REAL default runs — proved by a config it alone reads", async () => {
  // Every other case injects `creditedMergedIds`, which is right for what they assert and left
  // `defaultCreditedMergedIds` unreachable — the #977/#978 all-fakes shape, and diff-coverage
  // blocked this PR on its six lines. Omitting ONLY that seam runs the real one.
  //
  // THE PAIR IS THE DISCRIMINATOR. Both calls are identical except for the config the default
  // reads: valid => it resolves and the command completes; malformed => `loadConfig` throws and
  // the command REFUSES. An injected seam would return 0 for both, so this cannot pass without
  // the default actually being consulted. `$HOME` is the lever (not a `claude` binary on PATH),
  // so both outcomes are deterministic on a CI runner and in an agent container alike.
  const ok = homeWithConfig(JSON.stringify({ claudeBin: "/bin/echo", root: "PLACEHOLDER" }));
  writeFileSync(
    join(ok.home, ".config", "remudero", "config.json"),
    JSON.stringify({ claudeBin: "/bin/echo", root: ok.root }),
    "utf8",
  );
  const bad = homeWithConfig("{ this is not json");
  const written: string[] = [];
  try {
    const good = await withHome(ok.home, () =>
      planReconcileCommand([], {
        readShards: () => [{ taskId: "W1-T90909-synthetic", path: "/p/synthetic.yaml", text: shard() }],
        writeShard: (path) => written.push(path),
      }),
    );
    assert.equal(good, 0, "a readable config must let the real projection resolve");
    assert.equal(written.length, 0, "no --write, and a synthetic id is credited by nothing");

    const refused = await withHome(bad.home, () =>
      planReconcileCommand([], {
        readShards: () => [{ taskId: "W1-T90909-synthetic", path: "/p/synthetic.yaml", text: shard() }],
        writeShard: (path) => written.push(path),
      }),
    );
    assert.equal(refused, 1, "an unreadable config must ABORT — only the default reads it at all");
    assert.equal(written.length, 0, "and a refusal still writes nothing");
  } finally {
    rmSync(ok.home, { recursive: true, force: true });
    rmSync(ok.root, { recursive: true, force: true });
    rmSync(bad.home, { recursive: true, force: true });
    rmSync(bad.root, { recursive: true, force: true });
  }
});

test("W1-T3043 (wiring): with NO readShards injected, the REAL reader walks a directory", async () => {
  // The SECOND default seam in this command, unreachable for the same reason as the first: every
  // other case injects `readShards`. Driven through `--plan <dir>` so it walks a real fixture
  // tree and touches neither the repo nor plan/tasks.d. The directory deliberately holds all
  // three cases the reader distinguishes — a shard with an `- id:`, a .yaml WITHOUT one, and a
  // non-.yaml file — so the skip arms are exercised, not just the happy path.
  const dir = mkdtempSync(join(tmpdir(), "rmd-reconcile-shards-"));
  const written: string[] = [];
  try {
    writeFileSync(join(dir, "W1-T1234.yaml"), shard(), "utf8");
    writeFileSync(join(dir, "no-id.yaml"), "title: has no id line\n", "utf8");
    writeFileSync(join(dir, "README.md"), "not a shard\n", "utf8");
    const code = await planReconcileCommand(["--plan", dir, "--write"], {
      creditedMergedIds: () => new Set(["W1-T1234"]),
      writeShard: (path) => written.push(path),
    });
    assert.equal(code, 0);
    assert.deepEqual(
      written,
      [join(dir, "W1-T1234.yaml")],
      "the real reader must have found the id-bearing shard, and skipped the id-less .yaml and the non-.yaml",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3043 (wiring, falsifier): AN UNREADABLE SHARD DIRECTORY EXITS 2 AND NEVER REACHES THE PROJECTION", async () => {
  // The catch arm of that same seam. Reached by pointing --plan at a directory that does not
  // exist, so the REAL `readdirSync` throws — no injected thrower, so the arm is proved by the
  // failure it actually handles. `creditedMergedIds` throws too: if the command reached it, the
  // exit code would be 1, so exit 2 also proves the abort happens BEFORE the projection.
  const missing = join(tmpdir(), `rmd-reconcile-absent-${Date.now()}`);
  const written: string[] = [];
  const code = await planReconcileCommand(["--plan", missing], {
    creditedMergedIds: () => { throw new Error("must not be reached"); },
    writeShard: (path) => written.push(path),
  });
  assert.equal(code, 2, "an unreadable shard directory is a usage-level abort, not a projection failure");
  assert.equal(written.length, 0);
});

test("W1-T3043 (wiring, falsifier): AN UNREADABLE PROJECTION ABORTS AND WRITES NOTHING", async () => {
  // Treating a failed credit read as "nothing merged" would be silently safe but would report a
  // count derived from a failed read as if it were a finding.
  const written: string[] = [];
  const code = await planReconcileCommand(["--write"], {
    readShards: () => [{ taskId: "A", path: "/p/A.yaml", text: shard() }],
    creditedMergedIds: () => { throw new Error("github unreachable"); },
    writeShard: (path) => written.push(path),
  });
  assert.equal(code, 1, "a failed projection must exit non-zero");
  assert.deepEqual(written, [], "and must write nothing");
});

test("W1-T3043 (wiring): a junk argument fails loud BEFORE any read", async () => {
  let read = false;
  const code = await planReconcileCommand(["--nope"], { readShards: () => { read = true; return []; } });
  assert.equal(code, 2);
  assert.equal(read, false, "arg validation precedes I/O");
});

test("W1-T3043 (wiring): the summary names the MODE first, so a dry run cannot read as applied", async () => {
  const dry = renderPlanReconcile({ rewritten: ["A"], skipped: { "not-credited-merged": 2, "status-not-queued": 0, retired: 1, "no-status-field": 0, "credit-unreadable": 0 } }, false);
  assert.match(dry, /dry run — nothing written/);
  assert.match(dry, /would be reconciled/);
  assert.match(dry, /not-credited-merged=2/);
  assert.match(dry, /retired=1/);
  assert.doesNotMatch(dry, /status-not-queued=0/, "a zero cause is not printed as noise");

  const applied = renderPlanReconcile({ rewritten: ["A"], skipped: { "not-credited-merged": 0, "status-not-queued": 0, retired: 0, "no-status-field": 0, "credit-unreadable": 0 } }, true);
  assert.match(applied, /--write/);
  assert.match(applied, /1 shard\(s\) reconciled/);
  assert.doesNotMatch(applied, /dry run/);
});
