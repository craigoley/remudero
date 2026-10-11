// Conventional Commits gate (W1-T31, MASTER-PLAN §6A). Enforced in CI by the `commitlint` job
// (.github/workflows/pr-title-lint.yml), which lints the PR TITLE — the squash subject — against this
// config (it reads the title live via `gh pr view`, so a retitle is picked up by a re-run; W1-T351).
// Individual commits on the branch are not linted. A malformed title (not `type(scope): subject`,
// or a bad type) fails that job — see test/commitlint-config.test.ts for the falsifier proof.
//
// W1-T6013: a `wip` marker in the title is refused too. The squash subject becomes main's permanent
// history, so a checkpoint label must not land there. `wip:` checkpoint COMMITS on a branch are
// unaffected (branch commits are never linted). Whole-word match only: `wipe`, `wip_limit` pass.
const WIP_WORD = /(^|[^a-z0-9_])wip($|[^a-z0-9_])/i;

export default {
  extends: ['@commitlint/config-conventional'],
  plugins: [
    {
      rules: {
        'no-wip-title': (parsed) => {
          const { type, scope, subject } = parsed;
          const isWip =
            (type ?? '').toLowerCase() === 'wip' ||
            (scope ?? '')
              .split(/[,/\\]/)
              .some((s) => s.trim().toLowerCase() === 'wip') ||
            WIP_WORD.test(subject ?? '');
          return [
            !isWip,
            'no-wip-title: the title carries a wip marker (type, scope or subject); retitle the PR for what it completes',
          ];
        },
      },
    },
  ],
  rules: {
    'no-wip-title': [2, 'always'],
  },
};
