// Conventional Commits gate (W1-T31, MASTER-PLAN §6A). Enforced in CI by the `commitlint` job
// (.github/workflows/ci.yml), which lints the PR TITLE — the squash-merge subject — against this
// config (it reads the title live via `gh pr view`, so a retitle is picked up by a re-run; W1-T351).
// Individual commits on the branch are not linted. A malformed title (not `type(scope): subject`,
// or a bad type) fails that job — see test/commitlint-config.test.ts for the falsifier proof.
export default {
  extends: ['@commitlint/config-conventional'],
};
