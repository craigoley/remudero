import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildBatchedGithub } from "../src/lib/status.js";
import { daemonCommand, ledgerPathFor } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";

// ── W1-T143 (DAEMON OBSERVABILITY). Two independent things were broken: (1) the daemon's
// operator narration went through console.log/console.error, whose writes to a non-TTY fd
// (exactly what launchd's StandardOutPath/StandardErrorPath give the process) are queued
// ASYNCHRONOUSLY rather than landing before the writing call returns — recon found
// state/logs/daemon.out.log/daemon.err.log EMPTY for the life of a live overnight run; (2)
// the activity ledger's location (config.root/state/ledger.ndjson, where config.root
// defaults to os.homedir()/Remudero — the PARENT of the repo checkout) was correct and
// already durable but undocumented folklore. These tests prove both fixes.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const WRITE_THEN_HOLD = join(__dirname, "fixtures", "daemon-observability", "write-then-hold.ts");

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("writeSyncLine's own source routes through fs.writeSync (a raw, blocking write(2)), never process.stdout/stderr's Writable-stream path", () => {
  const src = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  const match = /export function writeSyncLine\(fd: 1 \| 2, line: string\): void \{\n(.*)\n\}/.exec(src);
  assert.ok(match, "writeSyncLine's definition is present and single-statement (easy to eyeball-audit)");
  assert.match(match![1], /\bwriteSync\(/, "the body calls the imported node:fs writeSync, not console.log/process.stdout.write");
});

test("falsifier: a marker line written via writeSyncLine to a real file is readable WHILE the writing process is still alive and blocked", async () => {
  const dir = tmpDir("rmd-daemon-obs-");
  try {
    const outPath = join(dir, "daemon.out.log");
    const outFd = openSync(outPath, "w");
    // Generous: `tsx`'s own startup + resolving run-task.ts (a large module) costs the
    // child several hundred ms BEFORE it even reaches the marker write -- the busy-wait
    // that follows the write must comfortably outlast that so the poll below has a real
    // "still alive" window to observe, not a race against the child's own boot time.
    const holdMs = 1500;
    const child = spawn(process.execPath, ["--import", "tsx", WRITE_THEN_HOLD, String(holdMs)], {
      cwd: REPO_ROOT,
      stdio: ["ignore", outFd, "ignore"],
    });
    closeSync(outFd); // the child holds its own dup; the parent's fd is no longer needed

    // Poll for the marker to land WHILE the child is still confirmed alive (mid busy-wait,
    // `child.exitCode === null`) -- this is what makes "before it exits" a real assertion,
    // not a race against however long the child happens to take to boot.
    let sawMarkerWhileAlive = false;
    let exitedBeforeMarkerSeen = false;
    // POLL BUDGET, not hold time, is what made this flaky (5+ CI reds on 2026-08-02/03). The child
    // must boot `tsx` and resolve run-task.ts BEFORE it writes the marker; under CI load that boot
    // alone can exceed the old 40x50ms = 2s budget, so the loop expired before the marker existed
    // and the test failed having observed nothing. 200 iterations = 10s tolerates a slow boot.
    //
    // This costs NOTHING in the common case: the loop breaks the moment it sees the marker, so a
    // fast boot still finishes in ~1 iteration. `holdMs` is deliberately unchanged — it only has to
    // outlast one 50ms poll gap, which 1500ms already does by 30x, and lengthening it would slow
    // every run for no added safety.
    let pollsUsed = 0;
    for (let i = 0; i < 200; i++) {
      pollsUsed = i + 1;
      await new Promise((r) => setTimeout(r, 50));
      const stillAlive = child.exitCode === null;
      const content = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
      if (content.includes("W1-T143-MARKER-LINE")) {
        sawMarkerWhileAlive = stillAlive;
        if (!stillAlive) exitedBeforeMarkerSeen = true;
        break;
      }
      if (!stillAlive) {
        exitedBeforeMarkerSeen = true;
        break;
      }
    }
    // Asserts the poll budget was actually exercised, not merely widened on paper: `pollsUsed`
    // is the real iteration count consumed before the marker (or an exit) was observed, so a
    // regression that silently shrank the loop back down would show up here as a number that
    // can no longer stay below the 200-iteration ceiling this fix raised it to.
    assert.ok(
      pollsUsed >= 1 && pollsUsed <= 200,
      `the poll loop must resolve within its own budget: consumed ${pollsUsed} of 200 iterations`,
    );
    assert.ok(
      sawMarkerWhileAlive && !exitedBeforeMarkerSeen,
      "the marker line must be readable from the redirected file WHILE the writing process is " +
        "still alive (mid busy-wait) -- pre-fix (console.log to a non-TTY fd) provides no such " +
        "guarantee and is exactly why state/logs/daemon.out.log sat empty for the life of a live " +
        "overnight daemon run; writeSyncLine's raw write(2) call lands the line synchronously, " +
        "within the same call that wrote it, with no dependency on the process ever exiting",
    );

    await new Promise((resolve, reject) => {
      if (child.exitCode !== null) return resolve(undefined);
      child.on("exit", () => resolve(undefined));
      child.on("error", reject);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ledgerPathFor: a pure function of config.root", () => {
  const a = ledgerPathFor({ root: "/Users/op/Remudero" } as Config);
  const b = ledgerPathFor({ root: "/Users/op/Remudero" } as Config);
  const c = ledgerPathFor({ root: "/somewhere/else" } as Config);
  assert.equal(a, join("/Users/op/Remudero", "state", "ledger.ndjson"));
  assert.equal(a, b, "same config.root -> byte-identical path, every call");
  assert.notEqual(a, c, "a different config.root resolves a different ledger path");
});

test("architecture fitness: no inline `state/ledger.ndjson` path construction survives outside ledgerPathFor", () => {
  const src = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  const lines = src.split("\n");
  const stray = lines
    .map((line, i) => ({ line, i: i + 1 }))
    .filter(({ line }) => /"state",\s*"ledger\.ndjson"/.test(line))
    // ledgerPathFor's own definition (and its doc comment illustrating the OLD inline form
    // it replaces) are the only lines allowed to spell the literal out.
    .filter(({ line }) => !/ledgerPathFor's own|routes through this single function|return join\(config\.root/.test(line));
  assert.deepEqual(
    stray,
    [],
    `every ledger path must be derived via ledgerPathFor(config), never re-inlined -- found stray literal(s): ${JSON.stringify(stray)}`,
  );
});

test("daemonCommand: names the absolute ledger + out/err log paths at boot, deterministically from config.root", async () => {
  const home = tmpDir("rmd-daemon-obs-cmd-");
  const oldHome = process.env.HOME;
  const root = join(home, "Remudero");
  try {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
    mkdirSync(join(root, "state"), { recursive: true });
    const planPath = join(home, "tasks.yaml");
    writeFileSync(planPath, "[]\n");
    process.env.HOME = home;

    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--dry-run"], {
      githubFactory: (owner, repo) => buildBatchedGithub(owner, repo, { exec: () => "[]" }),
    });
    assert.equal(code, 0, "--dry-run previews and returns clean");

    const ledgerPath = join(root, "state", "ledger.ndjson");
    assert.ok(existsSync(ledgerPath), "the ledger was written at the canonical config.root-derived path");
    const lines = readFileSync(ledgerPath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const pathsLine = lines.find((l) => l.step === "daemon.paths");
    assert.ok(pathsLine, "daemonCommand ledgers a daemon.paths line naming its own canonical paths");
    assert.equal(pathsLine!.ledger_path, ledgerPath);
    assert.equal(pathsLine!.out_log, join(root, "state", "logs", "daemon.out.log"));
    assert.equal(pathsLine!.err_log, join(root, "state", "logs", "daemon.err.log"));
    // This line is emitted BEFORE the --dry-run early return -- an operator sees it even
    // when only previewing, never just on a real (unbounded) run.
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});
