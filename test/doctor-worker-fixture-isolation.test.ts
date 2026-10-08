import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const titles = [
  "doctor: the verb registration dispatches into the doctor module",
  "W1-T1109: a live run's lock is not reported as stale",
  "W1-T2627: doctorCommand calls readWorktreeBase for each live run's worktree, and renders the BRANCH-claimed task id",
  "W1-T2627: doctorCommand end to end — unrelated is a WARN naming the run; a failed ancestry read and an absent record both degrade to base-unknown, never unrelated",
];

function withProcessTableFixture(run: (child: (args: string[], variant: string) => string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "rmd-doctor-process-fixture-"));
  let closed = true;
  try {
    writeFileSync(join(root, "ps"), "#!/bin/sh\ncase \"$RMD_DOCTOR_FIXTURE_PS_CASE\" in\nempty) exit 0;;\naged) printf '%s\\n' '424242 1 8640000 /synthetic/npm ci';;\nunreadable) exit 1;;\n*) exit 64;;\nesac\n", { mode: 0o700 });
    run((args, variant) => {
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}`, TMPDIR: root, RMD_DOCTOR_FIXTURE_PS_CASE: variant };
      delete env.NODE_OPTIONS;
      closed = false;
      const result = spawnSync(process.execPath, ["--import", "tsx", ...args], { cwd: repo, env, encoding: "utf8", timeout: 120_000, maxBuffer: 2 * 1024 ** 2 });
      closed = result.error === undefined && result.signal === null && result.status !== null;
      assert.equal(result.error, undefined, "child must close normally; a refused capture is not a test result");
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, `${variant} process table; stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      return result.stdout;
    });
  } finally {
    // A timed-out child is not proof its descendants stopped; leave its private fixture intact.
    if (closed) rmSync(root, { recursive: true, force: true });
  }
}

test("healthy doctor fixtures do not read the ambient process table", () => {
  const file = "test/doctor.test.ts";
  assert.ok(statSync(join(repo, file)).isFile(), "verify the physical test path before execution");
  const pattern = titles.map((title) => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  withProcessTableFixture((child) => {
    for (const variant of ["aged", "unreadable"]) {
      const stdout = child(["--test", "--test-reporter=tap", "--test-concurrency=1", "--test-name-pattern", pattern, file], variant);
      for (const title of titles) assert.ok(stdout.includes(`# Subtest: ${title}`), `literal test did not execute: ${title}`);
      assert.match(stdout, /^# tests 4$/m);
      assert.match(stdout, /^# pass 4$/m);
      for (const field of ["fail", "cancelled", "skipped", "todo"]) assert.match(stdout, new RegExp(`^# ${field} 0$`, "m"));
    }
  });
});

test("isolating healthy doctor fixtures preserves the real default process-reader warnings", () => {
  const program = `
    import assert from 'node:assert/strict';
    import {readWorkerProcesses, judgeLaneLessWorkers} from './src/lib/doctor.ts';
    const reading=readWorkerProcesses();
    const unknown='unreadableReason' in reading;
    const check=unknown ? judgeLaneLessWorkers(undefined,0,reading.unreadableReason) : judgeLaneLessWorkers(reading.oldestEtimeS,reading.count);
    const variant=process.env.RMD_DOCTOR_FIXTURE_PS_CASE;
    assert.equal(check.verdict,variant==='empty'?'OK':'WARN');
    if(variant==='aged'){assert.equal(unknown,false);assert.equal(reading.count,1);}
    if(variant==='unreadable'){assert.equal(unknown,true);assert.match(check.measured,/UNKNOWN/);assert.doesNotMatch(check.measured,/0 worker process/);}
    console.log(JSON.stringify({variant,check}));
  `;
  withProcessTableFixture((child) => {
    for (const variant of ["empty", "aged", "unreadable"]) {
      const observation = JSON.parse(child(["--input-type=module", "-e", program], variant));
      assert.equal(observation.variant, variant);
      assert.equal(observation.check.name, "lane-less-workers");
    }
  });
});
