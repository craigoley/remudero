// test/check-acceptance-names-a-proof-that-discriminates-nothing.test.ts
//
// W1-T3687. `rmd check-acceptance` is the one pre-flight verb an author runs before opening a PR,
// and it never asked the discrimination question `rmd check-proof --base` already answers: a
// proof that matches BOTH the PR head and its merge-base discriminates nothing and the reviewer
// downgrades it to `executed_stale` (W1-T273/W1-T362) — but `check-acceptance` printed `OK`
// unconditionally, regardless. Filing rationale, MEASURED 2026-09-16: remudero-site#39 and
// remudero-console#47 both carried the SAME proof, both were refused by `remudero-review`, and
// `check-acceptance` had reported `OK` on one of those bodies before it ever opened.
//
// THE FIX (design): `check-acceptance` accepts `--base <ref>`, the same spelling/semantics as
// `check-proof --base`. With it, every parsed criterion is run through the SAME executor
// (`buildBaseProofDir` + `execWhitelistedProof`) `check-proof` itself uses — the merge-base tree
// built ONCE for the whole body, never once per criterion — and a criterion that matches both
// trees is named `executed_stale` and turns the exit code non-zero. Omitting `--base` leaves
// every line and exit code exactly as they were before this task.
//
// WHAT IS REAL HERE: this suite drives the production `checkAcceptanceCommand` directly, over a
// real throwaway head "checkout" (a plain temp directory holding one marker file) and the SAME
// `baseBlobDeps.showBlob` injection seam `test/check-proof-base.test.ts` already establishes for
// `checkProofCommand` — no real git ref ever needs to exist for these tests: the real `git
// worktree add` against a fake ref genuinely throws, `buildBaseProofDir` falls back to the blob
// path, and `showBlob` supplies that fixture "base" tree's content as a literal string.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { checkAcceptanceCommand } from "../src/run-task.js";

/** Run `checkAcceptanceCommand` with stdout captured, from `cwd` — same discipline
 *  `test/check-proof-base.test.ts`'s own `runCheckProof` uses for its sibling verb. */
function runCheckAcceptance(
  argv: string[],
  cwd: string,
  deps?: Parameters<typeof checkAcceptanceCommand>[1],
): { code: number; out: string } {
  const lines: string[] = [];
  const realLog = console.log;
  const realCwd = process.cwd();
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    process.chdir(cwd);
    const code = checkAcceptanceCommand(argv, deps);
    return { code, out: lines.join("\n") };
  } finally {
    console.log = realLog;
    process.chdir(realCwd);
  }
}

const NEEDLE = "NEEDLE_TOKEN_W1_T3687";
const FAKE_BASE_REF = "deadbeef0000000000000000000000000000000";

/** A throwaway "head" checkout with one marker file the fixture bodies' `grep:` proofs name. */
function headFixture(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-check-acceptance-base-head-"));
  const target = join(dir, "src", "marker.txt");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return dir;
}

/** An untrailered body — no `Remudero-Task:` line — so criteria resolve from the body's own
 *  `## Acceptance` block, exactly the shape the task's own filing note reproduces. */
function bodyFile(dir: string, criteriaCount: number): string {
  const path = join(dir, "body.md");
  const bullets = Array.from(
    { length: criteriaCount },
    (_, i) => `- claim: criterion ${i + 1}\n  proof: grep: ${NEEDLE} in src/marker.txt\n`,
  ).join("");
  writeFileSync(path, `## Acceptance\n${bullets}`);
  return path;
}

// ── Acceptance #1: a criterion matching base too is named as discriminating nothing ──────────────

test("a criterion matching base too is named as discriminating nothing", () => {
  const head = headFixture(`this line carries ${NEEDLE}\n`);
  try {
    const body = bodyFile(head, 1);
    const { out } = runCheckAcceptance(["body.md", "--base", FAKE_BASE_REF], head, {
      // The "base tree" ALSO carries the needle — the proof would have matched before the work
      // ever existed, so it discriminates nothing, same fixture shape check-proof-base.test.ts uses.
      baseBlobDeps: { showBlob: () => `this line ALSO carries ${NEEDLE} already, before any work\n` },
    });
    void body;

    assert.match(
      out,
      /discrimination:\s+executed_stale\b/,
      "must be reported under the reviewer's OWN name for this downgrade (W1-T273/W1-T362)",
    );
  } finally {
    rmSync(head, { recursive: true, force: true });
  }
});

// ── Acceptance #2: a body with a stale criterion exits non-zero ──────────────────────────────────

test("a body with a stale criterion exits non-zero", () => {
  const head = headFixture(`this line carries ${NEEDLE}\n`);
  try {
    bodyFile(head, 1);
    const { code, out } = runCheckAcceptance(["body.md", "--base", FAKE_BASE_REF], head, {
      baseBlobDeps: { showBlob: () => `this line ALSO carries ${NEEDLE} already, before any work\n` },
    });

    assert.notEqual(
      code,
      0,
      "a script gating on this verb must never green-light a PR the reviewer will refuse",
    );
    assert.doesNotMatch(out, /^OK\b/m, "the summary line must not claim OK once a criterion is stale");
  } finally {
    rmSync(head, { recursive: true, force: true });
  }
});

// ── Acceptance #3: check-acceptance without a base ref is unchanged ──────────────────────────────

test("check-acceptance without a base ref is unchanged", () => {
  const head = headFixture(`this line carries ${NEEDLE}\n`);
  try {
    bodyFile(head, 1);
    const withoutBase = runCheckAcceptance(["body.md"], head);
    const withBaseThatWouldThrowIfConsulted = runCheckAcceptance(["body.md"], head, {
      // Proves the seam is genuinely inert without --base: an injected showBlob that would blow up
      // if ever called must never fire when the flag itself is absent.
      baseBlobDeps: {
        showBlob: () => {
          throw new Error("must never be called — --base was not given");
        },
      },
    });

    assert.equal(withoutBase.code, 0);
    assert.equal(withoutBase.code, withBaseThatWouldThrowIfConsulted.code);
    assert.equal(
      withoutBase.out,
      withBaseThatWouldThrowIfConsulted.out,
      "an unconsulted deps object changes nothing — acceptance criterion 3",
    );
    assert.match(withoutBase.out, /^OK\b/m, "the ordinary OK line survives untouched");
    assert.doesNotMatch(withoutBase.out, /discrimination:/, "no discrimination line may appear without --base");
  } finally {
    rmSync(head, { recursive: true, force: true });
  }
});

// ── Acceptance #4: a four-criterion body builds one base worktree ────────────────────────────────

test("a four-criterion body builds one base worktree", () => {
  const head = headFixture(`this line carries ${NEEDLE}\n`);
  try {
    bodyFile(head, 4);
    let addWorktreeCalls = 0;
    runCheckAcceptance(["body.md", "--base", FAKE_BASE_REF], head, {
      baseBlobDeps: {
        addWorktree: () => {
          addWorktreeCalls++;
        },
      },
    });

    assert.equal(addWorktreeCalls, 1, "N criteria must not build N worktrees — one merge-base tree for the whole body");
  } finally {
    rmSync(head, { recursive: true, force: true });
  }
});

// ── Falsifier, both directions: a real discriminator and a real non-discriminator must disagree ──

test("FALSIFIER: a head-only match and a both-trees match resolve to genuinely different verdicts", () => {
  const head = headFixture(`this line carries ${NEEDLE}\n`);
  try {
    bodyFile(head, 1);
    const headOnly = runCheckAcceptance(["body.md", "--base", FAKE_BASE_REF], head, {
      baseBlobDeps: { showBlob: () => "no token here\n" },
    });
    const both = runCheckAcceptance(["body.md", "--base", FAKE_BASE_REF], head, {
      baseBlobDeps: { showBlob: () => `${NEEDLE} already here\n` },
    });

    assert.notEqual(headOnly.code, both.code, "a real discriminator must disagree with a real non-discriminator");
    assert.doesNotMatch(headOnly.out, /discrimination:/, "a proof absent at base discriminates — no stale claim");
    assert.match(both.out, /discrimination:\s+executed_stale/);
  } finally {
    rmSync(head, { recursive: true, force: true });
  }
});
