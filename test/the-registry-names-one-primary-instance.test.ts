// @source-text-subject: the shell readers REFUSE any registry field they do not list, so their known-field list IS the contract this suite pins for `primary`.
/**
 * W1-T4527 — THE INSTANCE REGISTRY NAMES ONE PRIMARY. Exactly one live instance carries
 * `primary: true`; zero or two is a named refusal; a deployment resolves whether it is the primary
 * through its state root; and the tracked registry names core.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  InstanceRegistryError,
  parseInstanceRegistry,
  requirePrimaryInstance,
} from "../src/lib/instance-registry.js";
import { daemonInstanceRows, isPrimaryDeployment } from "../src/lib/deployer.js";

function row(name: string, extra: string[] = [], stateDir = `/state/${name}`): string {
  return [
    `  ${name}:`,
    `    repo: ${name}`,
    `    github_repo: acme/${name}`,
    `    state_dir: ${stateDir}`,
    ...extra.map((l) => `    ${l}`),
    "",
  ].join("\n");
}
const registry = (...rows: string[]): string => `instances:\n${rows.join("")}`;

function refusalCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof InstanceRegistryError, `expected an InstanceRegistryError, got ${String(err)}`);
    return err.code;
  }
  return undefined;
}

test("W1-T4527: exactly one live instance is primary", () => {
  const one = parseInstanceRegistry(registry(row("a", ["primary: true"]), row("b"), row("c", ["primary: false"])));
  assert.equal(requirePrimaryInstance(one).name, "a");

  // Zero is a named refusal, not a silent pick — including when every row says false.
  assert.equal(refusalCode(() => requirePrimaryInstance(parseInstanceRegistry(registry(row("a"), row("b"))))), "no_primary");
  assert.equal(
    refusalCode(() => requirePrimaryInstance(parseInstanceRegistry(registry(row("a", ["primary: false"]))))),
    "no_primary",
  );
  // Two is refused at parse time.
  assert.equal(
    refusalCode(() => parseInstanceRegistry(registry(row("a", ["primary: true"]), row("b", ["primary: true"])))),
    "duplicate_primary",
  );
  // A value that is not true|false is refused by name.
  assert.equal(refusalCode(() => parseInstanceRegistry(registry(row("a", ["primary: yes"])))), "invalid_primary");

  // A retired row's `primary` is ignored: it neither counts as a second primary nor as the primary.
  const withRetired = parseInstanceRegistry(
    registry(row("a", ["primary: true"]), row("old", ["primary: true", "retired: true"], "/state/old")),
  );
  assert.equal(requirePrimaryInstance(withRetired).name, "a");
  assert.equal(
    refusalCode(() => requirePrimaryInstance(parseInstanceRegistry(registry(row("old", ["primary: true", "retired: true"]))))),
    "no_primary",
  );

  // A registry that has not grown the field still parses exactly as it always has.
  assert.equal(parseInstanceRegistry(registry(row("a"))).instances[0].primary, undefined);
});

test("W1-T4527: a deployment knows whether it is the primary", () => {
  const text = registry(
    row("a", ["primary: true"], "/state/a"),
    row("b", [], "/state/b"),
    row("old", ["primary: true", "retired: true"], "/state/old"),
  );
  assert.equal(daemonInstanceRows(text).get("a")?.primary, true);
  assert.equal(isPrimaryDeployment(text, "/state/a"), true);
  assert.equal(isPrimaryDeployment(text, "/state/a/"), true, "a trailing separator is not identity");
  assert.equal(isPrimaryDeployment(text, "/state/b"), false);
  assert.equal(isPrimaryDeployment(text, "/state/old"), false, "a retired row's primary is ignored");
  // No match, an ambiguous match and an unreadable registry all answer undefined: behave as today.
  assert.equal(isPrimaryDeployment(text, "/state/elsewhere"), undefined);
  assert.equal(isPrimaryDeployment(registry(row("a", ["primary: true"], "/s"), row("b", [], "/s")), "/s"), undefined);
  assert.equal(isPrimaryDeployment("", "/state/a"), undefined);
  // Field order does not matter: `primary` before `state_dir` still resolves.
  assert.equal(isPrimaryDeployment("instances:\n  a:\n    primary: true\n    state_dir: /x\n", "/x"), true);
});

test("W1-T4527: the tracked registry names core as the primary, and both shell readers know the field", () => {
  const tracked = readFileSync(new URL("../.remudero/daemon-instances.yaml", import.meta.url), "utf8");
  assert.equal(requirePrimaryInstance(parseInstanceRegistry(tracked)).name, "core");
  for (const script of ["install-host-units.sh", "recycle-container.sh"]) {
    const src = readFileSync(new URL(`../deploy/${script}`, import.meta.url), "utf8");
    assert.match(src, /^\s*primary\) : ;;$/m, `${script} must list primary as a known field`);
  }
});
