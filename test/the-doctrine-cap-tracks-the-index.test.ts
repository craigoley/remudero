import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  parseRuleBodyPointer,
  parseRuleHeadlines,
  renderHeadlineOnlyIndex,
} from "../src/lib/learnings.js";
import { detectInstrumentEntanglement } from "../src/lib/review.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// ── W1-T3341: the doctrine cap must track the index W1-T3323 left behind ────────────────────────
//
// W1-T3323 moved 41595 bytes of rule BODIES out of CLAUDE.md into `doctrine/` and left `capBytes` at
// 44000 against a 15501-byte file — 284% of the file, admitting about 150 new rules before refusing.
// A ceiling that far above its subject is not a ratchet; the gate spent that window gating nothing.
//
// WHY THIS IS ITS OWN TASK AND NOT W1-T3323's LAST COMMIT. `scripts/[^/]*-baseline\.json$` is on
// Standing rule 25's INSTRUMENT_SURFACE, and W1-T3323 changed `src/lib/learnings.ts` and
// `src/run-task.ts`. MEASURED against that PR's real diff with the baseline edit in it:
// `entangled: true`, which forces an unsuppressible review FAILURE. Removing it re-measured
// `entangled: false`. So this is the sanctioned instrument-only shape — and the last test below
// proves this diff really is instrument-only rather than merely intending to be.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLAUDE_MD = join(REPO_ROOT, "CLAUDE.md");
const BASELINE = join(REPO_ROOT, "scripts", "claude-md-budget-baseline.json");
const RATCHET = join(REPO_ROOT, "scripts", "claude-md-budget-ratchet.mjs");

interface Baseline {
  capBytes: number;
  foldDebtCeilingBytes: number;
  bumpRationale: string;
  priorBumpRationale: string;
  capturedAt: string;
}

const baseline = (): Baseline => JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;
const indexBytes = (): number => Buffer.byteLength(readFileSync(CLAUDE_MD, "utf8"));

/** The per-rule cost, re-derived from the LIVE index exactly as the shard's falsifier demands —
 *  never the figure the filing guessed. A new rule adds a HEADLINE plus a POINTER, and nothing else. */
function bytesPerNewRule(): { perRule: number; perHeadline: number; perPointer: number; rules: number } {
  const rules = parseRuleHeadlines(readFileSync(CLAUDE_MD, "utf8"));
  const perHeadline = Buffer.byteLength(renderHeadlineOnlyIndex(rules)) / rules.length;
  const pointerBytes = rules.reduce((n, r) => {
    const p = parseRuleBodyPointer(r.body);
    return n + (p === undefined ? 0 : Buffer.byteLength(` → ${p.target}`));
  }, 0);
  const perPointer = pointerBytes / rules.length;
  return { perRule: perHeadline + perPointer, perHeadline, perPointer, rules: rules.length };
}

// ── criterion 1: both bounds track the index, and a pre-migration cap fails ─────────────────────

test("W1-T3341 (1): the cap and the fold-debt ceiling both track the index, in RULES not bytes", () => {
  const b = baseline();
  const bytes = indexBytes();
  const { perRule, rules } = bytesPerNewRule();

  // POSITIVE CONTROL on the measurement itself: a pointer-bearing index must cost far less per rule
  // than the 610-byte bodies it replaced, or the migration this cap prices did not happen.
  assert.ok(rules >= 56, `positive control: expected the real corpus; got ${rules} rules`);
  assert.ok(perRule > 50 && perRule < 400, `implausible per-rule cost: ${perRule.toFixed(1)} bytes`);

  const capRules = (b.capBytes - bytes) / perRule;
  const ceilingRules = (b.foldDebtCeilingBytes - bytes) / perRule;
  assert.ok(capRules >= 3, `capBytes leaves only ${capRules.toFixed(1)} rules of headroom — too tight to author in`);
  assert.ok(capRules <= 20, `capBytes leaves ${capRules.toFixed(1)} rules of headroom — that is not a ratchet`);
  assert.ok(
    ceilingRules > capRules,
    "the fold-debt allowance must sit ABOVE the cap, or routing has nowhere to route to",
  );
  assert.ok(
    ceilingRules - capRules <= 12,
    `the debt window is ${(ceilingRules - capRules).toFixed(1)} rules — a debt allowance, not a second cap`,
  );
});

test("W1-T3341 (1, falsifier): the PRE-MIGRATION cap would fail this suite — the assertion is load-bearing", () => {
  // 44000 against a 15501-byte file is what shipped for a day. Prove the bound above rejects it,
  // rather than passing for any number anyone writes.
  const { perRule } = bytesPerNewRule();
  const preMigrationHeadroom = (44_000 - indexBytes()) / perRule;
  assert.ok(
    preMigrationHeadroom > 20,
    `the old cap must be outside the accepted band, or this suite proves nothing; got ${preMigrationHeadroom.toFixed(1)}`,
  );
  assert.ok(preMigrationHeadroom > 100, "and it should be wildly outside it — ~126 rules of headroom");
});

// ── criterion 2: the ratchet still passes, and one byte over is refused ──────────────────────────

test("W1-T3341 (2): the ratchet passes on the committed CLAUDE.md at the new cap", () => {
  const out = execFileSync(process.execPath, [RATCHET], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.match(out, new RegExp(`cap ${baseline().capBytes} bytes`));
  assert.match(out, /OK -- CLAUDE\.md is at or under the size budget cap/);
});

test("W1-T3341 (2, falsifier): a file ONE BYTE over the cap is refused, and the refusal names both figures", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}doctrine-cap-`));
  try {
    const cap = 500;
    const file = join(dir, "CLAUDE.md");
    const base = join(dir, "baseline.json");
    writeFileSync(base, JSON.stringify({ capBytes: cap }));

    writeFileSync(file, "x".repeat(cap));
    const atCap = execFileSync(process.execPath, [RATCHET, "--file", file, "--baseline", base], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    assert.match(atCap, /OK/, "exactly at the cap must pass — the bound is 'at or under'");

    writeFileSync(file, "x".repeat(cap + 1));
    let code = 0;
    let out = "";
    try {
      out = execFileSync(process.execPath, [RATCHET, "--file", file, "--baseline", base], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      code = e.status ?? 1;
      out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    assert.notEqual(code, 0, `one byte over the cap must fail; output was: ${out}`);
    assert.match(out, new RegExp(String(cap + 1)), "the refusal must name the measured size");
    assert.match(out, new RegExp(String(cap)), "the refusal must name the cap it breached");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── criterion 3: the superseded argument survives ────────────────────────────────────────────────

test("W1-T3341 (3): the superseded rationale survives the change that supersedes it, dated and attributed", () => {
  const b = baseline();
  assert.match(b.bumpRationale, /W1-T3341/, "the current cap must name the task that set it");
  assert.match(b.bumpRationale, /2026-09-11/, "and the date it was set");
  // The corrected measurement is the point of this entry, so it must carry the re-derived unit and
  // say that the filing's own estimate was wrong — not quietly ship the better number.
  assert.match(b.bumpRationale, /224\.8/, "the re-measured per-rule cost must be on the record");
  assert.match(b.bumpRationale, /RE-MEASURED/i, "and it must say the figure was re-derived, not reused");
  assert.match(b.priorBumpRationale, /2026-08-31/, "the superseded entry must survive with its date");
  assert.match(b.priorBumpRationale, /W1-T2507/, "and its attribution");
  // test/what-a-worker-loads.test.ts pins this token somewhere in the file; the chain must not drop it.
  assert.match(
    `${b.bumpRationale}${b.priorBumpRationale}`,
    /W1-T2759/,
    "the W1-T2759 lane correction another suite pins must survive the shuffle",
  );
});

// ── criterion 4: the scope is instrument-only, asserted so it SURVIVES THE MERGE ────────────────
//
// THE FIRST VERSION OF THIS TEST TOOK MAIN RED, and the failure is worth stating plainly because the
// shape is reusable. It read `git diff <merge-base>...HEAD` to prove "this PR touches no src/ path",
// with a positive control requiring the diff to carry the baseline — so that the verdict could not be
// the trivially-true one an empty diff earns. That control was right about PRs and fatal on trunk:
// once the PR merged, HEAD *is* main, the diff is EMPTY, and the control fired forever. One test,
// 4013 passing beside it, and every subsequent PR inherited a failing baseline.
//
// A TEST MAY NOT ASSERT A PROPERTY OF ITS OWN PULL REQUEST. The pull request is gone the moment it
// lands; the property has to be stated about something permanent. Here that is the SHARD: W1-T3341
// declares its `files:`, and "no src/ path among them" is checkable for as long as the shard exists.
// The diff-time check is kept as well, because the PR-time guarantee is real — but its ABSENCE is
// now a SKIP with a stated reason, never a failure.

const SHARD = join(REPO_ROOT, "plan", "tasks.d", "W1-T3341-the-doctrine-cap-tracks-the-index.yaml");

test("W1-T3341 (4): the DECLARED scope carries no src/ path, which is why rule 25 cannot fire on it", () => {
  // The durable half. Readable on main, on a branch, and in ten years — it asks the plan, not a diff.
  const shard = readFileSync(SHARD, "utf8");
  const files = /^\s*files:\s*\[([^\]]*)\]/m.exec(shard)?.[1];
  assert.ok(files !== undefined, "the shard no longer declares a flow-style files: list");
  const declared = files
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  // POSITIVE CONTROL: the list must be the real one, or "no src/ path" is true of an empty array.
  assert.ok(declared.length >= 3, `expected the declared scope; got ${JSON.stringify(declared)}`);
  assert.ok(
    declared.includes("scripts/claude-md-budget-baseline.json"),
    "the declared scope must name the baseline this task re-derives",
  );
  assert.deepEqual(
    declared.filter((f) => f.startsWith("src/")),
    [],
    "a src/ path in this task's scope would ride with an INSTRUMENT_SURFACE path and force an unsuppressible rule 25 failure",
  );
});

test("W1-T3341 (4): rule 25 really does fire on the pairing this scope avoids — the rule is load-bearing", () => {
  // Proves the rule the assertion above leans on, with no diff of our own involved: an instrument
  // path beside a src/ product path IS entangled, and the same instrument path alone is NOT.
  const instrumentOnly = detectInstrumentEntanglement(
    ["scripts/claude-md-budget-baseline.json", "test/the-doctrine-cap-tracks-the-index.test.ts"],
    "",
  );
  assert.equal(instrumentOnly.entangled, false, "an instrument-only scope must read clean");

  const withSrc = detectInstrumentEntanglement(
    ["scripts/claude-md-budget-baseline.json", "src/lib/learnings.ts"],
    "",
  );
  assert.equal(withSrc.entangled, true, "the detector no longer flags the pairing this task exists to avoid");
  assert.deepEqual(withSrc.instrumentPaths, ["scripts/claude-md-budget-baseline.json"]);
  assert.deepEqual(withSrc.srcPaths, ["src/lib/learnings.ts"]);
});

test("W1-T3341 (4): while a diff EXISTS it is checked too — and an empty one SKIPS rather than failing", () => {
  // The PR-time guarantee, kept. On main there is no diff against the merge base, and that is the
  // state the first version of this test treated as a defect.
  const base = execFileSync("git", ["-C", REPO_ROOT, "merge-base", "HEAD", "origin/main"], {
    encoding: "utf8",
  }).trim();
  const changed = execFileSync("git", ["-C", REPO_ROOT, "diff", "--name-only", `${base}...HEAD`], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);

  if (changed.length === 0) {
    // MERGED, or running on trunk. Nothing to judge, and saying so is the whole fix.
    assert.equal(changed.length, 0);
    return;
  }

  const diff = execFileSync("git", ["-C", REPO_ROOT, "diff", `${base}...HEAD`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const verdict = detectInstrumentEntanglement(changed, diff);
  assert.equal(
    verdict.entangled,
    false,
    `rule 25 entanglement on this branch's diff: instrument=${verdict.instrumentPaths.join(",")} src=${verdict.srcPaths.join(",")}`,
  );
});
