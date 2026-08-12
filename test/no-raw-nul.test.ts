// test/no-raw-nul.test.ts — W1-T438: gate against raw NUL bytes in tracked sources.
//
// THE DEFECT. The agent harness's `grep` is a ugrep wrapper with `-I` (ignore-binary) injected
// into every invocation, so a tracked file holding even one raw NUL byte is skipped WHOLE — no
// output, exit 1, indistinguishable from the symbol genuinely not existing. Bare `rg` is blind the
// same way in a directory sweep; only `/usr/bin/grep` at a human's terminal is unaffected, which is
// why this went unnoticed. Every `files:` sweep, violation count, and scope audit that ever touched
// one of these files answered on a corpus it could not see.
//
// THE FIX (companion diff, this same PR) rewrites each raw NUL BYTE as the two-character `\0`
// ESCAPE in `src/lib/task-linter.ts`, `src/lib/flight-signals.ts`, `src/lib/verdict-calibration.ts`,
// `test/gate-properties.test.ts`, and `test/property-parsers.test.ts` — a provably byte-identical,
// hash-identical no-op at runtime (see test/nul-escape-equivalence.test.ts) that makes `file`
// classify each as text again, so ordinary sweeps see them.
//
// WHY THIS IS A TEST, NOT A `.github/workflows/ci.yml` JOB. `judgeReview`'s instrument-isolation
// predicate (Standing rule 25, W1-T297) forces the review to failure whenever a diff touches both
// an INSTRUMENT_SURFACE path and an `isProductPath` src/ file — and this PR must touch
// `src/lib/task-linter.ts` and friends, so a workflow-wired gate would fail BY CONSTRUCTION however
// good the fix is. `isProductPath` excludes `test/`, so a test-implemented gate is entangled with
// nothing. This follows the same "shell `git ls-files` from the repo root" shape already used by
// test/instrument-surface-completeness.test.ts, test/enforcement-data-carveout.test.ts,
// test/checkout-writers.test.ts, and test/moving-base-changed-files.test.ts, and runs inside the
// existing `ci` job's `npm run test:ci` with no new wiring at all.
//
// WHY EXTENSION FILTERING, NOT AN ALLOWLIST. Three tracked PNGs carry NUL bytes legitimately and
// must keep passing. Filtering the sweep to source extensions (no list of binary paths to rot, and
// no drift check needed) is preferred per this task's design unless a tracked SOURCE turns up that
// the filter misses — it did not: the fifth raw-NUL source recon found at this task's HEAD
// (`src/lib/verdict-calibration.ts`, introduced by #1614/W1-T424 the same day) is a `.ts` file, so
// the extension filter already covers it without any change.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

/** Source extensions this gate reads. Anything else (PNGs included) is never opened. */
const COVERED_EXT_RE = /\.(ts|mjs|js|json|ya?ml|md)$/;

/** Tracked, extension-covered files under `root` carrying at least one raw NUL byte, each paired
 *  with the byte offset of its first occurrence — the "name the offending path" half of the gate. */
function rawNulViolations(root: string): { path: string; offset: number }[] {
  const listing = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" });
  const tracked = listing.split("\0").filter(Boolean);
  const violations: { path: string; offset: number }[] = [];
  for (const rel of tracked) {
    if (!COVERED_EXT_RE.test(rel)) continue;
    const buf = readFileSync(join(root, rel));
    const offset = buf.indexOf(0);
    if (offset !== -1) violations.push({ path: rel, offset });
  }
  return violations;
}

test("PROPERTY none of the tracked, extension-covered sources carries a raw NUL byte", () => {
  const violations = rawNulViolations(REPO_ROOT);
  assert.deepEqual(
    violations,
    [],
    `raw NUL byte(s) found: ${violations.map((v) => `${v.path}@${v.offset}`).join(", ")}`,
  );
});

test("PROPERTY the five previously-blind sources are individually clean", () => {
  // Named explicitly, not just covered by the aggregate sweep above, so a regression in any ONE
  // of them fails on its own path rather than only on the repo-wide assertion. This is the exact
  // non-PNG output of `git ls-files -z | xargs -0 perl -0777 -ne 'print "$ARGV\n" if /\0/'` at
  // this task's HEAD (70d52c2): four sources named in W1-T438's `files:` list, plus
  // `src/lib/verdict-calibration.ts`, which recon found the same day via #1614/W1-T424 and which
  // this PR folds in so the gate does not ship blind to a file already present at its own HEAD.
  const previouslyBlind = [
    "src/lib/task-linter.ts",
    "src/lib/flight-signals.ts",
    "src/lib/verdict-calibration.ts",
    "test/gate-properties.test.ts",
    "test/property-parsers.test.ts",
  ];
  const stillTracked = new Set(
    execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" }).split("\n").filter(Boolean),
  );
  for (const path of previouslyBlind) {
    assert.equal(stillTracked.has(path), true, `${path} is no longer tracked — update this test's list`);
  }
  const violating = new Set(rawNulViolations(REPO_ROOT).map((v) => v.path));
  for (const path of previouslyBlind) {
    assert.equal(violating.has(path), false, `${path} still carries a raw NUL byte`);
  }
});

test("PROPERTY the three tracked PNGs still contain a NUL and still pass the gate unbanned", () => {
  const pngs = [
    "docs/design-review/w1-t153/shell-1440.png",
    "docs/design-review/w1-t153/shell-390.png",
    "plan/feedback/attachments/fb-1784433603527-48134e/shot.png",
  ];
  const tracked = new Set(
    execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" }).split("\n").filter(Boolean),
  );
  for (const png of pngs) {
    assert.equal(tracked.has(png), true, `${png} is no longer tracked — update this test's PNG list`);
    assert.equal(COVERED_EXT_RE.test(png), false, `${png} unexpectedly matches the covered extensions`);
    const buf = readFileSync(join(REPO_ROOT, png));
    assert.notEqual(buf.indexOf(0), -1, `${png} no longer contains a NUL byte — pick a different real-PNG fixture`);
  }
  // The gate excludes these three before it ever opens them, so they cannot appear as violations.
  const flagged = rawNulViolations(REPO_ROOT)
    .map((v) => v.path)
    .filter((p) => pngs.includes(p));
  assert.deepEqual(flagged, []);
});

test("PROPERTY a planted raw NUL in a covered file fails the check and names the exact path", () => {
  const dir = mkdtempSync(join(tmpdir(), "no-raw-nul-fixture-"));
  try {
    execFileSync("git", ["init", "--quiet", "-b", "main", dir], { encoding: "utf8", env: GIT_ENV });
    mkdirSync(join(dir, "src", "lib"), { recursive: true });

    const prefix = "export const x = 1;";
    writeFileSync(
      join(dir, "src", "lib", "planted.ts"),
      Buffer.concat([Buffer.from(prefix), Buffer.from([0]), Buffer.from("// raw NUL planted for W1-T438\n")]),
    );
    writeFileSync(join(dir, "src", "lib", "clean.ts"), "export const y = 2;\n");
    // A non-covered extension carrying a NUL must NOT be flagged, even planted right alongside.
    writeFileSync(join(dir, "fixture.png"), Buffer.concat([Buffer.from("not a real png"), Buffer.from([0])]));

    execFileSync("git", ["-C", dir, "add", "-A"], { encoding: "utf8", env: GIT_ENV });
    execFileSync("git", ["-C", dir, "commit", "--quiet", "-m", "fixture"], { encoding: "utf8", env: GIT_ENV });

    const violations = rawNulViolations(dir);
    assert.deepEqual(violations.map((v) => v.path), ["src/lib/planted.ts"]);
    assert.equal(violations[0].offset, Buffer.byteLength(prefix));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
