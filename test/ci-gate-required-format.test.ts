import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

// ── W1-T107: "ci-gate REQUIRED array — one entry per line" ──────────────────────────────────
//
// ci-gate.yml's REQUIRED env var used to be a single-line JSON array literal. Every PR that
// adds a new required check has to edit that exact line, so two such PRs in flight at once
// collide on the same line and can't merge cleanly (the tier-gate collision class). The fix
// reformats REQUIRED as a YAML folded scalar (`>-`) with one array entry per line — folding
// joins same-indentation lines with a space, so the parsed JSON value is unchanged.
//
// This suite proves both halves directly against the real file on disk:
//   1. the PARSED REQUIRED set is unchanged (pre-reformat fixture vs. post-reformat real file,
//      deepEqual, same entries in the same order);
//   2. the on-disk FORMAT actually is one entry per line, and the file documents the collision
//      class the format avoids (not just a comment that happens to exist).

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CI_GATE_PATH = join(REPO_ROOT, ".github", "workflows", "ci-gate.yml");

// The REQUIRED array exactly as it read before this PR (single-line JSON literal) — the
// pre-reformat fixture. Order and membership must be byte-identical to what W1-T107 replaced.
const PRE_REFORMAT_REQUIRED_FIXTURE = JSON.stringify([
  "ci",
  "lint-plan",
  "depcruise",
  "containment-probe",
  "coverage-ratchet",
  "mutation-ratchet",
  "jscpd-gate",
  "claims",
  "learnings-budget-ratchet",
  "commitlint",
  "api-client-drift",
  "no-hand-rolled-fetch",
  "scan-pr / osv-scan",
]);

async function loadCiGate() {
  const raw = await readFile(CI_GATE_PATH, "utf8");
  const doc = parseYaml(raw) as { jobs: Record<string, any> };
  return { raw, env: doc.jobs["ci-gate"].env as Record<string, string> };
}

test("ci-gate-required-format: the parsed REQUIRED set is unchanged — pre-reformat fixture deepEquals the post-reformat real file", async () => {
  const { env } = await loadCiGate();

  const pre = JSON.parse(PRE_REFORMAT_REQUIRED_FIXTURE) as string[];
  const post = JSON.parse(env.REQUIRED) as string[];

  assert.deepEqual(
    post,
    pre,
    "ci-gate.yml's REQUIRED, parsed post-reformat, must deepEqual the pre-reformat fixture — " +
      "the one-entry-per-line YAML folded scalar must fold back to the identical JSON array.",
  );
});

test("ci-gate-required-format: the format is one entry per line, and the convention comment names the conflict class it avoids", async () => {
  const { raw } = await loadCiGate();

  const lines = raw.split("\n");
  const startIdx = lines.findIndex((l) => /^\s*REQUIRED:\s*>-\s*$/.test(l));
  assert.ok(startIdx >= 0, "expected a `REQUIRED: >-` folded-scalar block header");

  // Collect the folded-scalar body lines (more-indented than the `REQUIRED:` key itself) up to
  // the closing `]`.
  const bodyLines: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    bodyLines.push(lines[i]!);
    if (lines[i]!.trim() === "]") break;
  }

  const entryLines = bodyLines.filter((l) => /^\s*"/.test(l.trim()));
  // Each entry line holds exactly one quoted array element — never two entries sharing a line.
  for (const line of entryLines) {
    const quoteCount = (line.match(/"/g) ?? []).length;
    assert.equal(
      quoteCount,
      2,
      `expected exactly one quoted entry per line, got: ${JSON.stringify(line)}`,
    );
  }
  assert.equal(entryLines.length, 13, "expected 13 one-per-line REQUIRED entries");

  // The comment immediately above the block must name the conflict class this format avoids —
  // concurrent PRs editing the same single line.
  const commentBlock = lines.slice(Math.max(0, startIdx - 4), startIdx).join("\n");
  assert.match(
    commentBlock,
    /one entry per line/i,
    "expected the convention comment above REQUIRED to say 'one entry per line'",
  );
  assert.match(
    commentBlock,
    /concurrent|collide|same line|conflict/i,
    "expected the convention comment to name the collision class (concurrent edits colliding " +
      "on the same line)",
  );
});
