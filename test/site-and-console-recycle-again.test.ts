import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// W1-T6061: recycle-container.sh maps the App key and the Claude credential through each instance's
// claude_dir. W1-T4863 gave site and console their own, but only install-host-units.sh learned to
// mount the owner's .credentials.json into one, so a recycle refused (no key) and, given a key,
// would have started a container with no credential. Until the recycler carries that mount
// (W1-T6095), every live instance shares the primary's claude_dir.

interface Instance { name: string; claude_dir?: string; primary?: boolean; retired?: boolean }

function instances(text: string): Instance[] {
  const out: Instance[] = [];
  let current: Instance | undefined;
  for (const line of text.split("\n")) {
    const name = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (name) { current = { name: name[1]! }; out.push(current); continue; }
    const field = /^    (claude_dir|primary|retired):\s*(.+?)\s*$/.exec(line);
    if (!current || !field) continue;
    if (field[1] === "claude_dir") current.claude_dir = field[2]!.replace(/^"|"$/g, "");
    else if (field[1] === "primary") current.primary = field[2] === "true";
    else current.retired = field[2] === "true";
  }
  return out;
}

test("W1-T6061: no instance gets its own claude_dir before the recycler mounts the owner's credential", () => {
  const live = instances(readFileSync(".remudero/daemon-instances.yaml", "utf8")).filter((i) => !i.retired);
  assert.ok(live.length >= 3, `the registry must be read: saw ${live.map((i) => i.name).join(", ")}`);
  const primary = live.filter((i) => i.primary);
  assert.equal(primary.length, 1, "exactly one primary instance owns the credential");
  const recyclerMountsOwnerCredential = /\.credentials\.json:ro/.test(readFileSync("deploy/recycle-container.sh", "utf8"));
  const split = live.filter((i) => !i.primary && i.claude_dir !== primary[0]!.claude_dir).map((i) => `${i.name}=${i.claude_dir}`);
  if (!recyclerMountsOwnerCredential) {
    assert.deepEqual(split, [], "recycle-container.sh mounts no owner credential, so these instances would recycle with none");
  }
});
