/**
 * THE AUTHOR'S CENSUS PRECHECK SKIPS ITS FULL PASS ONLY WHEN NO CENSUS-READ FILE CHANGED — W1-T11940.
 *
 * OBSERVED 2026-11-10: the full census pass took 9 to 39 minutes; its counts take 3 to 5 s. With
 * `--skip-when-unread` (passed only by scripts/preflight-author.mjs) census-precheck computes the
 * counts first and skips the suite measurement only when the counts pass, the instrument census is
 * out of scope, and every suite the full pass would run declares `@census-reads` with no read changed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { CENSUS_READS_MARKER, sourceTextReaderOf } from "#src/lib/source-text-readers.js";
import {
  CENSUS_FULL_PASS_SKIPPED_LABEL, PRECHECK_PATH_TRIGGERED_SUITES, PRECHECK_TRIGGERED_SUITES,
  censusFullPassDecision, censusFullPassSuites, censusReadsDeclaration, main, withoutTriggerJoinedSuites,
  // @ts-ignore the executable .mjs module has no declaration file.
} from "#scripts/census-precheck.mjs";
// @ts-ignore the executable .mjs module has no declaration file.
import { CENSUS_FULL_PASS_SKIPPED_LINE, authorCensusPrecheckArgs, censusFullPassNote } from "#scripts/preflight-author.mjs";

type Tree = Record<string, string>;
type Member = { testFile: string; script: string; walks: string[] };

const SKILL_CENSUS = "test/rules/every-applies-to-skill-is-selectable-and-bounded.test.ts";
const SUITE_STUB = 'import { test } from "node:test"; test("stand-in", () => {});\n';
const DECLARED_SKILL_CENSUS = `// @census-reads: test/rules/ — the fixture's stand-in declares its reads\n${SUITE_STUB}`;
const READS_X = "test/reads-x.test.ts";
const DECLARED_READS_X = `// @census-reads: src/lib/x.ts — reads one file\n${SUITE_STUB}`;
const ROOTS = new Set(["src", "test", "docs", "scripts", ".claude"]);

/** A fixture repo whose `work` branch writes `change` over `seed` committed on main. */
function fixtureRepo(seed: Tree, change: Tree): string {
  const repo = gitRepo({ kind: "census-full-pass" });
  const write = (tree: Tree) => {
    for (const [path, text] of Object.entries(tree)) {
      mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
      writeFileSync(join(repo.dir, path), text);
    }
  };
  write(seed);
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "the base");
  repo.git("switch", "--quiet", "-c", "work");
  write(change);
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "the change");
  return repo.dir;
}

function capture(t: { mock: { method: (o: object, k: string, f: (...a: unknown[]) => void) => unknown } }) {
  const err: string[] = [];
  const out: string[] = [];
  t.mock.method(console, "error", (...a: unknown[]) => void err.push(a.join(" ")));
  t.mock.method(console, "log", (...a: unknown[]) => void out.push(a.join(" ")));
  return { err, out };
}

/** Run `main` over `repo` with the member list and a suite runner that records every file it is asked to run. */
function runMain(repo: string, members: Member[], flags: string[]) {
  const ran: string[][] = [];
  let measured = 0;
  const status = main(["--root", repo, "--base", "main", ...flags], {
    admitted: () => members,
    measure: () => {
      measured++;
      throw new Error("the instrument child must not run in this fixture");
    },
    runSuites: ({ files }: { files: string[] }) => {
      ran.push([...files].sort());
      return [];
    },
  });
  return { status, ran, measured };
}

const declaredOnDisk = (file: string) => readFileSync(join(REPO_ROOT, file), "utf8").split("\n")
  .some((line) => /^\s*(?:\/\/|\/?\*+)\s*@census-reads:/.test(line));

test("W1-T11940 criterion 1: the skip relies only on suites that declare @census-reads in their own text", () => {
  assert.equal(censusReadsDeclaration(SUITE_STUB, ROOTS), null, "no marker is undeclared");
  assert.deepEqual(censusReadsDeclaration(DECLARED_READS_X, ROOTS), ["src/lib/x.ts"]);
  assert.deepEqual(censusReadsDeclaration(`// @census-reads: none — reads a temp fixture\n${SUITE_STUB}`, ROOTS), []);
  assert.equal(censusReadsDeclaration(`const s = "@census-reads: src/";\n${SUITE_STUB}`, ROOTS), null,
    "the marker inside a string is data, not a declaration");
  assert.equal(censusReadsDeclaration(`// @census-reads: the ledger, somewhere\n${SUITE_STUB}`, ROOTS), null,
    "a declaration that resolves to no walk is unknown");
  assert.equal(censusReadsDeclaration(`// @census-reads: src/a.ts\n// @census-closure: src/a.ts\n${SUITE_STUB}`, ROOTS), null,
    "a closure seed widens past a declared FILE, so it is unknown");
  assert.equal(censusReadsDeclaration(`// @census-reads: test/\n// @census-closure: src/a.ts\n${SUITE_STUB}`, ROOTS), null,
    "a closure seed outside every declared directory is unknown");
  assert.equal(censusReadsDeclaration(`// @census-closure: src/a.ts\n${SUITE_STUB}`, ROOTS), null, "a seed with no declaration is unknown");
  assert.deepEqual(censusReadsDeclaration(`// @census-closure: src/a.ts\n// @census-reads: src/ — the closure lies under src/\n${SUITE_STUB}`, ROOTS),
    ["src/"], "a closure seed under a declared directory is declared by it");

  // Over the REAL tree: force EVERY suite of both trigger tables into the full pass, as a diff touching all of them would,
  // and read each one's declaration from disk. No suite may be undeclared, and every declared path must exist.
  const triggered = [...PRECHECK_TRIGGERED_SUITES, ...PRECHECK_PATH_TRIGGERED_SUITES];
  const roots = new Set(readdirSync(REPO_ROOT).filter((name) => name !== ".git"));
  const readHead = (p: string) => (existsSync(join(REPO_ROOT, p)) ? readFileSync(join(REPO_ROOT, p), "utf8") : null);
  const forced = triggered.map(({ testFile }: { testFile: string }) => ({ testFile, trigger: () => true }));
  const suites = censusFullPassSuites({ changed: ["docs/never-read.md"], members: [], readHead, readBase: readHead, roots,
    triggered: forced }) as { testFile: string; declared: string[] | null }[];
  const rowFiles = [...new Set(triggered.map(({ testFile }: { testFile: string }) => testFile))].sort();
  assert.ok(rowFiles.length >= 39, `the tables list ${rowFiles.length} suites`);
  assert.deepEqual(suites.map((s) => s.testFile).sort(), rowFiles, "every table suite joined the forced pass");
  assert.deepEqual(suites.filter((s) => s.declared === null).map((s) => s.testFile), [], "no suite the counts-only pass reports is undeclared");
  for (const s of suites) {
    assert.ok(declaredOnDisk(s.testFile), `${s.testFile} is relied on but declares no @census-reads`);
    assert.ok(s.declared!.length > 0, `${s.testFile} declares reads`);
    for (const walk of s.declared!) {
      const path = walk.endsWith("/") ? walk.slice(0, -1) : walk;
      assert.ok(existsSync(join(REPO_ROOT, path)), `${s.testFile} declares ${walk}, which names nothing in the tree`);
    }
    // A diff touching the suite's own file or its first declared read can never skip.
    for (const changed of [[s.testFile], [s.declared![0]!]]) {
      assert.equal(censusFullPassDecision({ changed, countsOk: true, suites }).skip, false, `${s.testFile} is skipped over ${changed[0]}`);
    }
  }
  // Control: the same forced suites DO skip a diff none of them reads, so the loop above is not a decision that never skips.
  assert.equal(censusFullPassDecision({ changed: ["docs/never-read.md"], countsOk: true, suites }).skip, true);
  const dotfile = suites.filter((s) => s.declared!.includes(".gitignore/")).map((s) => s.testFile);
  assert.deepEqual(dotfile, ["test/rules/the-root-scratch-ignore-stays-root-only.test.ts"]);
  assert.equal(censusFullPassDecision({ changed: [".gitignore"], countsOk: true, suites }).skip, false, "a root dotfile is read by its suite");
  assert.equal(censusFullPassDecision({ changed: [".gitignore-notes"], countsOk: true, suites }).skip, true, "a sibling name is not the file");
  assert.deepEqual(withoutTriggerJoinedSuites([{ testFile: READS_X }, { testFile: SKILL_CENSUS }, { testFile: dotfile[0] }]), [{ testFile: READS_X }],
    "a suite a trigger table names joins by its trigger, never by the walk its declaration adds");
  // The restated parser agrees with src/lib/source-text-readers.ts on every declaring suite in the tree.
  const markers = execFileSync("git", ["grep", "-lF", "--", CENSUS_READS_MARKER, "test/"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n").filter(Boolean);
  let compared = 0;
  for (const file of markers) {
    const text = readFileSync(join(REPO_ROOT, file), "utf8");
    const local = censusReadsDeclaration(text, roots) as string[] | null;
    if (local === null) continue;
    compared++;
    const real = sourceTextReaderOf(file, text, roots).walks;
    for (const walk of local) assert.ok(real.includes(walk), `${file}: ${walk} is not a walk of ${real.join(" ")}`);
  }
  assert.ok(compared >= 50, `compared ${compared} declaring suites`);
  const decision = censusFullPassDecision({ changed: ["docs/never-read.md"], countsOk: true, suites });
  assert.equal(decision.skip, true);
  assert.deepEqual(decision.reliedOn, suites.map((s) => s.testFile), "the skip names every suite it relied on");

  // The REAL triggers over a docs-only diff: the always-joined skill census declares its reads, so the skip is reachable.
  const real = censusFullPassSuites({ changed: ["docs/never-read.md"], members: [], readHead, readBase: readHead, roots }) as
    { testFile: string; declared: string[] | null }[];
  assert.ok(real.some((s) => s.testFile === SKILL_CENSUS), "the skill census joins every nonempty diff");
  assert.deepEqual(real.filter((s) => s.declared === null), [], "no suite the real triggers join is undeclared");
  const docsOnly = censusFullPassDecision({ changed: ["docs/never-read.md"], countsOk: true, suites: real });
  assert.equal(docsOnly.skip, true, docsOnly.reason);
  assert.ok(docsOnly.reliedOn.includes(SKILL_CENSUS));
  // ...and a source diff reads what the skill census imports, so it never skips.
  const source = censusFullPassSuites({ changed: ["src/lib/x.ts"], members: [], readHead, readBase: readHead, roots }) as
    { testFile: string; declared: string[] | null }[];
  const touched = censusFullPassDecision({ changed: ["src/lib/x.ts"], countsOk: true, suites: source });
  assert.equal(touched.skip, false);
  assert.match(touched.reason, /^the diff touches a file \d+ census suite\(s\) declare they read: /);
  assert.ok(source.find((s) => s.testFile === SKILL_CENSUS)?.declared?.some((w) => "src/lib/x.ts".startsWith(w)),
    "the skill census declares the src/ it imports");
});

test("W1-T11940 criterion 2: a diff touching a declared census-read file runs the full pass exactly as today", (t) => {
  const pure = censusFullPassDecision({ changed: ["src/lib/x.ts"], countsOk: true,
    suites: [{ testFile: READS_X, declared: ["src/lib/x.ts"] }] });
  assert.equal(pure.skip, false);
  assert.match(pure.reason, /touches a file 1 census suite\(s\) declare they read: test\/reads-x\.test\.ts/);

  const io = capture(t);
  const repo = fixtureRepo({ [SKILL_CENSUS]: DECLARED_SKILL_CENSUS, [READS_X]: DECLARED_READS_X, "src/lib/x.ts": "export const x = 1;\n" },
    { "src/lib/x.ts": "export const x = 2;\n" });
  const members = [{ testFile: READS_X, script: "", walks: ["src/lib/x.ts"] }];
  const gated = runMain(repo, members, ["--skip-when-unread"]);
  const today = runMain(repo, members, []);
  assert.equal(gated.status, 0, io.err.join("\n"));
  assert.deepEqual(gated, today, "the gated run measures exactly the suites the ungated one does");
  assert.ok(gated.ran.flat().includes(READS_X), "the suite reading the changed file ran");
  assert.ok(io.out.some((l) => l.startsWith("census-precheck: full pass runs - the diff touches a file")), io.out.join("\n"));
  assert.ok(!io.out.some((l) => l.startsWith(CENSUS_FULL_PASS_SKIPPED_LABEL)));
});

test("W1-T11940 criterion 3: a diff touching no census-read file skips the full pass and the preflight says so, naming the count", (t) => {
  const io = capture(t);
  const repo = fixtureRepo({ [SKILL_CENSUS]: DECLARED_SKILL_CENSUS, [READS_X]: DECLARED_READS_X, "docs/a.md": "one\n" },
    { "docs/a.md": "two\n" });
  const gated = runMain(repo, [{ testFile: READS_X, script: "", walks: ["src/lib/x.ts"] }], ["--skip-when-unread"]);
  assert.equal(gated.status, 0, io.err.join("\n"));
  assert.deepEqual(gated.ran, [], "no census suite started");
  assert.equal(gated.measured, 0, "the instrument child never started");
  const line = io.out.find((l) => l.startsWith(CENSUS_FULL_PASS_SKIPPED_LABEL));
  assert.ok(line, io.out.join("\n"));
  assert.match(line, /relied on counts OK over 1 changed file\(s\) against main and 1 census suite\(s\) declaring @census-reads/);

  // The author preflight asks for the gate, and reads the skip and its count from the census step's own stdout.
  assert.deepEqual(authorCensusPrecheckArgs("/r", "abc").slice(1), ["--base", "abc", "--skip-when-unread"]);
  assert.ok(CENSUS_FULL_PASS_SKIPPED_LINE.startsWith(`${CENSUS_FULL_PASS_SKIPPED_LABEL} - `), "the two scripts name one line");
  const note = censusFullPassNote({ status: 0, stdout: io.out.join("\n") });
  assert.equal(note.skipped, true);
  assert.match(note.reliedOn, /^relied on counts OK over 1 changed file\(s\)/);
  assert.deepEqual(censusFullPassNote({ status: 1, stdout: io.out.join("\n") }), { skipped: false }, "a failed step is never a skip");
  assert.deepEqual(censusFullPassNote({ status: 0, stdout: "census-precheck: OK — 1 changed file(s) checked against main\n" }), { skipped: false });
});

test("W1-T11940 criterion 4: a suite with no declaration is never skipped, and a counts-only failure runs the full pass", (t) => {
  const undeclared = censusFullPassDecision({ changed: ["docs/a.md"], countsOk: true,
    suites: [{ testFile: READS_X, declared: ["src/lib/x.ts"] }, { testFile: SKILL_CENSUS, declared: null }] });
  assert.equal(undeclared.skip, false);
  assert.match(undeclared.reason, /1 census suite\(s\) declare no @census-reads: test\/rules\/every-applies-to-skill/);
  const counts = censusFullPassDecision({ changed: ["docs/a.md"], countsOk: false, suites: [] });
  assert.deepEqual(counts, { skip: false, reason: "the counts-only pass refused this branch", reliedOn: [] });
  assert.equal(censusFullPassDecision({ changed: ["docs/a.md"], countsOk: true, suites: null, unlisted: "no table" }).skip, false);
  assert.equal(censusFullPassDecision({ changed: ["scripts/a.mjs"], countsOk: true, suites: [], instrumentInScope: true }).skip, false);
  const throwing = censusFullPassSuites({ changed: ["docs/a.md"], members: [], readHead: () => null, readBase: () => null, roots: ROOTS,
    triggered: [{ testFile: READS_X, trigger: () => { throw new Error("unreadable"); } }] });
  assert.deepEqual(throwing, [{ testFile: READS_X, declared: null, unknown: "its trigger could not be evaluated: unreadable" }]);

  const io = capture(t);
  // The same docs-only diff as criterion 3, but the always-joined skill census carries no declaration.
  const repo = fixtureRepo({ [SKILL_CENSUS]: SUITE_STUB, "docs/a.md": "one\n" }, { "docs/a.md": "two\n" });
  const gated = runMain(repo, [], ["--skip-when-unread"]);
  assert.equal(gated.status, 0, io.err.join("\n"));
  assert.ok(gated.ran.flat().includes(SKILL_CENSUS), "the undeclared suite ran");
  assert.ok(io.out.some((l) => l.startsWith("census-precheck: full pass runs - 1 census suite(s) declare no @census-reads")), io.out.join("\n"));

  // A counts refusal: a new test deriving its own root. The full pass runs as today and its rows print.
  const own = `import { fileURLToPath } from "node:url";\nexport const ROOT = fileURLToPath(new URL("..", import` + `.meta.url));\n`;
  const refused = fixtureRepo({ [SKILL_CENSUS]: DECLARED_SKILL_CENSUS, "docs/a.md": "one\n" }, { "test/own-root.test.ts": own });
  const before = io.out.length;
  assert.equal(runMain(refused, [], ["--skip-when-unread"]).status, 1, io.err.join("\n"));
  assert.ok(io.out.slice(before).some((l) => l === "census-precheck: full pass runs - the counts-only pass refused this branch"), io.out.join("\n"));
  assert.ok(io.err.some((l) => /test-repo-root: new test test\/own-root\.test\.ts derives its own root/.test(l)), io.err.join("\n"));
});
