import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { gitRepo } from "#test/helpers/git-repo.js";
import { repoRoot } from "#test/helpers/repo-root.js";

function fixture() {
  const repo = gitRepo({ kind: "next-task-id-max-scan" });
  mkdirSync(join(repo.dir, "plan"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), "- id: W1-T11223\n  title: seed\n");
  repo.git("add", "plan/tasks.yaml");
  repo.git("commit", "--quiet", "-m", "test: seed bounded task id mint");
  repo.git("update-ref", "refs/remotes/origin/main", repo.git("rev-parse", "HEAD"));
  return repo;
}

function invoke(args: string[], opts: { taken?: Set<string> } = {}) {
  const repo = fixture();
  try {
    const moduleUrl = pathToFileURL(join(repoRoot(), "src", "run-task.ts")).href;
    const script = `
      import { nextTaskIdCommand } from ${JSON.stringify(moduleUrl)};
      const args = ${JSON.stringify(args)};
      const taken = new Set(${JSON.stringify([...(opts.taken ?? [])])});
      const out = [], err = [], tried = [];
      let openPrReads = 0, targetRepoReads = 0;
      console.log = (...values) => out.push(values.join(" "));
      console.error = (...values) => err.push(values.join(" "));
      const reserver = {
        mintAnchor: () => "ANCHOR-SHA",
        attempt(taskId) { tried.push(taskId); return taken.has(taskId) ? "taken" : "created"; },
      };
      const code = await nextTaskIdCommand(args, {}, {
        repoRoot: ${JSON.stringify(repo.dir)}, reserver, holderOf: () => "unknown",
        openPrTexts: () => (openPrReads++, []),
        openTargetRepo: () => { targetRepoReads++; throw new Error("prefix target must not be opened"); },
      });
      process.stdout.write(JSON.stringify({ code, out, err, tried, openPrReads, targetRepoReads }));
    `;
    const child = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script], {
      cwd: repoRoot(), encoding: "utf8",
    });
    assert.equal(child.status, 0, `child exited ${child.status}: ${child.stderr}\n${child.stdout}`);
    return JSON.parse(child.stdout) as {
      code: number; out: string[]; err: string[]; tried: string[]; openPrReads: number; targetRepoReads: number;
    };
  } finally {
    repo.cleanup();
  }
}

function takenRange(start: number, count: number): Set<string> {
  return new Set(Array.from({ length: count }, (_, index) => `W1-T${start + index}`));
}

test("W1-T11224: the default stays at 50 and an explicit bound reaches the next candidate", () => {
  const defaultRun = invoke(["--reserve"], { taken: takenRange(11224, 50) });
  assert.equal(defaultRun.code, 2);
  assert.equal(defaultRun.tried.length, 50);
  assert.doesNotMatch(defaultRun.err.join("\n"), /max-scan:/, "the default result stays byte-compatible");
  assert.match(defaultRun.err.join("\n"), /every candidate in the scanned range is already reserved/);

  const expanded = invoke(["--reserve", "--max-scan", "51"], { taken: takenRange(11224, 50) });
  assert.equal(expanded.code, 0);
  assert.equal(expanded.tried.length, 51);
  assert.equal(expanded.tried.at(-1), "W1-T11274");
  assert.match(expanded.out.join("\n"), /RESERVED W1-T11274 .*max-scan: 51/);
  assert.equal(expanded.openPrReads, 1);

  const atCap = invoke(["--reserve", "--max-scan", "200"], { taken: takenRange(11224, 199) });
  assert.equal(atCap.code, 0);
  assert.equal(atCap.tried.length, 200);
  assert.equal(atCap.tried.at(-1), "W1-T11423");
  assert.match(atCap.out.join("\n"), /max-scan: 200/);
});

test("W1-T11224: --count uses the selected bound for each held id", () => {
  const result = invoke(["--reserve", "--count", "2", "--max-scan", "51"], { taken: takenRange(11224, 50) });
  assert.equal(result.code, 0);
  assert.equal(result.tried.length, 52);
  assert.deepEqual(result.tried.slice(-2), ["W1-T11274", "W1-T11275"]);
  assert.equal((result.out.join("\n").match(/max-scan: 51/g) ?? []).length, 2);
  assert.equal(result.openPrReads, 1);
});

test("W1-T11224: malformed, duplicate, or over-cap bounds refuse before remote reads", () => {
  const invalid = [
    ["--reserve", "--max-scan"],
    ["--reserve", "--max-scan", ""],
    ["--reserve", "--max-scan", "1.5"],
    ["--reserve", "--max-scan", "0"],
    ["--reserve", "--max-scan", "201"],
    ["--reserve", "--max-scan", "nope"],
    ["--reserve", "--max-scan", "10", "--max-scan", "20"],
  ];
  for (const args of invalid) {
    const result = invoke(args);
    assert.equal(result.code, 2, args.join(" "));
    assert.equal(result.openPrReads, 0, `open-PR read occurred for ${args.join(" ")}`);
    assert.equal(result.tried.length, 0, `reservation occurred for ${args.join(" ")}`);
    assert.match(result.err.join("\n"), /--max-scan must be an integer between 1 and 200/);
  }
});

test("W1-T11224: an explicit bound requires --reserve and does not reach the prefix allocator", () => {
  const withoutReserve = invoke(["--max-scan", "75"]);
  assert.equal(withoutReserve.code, 2);
  assert.match(withoutReserve.err.join("\n"), /--max-scan requires explicit --reserve/);
  assert.equal(withoutReserve.openPrReads, 0);

  const prefix = invoke(["--reserve", "--max-scan", "75", "--prefix", "CONSOLE", "--repo", "craigoley/remudero-console"]);
  assert.equal(prefix.code, 2);
  assert.equal(prefix.targetRepoReads, 0);
  assert.match(prefix.err.join("\n"), /applies only to W1 task reservations/);
});
