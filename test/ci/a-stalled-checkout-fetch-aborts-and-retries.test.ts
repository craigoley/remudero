// W1-T13321 — a stalled checkout fetch in the ci and coverage shards aborts and is retried.
// W1-T13271 RECON, MEASURED 2026-11-17 (Actions jobs API, every ci.yml run 2026-11-10..17): 13 of 37,468 ci-shard
// and coverage-shard checkout steps took 323-1245 s, each one silent `git fetch` that later completed, while
// sibling shards of the same run fetched in 23-26 s. actions/checkout v7.0.1 passes process.env to git and retries
// a failed fetch (3 attempts, 10-20 s apart), so git's low-speed abort turns a 21-minute stall into about 2.5 min.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Step = { id?: string; uses?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Workflow = { jobs: Record<string, { steps?: Step[] }> };

const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const LANES = ["ci", "coverage-ratchet"] as const;
const checkoutOf = (job: string) => {
  const doc = parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as Workflow;
  // W1-T13825 added a retry checkout after this one; the bounded first checkout carries id "checkout".
  const steps = (doc.jobs[job]?.steps ?? []).filter((s) => s.id === "checkout");
  assert.equal(steps.length, 1, `${job} has exactly one first checkout step`);
  assert.ok((steps[0]!.uses ?? "").startsWith("actions/checkout@"), `${job}'s first checkout is actions/checkout`);
  return steps[0]!;
};

test("W1-T13321 criterion 1: both shard lanes' checkout steps set the low-speed abort in their step env", () => {
  for (const job of LANES) {
    const step = checkoutOf(job);
    assert.deepEqual(step.env, { GIT_HTTP_LOW_SPEED_LIMIT: "1000", GIT_HTTP_LOW_SPEED_TIME: "120" }, job);
    assert.ok(step.with, `${job} keeps its with: inputs`);
  }
});

test("W1-T13321 criterion 2: invariant fetch-unchanged, both checkouts keep the full fetch and the pinned action", () => {
  for (const job of LANES) {
    const step = checkoutOf(job);
    assert.equal(step.uses, CHECKOUT, `${job} keeps the pinned actions/checkout sha`);
    assert.equal(step.with!["fetch-depth"], 0, `${job} keeps fetch-depth 0, so every history reader sees the full history`);
  }
});

/** A git smart-HTTP server that starts its first answer and then sends nothing more, as the stalled fetches did. */
async function stallingServer() {
  const held: ServerResponse[] = [];
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/x-git-upload-pack-advertisement", "Cache-Control": "no-cache" });
    res.write("001e# service=git-upload-pack\n");
    held.push(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/remudero.git`,
    close: () => new Promise<void>((resolve) => {
      for (const res of held) res.destroy();
      server.close(() => resolve());
    }),
  };
}

/** Run a real `git fetch` against `url`; resolve with its exit code, or "running" if it outlives `boundMs`. */
function fetchWithin(repo: string, url: string, extraEnv: Record<string, string>, boundMs: number) {
  return new Promise<{ code: number | "running"; stderr: string }>((resolve) => {
    const child = spawn("git", ["-c", "protocol.version=2", "fetch", "--no-tags", url, "+refs/heads/*:refs/remotes/origin/*"], {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0", ...extraEnv },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: "running", stderr });
    }, boundMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

test("W1-T13321 criterion 3: the low-speed variables reach git and abort a fetch whose server stops sending", async () => {
  const repo = gitRepo({ kind: "stalled-fetch" });
  const root = repo.dir;
  const server = await stallingServer();
  try {

    // The positive control: without the variables, the same fetch is still waiting at 5 s.
    const unbounded = await fetchWithin(root, server.url, {}, 5_000);
    assert.equal(unbounded.code, "running", `an unbounded fetch must still be stalled at 5 s: ${unbounded.stderr}`);

    const started = Date.now();
    const bounded = await fetchWithin(root, server.url, { GIT_HTTP_LOW_SPEED_LIMIT: "1000", GIT_HTTP_LOW_SPEED_TIME: "2" }, 20_000);
    assert.notEqual(bounded.code, "running", "the bounded fetch must exit inside 20 s");
    assert.notEqual(bounded.code, 0, "a fetch git aborted exits non-zero, which actions/checkout's retry helper retries");
    assert.ok(Date.now() - started >= 1_500, "the abort waits for the low-speed window, not an immediate refusal");
  } finally {
    await server.close();
    repo.cleanup();
  }
});
