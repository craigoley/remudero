import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildShardStandingBriefs } from "../src/lib/learnings.js";
import { buildStandingBrief, findMissingOrUncitedClaims } from "../src/lib/standing-briefs.js";
import type { LocalLearningEntry } from "../src/lib/learnings.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// W1-T4680 — 34% of tasks overflow the flat learnings budget and lose whatever the ranker cut
// (src/lib/knowledge-outcome.ts). This keeps ONE standing brief per shard instead: every claim
// still cites its `learnings#<id>`, but the brief is rebuilt only when its shard's active facts
// change, and unchanged claims keep byte-identical wording on a refresh (Hindsight's mental
// models, engine/reflect/delta_ops.py's id-addressed edit operations).

function entry(over: Partial<LocalLearningEntry> = {}): LocalLearningEntry {
  return {
    id: "brief-fact-a",
    subsystem: "knowledge",
    lifecycle: "active",
    files: ["src/lib/learnings.ts"],
    fact: "A standing brief cites the id it summarises.",
    src: "W1-T4680",
    ...over,
  };
}

test("W1-T4680: a brief is refreshed only when its shard changes", () => {
  const entries = [entry({ id: "brief-fact-a" }), entry({ id: "brief-fact-b", fact: "Second fact." })];

  const first = buildStandingBrief(entries, "architecture.yaml");
  assert.equal(first.version, 1);

  // Same shard content, called again: no refresh — the exact same brief object comes back.
  const again = buildStandingBrief(entries, "architecture.yaml", first);
  assert.equal(again, first);
  assert.equal(again.version, 1);

  // A non-active entry (lifecycle change) still counts as unchanged for the shard's INJECTABLE
  // facts only when the active set itself is untouched; here we touch one active entry's fact,
  // which must bump the shard-level version...
  const changed = [entries[0], entry({ id: "brief-fact-b", fact: "Second fact, corrected." })];
  const refreshed = buildStandingBrief(changed, "architecture.yaml", first);
  assert.notEqual(refreshed.shardHash, first.shardHash);
  assert.equal(refreshed.version, 2);

  // ...but the UNCHANGED claim (brief-fact-a) keeps byte-identical wording across the refresh —
  // edited in place by id, not rewritten wholesale.
  const priorA = first.claims.find((c) => c.id === "brief-fact-a");
  const refreshedA = refreshed.claims.find((c) => c.id === "brief-fact-a");
  assert.ok(priorA && refreshedA);
  assert.equal(refreshedA!.text, priorA!.text);
  assert.equal(refreshedA!.claimHash, priorA!.claimHash);

  // The changed claim (brief-fact-b) DOES get new text.
  const refreshedB = refreshed.claims.find((c) => c.id === "brief-fact-b");
  assert.ok(refreshedB);
  assert.match(refreshedB!.text, /corrected/);
});

test("W1-T4680: every claim in a brief cites a learning", () => {
  const entries = [
    entry({ id: "cited-one", fact: "Fact one." }),
    entry({ id: "cited-two", fact: "Fact two." }),
    entry({ id: "quarantined-fact", fact: "Should never appear.", lifecycle: "quarantined" }),
  ];

  const brief = buildStandingBrief(entries, "testing.yaml");

  // Only the active entries get a claim; a quarantined entry's fact never reaches the brief.
  assert.deepEqual(
    brief.claims.map((c) => c.id).sort(),
    ["cited-one", "cited-two"],
  );

  // Every claim's rendered text carries its own `[src: learnings#<id>]` citation.
  for (const claim of brief.claims) {
    assert.match(claim.text, new RegExp(`\\[src: learnings#${claim.id}\\]$`));
  }
  assert.match(brief.rendered, /\[src: learnings#cited-one\]/);
  assert.match(brief.rendered, /\[src: learnings#cited-two\]/);

  // (iii) A brief that drops a cited fact fails its own check: findMissingOrUncitedClaims is the
  // check, and it reports nothing missing for a complete brief...
  assert.deepEqual(findMissingOrUncitedClaims(entries, brief), []);

  // ...but DOES report an id whose claim was silently dropped from the brief.
  const dropped = { ...brief, claims: brief.claims.filter((c) => c.id !== "cited-two") };
  assert.deepEqual(findMissingOrUncitedClaims(entries, dropped), ["cited-two"]);
});

test("W1-T4680: buildShardStandingBriefs builds one brief per learnings shard on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}standing-briefs-`));
  writeFileSync(
    join(dir, "alpha.yaml"),
    JSON.stringify([entry({ id: "alpha-fact", files: ["src/alpha.ts"] })]),
  );
  writeFileSync(
    join(dir, "beta.yaml"),
    JSON.stringify([entry({ id: "beta-fact", files: ["src/beta.ts"], fact: "Beta shard fact." })]),
  );

  const briefs = buildShardStandingBriefs(dir);

  assert.deepEqual(Object.keys(briefs).sort(), ["alpha.yaml", "beta.yaml"]);
  assert.deepEqual(
    briefs["alpha.yaml"].claims.map((c) => c.id),
    ["alpha-fact"],
  );
  assert.deepEqual(
    briefs["beta.yaml"].claims.map((c) => c.id),
    ["beta-fact"],
  );

  // Rebuilding with the previous map and an untouched directory refreshes nothing: same objects.
  const rebuilt = buildShardStandingBriefs(dir, briefs);
  assert.equal(rebuilt["alpha.yaml"], briefs["alpha.yaml"]);
  assert.equal(rebuilt["beta.yaml"], briefs["beta.yaml"]);
});
