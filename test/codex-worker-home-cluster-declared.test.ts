import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { HOST_CAUSED_SUITE_REDS } from "../src/lib/ci-parity.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUBJECT = "test/codex-worker-home-redirection.test.ts";

/**
 * test/codex-worker-home-cluster-declared.test.ts — W1-T2850.
 *
 * THE FILING EXPECTED A CLUSTER; THE FIXTURE SAID OTHERWISE, AND THE SHARD'S OWN DESIGN (iii) IS
 * THE CLAUSE THAT CAUGHT IT. Three tests in the subject file died `spawnSync /usr/bin/bash ENOENT`
 * on the operator's mini, where bash ships at `/bin/bash`. The shard's note calls this "the ONLY
 * one of the four 2026-09-04 findings that is GENUINELY A HOST FACT". Measured, it is not:
 *
 *   - bash is not the code under test. It is a PROBE, spawned only to read back what the worker
 *     spawn env exports.
 *   - the PRODUCTION path resolves bash BY NAME through the injectable spawn seam —
 *     `detectHostFacts` (src/lib/ci-parity.ts) spawns `"bash"`, never an absolute path.
 *   - the env the probe is handed CARRIES PATH: `codexSpawnEnvForTest`'s keys measured as
 *     CODEX_HOME, GH_TOKEN, GITHUB_TOKEN, HOME, PATH, REMUDERO_WORKER_SCOPE.
 *
 * So the probe could always have resolved the interpreter exactly as production does, and the three
 * reds were a hardcoded path in a test — not a fact about the machine. Design (iii) says it
 * outright: "a declared cluster over a real test defect buries it permanently." The defect is fixed
 * at its source instead, and NO cluster is declared for it — a cluster attributing reds that no
 * longer happen is a false attribution in the other direction, which design (ii) warns of by name.
 *
 * The shard's three acceptance criteria all describe the cluster. They are not satisfiable over a
 * defect that has been fixed — criterion 3 in particular ("the declared count matches the number of
 * reds the file actually produces") is now zero — so they are repointed in a separate plan-only PR
 * rather than satisfied by declaring something untrue.
 */

test("W1-T2850: the interpreter is resolved through PATH, never hardcoded to a location that does not exist on darwin", () => {
  const raw = readFileSync(join(REPO_ROOT, SUBJECT), "utf8");
  // Read as SOURCE because the property is the ABSENCE of a hardcoded path, which no call can
  // demonstrate: a helper that happens to work on THIS host proves nothing about the host where it
  // failed. (W1-T2905's census counts reads of `src/` paths and this reads `test/`, so no declared
  // exemption is claimed — the read stands on the argument above, not on a marker.)
  //
  // COMMENTS STRIPPED FIRST, and that is not a convenience: the fix's own doc comment NAMES the
  // path it removed, so a raw substring scan trips on the prose explaining the absence — the same
  // shape scripts/assertion-discrimination-check.mjs refuses, and the same mistake this session
  // already made once in W1-T2831's no-override test.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  assert.ok(raw.includes("/usr/bin/bash"), "the prose still names the removed path (the control for the strip)");
  assert.ok(!src.includes("/usr/bin/bash"), "but no CODE spawns it — the absolute path is gone");
  assert.match(src, /execFileSync\("bash",/, "resolved by name, the way the production seam does");

  // Any OTHER absolute interpreter path in the file would reintroduce the same class.
  const hardcoded = src.match(/execFileSync\("\/[^"]*"/g) ?? [];
  assert.deepEqual(hardcoded, [], `no absolute interpreter path may be spawned here: ${hardcoded.join(", ")}`);
});

test("W1-T2850: the probe works when the interpreter is NOT at the path the test used to assume", () => {
  // The darwin shape, reproduced without needing darwin: an absolute path that does not exist dies
  // ENOENT, while resolving by name through the SAME env succeeds. That pair is the whole finding.
  const env = { PATH: process.env.PATH, HOME: "/tmp", ANTHROPIC_API_KEY: "sentinel-value" };
  assert.throws(
    () => execFileSync("/no/such/dir/bash", ["-ic", "true"], { env, stdio: "ignore" }),
    /ENOENT/,
    "a hardcoded path that is absent is exactly how this failed on the mini",
  );
  const out = execFileSync("bash", ["-ic", 'printf %s "${ANTHROPIC_API_KEY-}"'], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  assert.equal(out, "sentinel-value", "PATH resolution reads the env back correctly");
});

test("W1-T2850: NO host cluster is declared for this file — a cluster over a fixed defect is a false attribution", () => {
  const declared = HOST_CAUSED_SUITE_REDS.filter((c) => c.file === SUBJECT);
  assert.deepEqual(
    declared,
    [],
    "declaring a cluster here would attribute to the machine three reds that no longer happen, and " +
      "would bury the test defect that caused them — design (iii)'s named trap.",
  );

  // CONTROL: the table is real and this test can see it, so the empty result above is a measurement
  // rather than a broken read — and the sibling fact the shard cites IS still declared.
  assert.ok(HOST_CAUSED_SUITE_REDS.length > 5, `the cluster table must be populated (${HOST_CAUSED_SUITE_REDS.length})`);
  const bsdDate = HOST_CAUSED_SUITE_REDS.filter((c) => /fleet-heartbeat-supervisor-tick/.test(c.file));
  assert.equal(bsdDate.length, 1, "the bsd-date sibling the shard cites is present, so the query works");
});
