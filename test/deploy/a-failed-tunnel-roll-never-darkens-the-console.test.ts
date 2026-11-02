/**
 * W1-T10844 -- a failed tunnel roll never darkens console.remudero.com. The tunnel is the console's
 * only ingress, so every failure arm of deploy/edge-heal.sh's replica-first roll keeps one connector
 * serving: a replica that never registers is removed with the main untouched, a new main that fails
 * leaves the replica serving, a later tick removes a leftover replica only beside a registered pinned
 * main, and a failed roll stamps a one-hour backoff so a broken pin cannot churn replicas every tick.
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

test("a replica that never registers is removed and the main is left untouched", (t) => {
  const s = scene(t, { cloudflared: OFF_PIN, "reg-cloudflared-next": "0" });
  const r = heal(s);
  assert.equal(r.status, 3, r.stderr);
  assert.deepEqual(calls(s).slice(2), [`pull ${PIN}`, runLine(s, "cloudflared-next"), "logs cloudflared-next", "rm -f cloudflared-next"]);
  assert.ok(!calls(s).includes("rm -f cloudflared"), "the main was removed while no registered connector existed");
  assert.equal(image(s, "cloudflared"), OFF_PIN, "the main still serves on its old image");
  assert.equal(image(s, "cloudflared-next"), undefined);
  assert.match(r.stdout, /^edge-heal: tunnel roll failed -- replica cloudflared-next never registered within 0s; removed it, cloudflared untouched$/m);
  assert.ok(existsSync(s.stamp), "the failure is stamped for the backoff");
});

test("a new main that fails to register leaves the replica serving", (t) => {
  const s = scene(t, { cloudflared: OFF_PIN, "reg-cloudflared": "0" });
  const r = heal(s);
  assert.equal(r.status, 3, r.stderr);
  assert.equal(calls(s).at(-1), "logs cloudflared", "nothing is removed after the new main fails");
  assert.equal(image(s, "cloudflared-next"), PIN, "the registered replica is left serving");
  assert.match(r.stdout, /^edge-heal: tunnel roll failed -- the new cloudflared never registered within 0s; cloudflared-next left serving$/m);
});

test("a leftover replica beside a registered pinned main is removed by a later tick", (t) => {
  const s = scene(t, { cloudflared: PIN, "cloudflared-next": PIN });
  const r = heal(s);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls(s).slice(1), [INSPECT, "logs cloudflared", "rm -f cloudflared-next"]);
  assert.equal(image(s, "cloudflared-next"), undefined);
  assert.match(r.stdout, /^edge-heal: tunnel on pin /m);
});

test("a leftover replica beside a pinned main that is NOT registered keeps serving", (t) => {
  const s = scene(t, { cloudflared: PIN, "cloudflared-next": PIN, "reg-cloudflared": "2" });
  const r = heal(s);
  assert.equal(r.status, 3, r.stderr);
  assert.ok(!calls(s).includes("rm -f cloudflared-next"), "the only registered connector was removed");
  assert.equal(image(s, "cloudflared-next"), PIN);
});

test("a failed roll is not retried within the hour, and is retried once the hour has passed", (t) => {
  const s = scene(t, { cloudflared: OFF_PIN, "reg-cloudflared-next": "0" });
  assert.equal(heal(s).status, 3);
  const first = calls(s).length;
  const held = heal(s);
  assert.equal(held.status, 3, "a held roll still reports the tunnel off its pin");
  assert.deepEqual(calls(s).slice(first), ["container inspect remudero-serve", INSPECT], "no pull, no replica inside the hour");
  assert.match(held.stdout, /^edge-heal: tunnel roll failed -- held: cloudflared runs cloudflare\/cloudflared:latest, not the pin/m);

  writeFileSync(s.stamp, `${Math.floor(Date.now() / 1000) - 3601}\n`);
  rmSync(join(s.present, "reg-cloudflared-next"));
  const second = calls(s).length;
  const retried = heal(s);
  assert.equal(retried.status, 0, retried.stderr);
  assert.ok(calls(s).slice(second).includes(`pull ${PIN}`), "an hour later the roll runs again");
  assert.equal(image(s, "cloudflared"), PIN);
  assert.equal(existsSync(s.stamp), false, "a good roll clears the stamp");
});
