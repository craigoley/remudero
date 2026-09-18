import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  GREP_TARGET_EXTENSIONLESS,
  grepProofTargetRefusal,
  proofGrepSafetyViolations,
  type GrepProofTargetKind,
} from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";

/**
 * W1-T3653. `grepProofTargetNamesNoFile` (review.ts) approximates "is this path a file" with a
 * PURE has-a-dot heuristic, because the parse it backs has no checkout to ask. That heuristic
 * refuses every tracked, extensionless FILE this repo actually carries — `hooks/pre-push`,
 * `hooks/pre-commit`, `hooks/commit-msg` — reading each as though it named a directory.
 *
 * This file proves the fix at the filing-time linter (`proofGrepSafetyViolations`, the check that
 * blocked #5740): {@link grepProofTargetRefusal} settles blob-vs-tree EXACTLY through a caller-
 * injected reader, still refuses a genuine directory or a genuinely absent path (each with its own
 * wording, so a typo never reads as a deliberate directory target), and — with no reader injected
 * at all, the standing default for every pre-existing call site — degrades to today's heuristic,
 * named {@link GREP_TARGET_EXTENSIONLESS}, unchanged.
 */

const REPO_ROOT = process.cwd();

/** A REAL, git-backed reader — `git cat-file -t HEAD:<path>` is the "cat-file type read" the
 *  task's own design text names as blob-vs-tree's other equally exact form (the alternative it
 *  offers beside asking the index directly, which a directory pathspec also satisfies, forcing a
 *  second `stat` call to break that tie). One object-type read settles the exact same three-way
 *  verdict directly from git's own model — `blob` is a real file, `tree` is a real directory, and
 *  anything else (git's own diagnostic on stderr, not a type word) is nothing at this path in this
 *  checkout. */
function realGrepProofTargetKind(): (repoRelPath: string) => GrepProofTargetKind | undefined {
  return (repoRelPath: string) => {
    let kind: string;
    try {
      kind = execFileSync("git", ["cat-file", "-t", `HEAD:${repoRelPath}`], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "absent";
    }
    if (kind === "blob") return "file";
    if (kind === "tree") return "directory";
    return "absent";
  };
}

function taskWithProof(proof: string): Task {
  return {
    id: "W1-TTEST",
    title: "t",
    status: "todo",
    depends_on: [],
    verify: "auto",
    acceptance: [{ claim: "a claim", proof }],
  } as unknown as Task;
}

// ── criterion 1: a tracked extensionless file is accepted, and grep really executes against it ──

test("a tracked extensionless file (hooks/pre-push) is ACCEPTED by the injected reader", () => {
  const reader = realGrepProofTargetKind();
  assert.equal(
    grepProofTargetRefusal("hooks/pre-push", reader),
    undefined,
    "a real tracked file is accepted regardless of its own name carrying no extension",
  );

  const v = proofGrepSafetyViolations(taskWithProof("grep: #!/bin/sh in hooks/pre-push"), {
    grepProofTargetKind: reader,
  });
  assert.deepEqual(v.filter((x) => x.severity === "block"), [], JSON.stringify(v));
});

test("the extensionless file's grep proof actually executes — real grep, real file, real match", () => {
  assert.ok(existsSync(join(REPO_ROOT, "hooks/pre-push")), "the fixture file this task names is really tracked here");
  const out = execFileSync("grep", ["-arn", "--", "#!/bin/sh", "hooks/pre-push"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.match(out, /^(?:hooks\/pre-push:)?1:#!\/bin\/sh$/m, "grep ran against the real extensionless file and found the real line");
});

test("the extensionless grep proof accepts a path-prefixed line from grep", () => {
  assert.match(
    "hooks/pre-push:1:#!/bin/sh\n",
    /^(?:hooks\/pre-push:)?1:#!\/bin\/sh$/m,
    "the proof accepts grep implementations that include the file operand",
  );
});

// ── criterion 2: a directory target is still refused ──────────────────────────────────────────

test("a directory target is still refused", () => {
  const asDirectory: (p: string) => GrepProofTargetKind | undefined = () => "directory";
  const reason = grepProofTargetRefusal("src/lib", asDirectory);
  assert.ok(reason, "a directory is refused even with a reader injected");
  assert.match(reason!, /is a directory/i);
  assert.ok(!/does not exist/i.test(reason!), "a directory is never worded as absent");

  const v = proofGrepSafetyViolations(taskWithProof("grep: something in src/lib"), { grepProofTargetKind: asDirectory });
  const blocking = v.filter((x) => x.severity === "block");
  assert.equal(blocking.length, 1, JSON.stringify(v));
  assert.match(blocking[0].message, /is a directory/i);

  // CONTROL: a real file, same reader, is not caught by this arm.
  const asFile: (p: string) => GrepProofTargetKind | undefined = () => "file";
  assert.equal(grepProofTargetRefusal("src/lib/plan.ts", asFile), undefined);
});

// ── criterion 3: an absent path is refused as absent, never as a directory ────────────────────

test("an absent path is refused as absent not as a directory", () => {
  const asAbsent: (p: string) => GrepProofTargetKind | undefined = () => "absent";
  const reason = grepProofTargetRefusal("hooks/pre-pushh", asAbsent);
  assert.ok(reason, "an absent path is refused");
  assert.match(reason!, /does not exist/i);
  assert.ok(!/is a directory/i.test(reason!), "an absent path never reads as a directory — a typo reads as a typo");

  const v = proofGrepSafetyViolations(taskWithProof("grep: something in hooks/pre-pushh"), {
    grepProofTargetKind: asAbsent,
  });
  const blocking = v.filter((x) => x.severity === "block");
  assert.equal(blocking.length, 1, JSON.stringify(v));
  assert.match(blocking[0].message, /does not exist/i);
  assert.ok(!/is a directory/i.test(blocking[0].message));

  // CONFIRM with the real git-backed reader too: a genuinely absent path in THIS checkout.
  const real = realGrepProofTargetKind();
  assert.match(grepProofTargetRefusal("hooks/does-not-exist-at-all", real)!, /does not exist/i);
});

// ── criterion 4: with no repo reader injected, the extension heuristic still applies ──────────

test("with no reader injected, the extension heuristic still applies (GREP_TARGET_EXTENSIONLESS)", () => {
  assert.equal(typeof GREP_TARGET_EXTENSIONLESS, "string");
  assert.match(
    grepProofTargetRefusal("hooks/pre-push")!,
    /names no file/,
    "with no reader at all — every pre-existing call site — the same real file is refused exactly as before",
  );
  assert.equal(grepProofTargetRefusal("src/lib/plan.ts"), undefined, "the heuristic still accepts an ordinary dotted file");
  assert.equal(grepProofTargetRefusal("src/lib"), "target `src/lib` names no file — a `grep:` proof must name a FILE (a path whose final segment carries an extension, e.g. src/lib/plan.ts) — a directory target is not a proof of anything specific");

  const v = proofGrepSafetyViolations(taskWithProof("grep: something in hooks/pre-push"));
  assert.equal(v.filter((x) => x.severity === "block").length, 1, "unchanged default behaviour: still refused with no reader");

  // A reader that cannot resolve THIS path (returns undefined) degrades the same way as no reader.
  const unresolved: (p: string) => GrepProofTargetKind | undefined = () => undefined;
  assert.match(grepProofTargetRefusal("hooks/pre-push", unresolved)!, /names no file/);
});
