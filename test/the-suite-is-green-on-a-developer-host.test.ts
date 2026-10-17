// @census-reads: test/
/** @source-text-subject: this census audits the host dependencies declared by test suites. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * W1-T9872: every tracked test file under test/ at ANY depth (relative to test/, minus test/fixtures/)
 * plus the absolute test/ directory, both resolved from the REPO ROOT that git reports for this file's
 * own folder. A readdirSync of the folder holding the suite would silently drop every file that moved
 * into a subfolder. Two independent pathspecs must agree on the count.
 */
function testCorpus(): { dir: string; files: string[] } {
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: TEST_DIR, encoding: "utf8", maxBuffer: 64 << 20 });
  const root = git("rev-parse", "--show-toplevel").trim();
  const list = (spec: string): string[] =>
    git("ls-files", "--full-name", "--", spec).split("\n").filter((f) => f.startsWith("test/") && !f.startsWith("test/fixtures/"));
  const walked = list(":(top,glob)test/**/*.test.ts");
  assert.ok(walked.length > 0, "the recursive test/ listing must find the test corpus");
  assert.equal(walked.length, list(":(top)test/*.test.ts").length, "both pathspecs must see the same population");
  return { dir: join(root, "test"), files: walked.map((f) => f.slice("test/".length)) };
}

// Each observation is a host-sensitive operation in the six suites reported by W1-T4440.
// The declaration names the isolation or the capability gate at the call site.
const OBSERVATIONS = [
  { file: "git-fixture-gc-hygiene.test.ts", observes: /execFileSync\("git"/, declaration: "isolated-git" },
  { file: "credential-reach-probe.test.ts", observes: /hostClassOf\(process\.env/, declaration: "credential-reach" },
  { file: "a-gardener-pr-carries-a-conforming-identity.test.ts", observes: /symlinkSync\(/, declaration: "symlink" },
  { file: "a-live-console-review-is-runnable.test.ts", observes: /mod\.writeArtefacts\(/, declaration: "isolated-temp-root" },
  { file: "adhoc-lane-reap.test.ts", observes: /execFileSync\("git"/, declaration: "isolated-git" },
  { file: "the-scheduled-learning-rung-drafts-and-discards.test.ts", observes: /buildCiLearningCadenceRunner\(/, declaration: "isolated-temp-root" },
] as const;

const HOST_READS = [
  { observes: /hostClassOf\(process\.env|process\.env\.HOME \?\? homedir\(\)/, declaration: "credential-reach" },
  { observes: /execFileSync\("git", \["config", "--global"/, declaration: "isolated-git" },
] as const;

function undeclared(corpus: ReadonlyMap<string, string>): string[] {
  const known = OBSERVATIONS.flatMap(({ file, observes, declaration }) => {
    const source = corpus.get(file);
    if (!source) return [`${file}: suite missing from census corpus`];
    if (!observes.test(source)) return [`${file}: host observation disappeared; update the census`];
    if (!source.includes(`@host-capability ${declaration}:`)) return [`${file}: ${declaration} host read is undeclared`];
    return [];
  });
  const discovered = [...corpus].flatMap(([file, source]) => {
    if (file === "the-suite-is-green-on-a-developer-host.test.ts") return [];
    return HOST_READS.flatMap(({ observes, declaration }) =>
      observes.test(source) && !source.includes(`@host-capability ${declaration}:`)
        ? [`${file}: ${declaration} host read is undeclared`]
        : [],
    );
  });
  return [...new Set([...known, ...discovered])];
}

test("W1-T4440: no suite reads host git or credential state without a declared capability", () => {
  const { dir, files } = testCorpus();
  const corpus = new Map(files.map((file) => [file, readFileSync(join(dir, file), "utf8")] as const));
  assert.deepEqual(undeclared(corpus), [], "host-dependent suites must declare their fixture or capability");

  // Positive control: dropping one declaration must name the suite that lost it.
  const changed = new Map(corpus);
  const file = "credential-reach-probe.test.ts";
  changed.set(file, changed.get(file)!.replace("@host-capability credential-reach:", ""));
  assert.deepEqual(undeclared(changed), [`${file}: credential-reach host read is undeclared`]);

  changed.set(file, corpus.get(file)!);
  changed.set("new-host-reader.test.ts", 'const home = process.env.HOME ?? homedir();');
  assert.deepEqual(undeclared(changed), ["new-host-reader.test.ts: credential-reach host read is undeclared"]);
});
