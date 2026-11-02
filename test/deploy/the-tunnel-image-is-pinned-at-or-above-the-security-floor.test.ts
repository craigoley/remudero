/**
 * W1-T10844 -- the console tunnel runs a pinned cloudflared image. Cloudflare's eMudhra notice
 * (2026-10-26) requires 2026.10.2 or later; the host ran 2026.8.3 from `cloudflare/cloudflared:latest`.
 * deploy/cloudflared/Dockerfile holds the one digest-qualified ref (never built: Dependabot bumps
 * it), deploy/edge-heal.sh creates an absent tunnel from it, and a missing or malformed pin refuses
 * with a named reason and creates or replaces nothing.
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
const FLOOR = [2026, 10, 2];

/** Writes a pin file into the scene and points edge-heal at it. */
function pinFile(s: Scene, body: string): void {
  const path = join(s.root, "Dockerfile");
  writeFileSync(path, body);
  s.env.RMD_CLOUDFLARED_PIN_FILE = path;
}

const DIGEST = "a".repeat(64);
const assertNothingRun = (s: Scene) => assert.doesNotMatch(read(s.dockerLog), /^(run|rm|pull|network create) /m, read(s.dockerLog));

test("deploy/cloudflared/Dockerfile pins one digest-qualified cloudflared release at or above 2026.10.2", () => {
  const body = readFileSync(join(REPO_ROOT, "deploy", "cloudflared", "Dockerfile"), "utf8");
  const froms = body.split("\n").filter((l) => /^\s*FROM\s/i.test(l));
  assert.equal(froms.length, 1, "exactly one FROM line");
  const m = /^FROM cloudflare\/cloudflared:(\d{4})\.(\d{1,2})\.(\d+)@sha256:[0-9a-f]{64}$/.exec(froms[0]!.trim());
  assert.ok(m, `not a digest-qualified cloudflared release: ${froms[0]}`);
  const version = m.slice(1, 4).map(Number);
  const cmp = version.map((v, i) => v - FLOOR[i]!).find((d) => d !== 0) ?? 0;
  assert.ok(cmp >= 0, `${version.join(".")} is below the ${FLOOR.join(".")} eMudhra floor`);
  assert.ok(!readFileSync(HEAL, "utf8").includes("cloudflared:latest"), "`:latest` is no longer a default");
});

test("edge heal creates an absent tunnel from the pinned ref", (t) => {
  const s = scene(t, {});
  const r = heal(s);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(PIN.length > 0, "the pin parsed");
  assert.deepEqual(calls(s).filter((l) => l.startsWith("run ")), [runLine(s, "cloudflared")]);
});

test("RMD_CLOUDFLARED_IMAGE still overrides the pin", (t) => {
  const s = scene(t, {}, { RMD_CLOUDFLARED_IMAGE: "example.invalid/cloudflared:override" });
  assert.equal(heal(s).status, 0);
  assert.match(calls(s).find((l) => l.startsWith("run ")) ?? "", / example\.invalid\/cloudflared:override tunnel /);
});

test("a missing pin file creates nothing and names why", (t) => {
  const s = scene(t, {}, { RMD_CLOUDFLARED_PIN_FILE: "/nonexistent/cloudflared/Dockerfile" });
  const r = heal(s);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /REFUSING cloudflared -- pin file \/nonexistent\/cloudflared\/Dockerfile is missing; nothing created or replaced/);
  assertNothingRun(s);
});

test("a malformed pin creates nothing: no digest, two FROM lines, or below the floor", (t) => {
  const cases: [string, RegExp][] = [
    ["FROM cloudflare/cloudflared:2026.10.4\n", /needs exactly one 'FROM cloudflare\/cloudflared:<YYYY\.M\.P>@sha256:<64 hex>' line/],
    ["FROM cloudflare/cloudflared:latest\n", /needs exactly one/],
    [`FROM cloudflare/cloudflared:2026.10.4@sha256:${DIGEST}\nFROM cloudflare/cloudflared:2026.10.5@sha256:${DIGEST}\n`, /needs exactly one/],
    [`FROM cloudflare/cloudflared:2026.8.3@sha256:${DIGEST}\n`, /pin 2026\.8\.3 is below the 2026\.10\.2 security floor/],
    [`FROM cloudflare/cloudflared:2026.10.1@sha256:${DIGEST}\n`, /pin 2026\.10\.1 is below the 2026\.10\.2 security floor/],
  ];
  for (const [body, why] of cases) {
    const s = scene(t, {});
    pinFile(s, body);
    const r = heal(s);
    assert.equal(r.status, 1, body);
    assert.match(r.stderr, why, body);
    assertNothingRun(s);
  }
});

test("a malformed pin replaces nothing: a present off-pin tunnel is left alone", (t) => {
  const s = scene(t, { cloudflared: OFF_PIN });
  pinFile(s, "FROM cloudflare/cloudflared:2026.10.4\n");
  const r = heal(s);
  assert.equal(r.status, 1, "a bad pin is a heal failure, not a failed roll");
  assertNothingRun(s);
  assert.equal(image(s, "cloudflared"), OFF_PIN);
});

test("a pin at or above the floor is accepted, whatever its month width", (t) => {
  const s = scene(t, {});
  pinFile(s, `# comment\nFROM cloudflare/cloudflared:2027.1.0@sha256:${DIGEST}\n`);
  assert.equal(heal(s).status, 0);
  assert.match(calls(s).find((l) => l.startsWith("run ")) ?? "", new RegExp(` cloudflare/cloudflared:2027\\.1\\.0@sha256:${DIGEST} tunnel `));
});
