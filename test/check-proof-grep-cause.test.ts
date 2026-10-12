import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const CLI = fileURLToPath(new URL("../src/run-task.ts", import.meta.url));

// ── W1-T1224: `grepZeroHitCauseLine`'s wiring inside `checkProofCommand` — line-seam, case-only ──
// and matched, exercised through the REAL command against a REAL `grep` child process, never a
// re-implementation of the classifier's own decision. `test/grep-zero-cause.test.ts` already
// covers `classifyGrepZeroHit` (src/lib/grep-zero-cause.ts) at the unit level with fixtures; this
// suite proves the three non-`absent` causes actually surface on `checkProofCommand`'s own stdout
// for a genuinely-run zero-hit `grep:` proof — `absent` itself is already covered live by
// test/check-proof-executor-parity.test.ts's "does-not-exist" fixture.

/** A throwaway checkout containing exactly one file, `src/marker.txt`, holding `content` — same
 *  fixture shape test/check-proof-base.test.ts already established for this verb. */
function markerFixture(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-check-proof-grep-cause-"));
  const target = join(dir, "src", "marker.txt");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return dir;
}

/** Run the public command from the fixture checkout and capture its process result. */
function runCheckProof(argv: string[], cwd: string): { code: number; out: string } {
  const result = spawnSync(process.execPath,
    ["--import", import.meta.resolve("tsx"), CLI, "--repo-root", cwd, "check-proof", ...argv],
    { cwd, encoding: "utf8", timeout: 60_000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.notEqual(result.status, null, result.stderr);
  return { code: result.status!, out: result.stdout };
}

test("line-seam: a phrase wrapped across a line break reads a genuine zero-hit grep AND a line-seam cause", () => {
  // "quick brown" never appears on one physical line — real grep genuinely finds nothing.
  const dir = markerFixture("the quick\nbrown fox\n");
  try {
    const { code, out } = runCheckProof(["grep:", "quick brown", "in", "src/marker.txt"], dir);
    assert.equal(code, 1, "a genuine zero-hit grep proof fails, exactly as before this task");
    assert.match(out, /^exit:\s+1\s*$/m);
    assert.match(out, /^hits:\s+0\s*$/m);
    assert.match(out, /^verdict:\s+fail\s*$/m);
    assert.match(out, /^cause:\s+line-seam —/m, "the wrapped phrase must classify as line-seam, not absent");
    assert.match(out, /this can NEVER\s*$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("case-only: a phrase present with different capitalisation reads a genuine zero-hit grep AND a case-only cause", () => {
  // grep with no `-i` is case-sensitive — "hello world" genuinely finds nothing against "Hello World".
  const dir = markerFixture("Hello World\n");
  try {
    const { code, out } = runCheckProof(["grep:", "hello world", "in", "src/marker.txt"], dir);
    assert.equal(code, 1);
    assert.match(out, /^exit:\s+1\s*$/m);
    assert.match(out, /^hits:\s+0\s*$/m);
    assert.match(out, /^verdict:\s+fail\s*$/m);
    assert.match(out, /^cause:\s+case-only —/m, "the differently-cased phrase must classify as case-only, not absent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("matched: a real GNU-grep-vs-classifier disagreement over an escaped `\\+` reads a matched cause, not absent", () => {
  // GNU grep's BRE treats `\+` as its own "one or more" extension, so `grep: ab\+c` genuinely
  // finds nothing in a file whose only text is the four literal characters "ab+c" (measured: exit
  // 1, zero hits). The classifier's own BRE-emulating translator (breSource, grep-zero-cause.ts)
  // keeps an escaped `\+` as a literal plus, matching "ab+c" on its one line — the exact matcher
  // disagreement `matched` exists to name, never misreported as a legitimate forward reference.
  const dir = markerFixture("ab+c\n");
  try {
    const { code, out } = runCheckProof(["grep:", "ab\\+c", "in", "src/marker.txt"], dir);
    assert.equal(code, 1, "the real grep genuinely found nothing");
    assert.match(out, /^exit:\s+1\s*$/m);
    assert.match(out, /^hits:\s+0\s*$/m);
    assert.match(out, /^verdict:\s+fail\s*$/m);
    assert.match(out, /^cause:\s+matched —/m, "a genuine matcher disagreement must classify as matched, not absent");
    assert.match(out, /matcher disagreement, not a fact about the file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
