import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkProofCommand, CHECK_PROOF_EXIT } from "../src/run-task.js";

/** This repo's own root — used ONLY by the NOT-COMPARABLE test below, which needs a real
 *  `unit test:` proof (a `grep:`-only fixture dir cannot resolve one) rather than the throwaway
 *  single-file `headFixture` every other test in this suite uses. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── W1-T912: `rmd check-proof` answered a different question than the reviewer asks ─────────────
//
// Without --base, check-proof reports whether a proof MATCHES the working tree — one tree, one
// verdict. The reviewer separately re-runs a passing proof against the PR's merge-base and, when it
// matches BOTH, downgrades it to `executed_stale` (W1-T273 for `grep:`, extended to `unit test:` by
// W1-T362): the proof discriminates nothing, so it counts for nothing in review. #1943 shipped this
// live, TWICE in one body — two `grep:` proofs that read `verdict: pass` locally matched the merge
// base too, and were replaced only because the session happened to re-check by hand. Nothing in the
// tooling asked for it.
//
// This suite drives the REAL exported `checkProofCommand`, never a re-implementation of its
// decision — the same discipline test/check-proof-executor-parity.test.ts and
// test/check-proof-suite-run.test.ts already establish for this verb. The "base tree" is a literal
// fixture directory's content string, injected via `checkProofCommand`'s new `baseBlobDeps.showBlob`
// seam — no real git ref, no real `git show` spawn, ever needs to exist for these tests: the
// comparison is decidable from two fixture trees with no spawn beyond the executor this verb already
// drives (the grep child process `execWhitelistedProof` itself spawns).

/** Run `checkProofCommand` with stdout captured, from `cwd`. Restores both, always — same
 *  discipline the sibling check-proof suites use for this verb. */
function runCheckProof(
  argv: string[],
  cwd: string,
  deps?: Parameters<typeof checkProofCommand>[1],
): { code: number; out: string } {
  const lines: string[] = [];
  const realLog = console.log;
  const realCwd = process.cwd();
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    process.chdir(cwd);
    const code = checkProofCommand(argv, deps);
    return { code, out: lines.join("\n") };
  } finally {
    console.log = realLog;
    process.chdir(realCwd);
  }
}

/** A throwaway "head" checkout containing exactly one file, `src/marker.txt`, holding `content`. */
function headFixture(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-check-proof-base-head-"));
  const target = join(dir, "src", "marker.txt");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return dir;
}

const NEEDLE = "NEEDLE_TOKEN_W1_T912";
const PROOF_ARGV = ["grep:", NEEDLE, "in", "src/marker.txt"];
const FAKE_BASE_REF = "deadbeef0000000000000000000000000000000";

// ── Acceptance #1: matches head, NOT base ⇒ reported as discriminating ───────────────────────────

test("a proof that matches head and not base is reported as discriminating", () => {
  const head = headFixture(`this line carries ${NEEDLE}\n`);
  try {
    const { code, out } = runCheckProof(["--base", FAKE_BASE_REF, ...PROOF_ARGV], head, {
      // The "base tree" holds unrelated content — the needle is absent there, so the base run
      // genuinely fails to match. No real `<ref>` needs to exist for this: the seam is exactly
      // what makes that true.
      baseBlobDeps: { showBlob: () => "this line does not carry the token\n" },
    });

    assert.equal(code, CHECK_PROOF_EXIT.pass, "head still passes — --base must not re-rank the head verdict");
    assert.match(out, /^verdict:\s+pass\s*$/m, "the ordinary head verdict line is unchanged");
    assert.match(out, /^base:\s+fail\s*$/m, "the base run genuinely found nothing");
    assert.match(
      out,
      /^discrimination:\s+discriminates\b/m,
      "head and base disagree, so this proof tells done from not-done",
    );
    assert.doesNotMatch(out, /executed_stale/, "a discriminating proof must never be reported stale");
  } finally {
    rmSync(head, { recursive: true, force: true });
  }
});

// ── Acceptance #2: matches BOTH head and base ⇒ reported stale, under the reviewer's own name ────

test("a proof matching both trees is reported stale rather than passing", () => {
  const head = headFixture(`this line carries ${NEEDLE}\n`);
  try {
    const { code, out } = runCheckProof(["--base", FAKE_BASE_REF, ...PROOF_ARGV], head, {
      // The "base tree" ALSO carries the needle — the proof would have matched before the work
      // ever existed, so it discriminates nothing.
      baseBlobDeps: { showBlob: () => `this line ALSO carries ${NEEDLE} already, before any work\n` },
    });

    assert.match(out, /^verdict:\s+pass\s*$/m, "the raw head run genuinely passed — check-proof does not lie about that");
    assert.match(out, /^base:\s+pass\s*$/m, "the base run also genuinely passed");
    assert.match(
      out,
      /^discrimination:\s+executed_stale\b/m,
      "must be reported under the reviewer's OWN name for this downgrade (W1-T273/W1-T362)",
    );
    assert.notEqual(
      code,
      CHECK_PROOF_EXIT.pass,
      "a proof that would count for nothing in review must not exit as a plain local pass",
    );
    assert.equal(code, CHECK_PROOF_EXIT.executedStale, "must map to its own distinct exit code, never fail/no-match either");
  } finally {
    rmSync(head, { recursive: true, force: true });
  }
});

// ── Acceptance #3: omitting --base ⇒ byte-identical to today, no existing caller shifts ──────────

test("check proof without a base flag behaves exactly as it does today", () => {
  const head = headFixture(`this line carries ${NEEDLE}\n`);
  try {
    const withoutBase = runCheckProof([...PROOF_ARGV], head);
    const withBaseThatWouldRefuseIfConsulted = runCheckProof([...PROOF_ARGV], head, {
      // Proves the seam is genuinely inert without --base: an injected showBlob that would blow
      // up if ever called must never fire when the flag itself is absent.
      baseBlobDeps: {
        showBlob: () => {
          throw new Error("must never be called — --base was not given");
        },
      },
    });

    assert.equal(withoutBase.code, CHECK_PROOF_EXIT.pass);
    assert.equal(withoutBase.code, withBaseThatWouldRefuseIfConsulted.code);
    assert.equal(withoutBase.out, withBaseThatWouldRefuseIfConsulted.out, "an unconsulted deps object changes nothing");

    for (const line of ["proof:", "parse:", "argv:", "exit:", "hits:", "verdict:"]) {
      assert.ok(withoutBase.out.includes(line), `expected the unchanged ${line} diagnostic line to survive`);
    }
    assert.doesNotMatch(withoutBase.out, /^base(?: ref)?:/m, "no base-comparison line may appear without --base");
    assert.doesNotMatch(withoutBase.out, /^discrimination:/m, "no discrimination line may appear without --base");
  } finally {
    rmSync(head, { recursive: true, force: true });
  }
});

// ── Falsifier, both directions (design (iv)): a check that called everything stale, or one that ──
// never fired, must both fail this suite ─────────────────────────────────────────────────────────

test("FALSIFIER: a head-only match and a both-trees match resolve to genuinely different discrimination verdicts", () => {
  const head = headFixture(`this line carries ${NEEDLE}\n`);
  try {
    const headOnly = runCheckProof(["--base", FAKE_BASE_REF, ...PROOF_ARGV], head, {
      baseBlobDeps: { showBlob: () => "no token here\n" },
    });
    const both = runCheckProof(["--base", FAKE_BASE_REF, ...PROOF_ARGV], head, {
      baseBlobDeps: { showBlob: () => `${NEEDLE} already here\n` },
    });

    assert.notEqual(headOnly.code, both.code, "a real discriminator must disagree with a real non-discriminator");
    assert.match(headOnly.out, /discrimination:\s+discriminates/);
    assert.match(both.out, /discrimination:\s+executed_stale/);
  } finally {
    rmSync(head, { recursive: true, force: true });
  }
});

// ── Acceptance #4: `--base` given with NO ref value is REFUSED, not a silent argv-eating bug ─────

test("--base with no trailing <ref> is refused rather than swallowing the next token", () => {
  const head = headFixture(`this line carries ${NEEDLE}\n`);
  try {
    // `--base` is the LAST token: `rest[baseFlagIdx + 1]` is genuinely out of bounds, never another
    // proof token silently reinterpreted as the ref.
    const { code, out } = runCheckProof([...PROOF_ARGV, "--base"], head, {
      baseBlobDeps: {
        showBlob: () => {
          throw new Error("must never be called — a refused run executes nothing");
        },
      },
    });

    assert.equal(code, CHECK_PROOF_EXIT.refused, "a dangling --base with no ref must refuse, never execute");
    // The refusal message itself goes to console.error (stderr), not the console.log stdout this
    // helper captures — asserting on `out` here would assert on the wrong stream. What matters for
    // THIS suite is behavioral: nothing executed at all.
    assert.equal(out, "", "nothing was ever executed — no diagnostic line at all, not even a verdict");
  } finally {
    rmSync(head, { recursive: true, force: true });
  }
});

// ── Acceptance #5: base blob genuinely UNREADABLE — a broken `git show`, never a false discriminator ─

test("a base blob that fails to READ (not merely absent) is reported UNREADABLE, distinct from a genuine base miss", () => {
  const head = headFixture(`this line carries ${NEEDLE}\n`);
  try {
    const { code, out } = runCheckProof(["--base", FAKE_BASE_REF, ...PROOF_ARGV], head, {
      // No `status`/`code` at all — baseBlobErrorIsAbsence (W1-T460) fails CLOSED on exactly this
      // shape: anything unrecognised is a READ FAILURE, never absence.
      baseBlobDeps: {
        showBlob: () => {
          throw new Error("simulated git show failure — not a `status: 128` path-absent");
        },
      },
    });

    assert.equal(code, CHECK_PROOF_EXIT.pass, "the head verdict itself is untouched by an unreadable base blob");
    assert.match(out, /^base:\s+UNREADABLE/m);
    assert.match(out, /base_unreadable degrade the reviewer itself uses \(W1-T460\)/);
    assert.match(
      out,
      /^discrimination:\s+unknown\s+—\s+reported verdict above stands unchanged\s*$/m,
      "an unreadable base is inconclusive, never counted as a false discrimination",
    );
    assert.doesNotMatch(out, /ABSENT at/, "must not be conflated with the genuine forward-reference case");
  } finally {
    rmSync(head, { recursive: true, force: true });
  }
});

// ── Acceptance #6: base blob genuinely ABSENT (forward reference) — the strongest discriminator ────

test("a base blob genuinely ABSENT at <ref> (a forward reference) is reported ABSENT, not UNREADABLE", () => {
  const head = headFixture(`this line carries ${NEEDLE}\n`);
  try {
    const { code, out } = runCheckProof(["--base", FAKE_BASE_REF, ...PROOF_ARGV], head, {
      // `status: 128`, no `code` — the EXACT shape `baseBlobErrorIsAbsence` (W1-T460) recognises as
      // "git ran and answered: not there", never a broken read.
      baseBlobDeps: {
        showBlob: () => {
          const e = new Error("fatal: path 'src/marker.txt' does not exist in 'deadbeef'") as Error & {
            status?: number;
          };
          e.status = 128;
          throw e;
        },
      },
    });

    assert.equal(code, CHECK_PROOF_EXIT.pass, "the head verdict itself is untouched by an absent base blob");
    assert.match(out, /^base:\s+ABSENT at/m);
    assert.match(out, /forward reference/);
    assert.match(
      out,
      /^discrimination:\s+unknown\s+—\s+reported verdict above stands unchanged\s*$/m,
      "genuinely absent is still reported as an inconclusive base comparison here — no false discrimination claimed",
    );
    assert.doesNotMatch(out, /UNREADABLE/, "must not be conflated with a broken read");
  } finally {
    rmSync(head, { recursive: true, force: true });
  }
});

// ── Acceptance #7: a `unit test:` proof is NOT COMPARABLE — only `grep:` gets a base blob at all ──

test("a `unit test:` proof reports NOT COMPARABLE rather than silently skipping the base check", () => {
  const { code, out } = runCheckProof(
    ["--base", FAKE_BASE_REF, "unit test:", "test/serve-identity-default-path.test.ts"],
    REPO_ROOT,
    { baseBlobDeps: { showBlob: () => "unused — materialiseBaseProofBlobs never calls showBlob for a non-grep proof" } },
  );

  assert.equal(code, CHECK_PROOF_EXIT.pass, "the real file genuinely passes at head");
  assert.match(out, /^base:\s+NOT COMPARABLE/m);
  assert.match(out, /only `grep:` proofs get a base blob materialized today \(kind=test\)/);
  assert.match(
    out,
    /^discrimination:\s+unknown\s+—\s+reported verdict above stands unchanged\s*$/m,
    "not-comparable is reported, never silently skipped",
  );
});

// ── Acceptance #8: the base run itself COULD NOT EXECUTE — an environment gap, not evidence ───────

test("a base run that itself cannot execute (e.g. an unreadable base file on disk) degrades to COULD NOT EXECUTE, not a false discrimination", () => {
  const head = headFixture(`this line carries ${NEEDLE}\n`);
  const base = mkdtempSync(join(tmpdir(), "rmd-check-proof-base-base-"));
  try {
    // Pre-materialise the blob's PATH ourselves, WRITE-ONLY (mode 0200): buildBaseProofDir's own
    // writeFileSync still succeeds (write access is all it needs), so `baseCheckoutDir` comes back
    // genuinely DEFINED — but the grep child process this verb spawns next needs READ access to open
    // the file at all, which mode 0200 refuses, so THAT spawn (not the write) is where this breaks.
    const target = join(base, "src", "marker.txt");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "placeholder\n");
    chmodSync(target, 0o200);

    const { code, out } = runCheckProof(["--base", FAKE_BASE_REF, ...PROOF_ARGV], head, {
      baseBlobDeps: {
        showBlob: () => `this line ALSO carries ${NEEDLE}\n`,
        makeDir: () => base,
      },
    });

    assert.equal(code, CHECK_PROOF_EXIT.pass, "the head verdict itself is untouched by a base spawn failure");
    assert.match(out, /^base:\s+COULD NOT EXECUTE/m);
    assert.match(out, /environment gap, never/);
    assert.match(
      out,
      /^discrimination:\s+unknown\s+—\s+reported verdict above stands unchanged\s*$/m,
      "an environment gap on the base run is inconclusive, never a false discrimination",
    );
  } finally {
    rmSync(head, { recursive: true, force: true });
    chmodSync(join(base, "src", "marker.txt"), 0o600); // restore write+read so rmSync can remove it
    rmSync(base, { recursive: true, force: true });
  }
});
