import assert from "node:assert/strict";
import { test } from "node:test";
import { runBeat, type Beat, type BeatOpts } from "#test/helpers/fleet-heartbeat-harness.js";

function field(beat: Beat, key: string): string {
  assert.equal(beat.status, 0, beat.stderr);
  const row = beat.published.split("\n").find((line) => line.startsWith(`${key}=`));
  assert.ok(row, `published payload must contain ${key}`);
  return row.slice(key.length + 1);
}

const RUNTIME = `
case "$1" in
  ps) printf 'id-a remudero-daemon\\nid-b remudero-two-daemon\\n'; exit 0 ;;
  inspect)
    case "$*" in
      *'.Mounts'*)
        [ "$MOUNT_FAIL" = all ] && exit 1
        if [ "$2" = remudero-daemon ]; then
          printf '%s\\t%s\\n' "$STUB_INSTALL/unrelated" /tmp
          [ "$MOUNT_FAIL" = malformed ] && { printf 'not a mount\\n'; exit 0; }
          [ "$MOUNT_FAIL" = absent ] && exit 0
          printf '%s\\t%s\\n' "$STUB_INSTALL/wrong-tree" /home/node/Remudero
          printf '%s\\t%s\\n' "$STUB_INSTALL/mounted trees/a" /home/node/Remudero/remudero
          [ "$MOUNT_FAIL" = partial ] && exit 1
        else
          # An ancestor mount is also a valid source of the code tree.
          printf '%s\\t%s\\n' "$STUB_INSTALL/mounted trees/b" /home/node/Remudero
        fi
        exit 0 ;;
    esac ;;
esac
exit 1
`;

function fleet(opts: BeatOpts = {}): Beat {
  return runBeat({
    tsx: false,
    stateFiles: { "heartbeat-count.txt": "1\n" },
    dockerStub: RUNTIME,
    mountedTrees: { a: { tsx: true, entries: ["package"] }, "b/remudero": { tsx: true } },
    ...opts,
  });
}

test("W1-T12943 criterion 1: healthy mounted trees override an empty host install", () => {
  const beat = fleet();
  const install = field(beat, "install_dir");
  assert.equal(field(beat, "rmd_verdict"), "ok");
  assert.equal(field(beat, "tsx_present"), "no");
  assert.equal(field(beat, "node_modules_entries"), "0");
  assert.equal(field(beat, "rmd_remudero-daemon_tree"), `${install}/mounted trees/a`);
  assert.equal(field(beat, "rmd_remudero-two-daemon_tree"), `${install}/mounted trees/b/remudero`);
  assert.equal(field(beat, "rmd_remudero-daemon_tsx"), "yes");
  assert.equal(field(beat, "rmd_remudero-two-daemon_tsx"), "yes");
  assert.equal(field(beat, "rmd_remudero-daemon_node_modules_entries"), "2");
  assert.equal(field(beat, "rmd_remudero-two-daemon_node_modules_entries"), "1");
  const reads = beat.dockerCalls.filter((args) => args[0] === "inspect" && args.at(-1)?.includes(".Mounts") && args.length === 4);
  assert.deepEqual(reads.map((args) => args[1]), ["remudero-daemon", "remudero-two-daemon"]);
  for (const args of reads) {
    assert.equal(args[2], "--format");
    assert.equal(args[3], '{{range .Mounts}}{{printf "%s\\t%s\\n" .Source .Destination}}{{end}}');
  }
});

test("W1-T12943 criterion 2: broken mounted trees name the instance and tree", () => {
  for (const entries of [[], ["some-package"]]) {
    const beat = fleet({ tsx: true, mountedTrees: { a: { tsx: true }, "b/remudero": { entries } } });
    const tree = `${field(beat, "install_dir")}/mounted trees/b/remudero`;
    const verdict = field(beat, "rmd_verdict");
    assert.match(verdict, /^BROKEN:/);
    assert.ok(verdict.includes("remudero-two-daemon"));
    assert.ok(verdict.includes(tree));
    assert.equal(field(beat, "rmd_remudero-two-daemon_tsx"), "no");
    assert.equal(field(beat, "rmd_remudero-two-daemon_node_modules_entries"), String(entries.length));
  }
});

test("W1-T12943 criterion 3: host dependency health is published separately", () => {
  for (const tsx of [false, true]) {
    const beat = fleet({ tsx });
    assert.equal(field(beat, "host_install_dir"), field(beat, "install_dir"));
    assert.equal(field(beat, "host_install_tsx"), tsx ? "yes" : "no");
    assert.equal(field(beat, "rmd_verdict"), "ok");
    assert.doesNotMatch(beat.published, /every rmd verb/);
  }
});

test("W1-T12943 criterion 4: no-runtime verdicts are unchanged and unreadable mounts stay unknown", () => {
  for (const dockerStub of [undefined, "#!/bin/sh\nexit 0\n"]) {
    for (const tsx of [true, false]) {
      const beat = runBeat({ dockerStub, tsx, stateFiles: { "heartbeat-count.txt": "1\n" } });
      assert.equal(field(beat, "rmd_verdict"), tsx ? "ok" : "BROKEN: node_modules is empty — every rmd verb and the launchd supervisor are dead");
      assert.equal(field(beat, "tsx_present"), tsx ? "yes" : "no");
      assert.equal(field(beat, "node_modules_entries"), tsx ? "1" : "0");
    }
  }
  for (const failure of ["all", "partial", "malformed", "absent"]) {
    const beat = fleet({ tsx: true, env: { MOUNT_FAIL: failure } });
    assert.match(field(beat, "rmd_verdict"), /^unknown/);
    assert.equal(field(beat, "rmd_remudero-daemon_tree"), "unknown");
    assert.equal(field(beat, "rmd_remudero-daemon_tsx"), "unknown");
    assert.equal(field(beat, "rmd_remudero-daemon_node_modules_entries"), "unknown");
  }
});
