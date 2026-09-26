import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStatusStream } from "../../src/lib/board.js";
import { buildServeRoutes } from "../../src/lib/serve.js";

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
 * A `path: "/..."` literal is found ANYWHERE on its line (W1-T4584: `/v1/operator-agent/ask`
 * declares `{ method: "POST", path: ... }` on one line and a line-start scan missed it). Its method
 * is a `method:` earlier on the same line, else the nearest `method:` line above it within the same
 * route object literal; an SSE route declares no method and is probed as GET, which it accepts.
 *
 * W1-T4584: for the real src/lib the source scan is UNIONED with the assembled route table. Eight
 * served routes are built through a variable or a loop and carry no `path:` literal at all
 * (the consequences routes, /v1/confirm, /v1/hooks/github, /v1/incidents/events, GET /), so a
 * source scan alone cannot see them; the table alone could not see a declared-but-unmounted route.
 */
export function declaredConsoleRoutes(libDir: string = LIB_DIR): DeclaredRoute[] {
  const modules = readdirSync(libDir)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => /export function build\w*Routes?\s*\(/.test(readFileSync(join(libDir, name), "utf8")));

  const seen = new Set<string>();
  const declared: DeclaredRoute[] = [];
  const add = (method: string, path: string, where: string): void => {
    const key = `${method} ${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    declared.push({ method, path, where });
  };
  for (const name of modules) {
    const lines = readFileSync(join(libDir, name), "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const pathMatch of line.matchAll(/\bpath:\s*"(\/[^"]*)"/g)) {
        let method = /\bmethod:\s*"([A-Z]+)"/.exec(line.slice(0, pathMatch.index))?.[1];
        for (let back = index - 1; method === undefined && back >= Math.max(0, index - 4); back--) {
          method = /^\s*method:\s*"([A-Z]+)"/.exec(lines[back])?.[1];
        }
        add(method ?? "GET", pathMatch[1], `src/lib/${name}:${index + 1}`);
      }
    });
  }
  if (libDir === LIB_DIR) {
    for (const route of assembledRoutes()) add(route.method, route.path, "the assembled route table (buildServeRoutes)");
  }
  return declared;
}

/** The routes `buildServeRoutes` actually assembles, plus the status SSE route, over a minimal
 *  throwaway state — the SAME table W1-T4579's contract census reads. */
export function assembledRoutes(): Array<{ method: string; path: string }> {
  const root = mkdtempSync(join(tmpdir(), "rmd-declared-routes-"));
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    mkdirSync(join(root, "plan"), { recursive: true });
    writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
    const ledgerPath = join(root, "state", "ledger.ndjson");
    writeFileSync(ledgerPath, "");
    const github = {} as never;
    const board = { plan: { version: 1, tasks: [] }, ledgerPath, github } as never;
    const deps = {
      board,
      panelGraph: { root, planPath: join(root, "plan", "tasks.yaml"), ledgerPath, github, statusGithub: github, ratify: {} },
      ledgerPath,
      issues: {},
      fleetControlRoot: root,
      questionsRoot: root,
      tokens: { read: "read-token", write: "write-token" },
      pollMs: 60_000,
      githubAppRefresh: { start: () => ({ armed: false }) },
      daemonHealth: { exec: () => "{}" },
    } as never;
    return [
      ...buildServeRoutes(deps).map((route) => ({ method: route.method, path: route.path })),
      { method: "GET", path: buildStatusStream(board).path },
    ];
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
