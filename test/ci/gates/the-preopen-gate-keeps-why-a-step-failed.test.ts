import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  GATE_DETAIL_MAX_BYTES, defaultGateContainment, findOnPath, preopenGateEnv, readGateSummary, runPreopenGate,
  type GateRun,
} from "#src/lib/preopen-gate.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

/** A summary the gate child would write, as the harness reads it back from its throwaway HOME. */
type Step = { name: string; ok: boolean; detail?: string };
function summaryRun(steps: Step[] | ((home: string) => Step[])): { home: string; run: GateRun } {
  const home = mkdtempSync(join(tmpdir(), "rmd-w10920-home-"));
  const file = join(home, "preflight-summary.json");
  writeFileSync(file, JSON.stringify({ finishedAt: new Date(Date.now() + 1000).toISOString(), steps: typeof steps === "function" ? steps(home) : steps }));
  return { home, run: { exitCode: 1, containment: "sandboxed", summary: readGateSummary(file, Date.now()) } };
}

const noPush = async () => ({ kind: "skipped" as const, reason: "fixture has no remote" });
const noProcfs = () => [];

test("W1-T10920: a failed gate step keeps a bounded tail of why it failed", async () => {
  const lines = Array.from({ length: 400 }, (_, i) => `src/lib/x.ts(${i + 1},1): error TS2322: Type 'string' is not assignable to type 'number'.`);
  const { home, run } = summaryRun((gateHome) => [
    { name: "commitlint", ok: true, detail: "commitlint: PASS" },
    { name: "typecheck", ok: false, detail: `typecheck: FAIL — tsc -p tsconfig.json --noEmit\n${lines.join("\n")}\ntsbuildinfo kept at ${gateHome}/cache/x` },
  ]);
  try {
    const gate = await runPreopenGate("/nowhere", { runGate: async () => run, runPushGate: noPush, scanProcfsWrites: noProcfs });
    assert.equal(gate.kind, "fail");
    assert.ok("failedDetail" in gate && gate.failedDetail, "a failed gate carries its steps' detail");
    const tail = gate.failedDetail.typecheck;
    assert.ok(tail.length > 0 && Buffer.byteLength(tail) <= GATE_DETAIL_MAX_BYTES, `bounded: ${Buffer.byteLength(tail)} bytes`);
    assert.match(tail, /x\.ts\(400,1\): error TS2322/, "the TAIL is kept: the last diagnostic survives");
    assert.doesNotMatch(tail, /x\.ts\(1,1\)/, "the head is what gets cut");
    assert.match(tail, /tsbuildinfo kept at \$GATE_HOME\/cache\/x$/, "the throwaway HOME is named, not printed");
    assert.equal(gate.failedDetail.commitlint, undefined, "a passing step contributes no detail");
    const head = readGateSummary(join(home, "preflight-summary.json"), 0);
    assert.ok(!("unreadable" in head));
    assert.ok(!JSON.stringify(head).includes(home), "the throwaway HOME path is scrubbed from the detail");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("W1-T10920: a step its sandbox broke is unmeasured, not the build", async () => {
  const cases: { name: string; steps: { name: string; ok: boolean; detail?: string }[]; env: string[]; handed: string[] }[] = [
    { name: "a NOT_RUN admission", env: ["typecheck"], handed: [],
      steps: [{ name: "typecheck", ok: false, detail: "typecheck: NOT_RUN (static admission refused: headroom 1200 MiB under a 3072 MiB peak)" }] },
    { name: "a spawn that never ran", env: ["typecheck"], handed: [],
      steps: [{ name: "typecheck", ok: false, detail: "typecheck: SPAWN FAILURE — spawnSync tsc EACCES; the check did NOT run, so this is not a result about the code" }] },
    { name: "a sandbox errno beside a real failure", env: ["rule-checks"], handed: ["claims"],
      steps: [
        { name: "rule-checks", ok: false, detail: "rule-checks: FAIL\nError: listen EPERM: operation not permitted /tmp/tsx-1000/12345.pipe" },
        { name: "claims", ok: false, detail: "claims: FAIL — W1-T1 claims src/a.ts but the diff never touches it" },
      ] },
  ];
  for (const c of cases) {
    const { home, run } = summaryRun(c.steps);
    try {
      const gate = await runPreopenGate("/nowhere", { runGate: async () => run, runPushGate: noPush, scanProcfsWrites: noProcfs });
      if (c.handed.length === 0) {
        assert.equal(gate.kind, "unmeasured", `${c.name}: a gate whose every failure is its own sandbox is unmeasured`);
        assert.ok(gate.kind === "unmeasured" && gate.reason === `environment: ${c.env.join(", ")}`, `${c.name}: names the steps (${gate.kind === "unmeasured" ? gate.reason : ""})`);
      } else {
        assert.equal(gate.kind, "fail", c.name);
        assert.deepEqual(gate.kind === "fail" ? gate.failedSteps : [], c.handed, `${c.name}: only the build's own failure is handed to the worker`);
      }
      assert.deepEqual("environmentSteps" in gate ? gate.environmentSteps : undefined, c.env, `${c.name}: the environment steps are recorded`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("W1-T10920: a real compile error is still the build", async () => {
  const { home, run } = summaryRun([{ name: "typecheck", ok: false,
    detail: "typecheck: FAIL — tsc -p tsconfig.json --noEmit\nsrc/lib/a.ts(3,5): error TS2322: EPERM is not assignable to type 'never'." }]);
  try {
    const gate = await runPreopenGate("/nowhere", { runGate: async () => run, runPushGate: noPush, scanProcfsWrites: noProcfs });
    assert.equal(gate.kind, "fail", "a compiler diagnostic is the build's, even when its text names an errno");
    assert.deepEqual(gate.kind === "fail" ? gate.failedSteps : [], ["typecheck"]);
    assert.equal("environmentSteps" in gate ? gate.environmentSteps : undefined, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("W1-T10920: a clean tree passes typecheck inside the real gate sandbox", async (t) => {
  if (process.platform !== "linux" || findOnPath("bwrap") === null) {
    t.skip("SKIPPED, NOT PASSED: bwrap is not installed here, so the real gate sandbox cannot run; this case runs on the Linux host");
    return;
  }
  const tree = mkdtempSync(join(tmpdir(), "rmd-w10920-tree-"));
  const home = mkdtempSync(join(tmpdir(), "rmd-w10920-sbx-home-"));
  try {
    writeFileSync(join(tree, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, files: ["ok.ts"] }));
    writeFileSync(join(tree, "ok.ts"), "export const n: number = 1;\n");
    symlinkSync(join(REPO_ROOT, "node_modules"), join(tree, "node_modules"));
    const env = preopenGateEnv(home);
    const sandbox = await defaultGateContainment({ cwd: tree, home, harnessRoot: REPO_ROOT, env });
    assert.equal(sandbox.mode, "sandboxed", `the gate sandbox must start where bwrap exists: ${sandbox.mode === "unavailable" ? sandbox.reason : ""}`);
    if (sandbox.mode !== "sandboxed") return;
    const tsc = join(tree, "node_modules", "typescript", "bin", "tsc");
    const r = spawnSync(sandbox.file, [...sandbox.argv, process.execPath, tsc, "-p", "tsconfig.json"], { cwd: tree, env, encoding: "utf8", timeout: 120_000 });
    assert.equal(r.status, 0, `a clean tree's typecheck fails inside the gate sandbox:\n${(r.stdout ?? "") + (r.stderr ?? "")}`);
  } finally {
    rmSync(tree, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
