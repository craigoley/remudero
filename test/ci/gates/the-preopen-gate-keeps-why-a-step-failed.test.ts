import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { spawnFailureDetail } from "#src/lib/commit-message.js";
import {
  GATE_DETAIL_MAX_BYTES, defaultGateContainment, findOnPath, preopenGateEnv, preopenGateLedgerFields, readGateSummary, renderPreopenGatePrompt, runPreopenGate,
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
  const token = `ghp_${"a".repeat(36)}`;
  const { home, run } = summaryRun((gateHome) => [
    { name: "commitlint", ok: true, detail: "commitlint: PASS" },
    { name: "typecheck", ok: false, detail: `typecheck: FAIL — tsc -p tsconfig.json --noEmit\n${lines.join("\n")}\n${token}\nhost cache: ${homedir()}/.cache/x\ntsbuildinfo kept at ${gateHome}/cache/x` },
    { name: "secret-tail", ok: false, detail: `ghp_${"b".repeat(GATE_DETAIL_MAX_BYTES * 2)}` },
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
    assert.ok(!tail.includes(token), "recognized tokens are scrubbed from retained detail");
    assert.match(tail, /<redacted>/);
    if (homedir() !== "/") assert.match(tail, /host cache: \$HOME\/\.cache\/x/);
    assert.equal(gate.failedDetail["secret-tail"], "<redacted>", "redaction precedes truncation, so no token fragment survives");
    assert.equal(gate.failedDetail.commitlint, undefined, "a passing step contributes no detail");
    assert.deepEqual(preopenGateLedgerFields(gate).failed_detail, gate.failedDetail, "both gate row writers retain the redacted detail map");
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
      steps: [{ name: "typecheck", ok: false, detail: spawnFailureDetail("typecheck", { status: null, error: "spawnSync tsc EACCES" }) }] },
    ...[
      ["missing dependency", "ENOENT: no such file or directory, open '/opt/harness/node_modules/typescript/lib.d.ts'"],
      ["relative dependency", "ENOENT: no such file or directory, open 'node_modules/typescript/lib.d.ts'"],
      ["read-only cache", "EROFS: read-only file system, mkdir '/home/runner/.cache/swc'"],
      ["sandbox temporary file", "EACCES: permission denied, open '/tmp/tsx-1000/x'"],
      ["bwrap mount", "bwrap: Can't bind mount /opt/harness: No such file or directory"],
      ["swc cache failure", "failed to create swc cache directory: /home/runner/.swc/cache"],
      ["swc cache path failure", "failed to create cache directory: /home/runner/.swc/cache"],
      ["tsx IPC failure", "Error: listen /tmp/tsx-1000/12345.pipe"],
      ["harness path", `EPERM: operation not permitted, open '${REPO_ROOT}/bin/rmd'`],
    ].map(([name, detail]) => ({ name, env: ["typecheck"], handed: [], steps: [{ name: "typecheck", ok: false, detail }] })),
    ...[
      ["source permission", "EACCES: permission denied, open 'src/generated.ts'"],
      ["missing source", "ENOENT: no such file or directory, open '/project/src/generated.ts'"],
      ["unrelated errno", "EPERM: operation not permitted"],
      ["source mentions cache", "EACCES: permission denied, open 'src/cache.ts'"],
      ["errno and unrelated cache line", "EACCES: permission denied, open 'src/generated.ts'\ncache is at /tmp/cache"],
      ["diagnostic overrules environment", "typecheck: NOT_RUN\nsrc/generated.ts(1,2): error TS2322: ENOENT /tmp/cache"],
    ].map(([name, detail]) => ({ name, env: [], handed: ["typecheck"], steps: [{ name: "typecheck", ok: false, detail }] })),
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
        const prompt = renderPreopenGatePrompt(gate.kind === "fail" ? gate.failedSteps : [], true);
        for (const step of c.env) assert.ok(!prompt.includes(`  - ${step}`), `${c.name}: environment steps never enter the repair prompt`);
      }
      assert.deepEqual("environmentSteps" in gate ? gate.environmentSteps : undefined, c.env.length ? c.env : undefined, `${c.name}: the environment steps are recorded`);
      assert.deepEqual(preopenGateLedgerFields(gate).environment_steps, c.env.length ? c.env : undefined);
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
    const entry = pathToFileURL(join(REPO_ROOT, "src/lib/commit-message.ts")).href;
    const loader = pathToFileURL(join(REPO_ROOT, "node_modules/tsx/dist/loader.mjs")).href;
    const script = `import { typecheckStep } from ${JSON.stringify(entry)};
      const step = typecheckStep(process.cwd());
      console.log(JSON.stringify(step));
      process.exitCode = step.ok ? 0 : 1;`;
    const r = spawnSync(sandbox.file, [...sandbox.argv, process.execPath, "--import", loader, "--input-type=module", "-e", script], { cwd: tree, env, encoding: "utf8", timeout: 120_000 });
    assert.equal(r.status, 0, `a clean tree's typecheck fails inside the gate sandbox:\n${(r.stdout ?? "") + (r.stderr ?? "")}`);
    assert.deepEqual(JSON.parse(r.stdout.trim()), { name: "typecheck", ok: true, detail: "typecheck: PASS — tsc -p tsconfig.json --noEmit" });
    assert.ok(existsSync(join(tree, ".rmd-typecheck.tsbuildinfo")), "production cache preparation wrote the fixture's buildinfo");
  } finally {
    rmSync(tree, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
