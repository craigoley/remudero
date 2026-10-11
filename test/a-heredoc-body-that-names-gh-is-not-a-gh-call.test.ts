import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const hook = fileURLToPath(new URL("../hooks/deny-floor.sh", import.meta.url));

function withFloor(run: (fire: (command: string) => ReturnType<typeof spawnSync>, stamp: string) => void): void {
  const cache = mkdtempSync(join(tmpdir(), "rmd-heredoc-gh-"));
  const stamp = join(cache, "remudero", "gh-last-read");
  mkdirSync(join(cache, "remudero"));
  writeFileSync(stamp, "");
  try {
    run((command) => spawnSync("bash", [hook], {
      input: JSON.stringify({ tool_input: { command } }),
      encoding: "utf8",
      env: { ...process.env, HOME: cache, XDG_CACHE_HOME: cache,
        RMD_GH_CACHE_HOME: cache, RMD_GH_COOLDOWN_S: "180" },
    }), stamp);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

test("test/a-heredoc-body-that-names-gh-is-not-a-gh-call.test.ts", () => {
  withFloor((fire, stamp) => {
    const before = statSync(stamp).mtimeMs;
    for (const reader of ["python3 -", "cat > /tmp/source.txt"]) {
      for (const delimiter of ["EOF", "'EOF'", '"EOF"']) {
        const result = fire(`${reader} <<${delimiter}\n# over the async gh transport\nEOF`);
        assert.equal(result.status, 0, String(result.stderr));
        assert.equal(statSync(stamp).mtimeMs, before, "data must not consume the cadence window");
      }
    }
    assert.equal(fire("cat <<-EOF\n\tover the async gh transport\n\tEOF").status, 0);
    assert.equal(fire("cat <<'EOF'\ngh pr view 1\nEOF").status, 0);
    for (const command of [
      "gh pr view 1 <<'EOF'\ndata\nEOF",
      "cat <<EOF\n$" + "(gh pr view 1)\nEOF",
      "cat <<EOF\n`" + "gh pr view 1`\nEOF",
      "cat <<'EOF'\ndata\nEOF\ngh pr view 1",
    ]) {
      const result = fire(command);
      assert.equal(result.status, 2, command);
      assert.match(String(result.stderr), /read-shaped/);
    }
  });
});

test("a heredoc fed to an interpreter that runs gh is still a gh call", () => {
  withFloor((fire) => {
    for (const reader of ["bash", "sh", "zsh", "/bin/bash", "env bash", "ssh host bash -s", "ssh host"]) {
      for (const delimiter of ["EOF", "'EOF'"]) {
        const command = `${reader} <<${delimiter}\ngh pr view 1\nEOF`;
        const result = fire(command);
        assert.equal(result.status, 2, command);
        assert.match(String(result.stderr), /read-shaped/);
      }
    }
  });
});
