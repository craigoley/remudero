import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DECLARED_CLI_PIN_ARG,
  parseClaudeVersionOutput,
  parseDeclaredClaudeVersion,
  readBinaryPin,
} from "../src/lib/env.js";
import { defaultBinaryPinDeps, runTask } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { GitHub } from "../src/lib/status.js";
import type { spawnWorker } from "../src/lib/worker.js";
import type { ProbeExecResult } from "../src/lib/containment.js";

/**
 * `checkBinaryPin` (src/lib/env.ts, W1-T236) SHIPPED WITH NO PRODUCTION CALLER — src/lib/
 * reachability.ts lists it by name among the zero-consumer organs, and deploy/Dockerfile cites it
 * as the reason a version swap inside the image would be VISIBLE. It would not have been.
 *
 * AND THE REASON IS NOT THAT SOMEONE FORGOT THE CALL. Its `recordedVersion` argument had NO
 * PRODUCER anywhere in the tree: `Config` carries `claudeBin`, a PATH, and no version, and
 * `resolveClaudeExecutable` runs `--version` with `stdio: "ignore"` and throws the output away. So
 * wiring it meant deciding what "recorded" means, and that choice is the design: the ONE
 * declaration this repo already makes, `ARG CLAUDE_CODE_VERSION` in deploy/Dockerfile, which
 * deploy/verify-image.sh now reads from the SAME line. One declaration, two consumers.
 *
 * THREE STATES, NEVER TWO. A read that did not happen must never render as `match`. The recon that
 * produced this change found that law broken three times in one function (deployer.ts probeIdle,
 * where a failed read becomes zero workers and therefore "idle"); it is not repeated here.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REAL_DOCKERFILE = readFileSync(join(REPO_ROOT, "deploy", "Dockerfile"), "utf8");

/** A `claude` stand-in that prints a chosen version in the MEASURED real shape. */
function fakeClaude(dir: string, version: string): string {
  const p = join(dir, "fake-claude");
  writeFileSync(p, `#!/bin/sh\necho "${version} (Claude Code)"\n`, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

// ── THE PARSERS, against the REAL declaration rather than a paraphrase of it ──────────────────

test("parseDeclaredClaudeVersion reads the pin out of the REAL deploy/Dockerfile", () => {
  const declared = parseDeclaredClaudeVersion(REAL_DOCKERFILE);
  assert.match(String(declared), /^\d+\.\d+\.\d+$/, "the shipped Dockerfile must declare a parseable pin");
  assert.ok(
    REAL_DOCKERFILE.includes(`ARG ${DECLARED_CLI_PIN_ARG}=${declared}`),
    "and the parse must agree with the literal line, not merely produce something version-shaped",
  );
});

test("parseDeclaredClaudeVersion returns undefined rather than guessing when the ARG is absent", () => {
  assert.equal(parseDeclaredClaudeVersion("FROM node:22\nENV DISABLE_AUTOUPDATER=1\n"), undefined);
  assert.equal(parseDeclaredClaudeVersion(""), undefined);
  // A commented-out pin is not a declaration.
  assert.equal(parseDeclaredClaudeVersion(`# ARG ${DECLARED_CLI_PIN_ARG}=9.9.9\n`), undefined);
});

test("parseDeclaredClaudeVersion tolerates quoting and trailing comments, since a future edit may add either", () => {
  assert.equal(parseDeclaredClaudeVersion(`ARG ${DECLARED_CLI_PIN_ARG}="2.1.220"\n`), "2.1.220");
  assert.equal(parseDeclaredClaudeVersion(`  ARG   ${DECLARED_CLI_PIN_ARG} = 2.1.220   # the pin\n`), "2.1.220");
});

test("parseClaudeVersionOutput takes the version and drops the product name", () => {
  // MEASURED shape, from a real binary: `2.1.227 (Claude Code)`.
  assert.equal(parseClaudeVersionOutput("2.1.227 (Claude Code)\n"), "2.1.227");
  assert.equal(parseClaudeVersionOutput("  2.1.220 (Claude Code)"), "2.1.220");
  assert.equal(parseClaudeVersionOutput("Claude Code v2.1.220"), undefined, "no LEADING version is not a version");
  assert.equal(parseClaudeVersionOutput(""), undefined);
});

// ── THE THREE STATES ─────────────────────────────────────────────────────────────────────────

test("a matched pair reads MATCH and names the version", () => {
  const r = readBinaryPin({
    readDockerfile: () => "ARG CLAUDE_CODE_VERSION=2.1.220\n",
    runClaudeVersion: () => "2.1.220 (Claude Code)\n",
  });
  assert.equal(r.status, "match");
  assert.equal(r.declaredVersion, "2.1.220");
  assert.equal(r.observedVersion, "2.1.220");
});

test("a mismatched pair reads DRIFT and names BOTH versions — the operator must not have to guess which", () => {
  const r = readBinaryPin({
    readDockerfile: () => "ARG CLAUDE_CODE_VERSION=2.1.220\n",
    runClaudeVersion: () => "2.1.227 (Claude Code)\n",
  });
  assert.equal(r.status, "drift");
  assert.equal(r.declaredVersion, "2.1.220");
  assert.equal(r.observedVersion, "2.1.227");
  assert.match(r.reason, /2\.1\.227/);
  assert.match(r.reason, /2\.1\.220/);
});

test("EVERY read failure degrades to UNKNOWN, never to a match it never observed", () => {
  const thrower = () => {
    throw new Error("ENOENT");
  };
  const unreadableDockerfile = readBinaryPin({ readDockerfile: thrower, runClaudeVersion: () => "2.1.220 (Claude Code)" });
  assert.equal(unreadableDockerfile.status, "unknown");
  assert.match(unreadableDockerfile.reason, /ENOENT/, "the cause is named, not swallowed");

  const noPin = readBinaryPin({ readDockerfile: () => "FROM node:22\n", runClaudeVersion: () => "2.1.220 (Claude Code)" });
  assert.equal(noPin.status, "unknown");

  const binaryWontRun = readBinaryPin({ readDockerfile: () => "ARG CLAUDE_CODE_VERSION=2.1.220\n", runClaudeVersion: thrower });
  assert.equal(binaryWontRun.status, "unknown");
  assert.equal(binaryWontRun.declaredVersion, "2.1.220", "what WAS read is still reported");

  const junk = readBinaryPin({ readDockerfile: () => "ARG CLAUDE_CODE_VERSION=2.1.220\n", runClaudeVersion: () => "wrapper error" });
  assert.equal(junk.status, "unknown");

  for (const r of [unreadableDockerfile, noPin, binaryWontRun, junk]) {
    assert.notEqual(r.status, "match", "an unknown must NEVER be reported as a match");
    assert.ok(r.reason.trim().length > 0, "and it must say which read failed");
  }
});

// ── THE DEFAULT DEPS, RUN FOR REAL — no injected seam, a real file and a real spawn ───────────

test("defaultBinaryPinDeps really reads the shipped Dockerfile and really executes the binary", () => {
  // Every other test here injects both reads, which would leave the default — the code that runs
  // in production — completely unexercised. This one drives it end to end.
  const dir = mkdtempSync(join(tmpdir(), "binary-pin-default-"));
  try {
    const declared = parseDeclaredClaudeVersion(REAL_DOCKERFILE);
    assert.ok(declared, "precondition: the shipped Dockerfile declares a pin");

    const matched = readBinaryPin(defaultBinaryPinDeps(fakeClaude(dir, declared)));
    assert.equal(matched.status, "match", "the REAL Dockerfile read plus a REAL spawn agree");
    assert.equal(matched.observedVersion, declared);

    const drifted = readBinaryPin(defaultBinaryPinDeps(fakeClaude(dir, "9.9.9")));
    assert.equal(drifted.status, "drift", "and the same real reads detect a real disagreement");
    assert.equal(drifted.declaredVersion, declared);
    assert.equal(drifted.observedVersion, "9.9.9");

    const absent = readBinaryPin(defaultBinaryPinDeps(join(dir, "definitely-not-here")));
    assert.equal(absent.status, "unknown", "a binary that cannot be executed is UNKNOWN, not a match");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── THE CALL SITE EXECUTES — the whole defect being fixed is a function nothing calls ─────────

const FIXTURE_PLAN = [
  "- id: TST-BINARY-PIN",
  "  title: binary-pin rung wiring probe",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/lib/daemon.ts]",
  "  origin: architect",
  "  status: queued",
  "",
].join("\n");

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

/** Reports the outside-cwd write SUCCEEDED, so the containment preflight refuses right after the
 *  binary-pin rung — which is what makes the ORDERING assertion below possible. */
const droppedContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({ transcript: `touch ../${token}.txt`, outsideWriteCreated: true, insideWriteCreated: true, costUsd: 0 });

async function driveRun(binaryPinDeps: Parameters<typeof readBinaryPin>[0]) {
  const root = mkdtempSync(join(tmpdir(), "runtask-binary-pin-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };
  const spawn = (async () => {
    throw new Error("spawn must never run — the containment preflight refuses first");
  }) as typeof spawnWorker;
  const res = await runTask("TST-BINARY-PIN", {
    skipGitSync: true,
    planPath,
    config,
    github: OFFLINE_GITHUB,
    spawn,
    containmentExec: droppedContainmentExec,
    binaryPinDeps,
  });
  const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  rmSync(root, { recursive: true, force: true });
  return { res, ledger };
}

test("BEHAVIORAL: the rung EXECUTES in the real run path and its reading reaches the ledger", async () => {
  const { ledger } = await driveRun({
    readDockerfile: () => "ARG CLAUDE_CODE_VERSION=2.1.220\n",
    runClaudeVersion: () => "2.1.227 (Claude Code)\n",
  });

  const line = ledger.find((l) => l.step === "preflight.binary_pin");
  assert.ok(line, "a function wired into a path nobody takes is the defect being fixed, repeated");
  assert.equal(line.status, "drift");
  assert.equal(line.declared_version, "2.1.220");
  assert.equal(line.observed_version, "2.1.227");
  assert.match(String(line.reason), /untested/);
});

test("BEHAVIORAL: the rung runs BEFORE the containment preflight, so it can explain a probe that then fails", async () => {
  const { res, ledger } = await driveRun({
    readDockerfile: () => "ARG CLAUDE_CODE_VERSION=2.1.220\n",
    runClaudeVersion: () => "2.1.227 (Claude Code)\n",
  });
  assert.equal(res.verdict, "blocked_containment", "precondition: the run really reached and failed the containment probe");

  const pinIdx = ledger.findIndex((l) => l.step === "preflight.binary_pin");
  const verdictIdx = ledger.findIndex((l) => l.step === "verdict" && l.verdict === "blocked_containment");
  assert.ok(pinIdx >= 0 && verdictIdx >= 0, "both lines were ledgered");
  assert.ok(pinIdx < verdictIdx, "the pin reading must precede the verdict it might explain");
});

test("BEHAVIORAL: a MATCHED pin is still ledgered — silence would make the rung indistinguishable from the unwired state", async () => {
  const { ledger } = await driveRun({
    readDockerfile: () => "ARG CLAUDE_CODE_VERSION=2.1.220\n",
    runClaudeVersion: () => "2.1.220 (Claude Code)\n",
  });
  const line = ledger.find((l) => l.step === "preflight.binary_pin");
  assert.ok(line, "a rung that only writes on drift cannot be told apart from one that never ran");
  assert.equal(line.status, "match");
});

test("BEHAVIORAL: a mismatch does NOT block the run — the disposition is loud, not fatal", async () => {
  // THE ARGUED HALF. checkBinaryPin's own doc requires it ("LEDGER the drift and CONTINUE rather
  // than hard-fail"), the fleet has merged PRs for days on a real mismatch, and a refusal would be
  // the FIFTH bound in this repo measured firing on a healthy condition. Pinned so a later edit
  // cannot quietly promote it to a gate.
  const { res } = await driveRun({
    readDockerfile: () => "ARG CLAUDE_CODE_VERSION=2.1.220\n",
    runClaudeVersion: () => "2.1.227 (Claude Code)\n",
  });
  assert.notEqual(res.verdict, "blocked_binary_pin", "there is no such verdict, and there must not be");
  assert.equal(res.verdict, "blocked_containment", "the run proceeded past the pin and was stopped by a DIFFERENT gate");
});
