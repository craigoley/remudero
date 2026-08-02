import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE ONE derivation of the console's declared route set, shared by the two suites that need it.
 *
 * Extracted verbatim from test/route-registration.test.ts (PR #1105), which introduced it. It moved
 * here — rather than being copied — the moment a second suite needed it: two derivations of "what
 * routes exist" would drift, and a drifting route list is the exact defect #1105 was written to
 * catch (`buildPanelActionRoutes` declared eleven routes while serve.ts mounted ten, and nothing
 * compared the two). One copy, two consumers:
 *
 *   - test/route-registration.test.ts — every declared route is MOUNTED (404 vs 401)
 *   - test/route-wiring.test.ts       — the operator-facing write routes reach the RIGHT DEPS
 *
 * A route added to any src/lib module is in scope for both the moment it is written, with no
 * hand-maintained list to update.
 */
const LIB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "lib");

export interface DeclaredRoute {
  method: string;
  path: string;
  where: string;
}

/**
 * Every console route DECLARED in src/lib, read out of the source rather than out of any
 * registration list — so a route that no aggregator and no `serve.ts` line mentions is still
 * found. The module set is itself derived (every file exporting a `build*Route`/`build*Routes`),
 * so a brand-new route module is in scope the moment it exists.
 *
 * A `path:` literal's method is the nearest `method:` above it within the same route object
 * literal; an SSE route declares no method and is probed as GET, which is what it accepts.
 */
export function declaredConsoleRoutes(libDir: string = LIB_DIR): DeclaredRoute[] {
  const modules = readdirSync(libDir)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => /export function build\w*Routes?\s*\(/.test(readFileSync(join(libDir, name), "utf8")));

  const seen = new Set<string>();
  const declared: DeclaredRoute[] = [];
  for (const name of modules) {
    const lines = readFileSync(join(libDir, name), "utf8").split("\n");
    lines.forEach((line, index) => {
      const pathMatch = /^\s*path:\s*"([^"]+)"/.exec(line);
      if (!pathMatch) return;
      let method = "GET";
      for (let back = index - 1; back >= Math.max(0, index - 4); back--) {
        const methodMatch = /^\s*method:\s*"([A-Z]+)"/.exec(lines[back]);
        if (methodMatch) {
          method = methodMatch[1];
          break;
        }
      }
      const key = `${method} ${pathMatch[1]}`;
      if (seen.has(key)) return;
      seen.add(key);
      declared.push({ method, path: pathMatch[1], where: `src/lib/${name}:${index + 1}` });
    });
  }
  return declared;
}
