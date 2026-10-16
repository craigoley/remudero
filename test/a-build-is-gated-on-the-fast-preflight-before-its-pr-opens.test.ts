// 2026-10-09: #10482, #10491 and #10516 opened PRs carrying census/ratchet reds that
// `rmd preflight --fast` names in seconds; the worker's own preflight was only advisory.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const url = new URL("../src/lib/preopen-gate.ts", import.meta.url);
const mod: Record<string, unknown> | undefined = existsSync(url) ? await import(url.href) : undefined;
const fn = <T>(name: string) => {
  assert.equal(typeof mod?.[name], "function", `src/lib/preopen-gate.ts must export ${name}`);
  return mod![name] as T;
};

type Gate = (path: string, deps: object) => Promise<{ kind: string; failedSteps?: string[]; reason?: string }>;
const summary = (finishedAt: string, steps: Array<{ name: string; ok: boolean }>) =>
  JSON.stringify({ ok: steps.every((s) => s.ok), finishedAt, steps });

test("a build whose tree fails a census step is reported failing with that census named", async () => {
  const run = fn<Gate>("runPreopenGate");
  const reads: string[] = [];
  // W1-T9619: the runner hands back the harness-owned summary's failing steps; the worktree's own file is never read.
  const result = await run("/wt", {
    clock: { now: () => Date.parse("2026-10-10T03:00:00Z") },
    runGate: async () => ({ exitCode: 1, summary: { failedSteps: ["env-registry"] } }),
    readFile: (p: string) => {
      reads.push(p);
      return summary("2026-10-10T03:00:30Z", [{ name: "depcruise", ok: true }]);
    },
  });
  assert.deepEqual(reads, [], "no summary inside the worktree is read");
  assert.equal(result.kind, "fail");
  assert.deepEqual(result.failedSteps, ["env-registry"]);
  const prompt = fn<(steps: readonly string[], h: boolean) => string>("renderPreopenGatePrompt")(["env-registry"], false);
  assert.match(prompt, /env-registry/);
  assert.match(prompt, /rmd preflight --fast/);
});

test("a clean tree passes, and a stale or missing summary is unmeasured rather than a pass", async () => {
  const run = fn<Gate>("runPreopenGate");
  const clock = { now: () => Date.parse("2026-10-10T03:00:00Z") };
  const clean = await run("/wt", { clock, runGate: async () => ({ exitCode: 0 }) });
  assert.equal(clean.kind, "pass");
  const stale = await run("/wt", { clock, runGate: async () => ({ exitCode: 1, summary: { unreadable: "the preflight summary predates this gate run" } }) });
  assert.equal(stale.kind, "unmeasured");
  const missing = await run("/wt", { clock, runGate: async () => ({ exitCode: 1 }) });
  assert.equal(missing.kind, "unmeasured");
  const timedOut = await run("/wt", { clock, runGate: async () => ({ exitCode: null, error: "fast gate exceeded its backstop" }) });
  assert.equal(timedOut.kind, "unmeasured");
  // The summary reader itself: a summary older than the run is never read as current.
  const read = fn<(p: string, t: number, r: (p: string) => string) => { failedSteps?: string[]; unreadable?: string }>("readGateSummary");
  assert.deepEqual(read("/h/s.json", Date.parse("2026-10-10T03:00:00Z"), () => summary("2026-10-10T02:00:00Z", [])), { unreadable: "the preflight summary predates this gate run" });
  assert.deepEqual(read("/h/s.json", Date.parse("2026-10-10T03:00:00Z"), () => summary("2026-10-10T03:00:01Z", [{ name: "jscpd", ok: false }])), { failedSteps: ["jscpd"] });
});
