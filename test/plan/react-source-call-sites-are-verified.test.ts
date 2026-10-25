import assert from "node:assert/strict";
import { test } from "node:test";
import { callSiteViolations } from "#src/lib/task-linter.js";

type Task = Parameters<typeof callSiteViolations>[0];
function task(files: string[], proofs: string[]): Task {
  return { id: "W1-T10649", title: "Connect the implemented mechanism to the game", repo: "remudero",
    depends_on: [], type: "implement", verify: "auto", files,
    acceptance: proofs.map((proof) => ({ claim: "the runtime consumes the mechanism", proof })) } as unknown as Task;
}
const held = (...files: string[]) => (path: string) => files.includes(path);

test("real React source callers satisfy the production call-site guard", () => {
  for (const caller of ["src/App.tsx", "src/game/VehicleScene.tsx"]) {
    const plan = task(["src/sim/world.ts"], [`grep: createWorld( in ${caller}`]);
    assert.deepEqual(callSiteViolations(plan, { moduleExists: held(caller), callSite: "block" }), [], caller);
  }
});

test("React call-site proofs still require an existing distinct production caller", () => {
  for (const caller of ["src/Missing.tsx", "test/game/App.tsx", "tests/unit/App.tsx", "src/*.tsx"]) {
    const plan = task(["src/sim/world.ts"], [`grep: createWorld( in ${caller}`]);
    const violations = callSiteViolations(plan, {
      moduleExists: caller === "src/Missing.tsx" ? held() : held(caller), callSite: "block",
    });
    assert.equal(violations.length, 1, caller);
    assert.equal(violations[0]!.severity, "block", "React support preserves severity");
  }
  const self = task(["src/game/NewScene.tsx"], ["grep: createWorld( in src/game/NewScene.tsx"]);
  assert.equal(callSiteViolations(self, { moduleExists: held(), callSite: "block" }).length, 1);
});

test("new React source modules cannot evade the call-site guard", () => {
  const plan = task(["src/game/NewScene.tsx"], ["unit test: the new scene works"]);
  const violations = callSiteViolations(plan, { moduleExists: held(), callSite: "block" });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.check, "call-site");
  assert.match(violations[0]!.message, /src\/game\/NewScene\.tsx/);
  const connected = task(["src/game/NewScene.tsx"], ["grep: bindDrivingInput( in src/App.tsx"]);
  assert.deepEqual(callSiteViolations(connected, { moduleExists: held("src/App.tsx"), callSite: "block" }), []);
});

test("React support preserves TypeScript caller and invocation controls", () => {
  const ts = task(["src/sim/world.ts"], ["grep: createWorld( in src/game/runtime.ts"]);
  assert.deepEqual(callSiteViolations(ts, { moduleExists: held("src/game/runtime.ts"), callSite: "block" }), []);
  for (const caller of ["src/App.tsx", "src/game/runtime.ts"]) {
    const invocation = task(["src/sim/world.ts"], [`grep: createWorld( in ${caller}`]);
    assert.deepEqual(callSiteViolations(invocation, { moduleExists: held(caller), callSite: "block" }), [], "the same caller must accept an actual invocation");
    const mention = task(["src/sim/world.ts"], [`grep: createWorld in ${caller}`]);
    assert.equal(callSiteViolations(mention, { moduleExists: held(caller), callSite: "block" }).length, 1);
  }
  const editing = task(["src/game/Existing.tsx"], []);
  assert.deepEqual(callSiteViolations(editing, { moduleExists: held("src/game/Existing.tsx") }), [], "an existing file without new exports keeps the existing policy");
});

test("new exports in React source require their own distinct invocation proof", () => {
  const source = "src/game/state.tsx";
  const options = { moduleExists: held(source, "src/App.tsx"), callSite: "block" as const,
    addedExports: [{ path: source, symbol: "createWorld" }] };
  assert.deepEqual(callSiteViolations(task([source], ["grep: createWorld( in src/App.tsx"]), options), []);
  assert.equal(callSiteViolations(task([source], ["grep: otherWorld( in src/App.tsx"]), options).length, 1);
  assert.equal(callSiteViolations(task([source], [`grep: createWorld( in ${source}`]), options).length, 1);
});
