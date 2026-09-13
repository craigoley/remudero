import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHARD_DIR = join(REPO_ROOT, "plan", "tasks.d");
const MONOLITH = join(REPO_ROOT, "plan", "tasks.yaml");
const BASELINE_PATH = join(REPO_ROOT, "scripts", "self-path-proof-baseline.json");

// ── A SHARD'S PROOF THAT GREPS ITS OWN FILE CAN NEVER DISCRIMINATE ───────────────────────────────
//
// `grep:` proofs are re-run at the MERGE BASE by `classifyBaseProofOutcome`. A shard's acceptance
// proofs are judged when the task is BUILT — and by then the shard is already on `main`, so a proof
// whose target IS that shard passes at the base too, grades `executed_stale`, and drops every
// criterion to the keyword floor. The PR is then judged on body wording rather than evidence.
//
// MEASURED CONSEQUENCE, not a hypothesis. W1-T3387 shipped a correct implementation (#5256) and sat
// at `FAIL — unmet` for exactly this reason: both its proofs greped
// `plan/tasks.d/W1-T3387-….yaml`. A body repair could not lift it, because the `Remudero-Task:`
// trailer makes the PLAN the source of criteria, so no body wording reaches the proofs. It took an
// operator amendment (#5303) repointing them at `src/run-task.ts`. `origin/main` then landed #5310,
// `fix(plan): repoint four shards' self-path proofs at their deliverables (W1-T3470)` — four more,
// by hand, in one batch.
//
// MEASURED POPULATION at the time of filing: 181 self-path proofs across 62 tasks, out of 7,767
// proofs in 1,726 tasks. Every one of those 62 is a future PR that arrives correct and grades
// unmet. At four per hand-fix batch that is roughly fifteen more manual PRs.
//
// A FILING PR'S BODY BLOCK IS A DIFFERENT THING AND IS NOT COUNTED. When a PR ADDS the shard, the
// file is absent at the merge base, so a body proof targeting it does discriminate — that is how
// this repo's own filing PRs pass. The rule is about a SHARD'S `acceptance:` block, which is only
// ever judged after that shard has landed.
//
// RATCHET, NOT A WALL. Refusing all 181 at once would block every PR that touches those 62 shards,
// so the recorded baseline grandfathers them and this only refuses GROWTH. The count can fall and
// never rise — the same shape as `clock-signature-baseline.json` and `comment-load-baseline.json`.

/** `grep: <pattern> in <path>` — the only proof dialect that names a path to read. */
const GREP_PROOF_RE = /^\s*grep:\s*(.+?)\s+in\s+(\S+)\s*$/;

interface ShardFile {
  /** Repo-relative path, the key used in the baseline. */
  file: string;
  tasks: Array<{ id: string; proofs: string[] }>;
}

function readShards(): ShardFile[] {
  const out: ShardFile[] = [];
  const files = [...readdirSync(SHARD_DIR).filter((n) => n.endsWith(".yaml")).map((n) => join(SHARD_DIR, n)), MONOLITH];
  for (const abs of files) {
    let parsed: unknown;
    try {
      parsed = parseYaml(readFileSync(abs, "utf8"));
    } catch {
      // An unparseable shard is `lint-plan`'s to refuse, not this census's. Skipping it here keeps
      // ONE gate responsible for parse failures; counting it as zero would hide a real row.
      continue;
    }
    const rel = abs.startsWith(REPO_ROOT) ? abs.slice(REPO_ROOT.length + 1) : abs;
    const tasks: Array<{ id: string; proofs: string[] }> = [];
    for (const t of (parsed as Array<Record<string, unknown>>) ?? []) {
      if (!t || typeof t !== "object" || typeof t.id !== "string") continue;
      const proofs = ((t.acceptance as Array<Record<string, unknown>>) ?? [])
        .map((c) => String(c?.proof ?? ""))
        .filter((p) => p.length > 0);
      tasks.push({ id: t.id, proofs });
    }
    out.push({ file: rel, tasks });
  }
  return out;
}

/**
 * Is this proof's target the very file the proof is written in?
 *
 * Compared on BASENAME as well as full path: the monolith and the shard directory address the same
 * shard differently in practice, and a proof written as a bare `W1-T123-….yaml` is the same defect
 * as one written with the full `plan/tasks.d/` prefix.
 */
export function proofTargetsOwnFile(proof: string, shardFile: string): boolean {
  const m = GREP_PROOF_RE.exec(proof);
  if (!m) return false;
  const target = m[2];
  return target === shardFile || basename(target) === basename(shardFile);
}

/** Self-path proof count per shard file, omitting files with none. */
export function scanSelfPathProofs(): Record<string, number> {
  const rows: Record<string, number> = {};
  for (const shard of readShards()) {
    let n = 0;
    for (const t of shard.tasks) for (const p of t.proofs) if (proofTargetsOwnFile(p, shard.file)) n += 1;
    if (n > 0) rows[shard.file] = n;
  }
  return rows;
}

function readBaseline(): Record<string, number> {
  const raw = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("_")) continue; // `_comment` and friends are documentation, not rows
    assert.equal(typeof v, "number", `${BASELINE_PATH}: ${k} must record a number`);
    out[k] = v as number;
  }
  return out;
}

test("the census sees its corpus — a positive control, so a zero can never pass vacuously", () => {
  const shards = readShards();
  assert.ok(shards.length > 100, `expected the real shard corpus, saw ${shards.length} file(s)`);
  const proofs = shards.reduce((n, s) => n + s.tasks.reduce((m, t) => m + t.proofs.length, 0), 0);
  assert.ok(proofs > 1000, `expected thousands of proofs, saw ${proofs}`);
});

test("no shard's self-path proof count exceeds its recorded baseline — the ratchet", () => {
  const baseline = readBaseline();
  const actual = scanSelfPathProofs();
  const grown = Object.entries(actual)
    .filter(([file, n]) => n > (baseline[file] ?? 0))
    .map(([file, n]) => `${file}: ${n} self-path proof(s) > baseline ${baseline[file] ?? 0}`);
  assert.deepEqual(
    grown,
    [],
    "a shard's acceptance proof may not grep the shard it lives in — it passes at the merge base too, " +
      "grades executed_stale, and drops the criterion to the keyword floor. Point the proof at the " +
      "DELIVERABLE the criterion is about (a src/ or test/ path), as #5303 and #5310 did. If a row here " +
      "genuinely fell, lower it in scripts/self-path-proof-baseline.json in the same change.\n  " +
      grown.join("\n  "),
  );
});

test("FALSIFIER: the detector fires on the real W1-T3387 shape, and not on a deliverable-pointing proof", () => {
  const shard = "plan/tasks.d/W1-T3387-an-untasked-pr-silently-skips-the-semantic-reviewer.yaml";
  // The shape that blocked #5256, verbatim in form.
  assert.equal(
    proofTargetsOwnFile(
      "grep: Resolve a default risk and budget for the in plan/tasks.d/W1-T3387-an-untasked-pr-silently-skips-the-semantic-reviewer.yaml",
      shard,
    ),
    true,
  );
  // The repointed form #5303 replaced it with must NOT fire, or the gate would refuse its own remedy.
  assert.equal(
    proofTargetsOwnFile("grep: an untrailered / unfiled PR is still a PR the fleet chose to review in src/run-task.ts", shard),
    false,
  );
  // A bare basename is the same defect written differently.
  assert.equal(
    proofTargetsOwnFile("grep: something in W1-T3387-an-untasked-pr-silently-skips-the-semantic-reviewer.yaml", shard),
    true,
  );
  // A DIFFERENT shard is not self-path: cross-shard proofs are a separate question this does not judge.
  assert.equal(proofTargetsOwnFile("grep: x in plan/tasks.d/W1-T9999-other.yaml", shard), false);
});

test("a non-grep proof is never a self-path finding, whatever it names", () => {
  // `unit test:` resolves a test title or path through the runner, not a file read, so the base-tree
  // staleness this census is about does not arise the same way. Counting it would inflate every row.
  const shard = "plan/tasks.d/W1-T1-x.yaml";
  assert.equal(proofTargetsOwnFile("unit test: plan/tasks.d/W1-T1-x.yaml", shard), false);
  assert.equal(proofTargetsOwnFile("", shard), false);
  assert.equal(proofTargetsOwnFile("some prose with no dialect at all", shard), false);
});
