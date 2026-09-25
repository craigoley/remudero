/**
 * W1-T4117: the adoption scan finds dead exports and nothing removed them. The export gardener
 * deletes, in a small batch, an export the scan has reported unreferenced in two scans — unless a
 * grep finds its name anywhere else (a string lookup, a registry, a test) — and judges the class
 * by whether the deletions stay deleted.
 *
 * @source-text-subject — this gardener's OUTPUT is source text: it deletes declarations from a
 * `src/lib/` file. Every read below is of a throwaway fixture checkout the gardener itself rewrote,
 * never this repository's own `src/`, so reading that text back IS asserting on its behaviour.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  EXPORT_GARDEN_BATCH,
  applyExportDeletions,
  exportDeclarationSpan,
  exportGardenCandidates,
  exportGardenRecordPath,
  exportGardenSpec,
  exportInventory,
  IDENT_RE,
  parseSymbolFinding,
  SYMBOL_ID_RE,
} from "../src/lib/export-gardener.js";
import { gardenStatePath, runGarden, type GardenCheckout } from "../src/lib/gardener.js";
import { adoptionLatestPath, adoptionProposalId } from "../src/lib/measurement-cadence.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { writeAtomic as writeAtomicFile } from "../src/lib/fs-race-safe.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

const DEAD = ["deadA", "deadB", "deadC", "deadD", "deadE", "deadF", "deadG"];

function deadFile(names: string[]): string {
  const blocks = names.map((n, i) =>
    i % 2 === 0 ? `/** ${n}: nothing calls this. */\nexport function ${n}(x: { v: number }): number {\n  return x.v + ${i};\n}\n` : `// ${n}: nor this.\nexport const ${n} = [${i}, ${i + 1}];\n`,
  );
  return [`import { join } from "node:path";\n`, `export function used(): string {\n  return join("a", "b");\n}\n`, ...blocks].join("\n");
}

function repoWith(files: Record<string, string>): GitRepo {
  const repo = gitRepo({ kind: "w1t4117" });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo.dir, rel)), { recursive: true });
    writeFileSync(join(repo.dir, rel), text);
  }
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "seed");
  return repo;
}

function scan(stateDir: string, generatedAt: string, symbols: Array<[string, string]>): void {
  const proposalIds = symbols.map(([definedIn, mechanism]) => adoptionProposalId({ shape: "symbol-no-caller", definedIn, mechanism }));
  writeFileSync(adoptionLatestPath(stateDir), JSON.stringify({ generatedAt, proposalIds, shapesObserved: ["symbol-no-caller"] }));
}

function harness(repo: GitRepo) {
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4117-state-`));
  // An optimistic record that always draws above even odds, so the test reads the gardener's
  // choices rather than one seeded draw.
  writeFileSync(gardenStatePath(stateDir, "export"), JSON.stringify({ classes: { "delete-unreferenced-export": { alpha: 1000, beta: 1 } } }));
  const landed: Array<{ paths: string[]; title: string; body: string; root: string }> = [];
  const workspaces: GitRepo[] = [];
  const deps = {
    stateDir,
    repoRoot: repo.dir,
    seed: 7,
    openWorkspace: (): GardenCheckout => {
      const ws = gitRepo({ kind: "w1t4117-ws", cloneFrom: repo.dir });
      workspaces.push(ws);
      return {
        root: ws.dir,
        land: (opts) => {
          landed.push({ ...opts, root: ws.dir });
          return `https://github.com/acme/demo/pull/${landed.length}`;
        },
        dispose: () => {},
      };
    },
    log: () => {},
  };
  return { stateDir, landed, deps, pass: () => runGarden(exportGardenSpec(deps), deps) };
}

test("W1-T4117: an export reported unreferenced twice is deleted in a small batch", () => {
  const repo = repoWith({ "src/lib/dead.ts": deadFile(DEAD), "src/lib/user.ts": `import { used } from "./dead.js";\n\nexport const who = used();\n` });
  const h = harness(repo);
  const reported = DEAD.map((n): [string, string] => ["src/lib/dead.ts", n]);

  // One scan is not enough: nothing is deleted on a single report.
  scan(h.stateDir, "2026-09-20T00:00:00.000Z", reported);
  const first = h.pass();
  assert.equal(first.ran, true);
  assert.equal(h.landed.length, 0, "an export reported unreferenced once is not deleted");

  // The second scan reports the same exports again, plus one seen for the first time.
  scan(h.stateDir, "2026-09-21T00:00:00.000Z", [...reported, ["src/lib/dead.ts", "used"]]);
  const second = h.pass();
  assert.equal(h.landed.length, 1, "the second report lands one PR");
  const pr = h.landed[0]!;
  assert.deepEqual(pr.paths, ["src/lib/dead.ts"]);
  assert.match(pr.title, /^refactor\(lib\): the export gardener deletes \d+ unreferenced export/);
  assert.ok(pr.title.length <= 100, pr.title);

  const after = readFileSync(join(pr.root, "src/lib/dead.ts"), "utf8");
  const gone = DEAD.filter((n) => !new RegExp(`\\b${n}\\b`).test(after));
  const kept = DEAD.filter((n) => new RegExp(`^export (?:function|const) ${n}\\b`, "m").test(after));
  assert.equal(gone.length, EXPORT_GARDEN_BATCH, "a small batch — no more than the batch size — is deleted, its comment with it");
  assert.equal(kept.length, DEAD.length - EXPORT_GARDEN_BATCH, "the rest wait for a later pass");
  assert.deepEqual(second.plan?.actions.map((a) => a.target).sort(), gone.map((n) => `src/lib/dead.ts#${n}`).sort());
  assert.match(after, /^export function used\(\): string \{$/m, "an export reported only once stays");
  assert.doesNotMatch(after, /\n\n\n/, "no run of blank lines is left where a declaration was");
  for (const n of gone) assert.match(pr.body, new RegExp(`\`${n}\``), `the PR names ${n}`);

  // The span finder read each declaration whole: what is left still has balanced brackets.
  const count = (re: RegExp) => (after.match(re) ?? []).length;
  assert.equal(count(/\{/g), count(/\}/g));
  assert.equal(count(/\[/g), count(/\]/g));
});

test("W1-T4117: an export named in a string lookup is kept", () => {
  const repo = repoWith({
    "src/lib/handlers.ts": [
      `export function registryHandler(): string {\n  return "r";\n}\n`,
      `export function plainDead(): string {\n  return "p";\n}\n`,
      `export function selfUsed(): string {\n  return "s";\n}\n`,
      `export const viaSelf = () => selfUsed();\n`,
    ].join("\n"),
    // The registry reaches its handler by NAME — no import, no call a static scan can see.
    "src/lib/registry.ts": `const HANDLERS = ["registryHandler"];\n\nexport function lookup(name: string): boolean {\n  return HANDLERS.includes(name);\n}\n`,
  });
  const h = harness(repo);
  const reported: Array<[string, string]> = [
    ["src/lib/handlers.ts", "registryHandler"],
    ["src/lib/handlers.ts", "plainDead"],
    ["src/lib/handlers.ts", "selfUsed"],
  ];
  scan(h.stateDir, "2026-09-20T00:00:00.000Z", reported);
  h.pass();
  scan(h.stateDir, "2026-09-21T00:00:00.000Z", reported);

  const candidates = exportGardenCandidates(exportInventory(repo.dir, h.stateDir), repo.dir);
  assert.deepEqual(
    candidates.map((a) => a.name),
    ["plainDead"],
    "a name found by grep anywhere outside its own declaration — a string lookup, or a use in its own file — is not a candidate",
  );

  h.pass();
  assert.equal(h.landed.length, 1);
  const after = readFileSync(join(h.landed[0]!.root, "src/lib/handlers.ts"), "utf8");
  assert.match(after, /^export function registryHandler\(\)/m, "the registry-named export is kept");
  assert.match(after, /^export function selfUsed\(\)/m, "an export its own file still uses is kept");
  assert.doesNotMatch(after, /plainDead/, "the export nothing names is deleted");
});

test("W1-T4117: a malformed record requires two fresh sightings before deletion", () => {
  const repo = repoWith({ "src/lib/dead.ts": deadFile(["deadA"]) });
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4117-corrupt-`));
  const reported: Array<[string, string]> = [["src/lib/dead.ts", "deadA"]];
  writeFileSync(exportGardenRecordPath(stateDir), "{truncated");

  scan(stateDir, "2026-09-20T00:00:00.000Z", reported);
  const first = exportInventory(repo.dir, stateDir);
  assert.deepEqual(first.twice, [], "a damaged record cannot supply the first sighting");
  assert.deepEqual(exportGardenCandidates(first, repo.dir), [], "one fresh sighting cannot delete an export");

  scan(stateDir, "2026-09-21T00:00:00.000Z", reported);
  const second = exportInventory(repo.dir, stateDir);
  assert.deepEqual(second.twice, [adoptionProposalId({ shape: "symbol-no-caller", definedIn: "src/lib/dead.ts", mechanism: "deadA" })]);
  assert.deepEqual(exportGardenCandidates(second, repo.dir).map((action) => action.name), ["deadA"]);
});

test("W1-T4117: a concurrent source edit withdraws the export deletion", () => {
  const repo = repoWith({ "src/lib/dead.ts": deadFile(["deadA"]) });
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4117-race-`));
  const report: Array<[string, string]> = [["src/lib/dead.ts", "deadA"]];
  scan(stateDir, "2026-09-20T00:00:00.000Z", report);
  exportInventory(repo.dir, stateDir);
  scan(stateDir, "2026-09-21T00:00:00.000Z", report);
  const candidates = exportGardenCandidates(exportInventory(repo.dir, stateDir), repo.dir);
  assert.equal(candidates.length, 1);

  const path = join(repo.dir, "src/lib/dead.ts");
  const concurrentEdit = `${readFileSync(path, "utf8")}\n// concurrent edit\n`;
  const deleted = applyExportDeletions(repo.dir, candidates, (target, content, options) => {
    writeAtomicFile(target, concurrentEdit);
    return writeAtomicFile(target, content, options);
  });

  assert.deepEqual(deleted, [], "the stale candidate is not reported as applied");
  assert.equal(readFileSync(path, "utf8"), concurrentEdit, "a concurrent edit is preserved byte-for-byte");
});

test("W1-T4117: a deletion re-added within the window is read as a failure", () => {
  const repo = repoWith({ "src/lib/dead.ts": deadFile(["deadA"]) });
  const h = harness(repo);
  scan(h.stateDir, "2026-09-20T00:00:00.000Z", [["src/lib/dead.ts", "deadA"]]);
  h.pass();
  scan(h.stateDir, "2026-09-21T00:00:00.000Z", [["src/lib/dead.ts", "deadA"]]);
  h.pass();
  assert.equal(h.landed.length, 1);

  // The PR merges: the export is gone from the checkout the next scan reads.
  writeFileSync(join(repo.dir, "src/lib/dead.ts"), readFileSync(join(h.landed[0]!.root, "src/lib/dead.ts"), "utf8"));
  scan(h.stateDir, "2026-09-22T00:00:00.000Z", []);
  const landedInv = exportInventory(repo.dir, h.stateDir);
  assert.equal(landedInv.record.deletions[0]?.landedAt, "2026-09-22T00:00:00.000Z");
  assert.deepEqual(landedInv.tally, { trials: 3, successes: 1 }, "two scans of one dead export, then a deletion that stays deleted: one success");

  // Then someone reverts it.
  writeFileSync(join(repo.dir, "src/lib/dead.ts"), deadFile(["deadA"]));
  scan(h.stateDir, "2026-09-23T00:00:00.000Z", [["src/lib/dead.ts", "deadA"]]);
  const reverted = exportInventory(repo.dir, h.stateDir);
  assert.equal(reverted.record.deletions[0]?.reAdded, true);
  assert.deepEqual(reverted.tally, { trials: 5, successes: 1 }, "a re-added export is a failure, and never proposed again");
  scan(h.stateDir, "2026-09-24T00:00:00.000Z", [["src/lib/dead.ts", "deadA"]]);
  assert.deepEqual(exportGardenCandidates(exportInventory(repo.dir, h.stateDir), repo.dir), []);
});

test("W1-T4117: a declaration span covers its comment and body, and refuses an overload", () => {
  const text = `// lead\nexport function a(): void {\n  if (x) {\n    y();\n  }\n}\n\nexport function b(n: number): number;\nexport function b(n: string): string;\nexport function b(n: unknown): unknown {\n  return n;\n}\n`;
  assert.deepEqual(exportDeclarationSpan(text, "a"), { start: 0, end: 5 });
  assert.equal(exportDeclarationSpan(text, "b"), undefined, "an overloaded export is left alone");
  assert.equal(exportDeclarationSpan(text, "c"), undefined);
});

test("W1-T4117: only a symbol-no-caller id with a plain name is read as a deletable export", () => {
  assert.equal(SYMBOL_ID_RE.test("adoption:symbol-no-caller:src/lib/a.ts:deadA"), true);
  assert.equal(SYMBOL_ID_RE.test("adoption:field-no-writer:src/lib/plan.ts:deadA"), false, "another shape is not an export");
  assert.equal(SYMBOL_ID_RE.test("adoption:symbol-no-caller:src/lib/a.ts:"), false, "no name");
  assert.deepEqual(parseSymbolFinding("adoption:symbol-no-caller:src/lib/a.ts:deadA"), { file: "src/lib/a.ts", name: "deadA" });
  assert.equal(parseSymbolFinding("adoption:script-no-invoker:scripts/x.mjs:x"), undefined);
  assert.equal(IDENT_RE.test("deadA"), true);
  assert.equal(IDENT_RE.test("$dead"), false, "grep -w cannot bound a `$` name, so the reference check cannot vouch for it");
  assert.equal(exportDeclarationSpan("export const $dead = 1;\n", "$dead"), undefined);
});
