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

// ── criterion 4: this diff really is instrument-only ─────────────────────────────────────────────

test("W1-T3341 (4): Standing rule 25 reads entangled FALSE on this PR's own diff", () => {
  const base = execFileSync("git", ["-C", REPO_ROOT, "merge-base", "HEAD", "origin/main"], {
    encoding: "utf8",
  }).trim();
  const changed = execFileSync("git", ["-C", REPO_ROOT, "diff", "--name-only", `${base}...HEAD`], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  const diff = execFileSync("git", ["-C", REPO_ROOT, "diff", `${base}...HEAD`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  // POSITIVE CONTROL: the diff must actually contain this task's work, or "not entangled" is the
  // trivially-true verdict an empty diff earns.
  assert.ok(
    changed.includes("scripts/claude-md-budget-baseline.json"),
    `the diff must carry the baseline this task re-derives; saw ${changed.join(", ")}`,
  );

  const verdict = detectInstrumentEntanglement(changed, diff);
  assert.equal(
    verdict.entangled,
    false,
    `rule 25 entanglement on this PR's own diff: instrument=${verdict.instrumentPaths.join(",")} src=${verdict.srcPaths.join(",")}`,
  );
  assert.deepEqual(
    changed.filter((f) => f.startsWith("src/")),
    [],
    "this task must touch no src/ path — that is the entire reason it is a separate PR",
  );
});
