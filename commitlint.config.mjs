// Conventional Commits gate (W1-T31, MASTER-PLAN §6A). Enforced in CI by the `commitlint` job
// (.github/workflows/ci.yml), which lints the PR TITLE — the squash-merge subject — against this
// config (it reads the title live via `gh pr view`, so a retitle is picked up by a re-run; W1-T351).
// Individual commits on the branch are not linted. A malformed title (not `type(scope): subject`,
// or a bad type) fails that job — see test/commitlint-config.test.ts for the falsifier proof.
//
// A Dependabot-authored PR is exempt from header-max-length ONLY. Dependabot writes its own title
// and has no setting to shorten it: a one-update group names the dependency in full, so #11968's
// title was 162 characters and stayed red until a hand retitle. pr-title-lint.yml sets
// PR_TITLE_AUTHOR from the event's pull_request.user.login, which a title cannot spoof; every other
// rule, and every other author, keeps the full config.
const dependabotTitle = process.env.PR_TITLE_AUTHOR === "dependabot[bot]";

export default {
  extends: ['@commitlint/config-conventional'],
  ...(dependabotTitle ? { rules: { 'header-max-length': [0] } } : {}),
};
