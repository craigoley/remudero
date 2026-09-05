import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
// pre-reformat fixture. Order and membership must be byte-identical to what W1-T107 replaced,
// PLUS every entry a later PR has appended since (most recently comment-load-ratchet).
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
  "License Review",
  "leak-grep",
  "assertion-discrimination",
  "task-id-existence",
  "acceptance-author-gate",
  "unwired-gate",
  "comment-load-ratchet",
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
  assert.equal(entryLines.length, 20, "expected 20 one-per-line REQUIRED entries");

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

// ── W1-T1131: the FAIL arm consults REQUIRED, not only IGNORE ───────────────────────────────
//
// evaluate_fails() used to select every check run with a failing conclusion, filtered ONLY
// against IGNORE (which holds nothing but "ci-gate" itself) — it never read REQUIRED at all.
// So any of the eleven-plus non-required check runs that can land on a PR head (advisory
// scanners, informational jobs, clock-sweep, ...) could hold every merge, while the printed
// message claimed a "required" check had failed (#2434: clock-sweep, which its own workflow
// header says is deliberately absent from ci-gate.yml, held merge with all 14 required checks
// green). The fix restricts evaluate_fails to names present in REQUIRED.
//
// This suite drives the REAL bash+jq script embedded in ci-gate.yml's one step (extracted from
// the file on disk, never re-typed here) as a subprocess, with a stub `gh` binary on PATH
// standing in for the GitHub API — the same harness test/ci-gate-dedupe.test.ts uses.

type CheckRun = {
  name: string;
  status: "completed" | "in_progress" | "queued";
  conclusion: string | null;
  started_at: string;
};

async function loadAggregateScript(): Promise<string> {
  const raw = await readFile(CI_GATE_PATH, "utf8");
  const doc = parseYaml(raw) as { jobs: Record<string, any> };
  const steps = doc.jobs["ci-gate"].steps as Array<{ name: string; run: string }>;
  const step = steps.find((s) => typeof s.run === "string" && s.run.includes("runs_json"));
  assert.ok(step, "expected ci-gate.yml's ci-gate job to have a step whose run script defines runs_json()");
  return step!.run;
}

async function writeFakeGh(dir: string, checkRuns: CheckRun[]): Promise<void> {
  const page = JSON.stringify([{ check_runs: checkRuns }]);
  const body = `#!/usr/bin/env bash\ncat <<'FIXTURE_EOF'\n${page}\nFIXTURE_EOF\n`;
  await writeFile(join(dir, "gh"), body, { mode: 0o755 });
}

async function runAggregateScript(
  script: string,
  required: string[],
  ignore: string[],
  checkRuns: CheckRun[],
  timeoutMs = 20_000,
) {
  const dir = await mkdtemp(join(tmpdir(), "ci-gate-required-format-"));
  try {
    await writeFakeGh(dir, checkRuns);
    return spawnSync("bash", ["-c", script], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GH_TOKEN: "fake-token",
        REPO: "example/example",
        SHA: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        REQUIRED: JSON.stringify(required),
        IGNORE: JSON.stringify(ignore),
        GRACE_WINDOW_SECONDS: "0",
        GRACE_POLL_INTERVAL_SECONDS: "1",
      },
      encoding: "utf8",
      timeout: timeoutMs,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("ci-gate-required-format (W1-T1131): a failing check that is NOT in REQUIRED (and not in IGNORE either) no longer holds the merge — the fail arm consults REQUIRED, not only IGNORE (the #2434 clock-sweep fixture)", async () => {
  const script = await loadAggregateScript();
  const result = await runAggregateScript(script, ["ci"], [], [
    { name: "ci", status: "completed", conclusion: "success", started_at: "2026-08-01T00:00:00Z" },
    { name: "clock-sweep", status: "completed", conclusion: "failure", started_at: "2026-08-01T00:01:00Z" },
  ]);
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.equal(result.status, 0, out);
  assert.match(out, /ci-gate: all required checks terminal, no failures — merge may proceed\./);
  assert.doesNotMatch(out, /FAILED/);
  assert.doesNotMatch(out, /- clock-sweep/);
});

test("ci-gate-required-format (W1-T1131): a failing check that IS in REQUIRED still holds the merge exactly as before", async () => {
  const script = await loadAggregateScript();
  const result = await runAggregateScript(script, ["ci"], [], [
    { name: "ci", status: "completed", conclusion: "failure", started_at: "2026-08-01T00:00:00Z" },
  ]);
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.notEqual(result.status, 0, out);
  assert.match(out, /::error::ci-gate: required check\(s\) FAILED — holding merge:/);
  assert.match(out, /- ci/);
});

test("ci-gate-required-format (W1-T1131): the hold message names only checks that are actually in REQUIRED — a required failure alongside a non-required failure reports only the required name", async () => {
  const script = await loadAggregateScript();
  const result = await runAggregateScript(script, ["ci"], [], [
    { name: "ci", status: "completed", conclusion: "failure", started_at: "2026-08-01T00:00:00Z" },
    { name: "clock-sweep", status: "completed", conclusion: "failure", started_at: "2026-08-01T00:01:00Z" },
  ]);
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.notEqual(result.status, 0, out);
  assert.match(out, /::error::ci-gate: required check\(s\) FAILED — holding merge:/);
  assert.match(out, /- ci/);
  assert.doesNotMatch(out, /- clock-sweep/);
});
