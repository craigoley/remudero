/**
 * test/a-task-trailer-redirects-review-to-an-unrelated-shard.test.ts — W1-T2669.
 *
 * A `Remudero-Task:` trailer makes the gate judge a PR against THAT task's shard instead of the
 * body's own `## Acceptance` block. That preference is correct — the shard is the author-time
 * contract — and the trailer is load-bearing besides, as one of the two merge-credit paths. What
 * is missing is any check that the named task has anything to do with the diff.
 *
 * MEASURED BEFORE THIS FILE EXISTED, against the shipped command: a body carrying a well-formed
 * five-bullet Acceptance block plus `Remudero-Task: W1-T1010` reported
 *
 *     criteria source: W1-T1010's shard via the body trailer
 *     criteria parsed: 6
 *     OK — the gate would judge this PR from W1-T1010's shard, not this body's block.
 *
 * with no mention that W1-T1010's declared files are `deploy/recycle-container.sh`,
 * `docs/operator-guide.md` and two more the diff never touches. The same shape was caught by hand
 * on #3559's first draft, whose trailer named the task it REACTED TO: it would have been judged on
 * eight criteria including proofs over `src/lib/github-app.ts`, failed on them, and its own five
 * criteria would never have been read.
 *
 * ADVISORY, NEVER A REFUSAL, and that is a design constraint rather than caution. A legitimate
 * build can widen beyond its declared files — the reviewer's own `scope_violation` treats
 * review-ratified widenings as legitimate — so refusing here would block honest work to catch a
 * mislabelled body. The failure mode this closes is SILENCE, not permissiveness, so the exit code
 * and the resolved criteria are both untouched.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { checkAcceptanceCommand } from "../src/run-task.js";

const PLAN = `- id: W1-T-DEPLOY
  title: a deploy-shaped task
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  status: queued
  files: [deploy/recycle-container.sh, docs/operator-guide.md]
  acceptance:
    - claim: the deploy path is covered
      proof: "grep: recycle in deploy/recycle-container.sh"
- id: W1-T-SRC
  title: a src-shaped task
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  status: queued
  files: [src/lib/thing.ts, test/thing.test.ts]
  acceptance:
    - claim: the src path is covered
      proof: "grep: thing in src/lib/thing.ts"
- id: W1-T-NOFILES
  title: a task declaring no files at all
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  status: queued
  acceptance:
    - claim: something
      proof: "grep: something in src/lib/thing.ts"
`;

function fixture(): { planPath: string; bodyPath: (body: string) => string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-trailer-relatedness-"));
  const planPath = join(dir, "tasks.yaml");
  writeFileSync(planPath, PLAN);
  let n = 0;
  return {
    planPath,
    bodyPath: (body: string) => {
      const p = join(dir, `body-${(n += 1)}.md`);
      writeFileSync(p, body);
      return p;
    },
  };
}

const OWN_BLOCK = ["A body carrying its own well-formed block.", "", "## Acceptance", "", "- my own claim | grep: thing in src/lib/thing.ts", ""].join("\n");
const withTrailer = (taskId: string) => `${OWN_BLOCK}\nRemudero-Task: ${taskId}\n`;

/** Run the command capturing stdout, so the assertions read what an operator actually sees. */
function run(args: string[], deps: Parameters<typeof checkAcceptanceCommand>[1]): { code: number; out: string } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    const code = checkAcceptanceCommand(args, deps);
    return { code, out: lines.join("\n") };
  } finally {
    console.log = orig;
  }
}

test("W1-T2669: a trailer whose task shares no path with the diff is reported beside the criteria source", () => {
  const { planPath, bodyPath } = fixture();
  const { out } = run([bodyPath(withTrailer("W1-T-DEPLOY"))], {
    planPath,
    changedFiles: () => ["src/lib/thing.ts", "test/thing.test.ts"],
  });

  assert.match(out, /criteria source: W1-T-DEPLOY's shard via the body trailer/);
  assert.match(out, /unrelated/i, "the mismatch must be named, not left silent");
  assert.match(out, /deploy\/recycle-container\.sh/, "the report names the declared files the diff never touches");
});

test("W1-T2669: a trailer whose task DOES intersect the diff is silent", () => {
  const { planPath, bodyPath } = fixture();
  const { out } = run([bodyPath(withTrailer("W1-T-SRC"))], {
    planPath,
    changedFiles: () => ["src/lib/thing.ts", "docs/unrelated.md"],
  });

  assert.match(out, /criteria source: W1-T-SRC's shard via the body trailer/);
  assert.doesNotMatch(out, /unrelated/i, "one shared path is enough — an ordinary build must stay quiet");
});

test("W1-T2669: the criteria still resolve from the shard — this reports, it never switches the source", () => {
  const { planPath, bodyPath } = fixture();
  const { out } = run([bodyPath(withTrailer("W1-T-DEPLOY"))], {
    planPath,
    changedFiles: () => ["src/lib/thing.ts"],
  });

  assert.match(out, /criteria source: W1-T-DEPLOY's shard via the body trailer/);
  assert.doesNotMatch(out, /criteria source: the body Acceptance/, "the source must not flip to the body block");
  assert.match(out, /criteria parsed: 1/, "and it is still the shard's one criterion that was parsed");
});

test("W1-T2669: a body with no trailer resolves from its own Acceptance block, unchanged", () => {
  const { planPath, bodyPath } = fixture();
  const { code, out } = run([bodyPath(OWN_BLOCK)], {
    planPath,
    changedFiles: () => ["deploy/recycle-container.sh"],
  });

  assert.match(out, /criteria source: the body Acceptance: block/);
  assert.doesNotMatch(out, /unrelated/i, "with no trailer there is no named task to be unrelated to");
  assert.equal(code, 0);
});

test("W1-T2669: the report is advisory — the exit code is what it was without it", () => {
  const { planPath, bodyPath } = fixture();
  const unrelated = run([bodyPath(withTrailer("W1-T-DEPLOY"))], {
    planPath,
    changedFiles: () => ["src/lib/thing.ts"],
  });
  const related = run([bodyPath(withTrailer("W1-T-SRC"))], {
    planPath,
    changedFiles: () => ["src/lib/thing.ts"],
  });

  assert.equal(unrelated.code, 0, "an unrelated trailer must not refuse — a widened build is legitimate");
  assert.equal(unrelated.code, related.code, "and it must not differ from the silent case either");
});

test("W1-T2669: a shard declaring no files, and an unreadable diff, are both silent rather than wrong", () => {
  const { planPath, bodyPath } = fixture();

  const noFiles = run([bodyPath(withTrailer("W1-T-NOFILES"))], {
    planPath,
    changedFiles: () => ["src/lib/thing.ts"],
  });
  assert.doesNotMatch(noFiles.out, /unrelated/i, "a task declaring nothing cannot be shown unrelated to anything");

  const unreadable = run([bodyPath(withTrailer("W1-T-DEPLOY"))], {
    planPath,
    changedFiles: () => {
      throw new Error("not a git checkout");
    },
  });
  assert.doesNotMatch(unreadable.out, /unrelated/i, "an absent diff is no evidence of a mismatch");
  assert.equal(unreadable.code, 0, "and it must never turn a readable body into a refusal");
});

test("W1-T2669: the DEFAULT changedFiles really shells out — the seam is not covered only by its fakes", () => {
  // Every test above injects `changedFiles`, which leaves the default unreachable: the exact shape
  // CLAUDE.md records as making a seam's default and its catch arm invisible to coverage. This one
  // omits the dep so `checkAcceptanceChangedFiles` runs for real against this checkout's own git.
  //
  // ASSERTS WHAT HOLDS EITHER WAY, deliberately. In a full checkout the read succeeds and the
  // relatedness comparison happens; in a shallow one with no origin/main it throws and
  // `trailerScopeMismatch` swallows it. Both must leave a readable body passing — that is the
  // advisory contract, and pinning the diff's CONTENT here would pin this test to a moving branch.
  const { planPath, bodyPath } = fixture();
  const { code, out } = run([bodyPath(withTrailer("W1-T-DEPLOY"))], { planPath });

  assert.equal(code, 0, "the real git read must never turn a readable body into a refusal");
  assert.match(out, /criteria source: W1-T-DEPLOY's shard via the body trailer/);
  assert.match(out, /criteria parsed: 1/, "and the shard's criteria still resolve either way");
});
