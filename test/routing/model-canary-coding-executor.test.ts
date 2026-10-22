import { REPO_ROOT as __workspaceRoot } from "#test/helpers/repo-root.js";
import { pathToFileURL as __workspaceUrl } from "node:url";
const __workspaceRootUrl = __workspaceUrl(__workspaceRoot + "/");
import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { codingBehaviorChallenge, codingContainerCommand, codingExecutorDefaultPorts, executeCodingIsolated } from "#src/lib/model-canary-coding-executor.js";
import { gradeCodingSandboxValues } from "#src/lib/model-canary-coding-isolation.js";

const image = "sha256:" + "b".repeat(64), wire = fileURLToPath(new URL("test/fixtures/coding-container-cli.mjs", __workspaceRootUrl));
const submission = { files: [{ path: "src/solution.mjs", text: "export const parseCount = value => Number(value);" }] };

test("coding executor default refuses unqualified native authority before any Docker operation", async () => {
  const r = await executeCodingIsolated("coding-parser", submission, image);
  try {
    assert.equal(r.state, "refused"); assert.equal(r.reason, "coding-native-runtime-and-owner-unqualified");
    assert.equal(r.executorQualified, false); assert.equal(r.resourceEvidence, null);
  } finally { if (r.retainedScratch) await rm(r.retainedScratch, { recursive: true, force: true }); }
  assert.equal((await executeCodingIsolated("coding-parser", {}, image)).state, "refused");
  await assert.rejects(codingExecutorDefaultPorts().command(["create"], "/tmp", 5000), /unqualified/);
});

test("real CLI spawn and owned filesystem cleanup failures retain an unavailable recovery boundary", async () => {
  for (const scenario of ["removal-spawn-refused", "scratch-not-writable", "invalid-image"]) {
    const r = await executeCodingIsolated("coding-parser", submission, scenario === "invalid-image" ? "node:latest" : image, {
      admission: async () => ({ admitted: true, reason: "synthetic-wire-only" }),
      command: async (args, cwd, limit) => {
        if (args[0] === "rm" && scenario === "removal-spawn-refused")
          return codingContainerCommand(join(cwd, "no-such-cli"), args, cwd, limit);
        const result = await codingContainerCommand(process.execPath, [wire, "good", ...args], cwd, limit);
        if (args[0] === "rm" && scenario === "scratch-not-writable") await chmod(cwd, 0o500);
        return result;
      },
    });
    try {
      assert.equal(r.state, "unavailable"); assert.equal(r.passed, null); assert.equal(r.executorQualified, false);
      if (scenario === "invalid-image") assert.equal(r.cleanup, "confirmed");
      else { assert.equal(r.cleanup, "unknown"); assert.ok(r.retainedScratch); assert.ok(r.cleanupFailure); }
    } finally {
      if (r.retainedScratch) { await chmod(r.retainedScratch, 0o700); await rm(r.retainedScratch, { recursive: true, force: true }); }
    }
  }
});

test("real credential-free CLI child bounds nonzero exits time and combined output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coding-cli-wire-"));
  try {
    const args = (verb: string) => [wire, "command", verb];
    assert.equal((await codingContainerCommand(process.execPath, args("bad-exit"), dir, 5000)).exitCode, 7);
    await assert.rejects(codingContainerCommand(process.execPath, args("overflow"), dir, 5000));
    await assert.rejects(codingContainerCommand(process.execPath, args("combined"), dir, 5000));
    await assert.rejects(codingContainerCommand(process.execPath, args("hang"), dir, 100));
    await assert.rejects(codingContainerCommand("relative", [], dir, 5000), TypeError);
    await assert.rejects(codingContainerCommand(process.execPath, [], dir, 5001), TypeError);
    await assert.rejects(codingContainerCommand(process.execPath, [], "relative", 5000), TypeError);
    await assert.rejects(codingContainerCommand(join(dir, "absent"), [], dir, 5000));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("real synthetic CLI exercises create inspect start terminal and exact-ID cleanup without qualifying a runtime", async () => {
  const calls: string[][] = [], roots = new Set<string>();
  const r = await executeCodingIsolated("coding-parser", submission, image, {
    admission: async () => ({ admitted: true, reason: "synthetic-wire-only-not-host-authority" }),
    command: async (args, cwd, limit) => {
      calls.push(args); roots.add(cwd);
      if (args[0] === "start") {
        const p = JSON.parse(await readFile(join(cwd, "wire-state.json"), "utf8"));
        assert.equal(p.args.filter((v: string) => v.startsWith("type=bind,")).length, 2);
      }
      return codingContainerCommand(process.execPath, [wire, "good", ...args], cwd, limit);
    },
  });
  assert.equal(r.passed, true); assert.equal(r.state, "complete"); assert.equal(r.cleanup, "confirmed");
  assert.equal(r.executorQualified, false); assert.equal(r.resourceEvidence, null);
  assert.deepEqual(calls.map(v => v[0]), ["create", "inspect", "start", "inspect", "rm"]);
  assert.equal(calls.at(-1)?.[2], "a".repeat(64));
  for (const root of roots) await assert.rejects(readFile(join(root, "wire-state.json")), /ENOENT/);
});

test("executor refuses policy drift forged output OOM live state and failed cleanup with real synthetic CLI", async () => {
  for (const scenario of ["runc", "wrong-id", "malformed-inspect", "wrong-nonce", "printed-pass", "oom", "still-running",
    "execution-failed", "start-failed", "cleanup-failed", "uncertain-create", "malformed-id", "wrong-values"]) {
    const calls: string[][] = [];
    const r = await executeCodingIsolated("coding-parser", submission, image, {
      admission: async () => ({ admitted: true, reason: "synthetic-wire-only" }),
      command: async (args, cwd, limit) => { calls.push(args); return codingContainerCommand(process.execPath, [wire, scenario, ...args], cwd, limit); },
    });
    try {
      assert.equal(r.executorQualified, false); assert.equal(r.resourceEvidence, null); assert.notEqual(r.passed, true, scenario);
      if (["runc", "wrong-id", "malformed-inspect"].includes(scenario)) assert.ok(!calls.some(v => v[0] === "start"));
      if (["uncertain-create", "malformed-id"].includes(scenario)) assert.ok(!calls.some(v => v[0] === "rm"), "never guess an owned container on uncertain create");
      if (["uncertain-create", "malformed-id", "cleanup-failed"].includes(scenario)) {
        assert.equal(r.cleanup, "unknown"); assert.equal(r.state, "unavailable"); assert.ok(r.retainedScratch);
      } else assert.equal(r.cleanup, "confirmed");
    } finally { if (r.retainedScratch) await rm(r.retainedScratch, { recursive: true, force: true }); }
  }
});

test("host-owned challenges distinguish real trusted reference and wrong behavior for all three coding tasks", async () => {
  const cases = [
    ["coding-parser", 'export function parseCount(v){if(typeof v!=="string"||!/^(0|[1-9][0-9]*)$/.test(v)||Number(v)>9999)throw new TypeError();return Number(v);}', 'export const parseCount=v=>Number(v);'],
    ["coding-cleanup", 'export async function withDeadline(f,s){const h=s.set(()=>{});try{return await f();}finally{s.clear(h);}}', 'export async function withDeadline(f,s){const h=s.set(()=>{});s.clear(h);return await f();}'],
    ["coding-accounting", 'export function totalCharges(rows){const s=new Map();for(const r of rows){if(!r||typeof r.id!=="string"||!r.id||!Number.isSafeInteger(r.cents)||r.cents<0||(s.has(r.id)&&s.get(r.id)!==r.cents))return {state:"unknown",total:null};s.set(r.id,r.cents);}const n=[...s.values()].reduce((a,b)=>a+b,0);return Number.isSafeInteger(n)?{state:"known",total:n}:{state:"unknown",total:null};}', 'export const totalCharges=r=>({state:"known",total:r.reduce((s,r)=>s+r.cents,0)});'],
  ] as const;
  const dir = await mkdtemp(join(tmpdir(), "coding-trusted-challenge-")), nonce = "c".repeat(32);
  try {
    for (const [id, reference, wrong] of cases) {
      const challenge = codingBehaviorChallenge(id, nonce);
      await writeFile(join(dir, "harness.mjs"), challenge.harness);
      for (const [source, pass] of [[reference, true], [wrong, false]] as const) {
        await writeFile(join(dir, "solution.mjs"), source);
        const r = await promisify(execFile)(process.execPath, [join(dir, "harness.mjs")], {
          cwd: dir, timeout: 5000, maxBuffer: 65536, env: { PATH: "/usr/bin:/bin", HOME: dir, TMPDIR: dir },
        });
        assert.equal(gradeCodingSandboxValues(nonce, challenge.expected, r.stdout).passed, pass, id);
      }
    }
    assert.throws(() => codingBehaviorChallenge("coding-parser", "bad"), TypeError);
    assert.throws(() => codingBehaviorChallenge("no-task" as never, nonce), TypeError);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
