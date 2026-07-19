// Conventional Commits gate (W1-T31, MASTER-PLAN §6A). Enforced in CI by the `commitlint` job
// (.github/workflows/ci.yml), which lints every commit on a PR against this config via
// `commitlint --from <base-sha> --to HEAD`. A malformed commit message (not `type(scope): subject`,
// or a bad type) fails that job — see test/commitlint-config.test.ts for the falsifier proof.
export default {
  extends: ['@commitlint/config-conventional'],
};
