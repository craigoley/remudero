/**
 * test/worker-bash-snapshot-isolation.test.ts — W1-T11908.
 *
 * The snapshot-boundary falsifier for the worker login profile (W1-T11693). A Claude worker's Bash
 * tool builds a shell snapshot by running `<shell> -c -l '<script>'`, and a login bash reads
 * /etc/profile (and so /etc/profile.d/*.sh) BEFORE `~/.bash_profile`. On the Azure host that leaked
 * six gawk* functions into the snapshot and the isolation probe refused the run (W1-T11891).
 *
 * This file drives that exact invocation against a real materialized worker home and asserts:
 *   1. RED CONTROL: with a zero-byte `~/.bash_profile` (the pre-W1-T11693 behaviour) a function
 *      present BEFORE the profile IS reported, so the harness can observe the leak;
 *   2. GREEN: with the materialized home no such function and no alias is reported, and
 *      `assessIsolation` calls the report isolated;
 *   3. STILL REFUSES: an alias and a function planted in `~/.bashrc` still reach the report and
 *      `assessIsolation` refuses naming them, while a CLAUDE_CODE_TOOL_WRAPPERS name stays excluded.
 *
 * The generator shape is taken from a THIRD-PARTY, UNOFFICIAL mirror of Claude Code's source
 * (utils/bash/ShellSnapshot.ts, https://tangled.org/oppi.li/claude-code/blob/main/utils/bash/ShellSnapshot.ts):
 * it execs `[shell, '-c', '-l', script]`, the script sources "$HOME/.bashrc" when present, then
 * serializes `declare -F` names except single-underscore ones. The native probe (W1-T11909) is the
 * authority for the shipped CLI.
 *
 * The system-profile function is injected WITHOUT touching /etc: a function exported with `export -f`
 * is imported by bash before any startup file, which is the same point a profile.d function appears.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildWorkerEnv } from "#src/lib/env.js";
import { assessIsolation, CLAUDE_CODE_TOOL_WRAPPERS, type IsolationEvidence } from "#src/lib/isolation.js";
import { WORKER_HOME_LOGIN_PROFILE, materializeWorkerHome } from "#src/lib/worker-home.js";

const INJECTED_FN = "rmd_injected_profile_fn";
const GAWK_NAMES = [
  "gawklibpath_append",
  "gawklibpath_default",
  "gawklibpath_prepend",
  "gawkpath_append",
  "gawkpath_default",
  "gawkpath_prepend",
];

/** The snapshot script: source the rc as the generator does, then list function and alias names. */
const SNAPSHOT_SCRIPT = [
  'if [ -f "$HOME/.bashrc" ]; then source "$HOME/.bashrc" < /dev/null; fi',
  "declare -F | while read -r _d _f name; do printf 'FUNC:%s\\n' \"$name\"; done",
  "compgen -A alias | while read -r name; do printf 'ALIAS:%s\\n' \"$name\"; done",
].join("\n");

interface Home {
  root: string;
  home: string;
  env: Record<string, string>;
  shell: string;
}

/** A real materialized worker home plus the env `buildWorkerEnv` hands a worker. */
function makeHome(): Home {
  const root = mkdtempSync(join(tmpdir(), "rmd-t11908-"));
  const home = join(root, "worker-home");
  const realHome = join(root, "real-home");
  materializeWorkerHome({ workerHome: home, realHome, exists: (p) => !p.endsWith("/.git") });
  const parent = { ...process.env } as NodeJS.ProcessEnv;
  const shell = execFileSync("bash", ["-c", "command -v bash"], { encoding: "utf8", env: parent }).trim();
  const env = buildWorkerEnv({}, parent, { home, shell });
  return { root, home, env, shell };
}

/** Run the snapshot generator invocation and return the report in the probe's evidence shape. */
function snapshotReport(h: Home, extraEnv: Record<string, string> = {}): IsolationEvidence {
  const env: Record<string, string> = { ...h.env, SHELL: h.shell, GIT_EDITOR: "true", CLAUDECODE: "1", ...extraEnv };
  // The parent is a plain `bash -c` that exports the injected function, then execs the harness.
  const out = execFileSync(
    "bash",
    ["-c", `${INJECTED_FN}() { :; }; export -f ${INJECTED_FN}; exec "$0" -c -l "$1"`, h.env.CLAUDE_CODE_SHELL, SNAPSHOT_SCRIPT],
    { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] },
  );
  const lines = out.split("\n");
  const names = (prefix: string): string[] =>
    lines.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length));
  const wrappers: readonly string[] = CLAUDE_CODE_TOOL_WRAPPERS;
  // The generator drops single-underscore names; the probe excludes the wrapper names.
  const fns = names("FUNC:").filter((n) => !/^_[^_]/.test(n) && n !== "_" && !wrappers.includes(n));
  const aliases = names("ALIAS:");
  return {
    aliasCount: aliases.length,
    functionCount: fns.length,
    aliasNames: aliases.length > 0 ? aliases.join(" ") : undefined,
    functionNames: fns.length > 0 ? fns.join(" ") : undefined,
  };
}

function withHome<T>(fn: (h: Home) => T): T {
  const h = makeHome();
  try {
    return fn(h);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
}

test("red control: a zero-byte ~/.bash_profile lets a pre-profile function reach the snapshot", () => {
  withHome((h) => {
    truncateSync(join(h.home, WORKER_HOME_LOGIN_PROFILE), 0);
    const report = snapshotReport(h);
    assert.match(report.functionNames ?? "", new RegExp(INJECTED_FN));
    assert.equal(assessIsolation(report).isolated, false);
  });
});

test("green: the materialized worker home leaves the snapshot with no pre-profile function and no alias", () => {
  withHome((h) => {
    const report = snapshotReport(h);
    assert.equal(report.aliasCount, 0);
    assert.doesNotMatch(report.functionNames ?? "", new RegExp(INJECTED_FN));
    assert.equal(assessIsolation(report).isolated, true);
  });
});

test(
  "green: no /etc/profile.d gawk function reaches the snapshot",
  { skip: existsSync("/etc/profile.d/gawk.sh") ? false : "skip: this host has no /etc/profile.d/gawk.sh" },
  () => {
    withHome((h) => {
      const report = snapshotReport(h);
      for (const name of GAWK_NAMES) assert.doesNotMatch(report.functionNames ?? "", new RegExp(`\\b${name}\\b`));
    });
  },
);

test("still refuses: an alias and a function planted in ~/.bashrc reach the report and trip assessIsolation", () => {
  withHome((h) => {
    writeFileSync(
      join(h.home, ".bashrc"),
      "alias rmd_planted_alias=true\nrmd_planted_fn() { :; }\nfind() { :; }\n",
    );
    const report = snapshotReport(h);
    assert.equal(report.aliasNames, "rmd_planted_alias");
    assert.match(report.functionNames ?? "", /\brmd_planted_fn\b/);
    // A wrapper-named function stays excluded exactly as the probe excludes it today.
    assert.doesNotMatch(report.functionNames ?? "", /\bfind\b/);
    const verdict = assessIsolation(report);
    assert.equal(verdict.isolated, false);
    assert.match(verdict.reason, /rmd_planted_alias/);
    assert.match(verdict.reason, /rmd_planted_fn/);
  });
});
