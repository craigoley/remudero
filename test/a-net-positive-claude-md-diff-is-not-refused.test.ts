import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { parse } from "yaml";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "claude-md-budget-ratchet.mjs");

// `scripts/**` sits OUTSIDE tsconfig's `include`, so a static import is a TS7016 — the same
// runtime-import shape test/learnings-ratchet-candidates.test.ts settled on. A dynamic specifier
// is not statically resolved, so this loads the REAL module with no shadow copy to drift from it.
const { defaultGit, evaluateNetBytes, evaluateRatchet, measureBytesAtRef, resolveBaseRef } = (await import(
  pathToFileURL(SCRIPT).href
)) as {
  defaultGit: (args: string[]) => string;
  evaluateNetBytes: (
    headBytes: number,
    baseBytes: number | null,
    operands?: { baseRef?: string; baseSource?: string; headLabel?: string },
  ) => string[];
  evaluateRatchet: (actualBytes: number, baseline: { capBytes?: unknown }) => string[];
  measureBytesAtRef: (file: string, ref: string, deps?: object) => number | null;
  resolveBaseRef: (deps?: { env?: Record<string, string | undefined>; remoteRef?: string }) => { ref: string; source: string } | null;
};

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
}

/**
 * test/a-net-positive-claude-md-diff-is-not-refused.test.ts — W1-T2831.
 *
 * `claude-md-budget-ratchet.mjs` compared ONE number — the file's total size — against `capBytes`.
 * MASTER-PLAN §8A asks something else: that each CHANGE pay for itself. A total-size ceiling is
 * silent about per-change discipline for as long as headroom lasts, so a lane could add 400 net
 * bytes, pass every required check, and leave the cost to whoever arrives when the cap binds.
 *
 * THE PREDICATE IS NET BYTES, AND THE OBVIOUS ALTERNATIVE IS WRONG. A gate refusing "an addition
 * carrying no deletion" would have PASSED all four commits that consumed the live headroom — every
 * one already deletes something. And a LINE count is not a BYTE count: of 32 commits measured over
 * 2026-08-14..2026-09-04, twelve are in-place rewrites a line count scores as folds, one of them
 * (`22ba6cba`, 27 added / 26 removed) being the same sentence reworded for +14 bytes.
 *
 * THE THREE NON-VIOLATION STATES ARE TESTED AS HARD AS THE REFUSAL, because a gate that refuses a
 * sharpening is worse than no gate: the sharpening is the behaviour §8A is trying to buy.
 */

/** A real repo with a real base commit, so the DEFAULT git seam and both of its catch arms are
 *  exercised rather than faked. A seam every test injects around is a seam nothing covers. */
function fixtureRepo(): string {
  // The RMD-owned prefix, so src/lib/tmp.ts's sweepStaleTempDirs can reap this if a run dies
  // before its finally block — scripts/mkdtemp-callsite-check.mjs refuses a bare prefix, and it
  // refused this one.
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t2831-`));
  const git = (...args: string[]): string => gitIn(dir, ...args);
  git("init", "-q", "-b", "main", ".");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "fixture");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "CLAUDE.md"), "base content\n");
  writeFileSync(join(dir, "scripts", "claude-md-budget-baseline.json"), JSON.stringify({ capBytes: 100000 }));
  git("add", "-A");
  git("commit", "-qm", "base");
  // A local `origin/main` so `git merge-base HEAD origin/main` resolves without a network remote.
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  return dir;
}

/** Run the real CLI as a subprocess in `dir` — exit code and streams, not a function call. */
function runCli(dir: string, env: Record<string, string | undefined> = {}): { status: number; stdout: string; stderr: string } {
  const res = execFileSync("node", [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, BASE_SHA: undefined, ...env } as NodeJS.ProcessEnv,
  } as never);
  return { status: 0, stdout: res as unknown as string, stderr: "" };
}

function runCliAllowingFailure(dir: string, env: Record<string, string | undefined> = {}) {
  try {
    return { ...runCli(dir, env), status: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

// ── the refusal, naming both operands ──────────────────────────────────────────────────────────

test("W1-T2831: a net-positive CLAUDE.md diff is REFUSED, naming the base operand, head operand and delta", () => {
  const dir = fixtureRepo();
  try {
    writeFileSync(join(dir, "CLAUDE.md"), "base content rewritten\nplus four hundred more bytes worth of unearned rule\n");
    const [added, deleted] = gitIn(dir, "diff", "--numstat", "origin/main", "--", "CLAUDE.md")
      .trim()
      .split(/\s+/, 2)
      .map(Number);
    assert.ok(added > 0, "the fixture is a real CLAUDE.md diff with added content");
    assert.ok(deleted > 0, "the fixture is not the weaker add-with-no-deletion predicate");

    // The operands are DERIVED from the same compared blobs the CLI uses, never hand-computed:
    // a literal here would assert my arithmetic rather than the failure text's own operands.
    const baseRef = gitIn(dir, "merge-base", "HEAD", "origin/main").trim();
    const baseBytes = Buffer.byteLength(gitIn(dir, "show", `${baseRef}:CLAUDE.md`), "utf8");
    const headBytes = readFileSync(join(dir, "CLAUDE.md")).length;
    assert.ok(headBytes > baseBytes);
    const r = runCliAllowingFailure(dir);
    assert.equal(r.status, 1, "a net-positive diff must RED");
    assert.match(r.stdout, /cap 100000 bytes/, "the fixture remains under the total-size cap");
    assert.doesNotMatch(r.stderr, /bytes > cap/, "so the refusal is the net-byte arm, not the cap arm");
    assert.match(
      r.stderr,
      new RegExp(
        `CLAUDE\\.md grew by ${headBytes - baseBytes} bytes ` +
          `\\(base ${baseBytes} at ${baseRef} via git merge-base HEAD origin/main -> head ${headBytes} at working tree\\)`,
      ),
      "the failure names the delta and BOTH operands, including the base ref and head source",
    );
    assert.match(r.stderr, /§8A/, "and the rule it is enforcing");
    // A gate that reports a delta without naming what it was taken against is the stale-operand
    // shape (CLAUDE.md hazard (h)), so the base REF and where it came from are printed too.
    assert.match(r.stdout, /via git merge-base HEAD origin\/main/, "the base's provenance is stated on stdout");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the three states that are NOT violations ───────────────────────────────────────────────────

test("W1-T2831: a fold and a sharpening both pass — the gate never refuses the behaviour §8A buys", () => {
  const dir = fixtureRepo();
  try {
    // A FOLD: strictly fewer bytes.
    writeFileSync(join(dir, "CLAUDE.md"), "base\n");
    assert.equal(runCliAllowingFailure(dir).status, 0, "a net-negative diff must pass");

    // A SHARPENING: an in-place reword of the SAME byte length — the twelve-commit shape the
    // measurement found, which a line count would have scored as a fold and a byte count scores
    // as neutral. This is the case a naive "added lines <= removed lines" gate gets wrong.
    writeFileSync(join(dir, "CLAUDE.md"), "same content\n");
    assert.equal(readFileSync(join(dir, "CLAUDE.md")).length, 13, "the reword is byte-identical in length");
    assert.equal(runCliAllowingFailure(dir).status, 0, "a byte-neutral reword must pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2831: the arm does not fire on an untouched file, and an unresolvable base SKIPS rather than refusing or inventing a comparand", () => {
  const dir = fixtureRepo();
  try {
    // UNTOUCHED: head and base are the same blob, so the delta is zero and nothing fires.
    const untouched = runCliAllowingFailure(dir);
    assert.equal(untouched.status, 0);
    assert.match(untouched.stdout, /net bytes 0 /);

    // UNRESOLVABLE BASE: no origin/main, no BASE_SHA. It must say so and exit 0 — a check that
    // cannot determine its own comparand must not claim to have enforced one.
    execFileSync("git", ["update-ref", "-d", "refs/remotes/origin/main"], { cwd: dir });
    writeFileSync(join(dir, "CLAUDE.md"), "base content\nand a great deal of new growth besides\n");
    const skipped = runCliAllowingFailure(dir);
    assert.equal(skipped.status, 0, "an unresolvable base is a SKIP, never a refusal");
    assert.match(skipped.stdout, /base unresolved, net-byte check skipped/);
    assert.doesNotMatch(skipped.stdout, /net bytes/, "and it must not invent a comparand");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2831: a base that does not carry the file at all skips too, rather than reporting the whole file as growth", () => {
  const dir = fixtureRepo();
  try {
    assert.equal(measureBytesAtRef("no-such-file.md", "HEAD", {}), null, "an absent path at the ref is null, never 0");
    // 0 would report the entire file as growth on the very commit that introduces it.
    assert.deepEqual(evaluateNetBytes(50_000, null), []);

    // AND THROUGH THE CLI, not only the pure function: a base commit with no CLAUDE.md at all is
    // the commit that INTRODUCES the file, and it is its own arm in main(). Driving it only at the
    // function level left those lines uncovered — diff-coverage said so before this PR was pushed.
    const bare = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t2831-bare-`));
    try {
      const git = (...args: string[]): string =>
        execFileSync("git", args, {
          cwd: bare,
          encoding: "utf8",
          env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
        });
      git("init", "-q", "-b", "main", ".");
      git("config", "user.email", "fixture@example.invalid");
      git("config", "user.name", "fixture");
      mkdirSync(join(bare, "scripts"), { recursive: true });
      writeFileSync(join(bare, "scripts", "claude-md-budget-baseline.json"), JSON.stringify({ capBytes: 100000 }));
      git("add", "-A");
      git("commit", "-qm", "a base with no CLAUDE.md");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      writeFileSync(join(bare, "CLAUDE.md"), "the file, introduced by THIS commit\n");

      const r = runCliAllowingFailure(bare);
      assert.equal(r.status, 0, "introducing the file is not growth — there is nothing to compare against");
      assert.match(r.stdout, /does not carry CLAUDE\.md, net-byte check skipped/);
      assert.doesNotMatch(r.stdout, /net bytes/, "and no delta is reported from a comparand that does not exist");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the pre-existing cap contract, from the same single invocation ─────────────────────────────

test("W1-T2831: the cap check still refuses an over-cap file and still throws on a non-number capBytes, both from one invocation", () => {
  const dir = fixtureRepo();
  try {
    writeFileSync(join(dir, "scripts", "claude-md-budget-baseline.json"), JSON.stringify({ capBytes: 5 }));
    writeFileSync(join(dir, "CLAUDE.md"), "base content that is well over five bytes\n");
    const both = runCliAllowingFailure(dir);
    assert.equal(both.status, 1);
    assert.match(both.stderr, /bytes > cap 5 bytes/, "the cap violation");
    assert.match(both.stderr, /grew by \d+ bytes/, "AND the net-byte violation, from the same run");

    writeFileSync(join(dir, "scripts", "claude-md-budget-baseline.json"), JSON.stringify({ capBytes: "44000" }));
    const quoted = runCliAllowingFailure(dir);
    assert.equal(quoted.status, 1);
    assert.match(quoted.stderr, /'capBytes' must be a number/);
    assert.doesNotMatch(quoted.stdout, /cap .* bytes\)/, "and it never prints a cap it could not compare against");

    // The cap's own remedy names raising capBytes. For a NET-BYTE refusal that would read as the
    // override §8A's design forbids, so it is printed only when a cap violation is present.
    assert.deepEqual(evaluateRatchet(10, { capBytes: 100 }), [], "under cap: no cap violation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2831: a net-byte refusal under the cap does NOT advertise raising capBytes", () => {
  const dir = fixtureRepo();
  try {
    writeFileSync(join(dir, "scripts", "claude-md-budget-baseline.json"), JSON.stringify({ capBytes: 100000 }));
    writeFileSync(join(dir, "CLAUDE.md"), "base content\nplus growth that stays far under the cap\n");
    const r = runCliAllowingFailure(dir);
    assert.equal(r.status, 1, "still refused — the cap is not the only contract");
    assert.match(r.stderr, /grew by \d+ bytes/);
    assert.doesNotMatch(r.stderr, /raise scripts\/claude-md-budget-baseline\.json's capBytes/, "no cap escape offered");
    assert.match(r.stderr, /Fold, sharpen or migrate/, "the §8A remedy instead");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the no-override property, pinned rather than intended ───────────────────────────────────────

test("W1-T2831: no override exists — the script offers no flag, env read or trailer that lets growth through", () => {
  // Asserted on the SOURCE because the property is the ABSENCE of an affordance, which no call can
  // demonstrate: an escape hatch is the failure mode the design names, and a test driving only the
  // happy paths would let one be added later without reddening anything. (W1-T2905's source-text
  // census does not reach this — it counts reads of `src/` paths, and this reads `scripts/` — so
  // no declared exemption is claimed here; the read stands on the argument above.)
  const raw = readFileSync(join(REPO_ROOT, "scripts", "claude-md-budget-ratchet.mjs"), "utf8");
  // COMMENTS ARE STRIPPED FIRST, and that is not a convenience. The design section in this very
  // script NAMES the forbidden hatches ("no `--allow-growth`, no env bypass...") so that a later
  // reader knows they were refused on purpose — a raw substring scan trips on the prose that
  // documents the absence, which is the opposite of what this asserts. The subject is the CODE.
  const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  // The strip is proved on a SYNTHETIC fixture rather than on the script's own prose. Asserting
  // that "allow-growth" appears in the real file would be satisfiable BY THE COMMENT ALONE — the
  // literal lives only in the design note that documents the refusal — and that is precisely the
  // shape scripts/assertion-discrimination-check.mjs refuses, which is how this was caught.
  assert.equal(stripComments('const a = 1; // allow-growth\n'), "const a = 1;  \n", "line comments go");
  assert.equal(stripComments("/* allow-growth */const b = 2;"), " const b = 2;", "block comments go");
  const src = stripComments(raw);
  for (const hatch of [
    "allow-growth",
    "allowGrowth",
    "ALLOW_GROWTH",
    "SKIP_NET",
    "--force",
    "exempt",
    "bypass",
    "override",
  ]) {
    assert.ok(!src.includes(hatch), `the script must expose no '${hatch}' escape hatch`);
  }
  // The only env read is the documented BASE_SHA fallback, and it selects the COMPARAND — it
  // cannot make a net-positive diff pass, which the next assertion drives rather than assumes.
  const envReads = src.match(/env\.[A-Z_]+/g) ?? [];
  assert.deepEqual([...new Set(envReads)], ["env.BASE_SHA"], "BASE_SHA is the only env read");
  assert.deepEqual(evaluateNetBytes(101, 100).length, 1, "and growth is refused regardless of it");

  // parseArgs declares exactly the two pre-existing options; a new one would show up here.
  const optionBlock = src.slice(src.indexOf("options: {"), src.indexOf("});", src.indexOf("options: {")));
  assert.match(optionBlock, /file:/);
  assert.match(optionBlock, /baseline:/);
  assert.equal((optionBlock.match(/type: "string"/g) ?? []).length, 2, "no third CLI option");
});

// ── the seams, driven for real ─────────────────────────────────────────────────────────────────

test("W1-T2831: defaultGit really shells out, and resolveBaseRef prefers the run-time merge-base over BASE_SHA", () => {
  const dir = fixtureRepo();
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    assert.match(defaultGit(["rev-parse", "HEAD"]).trim(), /^[0-9a-f]{40}$/, "the real git edge, not a fake");

    const runtime = resolveBaseRef({ env: { BASE_SHA: "deadbeef" } });
    assert.match(runtime!.source, /git merge-base/, "run-time resolution wins");
    assert.notEqual(runtime!.ref, "deadbeef");

    // BASE_SHA is the DOCUMENTED fallback, reached only when merge-base cannot resolve — it is an
    // event-payload snapshot, so a re-run replays a poisoned base rather than clearing it.
    execFileSync("git", ["update-ref", "-d", "refs/remotes/origin/main"], { cwd: dir });
    const fallback = resolveBaseRef({ env: { BASE_SHA: "deadbeef" } });
    assert.equal(fallback!.ref, "deadbeef");
    assert.match(fallback!.source, /event-payload snapshot/);
    assert.equal(resolveBaseRef({ env: {} }), null, "and with neither, there is no base at all");
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2831: evaluateNetBytes is the predicate, in all four directions", () => {
  assert.deepEqual(evaluateNetBytes(100, 100), [], "neutral");
  assert.deepEqual(evaluateNetBytes(99, 100), [], "a fold");
  assert.deepEqual(evaluateNetBytes(100, null), [], "no comparand");
  assert.equal(evaluateNetBytes(101, 100).length, 1, "one byte of growth is growth");
  assert.match(evaluateNetBytes(101, 100)[0]!, /grew by 1 bytes \(base 100 -> head 101\)/);
  assert.match(
    evaluateNetBytes(101, 100, { baseRef: "abc123", baseSource: "git merge-base HEAD origin/main", headLabel: "working tree" })[0]!,
    /grew by 1 bytes \(base 100 at abc123 via git merge-base HEAD origin\/main -> head 101 at working tree\)/,
    "the CLI can make the refusal self-contained by naming both compared operands",
  );
});

test("W1-T2831: CI actually gives the arm a comparand — an unwired gate skips on every run and fires never", () => {
  // THE SHIP-UNWIRED CASE, PINNED. This job checks out at actions/checkout's default fetch-depth
  // of 1 — a shallow clone with no `origin/main` ref — so the preferred `git merge-base` cannot
  // resolve there. Without BASE_SHA the arm would take its SKIP path on every CI run, and the gate
  // would be green forever while enforcing nothing. That is indistinguishable from working, which
  // is why it is asserted rather than assumed.
  // PARSED, NOT SLICED. A text window is the wrong instrument here: this step is the LAST in its
  // job so there is no following `- name:` to bound against, and `BASE_SHA: ${{ ... }}` appears
  // SEVEN times in this file — a loose window reading a neighbouring step's env is not a
  // hypothetical false pass but the likely one. (Both were observed while writing this.)
  const ci = parse(readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8")) as {
    jobs: Record<string, { steps: Array<{ run?: string; env?: Record<string, string> }> }>;
  };
  const steps = Object.values(ci.jobs).flatMap((j) => j.steps ?? []);
  const step = steps.find((st) => (st.run ?? "").includes("claude-md-budget-ratchet"));
  assert.ok(step, "the ratchet step still exists in ci.yml");
  assert.equal(
    step!.env?.BASE_SHA,
    "${{ github.event.pull_request.base.sha }}",
    "the step must carry the PR's base sha, or the net-byte arm has no comparand and skips every run",
  );

  // And the property that makes the fallback safe to rely on: with a base present the arm runs, so
  // this wiring is what separates "enforced" from "skipped". Driven, not asserted about.
  assert.equal(evaluateNetBytes(101, 100).length, 1, "with a comparand, growth is refused");
  assert.deepEqual(evaluateNetBytes(101, null), [], "without one, the arm has nothing to say");
});
