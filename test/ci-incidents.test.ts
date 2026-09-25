import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  ciIncidentEventsFromLog,
  createCiIncidentState,
  readCiIncidentJobLog,
  recordCheckRunOutcome,
} from "../src/lib/ci-incidents.js";
import { ghShim } from "./helpers/gh-shim.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const TWO_FAILURES = [
  "TAP version 13",
  "not ok 1 - alpha rejects an invalid token",
  "  ---",
  "  location: 'test/auth.test.ts:10:1'",
  "  failureType: 'testCodeFailure'",
  "  ...",
  "not ok 2 - beta preserves the receipt",
  "  ---",
  "  location: 'test/ledger.test.ts:20:3'",
  "  failureType: 'testCodeFailure'",
  "  ...",
  "not ok 3 - alpha rejects an invalid token",
  "  ---",
  "  location: 'test/auth.test.ts:10:1'",
  "  failureType: 'testCodeFailure'",
  "  ...",
].join("\n");

test("a failed job log is read through the real bounded gh text transport", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-ci-incident-job-log-"));
  const gh = ghShim([{ when: "api repos/craigoley/remudero/actions/jobs/321/logs", stdout: "RAW LOG: not JSON" }], {
    kind: "ci-incident-job-log",
  });
  const moduleUrl = pathToFileURL(join(repoRoot, "src/lib/ci-incidents.ts")).href;
  try {
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { readCiIncidentJobLog } from ${JSON.stringify(moduleUrl)}; process.stdout.write(await readCiIncidentJobLog("craigoley/remudero", 321));`,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${gh.dir}:${process.env.PATH ?? ""}`,
          HOME: root,
          RMD_GH_CACHE_HOME: root,
          RMD_GH_TRANSPORT_FLOOR: "advisory",
        },
      },
    );
    assert.equal(output, "RAW LOG: not JSON\n");
    assert.deepEqual(gh.calls(), ["api repos/craigoley/remudero/actions/jobs/321/logs"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(gh.dir, { recursive: true, force: true });
  }
});

test("job-log reading skips unknown repositories and reports a failed read without throwing", async () => {
  let calls = 0;
  assert.equal(
    await readCiIncidentJobLog("", 321, async () => {
      calls += 1;
      return "unexpected";
    }),
    "",
  );
  assert.equal(calls, 0);

  const failures: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  assert.equal(
    await readCiIncidentJobLog("craigoley/remudero", 321, async () => {
      throw new Error("fixture transport failure");
    }, (step, extra) => failures.push({ step, extra })),
    "",
  );
  assert.equal(failures.length, 1);
  assert.equal(failures[0].step, "serve.ci_incidents.job_log_unreadable");
  assert.match(String(failures[0].extra?.reason), /fixture transport failure/);
});

test("a failing check posts one incident event per failing test, fingerprinted by test", () => {
  const events = ciIncidentEventsFromLog(TWO_FAILURES, { sha: "head-a" });
  const sameTestsAtAnotherHead = ciIncidentEventsFromLog(TWO_FAILURES, { sha: "head-b" });

  assert.equal(events.length, 2, "duplicate TAP output for one file and title posts once");
  assert.deepEqual(events.map(({ name, message }) => [name, message]), [
    ["test/auth.test.ts", "alpha rejects an invalid token"],
    ["test/ledger.test.ts", "beta preserves the receipt"],
  ]);
  assert.deepEqual(events.map((event) => event.fingerprint), sameTestsAtAnotherHead.map((event) => event.fingerprint));
  assert.deepEqual(events.map((event) => event.sha), ["head-a", "head-a"]);
  assert.ok(events.every((event) => event.kind === "test_failure" && event.source === "ci"));
});

test("a check that passes on a re-run at the same sha marks its failed tests as flaky", () => {
  const failed = recordCheckRunOutcome(createCiIncidentState(), {
    sha: "same-head",
    branch: "feature",
    name: "ci-shard (1/8)",
    conclusion: "failure",
    log: TWO_FAILURES,
  });
  const passed = recordCheckRunOutcome(failed.state, {
    sha: "same-head",
    branch: "feature",
    name: "ci-shard (1/8)",
    conclusion: "success",
  });

  assert.equal(failed.events.length, 2);
  assert.deepEqual(passed.events.map((event) => event.kind), ["flake", "flake"]);
  assert.deepEqual(passed.events.map((event) => event.fingerprint), failed.events.map((event) => event.fingerprint));
  assert.deepEqual(passed.state.pending, {});
});

test("a test that also fails on main is never called a flake", () => {
  const mainFailure = recordCheckRunOutcome(createCiIncidentState(), {
    sha: "shared-head",
    branch: "main",
    name: "ci-shard (2/8)",
    conclusion: "failure",
    log: TWO_FAILURES,
  });
  const featureFailure = recordCheckRunOutcome(mainFailure.state, {
    sha: "shared-head",
    branch: "feature",
    name: "ci-shard (2/8)",
    conclusion: "failure",
    log: TWO_FAILURES,
  });
  const featurePass = recordCheckRunOutcome(featureFailure.state, {
    sha: "shared-head",
    branch: "feature",
    name: "ci-shard (2/8)",
    conclusion: "success",
  });

  assert.deepEqual(featurePass.events, []);
  assert.deepEqual(featurePass.state.pending, {});
});

test("overlapping failures of the same test keep independent same-sha rerun histories", () => {
  const first = recordCheckRunOutcome(createCiIncidentState(), {
    sha: "head-a",
    branch: "feature-a",
    name: "ci-shard",
    conclusion: "failure",
    log: TWO_FAILURES,
  });
  const second = recordCheckRunOutcome(first.state, {
    sha: "head-b",
    branch: "feature-b",
    name: "ci-shard",
    conclusion: "failure",
    log: TWO_FAILURES,
  });
  const firstPass = recordCheckRunOutcome(second.state, {
    sha: "head-a",
    branch: "feature-a",
    name: "ci-shard",
    conclusion: "success",
  });
  const secondPass = recordCheckRunOutcome(firstPass.state, {
    sha: "head-b",
    branch: "feature-b",
    name: "ci-shard",
    conclusion: "success",
  });

  assert.deepEqual(firstPass.events.map((event) => event.kind), ["flake", "flake"]);
  assert.deepEqual(secondPass.events.map((event) => event.kind), ["flake", "flake"]);
  assert.deepEqual(secondPass.state.pending, {});
});
