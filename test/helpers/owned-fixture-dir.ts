import { lstatSync, rmSync } from "node:fs";
import type { TestContext } from "node:test";
import { makeTempDir } from "../../src/lib/tmp.js";
import { retainFixture } from "../setup/retained-fixtures.js";

export type FixtureScope = Pick<TestContext, "after">;

/** Fresh test-owned scratch only. Shared/suite fixtures pass their enclosing scope. Callers
 * register child/writer closure with until(); a rejected closure keeps the path and fails teardown.
 * This is normal fixture disposal, not an age-based janitor or a way to retire fleet worktrees. */
export function ownedFixtureDir(scope: FixtureScope, kind: string) {
  const dir = makeTempDir(kind);
  const pin = lstatSync(dir);
  const closures: Array<Promise<{ ok: true } | { ok: false; error: unknown }>> = [];
  let retained: string | undefined;
  scope.after(async () => {
    try {
      const outcomes = await Promise.all(closures);
      const failed = outcomes.find((outcome) => !outcome.ok);
      if (failed && !failed.ok) throw failed.error;
      if (retained !== undefined) return;
      let current;
      try { current = lstatSync(dir); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== pin.dev ||
          current.ino !== pin.ino || current.uid !== pin.uid) throw new Error(`fixture identity changed; retained ${dir}`);
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      retainFixture(dir, "fixture disposal failed or writer closure is unproven");
      throw error;
    }
  });
  return {
    dir,
    until(closed: PromiseLike<unknown>): void {
      closures.push(Promise.resolve(closed).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error })));
    },
    retain(reason: string): void {
      if (!reason.trim()) throw new Error("retained fixture requires a reason");
      retained = reason;
      retainFixture(dir, reason);
    },
  };
}
