/** @source-text-subject: this census audits the host dependencies declared by test suites. */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

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
  const corpus = new Map(
    readdirSync(TEST_DIR)
      .filter((file) => file.endsWith(".test.ts"))
      .map((file) => [file, readFileSync(join(TEST_DIR, file), "utf8")] as const),
  );
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
