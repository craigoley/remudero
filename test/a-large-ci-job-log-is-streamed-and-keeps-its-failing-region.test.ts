import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCiFailureRegionReducer, fetchCiFailuresAsync } from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { ghShim } from "./helpers/gh-shim.js";

const ROLLUP = [
  {
    name: "coverage-shard (8/8)",
    conclusion: "FAILURE",
    detailsUrl: "https://github.com/craigoley/remudero/actions/runs/1/job/321",
  },
];

const TS = "2026-10-05T01:02:03.0000000Z ";

/** A real `gh` PATH shim whose job-log route streams `logFile` and whose annotations route is empty. */
async function withLogShim<T>(
  log: string | ((write: (chunk: string) => void) => void),
  exitCode: number,
  body: (shim: { calls(): string[] }) => Promise<T>,
): Promise<T> {
  const shim = ghShim([], { kind: "streamed-job-log" });
  const work = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}streamed-job-log-cache-`));
  const logFile = join(work, "job.log");
  let text = "";
  if (typeof log === "string") text = log;
  else {
    const parts: string[] = [];
    log((chunk) => parts.push(chunk));
    text = parts.join("");
  }
  writeFileSync(logFile, text);
  writeFileSync(
    join(shim.dir, "gh"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(join(shim.dir, "calls.log"))}`,
      'case "$*" in',
      "  *annotations*) echo '[]' ;;",
      exitCode === 0
        ? `  */logs) cat ${JSON.stringify(logFile)} ;;`
        : `  */logs) echo 'HTTP 502: bad gateway' 1>&2; exit ${exitCode} ;;`,
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const saved = { PATH: process.env.PATH, RMD_GH_CACHE_HOME: process.env.RMD_GH_CACHE_HOME };
  process.env.PATH = `${shim.dir}:${process.env.PATH ?? ""}`;
  process.env.RMD_GH_CACHE_HOME = work;
  try {
    return await body(shim);
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.RMD_GH_CACHE_HOME === undefined) delete process.env.RMD_GH_CACHE_HOME;
    else process.env.RMD_GH_CACHE_HOME = saved.RMD_GH_CACHE_HOME;
    rmSync(work, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  }
}

function bigLog(withTapBlock: boolean): string {
  const lines: string[] = [];
  const filler = (n: number) => `${TS}noise ${n} é✖ ${"x".repeat(180)}`;
  for (let n = 0; n < 40; n += 1) lines.push(filler(n));
  if (withTapBlock) {
    lines.push(`${TS}not ok 7 - the coverage shard fails here`);
    lines.push(`${TS}  ---`);
    lines.push(`${TS}  error: 'expected 1, received 2'`);
    lines.push(`${TS}  ...`);
  }
  for (let n = 40; n < 32_000; n += 1) lines.push(filler(n));
  lines.push(`${TS}THE-TAIL-LINE`);
  return lines.join("\n") + "\n";
}

test("a 6 MiB job log served by a real gh shim comes back with its not ok block and no logUnavailable", async () => {
  const log = bigLog(true);
  assert.ok(Buffer.byteLength(log) > 6 * 1024 * 1024, "the fixture is past the old 4 MiB cap");
  await withLogShim(log, 0, async (shim) => {
    const [failure] = await fetchCiFailuresAsync("craigoley", "remudero", ROLLUP, 60);
    assert.equal(failure.logUnavailable, undefined, JSON.stringify(failure.logUnavailable));
    assert.equal(failure.tailSource, "log");
    assert.match(failure.logTail, /not ok 7 - the coverage shard fails here/);
    assert.match(failure.logTail, /error: 'expected 1, received 2'/);
    assert.ok(failure.logTail.length < 2000, "the region is the failing block, never the whole log");
    assert.ok(shim.calls().some((c) => c.endsWith("/jobs/321/logs")));
  });
});

test("a 6 MiB job log with no failing block keeps its tail line", async () => {
  await withLogShim(bigLog(false), 0, async () => {
    const [failure] = await fetchCiFailuresAsync("craigoley", "remudero", ROLLUP, 20);
    assert.equal(failure.logUnavailable, undefined);
    assert.ok(failure.logTail.endsWith("THE-TAIL-LINE"), failure.logTail.slice(-80));
    assert.equal(failure.logTail.split("\n").length, 19, "20 lines less the trailing empty one trim drops");
  });
});

test("a failed streamed read still names fetch-failed with the gh stderr", async () => {
  await withLogShim("unused", 1, async () => {
    const [failure] = await fetchCiFailuresAsync("craigoley", "remudero", ROLLUP, 60);
    assert.equal(failure.logUnavailable?.kind, "fetch-failed");
    assert.match(String((failure.logUnavailable as { detail?: string }).detail), /502: bad gateway/);
    assert.equal(failure.logTail, "");
  });
});

function reduce(log: string, tailLines: number): string {
  const reducer = createCiFailureRegionReducer(tailLines);
  for (const line of log.split("\n")) reducer.push(line);
  return reducer.finish();
}

async function wholeText(log: string, tailLines: number): Promise<string> {
  const [failure] = await fetchCiFailuresAsync("o", "r", ROLLUP, tailLines, {
    fetchAnnotations: () => [],
    fetchJobLog: () => log,
  });
  return failure.logTail;
}

const VOCABULARY = [
  "plain noise line",
  "more output 12345",
  "not ok 3 - a failing test",
  "not ok 4 - another failing test",
  "  ---",
  "  error: 'boom'",
  "  ...",
  "ok 5 - a passing test",
  "##[group]Run npm test",
  "##[endgroup]",
  "##[error]Process completed with exit code 1.",
  "FLAKE-RETRY: shard 3 attempt 1",
  "FLAKE-RETRY: shard 4 attempt 1",
  "FLAKE-RETRY-RECOVERED: shard 3",
  "✖ failing tests:",
  "ℹ tests 5",
  "# fail 2",
  "Run 'npm run gen:a' and commit the result.",
  "Run 'npm run gen:b' and commit the result.",
  "",
];

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

test("on fixture logs under 4 MiB the streamed region equals extractCiFailureRegion plus the retained remedies", async () => {
  const fixed = [
    "",
    "just one line",
    `${TS}a\r\n${TS}b\r\n`,
    ["a", "##[group]Run x", "b", "c", "##[error]boom", "tail"].join("\n"),
    ["x", "✖ failing tests:", "  a", "  b", "ℹ tests 3", "late"].join("\n"),
    [
      "Run 'npm run gen:a' and commit the result.",
      ...Array.from({ length: 200 }, (_, n) => `filler ${n}`),
      "not ok 1 - late failure",
      "  ...",
    ].join("\n"),
  ];
  for (const log of fixed) {
    for (const tailLines of [1, 5, 60]) assert.equal(reduce(log, tailLines), await wholeText(log, tailLines), JSON.stringify([log.slice(0, 40), tailLines]));
  }
  const next = seeded(5836);
  for (let round = 0; round < 400; round += 1) {
    const size = Math.floor(next() * 150);
    const lines: string[] = [];
    for (let n = 0; n < size; n += 1) {
      const line = VOCABULARY[Math.floor(next() * VOCABULARY.length)];
      lines.push(next() < 0.5 ? `${TS}${line}` : line);
    }
    const log = lines.join("\n");
    for (const tailLines of [1, 4, 60]) {
      assert.equal(reduce(log, tailLines), await wholeText(log, tailLines), `round ${round} tail ${tailLines}\n${log}`);
    }
  }
});

test("the reducer holds only a bounded window however long the log is", () => {
  const reducer = createCiFailureRegionReducer(10);
  for (let n = 0; n < 200_000; n += 1) reducer.push(n % 3 === 0 ? `not ok ${n} - failure ${n}` : `noise ${n}`);
  const region = reducer.finish();
  assert.equal(region.split("\n").length, 10);
  assert.match(region, /noise 199999$/);
});
