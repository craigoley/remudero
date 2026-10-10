import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "../src/lib/tmp.js";
import { runBeat } from "./helpers/fleet-heartbeat-harness.js";

const guardUrl = new URL("./helpers/fixture-du.ts", import.meta.url);
const guardModule = existsSync(guardUrl) ? await import(guardUrl.href) : undefined;
function fixture(t: TestContext) {
  assert.equal(typeof guardModule?.installFixtureDuGuard, "function", "the namespace guard must exist before executing a fixture");
  const dir = makeTempDir("fixture-du-control"), bin = join(dir, "bin"), owned = join(dir, "owned");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(bin); mkdirSync(owned);
  writeFileSync(join(owned, "payload"), Buffer.alloc(8192, 1));
  const guard = guardModule!.installFixtureDuGuard(bin, [owned]);
  const run = (path: string) => spawnSync(guard.path, ["-sk", path], { encoding: "utf8", timeout: 10_000 });
  const calls = () => readFileSync(guard.callsPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { dir, owned, guard, run, calls };
}

function mountTopology(t: TestContext, fsroot: string) {
  const dir = makeTempDir("heartbeat-mount-topology"), calls = join(dir, "calls"), envFile = join(dir, "env.sh");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.match(fsroot, /^\/[a-z-]*$/);
  writeFileSync(envFile, [
    "findmnt() {",
    `  printf '%s\\n' "$*" >> '${calls.replace(/'/g, "'\\''")}'`,
    '  [ "$*" = "-n -o FSROOT -M /mnt/rmd" ] || return 1',
    `  printf '%s\\n' '${fsroot}'`,
    "}", "",
  ].join("\n"));
  return { env: { BASH_ENV: envFile }, calls: () => readFileSync(calls, "utf8").trim().split("\n") };
}

test("fixture du guard executes the real leaf only inside its canonical owned namespace", (t) => {
  const f = fixture(t);
  const result = f.run(f.owned);
  assert.equal(result.status, 0, `${result.error ?? ""} ${result.stderr}`);
  assert.match(result.stdout, /^[0-9]+\s/);
  assert.ok(Number(result.stdout.split(/\s/)[0]) >= 8, "positive native file-population control");
  assert.equal(f.calls()[0].allowed, true);
  assert.equal(f.calls()[0].status, 0);
});

test("fixture du guard refuses an external owned control and a symlink escape without reporting zero", (t) => {
  const f = fixture(t), external = makeTempDir("fixture-du-outside-control");
  t.after(() => rmSync(external, { recursive: true, force: true }));
  writeFileSync(join(external, "external-payload"), Buffer.alloc(8192, 1));
  symlinkSync(external, join(f.owned, "escape"), "dir");
  for (const path of [external, join(f.owned, "escape")]) {
    const result = f.run(path);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "", "a refused measurement is not a fabricated numeric zero");
    assert.match(result.stderr, /outside fixture namespace/);
  }
  assert.equal(f.calls().length, 2);
  assert.ok(f.calls().every(call => call.allowed === false));
});

test("fixture du guard accepts a canonical alias and preserves a real leaf permission failure", (t) => {
  const f = fixture(t), alias = join(f.dir, "alias");
  symlinkSync(f.owned, alias, "dir");
  assert.equal(f.run(alias).status, 0);
  const unreadable = join(f.owned, "unreadable");
  mkdirSync(unreadable); writeFileSync(join(unreadable, "payload"), "fixture"); chmodSync(unreadable, 0);
  try {
    const result = f.run(f.owned);
    assert.equal(result.status, 1, "native permission refusal must not become a successful size");
    assert.match(result.stderr, /Permission denied/);
    assert.equal(f.calls().at(-1).allowed, true);
    assert.equal(f.calls().at(-1).status, 1);
  } finally { chmodSync(unreadable, 0o700); }
});

test("fixture du guard refuses alternate flags and a missing path without invoking a measurement", (t) => {
  const f = fixture(t);
  for (const argv of [["-skL", f.owned], ["-sk", f.owned, f.owned], ["-sk", "relative"], ["-sk", join(f.owned, "absent")]]) {
    const result = spawnSync(f.guard.path, argv, { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /accepts only|cannot resolve fixture measurement/);
  }
  assert.equal(f.calls().length, 4);
  assert.ok(f.calls().every(call => !call.allowed && call.status === 1));
});

test("fixture du guard preserves a genuine native zero instead of treating zero as absent", (t) => {
  const f = fixture(t), empty = join(f.owned, "empty-file");
  writeFileSync(empty, "");
  const result = f.run(empty);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^0\s/);
  assert.equal(f.calls()[0].allowed, true);
});

test("fixture du installation rejects a broad namespace and never overwrites another executable", (t) => {
  const f = fixture(t), original = readFileSync(f.guard.path, "utf8");
  assert.throws(() => guardModule!.installFixtureDuGuard(join(f.dir, "bin"), []), /requires an owned namespace/);
  assert.throws(() => guardModule!.installFixtureDuGuard(join(f.dir, "bin"), ["relative"]), /must be absolute/);
  assert.throws(() => guardModule!.installFixtureDuGuard(join(f.dir, "bin"), ["/"]), /non-root directory/);
  assert.throws(() => guardModule!.installFixtureDuGuard(join(f.dir, "bin"), [join(f.owned, "payload")]), /non-root directory/);
  assert.throws(() => guardModule!.installFixtureDuGuard(join(f.dir, "bin"), [f.owned]), /EEXIST/);
  assert.equal(readFileSync(f.guard.path, "utf8"), original);
});

test("all heartbeat fixture runners install the native namespace boundary", () => {
  const callers = [
    "a-clone-that-can-no-longer-gc-says-so-in-the-beat",
    "fleet-heartbeat-image-sha", "fleet-heartbeat-supervisor-tick",
    "the-heartbeat-refuses-to-overlap-itself", "the-beat-reports-whether-the-fleet-builds",
    "w1-t5319-the-acr-login-refreshes-itself-and-escalates-when-it-cannot",
  ];
  for (const caller of callers) {
    const source = readFileSync(fileURLToPath(new URL(`./${caller}.test.ts`, import.meta.url)), "utf8");
    assert.ok(source.includes('"scripts"') || source.includes("scripts/fleet-heartbeat.sh"), `${caller}: positive subject control`);
    assert.match(source, /import \{ installFixtureDuGuard \} from "\.\/helpers\/fixture-du\.js";/, `${caller}: guard import`);
    assert.match(source, /installFixtureDuGuard\((?:binDir|bin), \[(?:dir|root)\]\);/, `${caller}: owned namespace installation`);
  }
  const acr = readFileSync(fileURLToPath(new URL("./w1-t5319-the-acr-login-refreshes-itself-and-escalates-when-it-cannot.test.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(acr, /"df", "du", "uname"/, "the restricted utility fixture must not replace its guard with an ambient du symlink");
});

test("heartbeat fixtures measure their real state but never scan a host-wide consumer", (t) => {
  const harness = readFileSync(fileURLToPath(new URL("./helpers/fleet-heartbeat-harness.ts", import.meta.url)), "utf8");
  assert.match(harness, /installFixtureDuGuard\(binDir, \[dir, rec\]\)/, "guard wiring must exist before executing the real script");
  const topology = mountTopology(t, "/owned-subdirectory");
  for (const platform of ["Linux", "Darwin"]) {
    const beat = runBeat({ env: topology.env, unameStub: `#!/bin/sh\nprintf '%s\\n' '${platform}'\n` });
    assert.equal(beat.status, 0, beat.stderr);
    const field = (name: string) => beat.published.split("\n").find(line => line.startsWith(name + "="))?.slice(name.length + 1);
    assert.match(field("consumer_state_kb") ?? "", /^[0-9]+$/);
    assert.ok(beat.duCalls.some(call => call.allowed && call.status === 0));
    if (platform === "Linux") {
      assert.equal(field("consumer_rmd_kb"), "unknown");
      assert.ok(beat.duCalls.some(call => call.requested === "/mnt/rmd" && !call.allowed));
    } else {
      assert.equal(field("consumer_rmd_kb"), undefined);
      assert.equal(beat.duCalls.some(call => call.requested === "/mnt/rmd"), false);
    }
  }
  assert.ok(topology.calls().includes("-n -o FSROOT -M /mnt/rmd"), "the real mount query must reach the controlled subdirectory topology");
});

test("whole-mount heartbeat fixtures use statfs and retain the guarded fallback when df fails", (t) => {
  const df = spawnSync("sh", ["-c", "command -p -v df"], { encoding: "utf8", timeout: 10_000 });
  assert.equal(df.status, 0, df.stderr); assert.match(df.stdout.trim(), /^\//);
  for (const readable of [true, false]) {
    const topology = mountTopology(t, "/");
    const beat = runBeat({
      env: topology.env,
      unameStub: "#!/bin/sh\nprintf 'Linux\\n'\n",
      dfStub: ["#!/bin/sh", 'if [ "$2" = "/mnt/rmd" ]; then', readable
        ? "  printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/fixture 900000 424242 475758 48%% /mnt/rmd\\n'"
        : "  exit 1", "else", `  exec '${df.stdout.trim().replace(/'/g, "'\\''")}' "$@"`, "fi", ""].join("\n"),
    });
    assert.equal(beat.status, 0, beat.stderr);
    const field = (name: string) => beat.published.split("\n").find(line => line.startsWith(name + "="))?.slice(name.length + 1);
    assert.equal(field("consumer_rmd_kb"), readable ? "424242" : "unknown");
    assert.ok(beat.duCalls.some(call => call.allowed && call.status === 0), "owned leaf sizes still come from native du");
    const rootWalks = beat.duCalls.filter(call => call.requested === "/mnt/rmd");
    if (readable) assert.equal(rootWalks.length, 0, "a whole mount must not be walked");
    else assert.ok(rootWalks.length > 0 && rootWalks.every(call => !call.allowed), "failed statfs cannot open a host-wide walk");
    assert.ok(topology.calls().includes("-n -o FSROOT -M /mnt/rmd"), "positive mount-query control");
  }
});
