import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { resolveMergedRuleId } from "../src/lib/knowledge-gardener.js";
import { slugifyRuleId } from "../src/lib/doctrine-lifecycle.js";
import { lookupWorkerRule, parseRuleBodyPointer, parseRuleHeadlines, type RuleHeadline } from "../src/lib/learnings.js";

// ── 2026-10-11: AN INDEX LINE CAN RETIRE WITHOUT ITS FROZEN RULE BEING LOST ─────────────────────
//
// CLAUDE.md is paid for in full by every interactive session, and 56 of its lines are W1-T3323
// rows frozen by `test/fixtures/doctrine-pre-migration-W1-T3323.json`. That freeze is on what a
// rule SAYS (headline + body sha), and `the-doctrine-index-points-at-every-body.test.ts` checks it
// against the RESOLVED corpus — so a frozen bullet moved VERBATIM into the body file of the rule
// that now carries its instruction is still resolvable and still byte-identical. What leaves is only
// its always-loaded index line. This suite pins the parts that make such a move honest:
//   (1) every frozen rule absent from the index sits under EXACTLY ONE live headline's body file;
//   (2) its id resolves to that live rule through `doctrine/merged-rules.json` (W1-T4097 iv);
//   (3) a superseded rule never ships beside its successor — the merge, not a "SUPERSEDES" prefix,
//       is how a successor replaces a frozen line.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(REPO_ROOT, "test", "fixtures", "doctrine-pre-migration-W1-T3323.json");

interface FrozenRow {
  id: string;
  headline: string;
}

const frozenRows = (): FrozenRow[] => (JSON.parse(readFileSync(MANIFEST, "utf8")) as { rules: FrozenRow[] }).rules;
const indexRules = (): RuleHeadline[] => parseRuleHeadlines(readFileSync(join(REPO_ROOT, "CLAUDE.md"), "utf8"));
const readStore = (target: string): string => readFileSync(join(REPO_ROOT, target), "utf8");

/** The live index rules whose body file carries `headline` as a LATER bullet (never its own first
 *  line — that is the rule's own index entry, not a retired one carried under it). */
function carriersOf(headline: string, rules: RuleHeadline[], read: (target: string) => string): RuleHeadline[] {
  return rules.filter((rule) => {
    const pointer = parseRuleBodyPointer(rule.body);
    return pointer !== undefined && read(pointer.target).includes(`\n- **${headline}**`);
  });
}

test("a retired index line keeps its frozen bullet verbatim under exactly one live headline", () => {
  const rules = indexRules();
  const live = new Set(rules.map((r) => r.headline));
  const retired = frozenRows().filter((row) => !live.has(row.headline));
  // POSITIVE CONTROL: the suite must be measuring real retirements, not an empty set.
  assert.ok(retired.length >= 1, `expected at least one retired frozen index line; got ${retired.length}`);

  for (const row of retired) {
    const carriers = carriersOf(row.headline, rules, readStore);
    assert.equal(carriers.length, 1, `"${row.headline.slice(0, 60)}" must sit under exactly one live rule; got ${carriers.length}`);
    assert.equal(
      resolveMergedRuleId(REPO_ROOT, row.id),
      slugifyRuleId(carriers[0].headline),
      `doctrine/merged-rules.json must resolve ${row.id} to the rule that carries it`,
    );
  }
});

test("a retired index line keeps its frozen bullet — CONTROL: a retired headline with no carrier is caught", () => {
  const rules = parseRuleHeadlines("## S\n\n- **LIVE RULE** → doctrine/s/live.md\n");
  const store: Record<string, string> = { "doctrine/s/live.md": "- **LIVE RULE** evidence.\n" };
  assert.equal(carriersOf("RETIRED RULE", rules, (t) => store[t]).length, 0, "an unmoved bullet has no carrier");
  store["doctrine/s/live.md"] += "\n- **RETIRED RULE** its frozen body.\n";
  assert.equal(carriersOf("RETIRED RULE", rules, (t) => store[t]).length, 1, "a moved bullet has exactly one");
  // A rule's OWN first line never counts as carrying itself.
  assert.equal(carriersOf("LIVE RULE", rules, (t) => store[t]).length, 0);
});

test("a superseded rule never ships beside its successor in the index", () => {
  const stacked = indexRules().filter((r) => /SUPERSEDES/.test(r.headline)).map((r) => r.headline.slice(0, 70));
  assert.deepEqual(stacked, [], "merge the superseded line into its successor instead of prefixing SUPERSEDES");
});

// "The headline is the whole rule: obey it unopened." Three shapes defer a headline's instruction to
// somewhere a reader of the index never looks, and all are mechanical enough to pin: a headline
// ENDING ON A COLON (its instruction is the body), one pointing at ANOTHER LINE ("above", "below"),
// and one OPENING ON "AND" as the continuation of its neighbour — a fold or reorder moves either
// neighbour out from under it.
function deferringHeadlines(rules: RuleHeadline[]): string[] {
  return rules
    .filter((r) => /:\s*$/.test(r.headline) || /\b(above|below)\b/i.test(r.headline) || /^and\b/i.test(r.headline))
    .map((r) => r.headline.slice(0, 70));
}

test("an index headline states its instruction — none ends on a colon, points at another line or opens on AND", () => {
  const rules = indexRules();
  assert.ok(rules.length >= 50, `positive control: the real index must be measured; got ${rules.length}`);
  assert.deepEqual(deferringHeadlines(rules), [], "fold the instruction into the headline (round 2, 2026-10-11)");
});

test("an index headline states its instruction — CONTROL: every deferring shape is caught", () => {
  const rules = parseRuleHeadlines(
    "## S\n\n- **NOW ENFORCED:** → doctrine/s/a.md\n- **SO THE SWEEP ABOVE CANNOT FIND IT** → doctrine/s/b.md\n" +
      "- **AND A TRAILER-ONLY SET UNDER-CREDITS** → doctrine/s/c.md\n" +
      "- **See the rule below.** → doctrine/s/d.md\n" +
      "- **Run `rmd x`: it reads the union, and a sandbox is no stand-in.** → doctrine/s/e.md\n",
  );
  // The last one is the HEALTHY arm: a colon mid-headline, and "and"/"stand" mid-sentence, are fine.
  assert.deepEqual(deferringHeadlines(rules), [
    "NOW ENFORCED:",
    "SO THE SWEEP ABOVE CANNOT FIND IT",
    "AND A TRAILER-ONLY SET UNDER-CREDITS",
    "See the rule below.",
  ]);
});

// A body file can be RENAMED (round 3, 2026-10-11: 42 sentence-length slugs became 2-4 words) or
// retired into a carrier, and merged plan shards, docs and learnings still cite the old path. Those
// files are history and are not rewritten, so an old path must keep reaching its rule: on disk, or
// through `doctrine/merged-rules.json`, which `lookupWorkerRule` already consults for a miss.
const DOCTRINE_PATH_RE = /doctrine\/[a-z0-9-]+\/[a-z0-9._-]+\.md/g;

function citingFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...citingFiles(abs));
    else if (/\.(md|ya?ml)$/.test(entry)) out.push(abs);
  }
  return out;
}

/** Paths into a real section only: `doctrine/x/y.md` in a shard is an example, not a citation. */
function citedDoctrinePaths(texts: string[], sections: Set<string>): Set<string> {
  return new Set(texts.flatMap((t) => t.match(DOCTRINE_PATH_RE) ?? []).filter((p) => sections.has(p.split("/")[1])));
}

function unresolvedDoctrineCitations(texts: string[], sections: Set<string>, resolves: (path: string) => boolean): string[] {
  return [...citedDoctrinePaths(texts, sections)].filter((path) => !resolves(path)).sort();
}

test("a doctrine path cited outside doctrine/ still reaches its rule — on disk or through the merge registry", () => {
  const roots = ["plan", "docs", "learnings"].map((d) => join(REPO_ROOT, d));
  const rootDocs = readdirSync(REPO_ROOT).filter((f) => f.endsWith(".md") && f !== "CLAUDE.md").map((f) => join(REPO_ROOT, f));
  const texts = [...roots.flatMap(citingFiles), ...rootDocs].map((f) => readFileSync(f, "utf8"));
  const source = readFileSync(join(REPO_ROOT, "CLAUDE.md"), "utf8");
  const resolves = (path: string) => existsSync(join(REPO_ROOT, path)) || lookupWorkerRule(path, source, readStore, []) !== undefined;
  const doctrine = join(REPO_ROOT, "doctrine");
  const sections = new Set(readdirSync(doctrine).filter((e) => statSync(join(doctrine, e)).isDirectory()));
  // POSITIVE CONTROL: the sweep must be reading real citations, not an empty corpus.
  const cited = citedDoctrinePaths(texts, sections);
  assert.ok(cited.size >= 3, `expected the plan to cite doctrine paths; got ${cited.size}`);
  assert.deepEqual(unresolvedDoctrineCitations(texts, sections, resolves), [], "alias each old body path in doctrine/merged-rules.json");
});

test("a doctrine path cited outside doctrine/ — CONTROL: a path with no file and no alias is caught", () => {
  const texts = ["see doctrine/s/kept.md", "moved: doctrine/s/old-long-name.md", "gone: doctrine/s/nowhere.md", "e.g. doctrine/x/y.md"];
  const onDisk = new Set(["doctrine/s/kept.md"]);
  const aliased = new Set(["doctrine/s/old-long-name.md"]);
  // `doctrine/x/y.md` names no real section, so it is an example and never a miss.
  assert.deepEqual(unresolvedDoctrineCitations(texts, new Set(["s"]), (p) => onDisk.has(p) || aliased.has(p)), ["doctrine/s/nowhere.md"]);
});
