import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// ── The budget ratchet names its compression candidates (W1-T419 design iii) ────────────────────
//
// A CEILING WITH NO CANDIDATES leaves compression to whoever's judgment is nearest: the ratchet
// going red said "over budget" and nothing else. This suite covers the message becoming specific —
// the K least-evidenced active entries, named, with a no-evidence entry rendered `never-cited`
// rather than omitted. The ceiling and the red/green semantics are UNCHANGED and this file asserts
// nothing about them; only the message stops being mute.
//
// WHY THIS FILE IS SEPARATE FROM test/learnings-citation-loop.test.ts, and it is not organisational
// taste: `scripts/learnings-budget-ratchet.mjs` is an INSTRUMENT_SURFACE path (`src/lib/review.ts`'s
// exported `INSTRUMENT_SURFACE`), so under Standing rule 25 a changeset touching it may not also
// touch a `src/` product path — `detectInstrumentEntanglement` refuses it and `judgeReview` forces
// `state: failure`, which `applyVerdictStability` can never suppress. W1-T419 was FILED with both
// halves in one `files:` list and its run (#1609) was refused on exactly that. This is the split
// half: instrument + `test/` only, which is the sanctioned shape precisely because `isProductPath`
// excludes `test/` (otherwise an instrument change could never carry the fixture that proves it).
//
// THE READER TOLERATES A CORPUS THAT HAS NEVER BEEN MINED, which is what lets this land first and
// alone. `cited`/`cited_count` are optional reads; an entry carrying neither renders `never-cited`,
// so on today's corpus — where nothing has been stamped yet — every candidate line is `never-cited`
// and the gate behaves exactly as before apart from saying which entries it means. The miner that
// starts stamping those fields is the other half (#1609) and is not required by anything here.

// `scripts/**` sits OUTSIDE tsconfig's `include` (see tsconfig.json), so a static
// `import … from "../scripts/learnings-budget-ratchet.mjs"` is a TS7016 — the same reason
// test/clock-sweep.test.ts reaches its script through a runtime import rather than a typed one.
// A dynamic specifier is not statically resolved, so this loads the REAL module with no shadow
// copy to drift from it.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "learnings-budget-ratchet.mjs");
const FIXTURES = join(__dirname, "fixtures", "learnings-citation-loop");

const RATCHET_URL = pathToFileURL(SCRIPT).href;
const { compressionCandidates, leastEvidencedFirst, renderCandidateLine } = (await import(RATCHET_URL)) as {
  compressionCandidates: (entries: unknown[], count?: number) => string[];
  leastEvidencedFirst: (entries: unknown[]) => Array<{ id: string }>;
  renderCandidateLine: (entry: unknown) => string;
};

/**
 * The entry shape the RATCHET itself builds (`loadShardEntries`), deliberately NOT
 * `LearningEntry` from `src/lib/learnings.ts`. This half must not depend on the other half's type
 * change — a `test/` file importing the src type would compile only once that lands, which would
 * re-couple the two PRs the rule 25 split exists to separate.
 */
interface RatchetEntry {
  id: string;
  fact: string;
  lifecycle: string;
  cited?: string;
  citedCount?: number;
}

function entry(id: string, overrides: Partial<RatchetEntry> = {}): RatchetEntry {
  return { id, fact: `fact for ${id}`, lifecycle: "active", ...overrides };
}

test("compressionCandidates: entry A (cited_count 9) vs never-cited entry B -- B is named, not A, at count 1", () => {
  const a = entry("A", { cited: "2026-07-01", citedCount: 9 });
  const b = entry("B"); // no cited/citedCount at all -- never-cited
  const candidates = compressionCandidates([a, b], 1);
  assert.deepEqual(candidates, ["B: never-cited"]);
  assert.equal(leastEvidencedFirst([a, b])[0].id, "B");
  assert.equal(renderCandidateLine(b), "B: never-cited");
  assert.equal(renderCandidateLine(a), "A: cited 9x, last 2026-07-01");
});

test("learnings-budget-ratchet CLI: over-cap corpus names the never-cited entry as a compression candidate, never omits it", () => {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, "--dir", join(FIXTURES, "corpus"), "--baseline", join(FIXTURES, "over-baseline.json")],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /BLOCKED/);
  assert.match(result.stderr, /Least-evidenced active entries/);
  assert.match(result.stderr, /beta-never-cited: never-cited/);
  assert.match(result.stderr, /alpha-cited: cited 9x, last 2026-07-01/);
  // The never-cited entry sorts before the evidenced one in the candidate list.
  const neverCitedLine = result.stderr.indexOf("beta-never-cited");
  const citedLine = result.stderr.indexOf("alpha-cited: cited");
  assert.ok(neverCitedLine > 0 && citedLine > 0 && neverCitedLine < citedLine, result.stderr);
});

test("a corpus that has NEVER been mined still renders candidates -- every line never-cited, nothing omitted", () => {
  // The tolerance this half's independence rests on, asserted rather than assumed: with no entry
  // carrying `cited`/`cited_count` (the state of the real corpus until the miner half lands), the
  // candidate list is still fully populated and every line reads `never-cited`.
  const entries = [entry("z"), entry("a"), entry("m")];
  assert.deepEqual(compressionCandidates(entries, 3), ["a: never-cited", "m: never-cited", "z: never-cited"]);
});
