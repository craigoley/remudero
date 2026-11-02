/**
 * W1-T10844 -- deploy/edge-heal.sh rolls a PRESENT cloudflared that is off its pin. `:latest` plus
 * `--no-autoupdate` kept 2026.8.3 serving seven weeks past Cloudflare's 2026.10.2 eMudhra floor,
 * because edge-heal only ever created an ABSENT tunnel. The roll is replica-first, so a registered
 * connector exists at every step: pull, `cloudflared-next` registered, main replaced and registered,
 * replica removed. A tunnel already on its pin costs one inspect and nothing else.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const HEAL = join(REPO_ROOT, "deploy", "edge-heal.sh");
const FAKE_TOKEN = "fake-tunnel-token-not-real-0000";
/** The pin edge-heal reads: the one FROM line of deploy/cloudflared/Dockerfile. */
const PIN = /^FROM (\S+)\s*$/m.exec(readFileSync(join(REPO_ROOT, "deploy", "cloudflared", "Dockerfile"), "utf8"))?.[1] ?? "";
const OFF_PIN = "cloudflare/cloudflared:latest";

/** Fake docker: a file per present container holds its image; `reg-<name>` the count of
 *  `Registered tunnel connection` lines its logs show (default 4); `pull-fails` fails a pull. */
const FAKE_DOCKER = (log: string, p: string): string => `#!/usr/bin/env bash
echo "$*" >> "${log}"
P="${p}"
case "$1 $2" in
  "container inspect")
    if [ "$3" = --format ]; then
      shift 4; rc=0
      for n in "$@"; do if [ -e "$P/$n" ]; then echo "/$n $(cat "$P/$n")"; else rc=1; fi; done
      exit "$rc"
    fi
    [ -e "$P/$3" ] ;;
  "network inspect") [ -e "$P/net-$3" ] ;;
  "network create") touch "$P/net-$3" ;;
  "run -d")
    prev=""; img=""
    for a in "$@"; do [ "$a" = tunnel ] && [ -z "$img" ] && img="$prev"; prev="$a"; done
    printf '%s' "$img" > "$P/$4" ;;
  "rm -f") rm -f "$P/$3" ;;
  "pull "*) [ ! -e "$P/pull-fails" ] ;;
  "logs "*)
    n="$(cat "$P/reg-$2" 2>/dev/null || echo 4)"
    for ((i = 0; i < n; i++)); do echo "INF Registered tunnel connection connIndex=$i protocol=quic" >&2; done ;;
  *) exit 0 ;;
esac
`;

interface Scene { root: string; present: string; dockerLog: string; tokenFile: string; stamp: string; env: NodeJS.ProcessEnv }

/** `containers` maps each present container to its image; serve and rmd-net are present. */
function scene(t: TestContext, containers: Record<string, string>, env: NodeJS.ProcessEnv = {}): Scene {
  const root = mkdtempSync(join(tmpdir(), "rmd-tunnel-pin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stub = join(root, "stubbin");
  const present = join(root, "present");
  for (const d of [stub, present]) mkdirSync(d);
  for (const [name, image] of Object.entries({ "remudero-serve": "serve", "net-rmd-net": "", ...containers })) writeFileSync(join(present, name), image);
  const dockerLog = join(root, "docker.log");
  writeFileSync(join(stub, "docker"), FAKE_DOCKER(dockerLog, present));
  chmodSync(join(stub, "docker"), 0o755);
  const tokenFile = join(root, "cloudflared-token");
  writeFileSync(tokenFile, `${FAKE_TOKEN}\n`, { mode: 0o600 });
  const stateDir = join(root, "state-root");
  return {
    root, present, dockerLog, tokenFile, stamp: join(stateDir, "state", "tunnel-roll-failed"),
    env: {
      ...process.env, PATH: `${stub}:${process.env.PATH ?? ""}`, RMD_STATE_DIR: stateDir, RMD_CLOUDFLARED_TOKEN_FILE: tokenFile,
      RMD_CLOUDFLARED_IMAGE: undefined, RMD_TUNNEL_REGISTER_TIMEOUT_S: "0", RMD_TUNNEL_REGISTER_POLL_S: "0", ...env,
    },
  };
}

const read = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");
const calls = (s: Scene): string[] => read(s.dockerLog).split("\n").filter(Boolean);
const image = (s: Scene, name: string): string | undefined => (existsSync(join(s.present, name)) ? readFileSync(join(s.present, name), "utf8") : undefined);
const heal = (s: Scene) => spawnSync("bash", [HEAL], { encoding: "utf8", env: s.env });
const runLine = (s: Scene, name: string): string =>
  `run -d --name ${name} --restart=unless-stopped --network rmd-net -v ${s.tokenFile}:/etc/cloudflared/token:ro ` +
  `${PIN} tunnel --no-autoupdate run --token-file /etc/cloudflared/token`;
const INSPECT = "container inspect --format {{.Name}} {{.Config.Image}} cloudflared cloudflared-next";

test("a present tunnel off its pin is rolled replica-first: pull, replica registered, main replaced and registered, replica removed", (t) => {
  const s = scene(t, { cloudflared: OFF_PIN });
  const r = heal(s);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls(s), [
    "container inspect remudero-serve",
    INSPECT,
    `pull ${PIN}`,
    runLine(s, "cloudflared-next"),
    "logs cloudflared-next",
    "rm -f cloudflared",
    runLine(s, "cloudflared"),
    "logs cloudflared",
    "rm -f cloudflared-next",
  ]);
  assert.equal(image(s, "cloudflared"), PIN, "the main now runs the pin");
  assert.equal(image(s, "cloudflared-next"), undefined, "the replica is gone");
  assert.match(r.stdout, new RegExp(`^edge-heal: tunnel on pin ${PIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.equal(existsSync(s.stamp), false, "a good roll leaves no failure stamp");
});

test("rolled with no gap: the main is removed only after the replica shows 4 registered connections", (t) => {
  const s = scene(t, { cloudflared: OFF_PIN });
  assert.equal(heal(s).status, 0);
  const c = calls(s);
  assert.ok(c.indexOf("logs cloudflared-next") >= 0 && c.indexOf("logs cloudflared-next") < c.indexOf("rm -f cloudflared"), c.join("\n"));
  assert.ok(c.lastIndexOf("logs cloudflared") < c.lastIndexOf("rm -f cloudflared-next"), "the replica outlives the new main's registration");
});

test("a rolled tunnel's token is only in a read-only mount: never in argv, env or output", (t) => {
  const s = scene(t, { cloudflared: OFF_PIN });
  const r = heal(s);
  assert.equal(r.status, 0, r.stderr);
  const runs = calls(s).filter((l) => l.startsWith("run "));
  assert.equal(runs.length, 2);
  for (const run of runs) assert.ok(run.includes(`-v ${s.tokenFile}:/etc/cloudflared/token:ro `) && run.endsWith("--token-file /etc/cloudflared/token"), run);
  for (const text of [read(s.dockerLog), r.stdout, r.stderr]) assert.ok(!text.includes(FAKE_TOKEN), "the token value leaked");
  assert.doesNotMatch(read(s.dockerLog), /(^| )-e /m, "no env value carries the token");
});

test("a tunnel already on its pin costs one inspect and nothing else", (t) => {
  const s = scene(t, { cloudflared: PIN });
  const r = heal(s);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls(s), ["container inspect remudero-serve", INSPECT]);
  assert.match(r.stdout, /^edge-heal: tunnel on pin /m);
});

test("a tunnel off its pin with a pull that fails touches nothing and exits 3", (t) => {
  const s = scene(t, { cloudflared: OFF_PIN, "pull-fails": "" });
  const r = heal(s);
  assert.equal(r.status, 3, r.stderr);
  assert.deepEqual(calls(s).slice(2), [`pull ${PIN}`], "nothing is run or removed after a failed pull");
  assert.equal(image(s, "cloudflared"), OFF_PIN);
  assert.match(r.stdout, /^edge-heal: tunnel roll failed -- pull .* failed; cloudflared untouched$/m);
});
