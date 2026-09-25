import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  ciIncidentEventsFromLog,
  createCiIncidentState,
  readCiIncidentJobLog,
  recordCheckRunOutcome,
  TAP_LOCATION_RE,
  TAP_NOT_OK_RE,
} from "../src/lib/ci-incidents.js";
import { clockFromMillisFn } from "../src/lib/clock.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import type { RatifyCliGateway } from "../src/lib/panel-graph.js";
import type { Plan } from "../src/lib/plan.js";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import type { GitHub } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
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

test("the TAP patterns accept a failing test line and its location, and refuse a passing line or a non-test location", () => {
  assert.equal(TAP_NOT_OK_RE.test("not ok 3 - alpha rejects an invalid token"), true);
  assert.equal(TAP_NOT_OK_RE.test("ok 3 - alpha rejects an invalid token"), false);
  assert.equal(TAP_LOCATION_RE.test("  location: 'test/auth.test.ts:10:1'"), true);
  assert.equal(TAP_LOCATION_RE.test("  location: 'src/lib/auth.ts:10:1'"), false);
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

test("the served gateway turns completed check runs into incident rows, and names an unreadable log", async () => {
  const secret = "ci-incident-secret";
  const repository = "craigoley/remudero";
  const root = mkdtempSync(join(tmpdir(), "rmd-ci-incident-serve-"));
  mkdirSync(join(root, "plan"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const github: GitHub = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
  const logged: Array<{ step: string } & Record<string, unknown>> = [];
  const deps: ServeDeps = {
    board: { plan: { tasks: [], byId: new Map() } as Plan, ledgerPath, github },
    panelGraph: {
      root,
      planPath,
      ledgerPath,
      github: { prView: () => null } as TraceGithub,
      statusGithub: github,
      ratify: { approve: () => {}, reframe: () => {} } as RatifyCliGateway,
    },
    ledgerPath,
    issues: { close: () => {} } as IssueCloser,
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: "ci-read", write: "ci-write" },
    pollMs: 50,
    githubEventWake: { secret, repository },
    ciIncidents: {
      fetchJobLog: (_repository, jobId) => {
        if (jobId === 2) throw new Error("fixture log unavailable");
        return TWO_FAILURES;
      },
      clock: clockFromMillisFn(() => Date.parse("2026-09-25T12:00:00.000Z")),
    },
    log: (step, extra) => void logged.push({ step, ...extra }),
  };
  const incidentRows = (): Array<Record<string, unknown>> =>
    existsSync(ledgerPath)
      ? readFileSync(ledgerPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((row) => row.step === "incident.event")
      : [];
  const settle = async (done: () => boolean, label: string): Promise<void> => {
    for (let waited = 0; !done(); waited += 10) {
      assert.ok(waited < 2_000, `${label} never settled`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/hooks/github`;
    const send = async (id: number, sha: string, conclusion: string): Promise<number> => {
      const body = JSON.stringify({
        action: "completed",
        repository: { full_name: repository },
        check_run: { id, name: "ci-shard (1/8)", head_sha: sha, head_branch: "feature", conclusion },
      });
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": `delivery-${id}`,
          "x-github-event": "check_run",
          "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`,
        },
        body,
      });
      await res.arrayBuffer();
      return res.status;
    };

    assert.equal(await send(1, "same-head", "failure"), 202);
    await settle(() => incidentRows().length === 2, "the failed check's rows");
    assert.equal(await send(3, "same-head", "success"), 202);
    await settle(() => incidentRows().length === 4, "the same-sha pass's flake rows");
    assert.deepEqual(incidentRows().map((row) => [row.kind, row.name, row.sha]), [
      ["test_failure", "test/auth.test.ts", "same-head"],
      ["test_failure", "test/ledger.test.ts", "same-head"],
      ["flake", "test/auth.test.ts", "same-head"],
      ["flake", "test/ledger.test.ts", "same-head"],
    ]);

    assert.equal(await send(4, "other-head", "cancelled"), 202);
    assert.equal(await send(2, "other-head", "failure"), 202);
    await settle(() => logged.some((row) => row.step === "serve.ci_incidents.job_log_unreadable"), "the unreadable log row");
    const unreadable = logged.find((row) => row.step === "serve.ci_incidents.job_log_unreadable");
    assert.deepEqual(unreadable, {
      step: "serve.ci_incidents.job_log_unreadable",
      reason: "fixture log unavailable",
      repository,
      jobId: 2,
    });
    assert.equal(incidentRows().length, 4, "neither a cancelled check nor an unreadable log posts an incident");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
