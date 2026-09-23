import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realDeployDeps } from "../src/lib/deployer.js";

function deployDeps(
  execFile: (cmd: string, args: string[]) => string,
  sleep: (ms: number) => void,
  log: (step: string, data?: Record<string, unknown>) => void,
) {
  const root = mkdtempSync(join(tmpdir(), "rmd-deploy-fetch-race-"));
  return realDeployDeps({
    installPath: root,
    stateRoot: root,
    daemonLabel: "remudero-daemon",
    serveLabel: "remudero-serve",
    servePort: 4317,
    uid: 1,
    ledgerPath: join(root, "ledger.ndjson"),
    execFile,
    sleep,
    log,
  });
}

function lockError(): Error & { stderr: string } {
  const error = new Error("git fetch failed") as Error & { stderr: string };
  error.stderr = "error: cannot lock ref 'refs/remotes/origin/main': is at abc but expected def";
  return error;
}

test("W1-T4060: a ref-lock race is retried and the tick proceeds", () => {
  let fetches = 0;
  const sleeps: number[] = [];
  const logs: Array<{ step: string; data?: Record<string, unknown> }> = [];
  const deps = deployDeps(
    (_cmd, args) => {
      if (args.includes("fetch")) {
        fetches += 1;
        if (fetches < 3) throw lockError();
      }
      return "";
    },
    (ms) => sleeps.push(ms),
    (step, data) => logs.push({ step, data }),
  );

  deps.fetch();

  assert.equal(fetches, 3);
  assert.deepEqual(sleeps, [250, 250]);
  assert.equal(logs.filter((entry) => entry.step === "deploy.fetch_retry").length, 2);
  assert.equal(logs.at(-1)?.step, "deploy.fetch_recovered");
});

test("W1-T4060: any other fetch failure still reports the install root unfit", () => {
  let fetches = 0;
  const sleeps: number[] = [];
  const logs: Array<{ step: string; data?: Record<string, unknown> }> = [];
  const deps = deployDeps(
    (_cmd, args) => {
      if (args.includes("fetch")) {
        fetches += 1;
        const error = new Error("git fetch failed") as Error & { stderr: string };
        error.stderr = "fatal: could not resolve host github.com";
        throw error;
      }
      return "";
    },
    (ms) => sleeps.push(ms),
    (step, data) => logs.push({ step, data }),
  );

  assert.throws(() => deps.fetch(), /git fetch failed/);
  assert.equal(fetches, 1);
  assert.deepEqual(sleeps, []);
  assert.equal(logs.some((entry) => entry.step === "deploy.fetch_retry"), false);
});

test("W1-T4060: the retry stops after three attempts", () => {
  let fetches = 0;
  const sleeps: number[] = [];
  const logs: Array<{ step: string; data?: Record<string, unknown> }> = [];
  const deps = deployDeps(
    (_cmd, args) => {
      if (args.includes("fetch")) {
        fetches += 1;
        throw lockError();
      }
      return "";
    },
    (ms) => sleeps.push(ms),
    (step, data) => logs.push({ step, data }),
  );

  assert.throws(() => deps.fetch(), /git fetch failed/);
  assert.equal(fetches, 3);
  assert.deepEqual(sleeps, [250, 250]);
  assert.equal(logs.filter((entry) => entry.step === "deploy.fetch_retry").length, 2);
});
