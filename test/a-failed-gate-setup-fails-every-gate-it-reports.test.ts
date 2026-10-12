/**
 * W1-T5858 — a failed gate setup fails every gate it reports.
 *
 * ci.yml's commitlint job runs checkout, setup-node, classify and `npm ci`, then its gates, then an
 * `if: always()` reporter that posts one check run per gate (W1-T4399). The reporter maps a
 * `skipped` gate to success on purpose (a fast-laned gate this diff cannot move). But a failed setup
 * step also leaves every later gate `skipped`, so each check read green on a job that checked
 * nothing. Here the reporter's REAL step body runs in bash against simulated step outcomes, with a
 * stub `node` and the shared gh shim recording every check-run post.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { ghShim } from "./helpers/gh-shim.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { successfulReporterSetupFixture } from "./helpers/reporter-setup.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
type Step = { id?: string; run?: string; env?: Record<string, string>; if?: string };
const ciYml = parseYaml(readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8")) as {
  jobs: Record<string, { steps: Step[] }>;
};
const reporter = ciYml.jobs.commitlint!.steps.at(-1)!;
const SETUP_IDS = ["checkout", "setup-node", "classify", "install"];

/** Every `${{ a || b }}` in an env template, resolved against `facts` (first non-empty operand). */
function resolve(template: string, facts: Record<string, string>): string {
  return template.replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (_, expr: string) =>
    expr.split("||").map((p) => facts[p.trim()] ?? "").find((v) => v !== "") ?? "");
}

/** Runs the reporter with the given step outcomes; returns each posted check run's conclusion and title. */
function report(outcomes: Record<string, string>, setupOutcomes?: string | null): Map<string, { conclusion: string; title: string }> {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5858-`));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "node"), '#!/usr/bin/env bash\necho "$2"\n', { mode: 0o755 });
  const gh = ghShim([], { kind: "w1t5858" });
  const facts: Record<string, string> = {
    "github.token": "tok",
    "github.sha": "9a0b",
    "github.run_id": "7",
    "github.run_attempt": "1",
    "job.check_run_id": "11",
    "runner.temp": dir,
  };
  for (const [id, outcome] of Object.entries(outcomes)) facts[`steps.${id}.outcome`] = outcome;
  const env = Object.fromEntries(Object.entries(reporter.env ?? {}).map(([k, v]) => [k, resolve(String(v), facts)]));
  if (setupOutcomes !== undefined) {
    if (setupOutcomes === null) delete env.SETUP_OUTCOMES;
    else env.SETUP_OUTCOMES = setupOutcomes;
  }
  writeFileSync(join(dir, "reporter.sh"), reporter.run!);
  const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", join(dir, "reporter.sh")], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: `${join(dir, "bin")}:${gh.dir}:${process.env.PATH}`, HOME: dir, GITHUB_REPOSITORY: "o/r", ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  const posts = new Map<string, { conclusion: string; title: string }>();
  for (const call of gh.calls().filter((c) => c.includes("/check-runs"))) {
    const name = /-f name=(\S+)/.exec(call)?.[1];
    const conclusion = /-f conclusion=(\S+)/.exec(call)?.[1];
    const title = /-f output\[title\]=(.*?) -f output\[summary\]/.exec(call)?.[1];
    assert.ok(name && conclusion && title !== undefined, `unparsed post: ${call}`);
    posts.set(name, { conclusion, title });
  }
  return posts;
}

/** Every gate step the reporter reads, each at `outcome`, beside the given setup outcomes. */
function gates(outcome: string, setup: Record<string, string>): Record<string, string> {
  const ids = Object.values(reporter.env ?? {})
    .map((v) => /steps\.([\w-]+)\.outcome/.exec(String(v))?.[1])
    .filter((id): id is string => id !== undefined && !SETUP_IDS.includes(id));
  return { ...Object.fromEntries(ids.map((id) => [id, outcome])), ...setup };
}

const GREEN_SETUP = { checkout: "success", "setup-node": "success", classify: "success", install: "success" };

test("successful reporter setup fixture refuses unavailable or unresolved context templates", () => {
  assert.throws(() => successfulReporterSetupFixture({}), /template must exist/);
  assert.throws(() => successfulReporterSetupFixture({ SETUP_OUTCOMES: "checkout=success" }), /reference real step outcomes/);
  assert.throws(() => successfulReporterSetupFixture({ SETUP_OUTCOMES: "checkout=${{ steps.checkout.outcome }} classify=${{ unknown.context }}" }), /explicitly resolved/);
  assert.equal(successfulReporterSetupFixture(reporter.env!), "checkout=success setup-node=success classify=success install=success");
});

test("bundled gate reporter refuses missing outcomes from unconditional setup steps", () => {
  for (const id of SETUP_IDS) {
    const actual = ciYml.jobs.commitlint!.steps.find((step) => step.id === id);
    assert.ok(actual, `positive control: the workflow really wires ${id}`);
    assert.equal(actual.if, undefined, `${id} is unconditional, not a legitimately fast-laned setup skip`);
    assert.ok(reporter.env!.SETUP_OUTCOMES!.includes(`steps.${id}.outcome`), `${id} must be represented in the actual report`);
    const posts = report(gates("skipped", { ...GREEN_SETUP, [id]: "" }));
    assert.ok(posts.size > 0, "the actual reporter posted its required contexts");
    for (const [name, post] of posts) {
      assert.equal(post.conclusion, "failure", `${name}: an unavailable ${id} outcome is not successful setup`);
      assert.ok(post.title.includes(`${id}=`), `${name}: the unavailable setup step remains named`);
    }
  }
});

test("bundled gate reporter refuses an absent or blank setup collection and preserves fast-lane skips", () => {
  for (const unavailable of [null, "", " \t "]) {
    const posts = report(gates("skipped", GREEN_SETUP), unavailable);
    assert.ok(posts.size > 0, "the actual reporter posted its required contexts");
    for (const [name, post] of posts) {
      assert.equal(post.conclusion, "failure", `${name}: an empty collection cannot certify setup`);
      assert.match(post.title, /setup-outcomes=unavailable/);
    }
  }
  const fastLane = report(gates("skipped", GREEN_SETUP));
  assert.ok(fastLane.size > 0, "positive control: valid fast-lane reports exist");
  for (const [name, post] of fastLane) assert.equal(post.conclusion, "success", `${name}: valid gate skips stay green`);
});

test("W1-T5858: a failed install posts every gate as failure naming the setup step", () => {
  const posts = report(gates("skipped", { ...GREEN_SETUP, install: "failure" }));
  const reported = [...reporter.run!.matchAll(/^\s*report "([^"]+)"/gm)].map((m) => m[1]!);
  assert.deepEqual([...posts.keys()].sort(), [...new Set(reported)].sort(), "every report line posted once");
  for (const [name, post] of posts) {
    assert.equal(post.conclusion, "failure", `${name} read green on a failed install`);
    assert.match(post.title, /setup did not succeed \(install=failure\)/, name);
  }
});

test("W1-T5858: a failed classify fails every gate and names each setup step that did not succeed", () => {
  const posts = report(gates("skipped", { ...GREEN_SETUP, classify: "failure", install: "skipped" }));
  for (const [name, post] of posts) {
    assert.equal(post.conclusion, "failure", name);
    assert.match(post.title, /classify=failure install=skipped/, name);
  }
});

test("W1-T5858: with setup green, a fast-laned skipped gate still posts success and a red gate fails", () => {
  const skipped = report(gates("skipped", GREEN_SETUP));
  for (const [name, post] of skipped) assert.equal(post.conclusion, "success", `${name}: a fast-lane skip is a pass`);
  const red = report({ ...gates("success", GREEN_SETUP), "lint-plan": "failure" });
  assert.equal(red.get("lint-plan")?.conclusion, "failure");
  assert.equal(red.get("leak-grep")?.conclusion, "success");
  assert.doesNotMatch(red.get("leak-grep")!.title, /setup did not succeed/);
});
