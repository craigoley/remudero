// test/the-one-failure-corpus-with-a-fix-attached-is-never-mined.test.ts — W1-T2957.
//
// THE ONE FAILURE SIGNAL THAT ARRIVES WITH ITS OWN FIX is read once by the fix rung, used to
// repair that pull request, and discarded. `ruleEfficacyReport`'s only corpus is the ledger, and
// `rule-efficacy.ts`'s own header says why that can never cover a gate: "HOST-SIDE, NOT A CI GATE:
// the ledger lives on the daemon host; nothing in CI can read it." So the single entry in
// RULE_SIGNATURES naming a CI gate is `measurable: false`, and 1 of 56 CLAUDE.md rule bullets is
// measured at all.
//
// This suite pins the collector that retains the pair: a red gate, and the later commit on the
// SAME pull request that turned that SAME gate green.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { collectCiFailureCorpus, type CorpusPr } from "../src/lib/ci-failure-corpus.js";

/** A check-run rollup entry, as `rollupFromRest` maps one. */
const run = (name: string, conclusion: string, startedAt = "2026-09-06T10:00:00Z") => ({ name, status: "COMPLETED", conclusion, startedAt });
/** A COMMIT STATUS entry — `remudero-review` is one of these, never a check run. */
const status = (context: string, state: string, startedAt = "2026-09-06T10:00:00Z") => ({ context, state, startedAt });

const pr = (number: number, commits: CorpusPr["commits"]): CorpusPr => ({ number, commits });

test("W1-T2957 one record per red gate, and the review COMMIT STATUS is not dropped", () => {
  // `rollupFromRest`'s own doc: reading only /check-runs "would drop `remudero-review` entirely and
  // make every reviewed PR look unreviewed". A corpus blind to it misses the gate that most often
  // refuses a PR, while passing every other assertion in this file.
  const corpus = collectCiFailureCorpus({
    prs: [
      pr(1, [{ sha: "aaa", rollup: [run("ci-shard (1/4)", "FAILURE"), status("remudero-review", "FAILURE")] }]),
    ],
  });
  assert.equal(corpus.status, "populated");
  assert.equal(corpus.prsScanned, 1);
  assert.deepEqual(corpus.fullyObservedGatePrs, [
    { pr: 1, gate: "ci-shard (1/4)" },
    { pr: 1, gate: "remudero-review" },
  ]);
  assert.deepEqual(
    corpus.pairs.map((p) => p.gate).sort(),
    ["ci-shard (1/4)", "remudero-review"],
    "a red commit status must produce a record exactly like a red check run",
  );
});

test("W1-T2957 a red gate is paired with the later commit that turned THAT gate green", () => {
  const corpus = collectCiFailureCorpus({
    prs: [
      pr(7, [
        { sha: "red1", rollup: [run("diff-coverage", "FAILURE")] },
        { sha: "fix1", rollup: [run("diff-coverage", "SUCCESS")], changedFiles: ["src/lib/x.ts", "test/x.test.ts"] },
      ]),
    ],
  });
  assert.equal(corpus.pairs.length, 1);
  const p = corpus.pairs[0];
  assert.equal(p.state, "repaired");
  assert.equal(p.redSha, "red1");
  assert.equal(p.greenSha, "fix1");
  assert.deepEqual(p.repairFiles, ["src/lib/x.ts", "test/x.test.ts"], "the repair delta is the lesson; it must be retained");
});

test("W1-T2957 a red gate with no observed repair is KEPT as an open pair", () => {
  // Dropping it would under-report; reporting it repaired would be a lie. Both are worse than open.
  const corpus = collectCiFailureCorpus({
    prs: [pr(9, [{ sha: "red1", rollup: [run("ci-gate", "FAILURE")] }])],
  });
  assert.equal(corpus.pairs.length, 1);
  assert.equal(corpus.pairs[0].state, "open");
  assert.equal(corpus.pairs[0].greenSha, undefined);
});

test("W1-T2957 green on ANOTHER pull request, or at an EARLIER sha, is not a repair", () => {
  // Both directions of the pairing falsifier. A corpus that pairs across PRs, or backwards in
  // time, would manufacture repairs that never happened and teach from them.
  const corpus = collectCiFailureCorpus({
    prs: [
      pr(1, [
        { sha: "green0", rollup: [run("ci-gate", "SUCCESS")] },
        { sha: "red1", rollup: [run("ci-gate", "FAILURE")] },
      ]),
      pr(2, [{ sha: "other", rollup: [run("ci-gate", "SUCCESS")], changedFiles: ["src/lib/unrelated.ts"] }]),
    ],
  });
  const red = corpus.pairs.filter((p) => p.gate === "ci-gate" && p.pr === 1);
  assert.equal(red.length, 1);
  assert.equal(red[0].state, "open", "an earlier green and another PR's green are both non-repairs");
  assert.equal(red[0].repairFiles, undefined);
});

test("W1-T2957 an empty window and an unreadable one are distinguishable", () => {
  // The no-naked-zero clause, the shape the adoption rung already holds. A collector returning an
  // empty array on a failed read reports "nothing went wrong" about a window it never saw.
  const clear = collectCiFailureCorpus({ prs: [pr(1, [{ sha: "a", rollup: [run("ci-gate", "SUCCESS")] }])] });
  assert.equal(clear.status, "clear");
  assert.deepEqual(clear.unreadableShas, []);

  const blind = collectCiFailureCorpus({ prs: [pr(1, [{ sha: "a" }])] });
  assert.equal(blind.status, "unreadable", "a rollup that could not be read is never a clean window");
  assert.deepEqual(blind.unreadableShas, ["a"]);
  assert.equal(blind.pairs.length, 0);
  assert.deepEqual(blind.fullyObservedGatePrs, [], "an unreadable pull request cannot certify a gate exposure");
});

test("W1-T2957 a superseded red attempt does not outvote its own successor on one sha", () => {
  // W1-T457's lesson, and W1-T2804 is the live shard about a third reader that still lacks it: a
  // sha accumulates one rollup entry PER ATTEMPT. Reading the stale attempt reports a red gate on
  // a sha that is green.
  const corpus = collectCiFailureCorpus({
    prs: [
      pr(3, [
        {
          sha: "one",
          rollup: [
            run("acceptance-author-gate", "CANCELLED", "2026-09-06T13:48:42Z"),
            run("acceptance-author-gate", "SUCCESS", "2026-09-06T13:50:02Z"),
          ],
        },
      ]),
    ],
  });
  assert.equal(corpus.status, "clear", "the latest attempt is the verdict for that sha");
  assert.equal(corpus.pairs.length, 0);
});

test("W1-T2957 the collector is reachable from the command surface, and writes nothing", () => {
  // BEHAVIOUR, NOT SOURCE TEXT (W1-T2905): reading run-task.ts as prose would pass on a comment and
  // break on a refactor that moved one. Instead CALL the shipped verb with a known window and read
  // its output — rendering a pair the collector alone can produce IS the proof it is wired.
  const wired = captured(() =>
    ciFailuresCommand([], {
      loadWindow: () => ({ prs: [pr(77, [{ sha: "wiredredsha", rollup: [run("ci-gate", "FAILURE")] }])] }),
    }),
  );
  assert.equal(wired.code, 0);
  assert.match(wired.out, /OPEN\s+#77 ci-gate\s+red=wiredred/, "an unwired collector renders no pair at all");

  // Law 5, also behavioural: the plan and the working tree are byte-identical after a full run, so a
  // report cannot file, mint, or present a machine reading as a ratified one.
  const planBefore = readFileSync("plan/tasks.yaml");
  const treeBefore = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  ciFailuresCommand([], {
    loadWindow: () => ({ prs: [pr(78, [{ sha: "s", rollup: [run("ci-gate", "FAILURE")] }])] }),
  });
  assert.ok(planBefore.equals(readFileSync("plan/tasks.yaml")), "the collector must not touch the plan");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }), treeBefore, "and must leave no file behind");
});

// ── The command surface and the real loader, both over an INJECTED fetcher ──────────────────────
// Every arm below runs the SHIPPED code path with zero network. The defaults these functions carry
// (`ghJson`) are the one line each that a unit test cannot reach; the dispatch case names that
// boundary explicitly.

import { ciFailuresCommand, commitChangedFiles, loadCiFailureWindow } from "../src/run-task.js";
import { rollupAtSha } from "../src/lib/ci-failure-corpus.js";

/** Capture console.log/error for one call. */
function captured(fn: () => number): { code: number; out: string } {
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    return { code: fn(), out: lines.join("\n") };
  } finally {
    console.log = log;
    console.error = err;
  }
}

test("W1-T2957 the verb renders each corpus status and refuses a bad window", () => {
  const repaired = captured(() =>
    ciFailuresCommand([], {
      loadWindow: () => ({
        prs: [
          pr(4, [
            { sha: "reddddddd1", rollup: [run("diff-coverage", "FAILURE")] },
            { sha: "greeeeeen1", rollup: [run("diff-coverage", "SUCCESS")], changedFiles: ["src/lib/a.ts"] },
          ]),
        ],
      }),
    }),
  );
  assert.equal(repaired.code, 0);
  assert.match(repaired.out, /status: populated/);
  assert.match(repaired.out, /REPAIRED #4 diff-coverage/);
  assert.match(repaired.out, /repair=src\/lib\/a\.ts/);

  const blind = captured(() => ciFailuresCommand(["--days", "3"], { loadWindow: () => ({ prs: [pr(5, [{ sha: "s1" }])] }) }));
  assert.equal(blind.code, 0);
  assert.match(blind.out, /3 day window/);
  assert.match(blind.out, /status: unreadable/);
  assert.match(blind.out, /UNREADABLE rollups \(never counted as green\): 1/);

  // A window that cannot be a window is refused rather than silently defaulted.
  for (const bad of [["--days", "0"], ["--days", "-2"], ["--days", "nope"]]) {
    assert.equal(captured(() => ciFailuresCommand(bad, { loadWindow: () => ({ prs: [] }) })).code, 2, bad.join(" "));
  }
  assert.equal(captured(() => ciFailuresCommand(["--bogus"], { loadWindow: () => ({ prs: [] }) })).code, 2);
});

test("W1-T2957 rollupAtSha unions both endpoints and reports an unreadable read as undefined", () => {
  const both = rollupAtSha("o", "r", "sha1", (args) => {
    const url = args[1] ?? "";
    if (url.includes("/check-runs")) return { check_runs: [{ name: "ci-gate", status: "completed", conclusion: "failure" }] };
    return { statuses: [{ context: "remudero-review", state: "failure" }] };
  });
  assert.deepEqual(
    (both ?? []).map((e) => e.name ?? e.context).sort(),
    ["ci-gate", "remudero-review"],
    "the commit-status half is what /check-runs alone cannot see",
  );
  // A throwing read is UNREADABLE, never an empty (i.e. all-green-looking) rollup.
  assert.equal(rollupAtSha("o", "r", "sha1", () => { throw new Error("403"); }), undefined);
  assert.equal(rollupAtSha("o", "r", "sha1", () => undefined), undefined);
});

test("W1-T2957 commitChangedFiles returns undefined rather than an empty repair delta", () => {
  assert.deepEqual(
    commitChangedFiles("o", "r", "s", (() => ({ files: [{ filename: "src/lib/a.ts" }, { filename: "" }] })) as never),
    ["src/lib/a.ts"],
  );
  assert.equal(commitChangedFiles("o", "r", "s", (() => ({})) as never), undefined);
  assert.equal(commitChangedFiles("o", "r", "s", (() => { throw new Error("boom"); }) as never), undefined);
});

test("W1-T2957 the loader honours the window and survives an unreadable commit list", () => {
  const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const fresh = new Date().toISOString();
  const fetchStub = ((args: string[]) => {
    const url = args[1] ?? "";
    if (url.includes("/pulls?state=all")) return [{ number: 11, updated_at: fresh }, { number: 99, updated_at: old }];
    if (url.includes("/pulls/11/commits")) return [{ sha: "c1" }];
    if (url.includes("/check-runs")) return { check_runs: [{ name: "ci-gate", status: "completed", conclusion: "failure" }] };
    if (url.endsWith("/commits/c1")) return { files: [{ filename: "src/lib/z.ts" }] };
    return { statuses: [] };
  }) as never;
  const input = loadCiFailureWindow(1, fetchStub);
  assert.deepEqual(input.prs.map((p) => p.number), [11], "a pull request outside the window is not scanned");
  assert.deepEqual(input.prs[0].commits[0].changedFiles, ["src/lib/z.ts"]);
  assert.equal(collectCiFailureCorpus(input).pairs.length, 1);

  // An unreadable commit list drops that pull request rather than inventing an empty one.
  const broken = loadCiFailureWindow(1, ((args: string[]) => {
    const url = args[1] ?? "";
    if (url.includes("/pulls?state=all")) return [{ number: 12, updated_at: fresh }];
    throw new Error("403");
  }) as never);
  assert.deepEqual(broken.prs, []);
});

test("W1-T2957 a window that could not be READ exits non-zero, never as an empty window", () => {
  const r = captured(() =>
    ciFailuresCommand([], {
      loadWindow: () => {
        throw new Error("spawnSync gh ENOENT");
      },
    }),
  );
  assert.equal(r.code, 1, "an unreadable window is a failure, not a clean report");
  assert.match(r.out, /could not be read/);
  assert.match(r.out, /no gate was red/);
  assert.doesNotMatch(r.out, /status: clear/);
});
