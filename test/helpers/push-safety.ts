/**
 * THE TOKENS THAT ARE ACTUALLY EMPTY ON A PUSH — the shared rule behind
 * test/push-ci-on-main.test.ts and test/fast-lane-classifier.test.ts, which both police the `ci`
 * job's step bodies because that job runs on BOTH a pull request and a push to main.
 *
 * `pull_request` USED TO BE ON THIS LIST AND SHOULD NOT HAVE BEEN. It is a VALUE, not a context:
 * comparing `$GITHUB_EVENT_NAME` against it is push-safe by construction, because that variable is
 * set on every trigger. Forbidding the bare token made the correct expression unwritable, and the
 * cost was measured — three separate attempts contorted around it in one day (`!= "push"`,
 * `-n "${GITHUB_BASE_REF}"`, and finally `"pull_""request"`, two adjacent string literals that
 * concatenate to the same value while the source text no longer contains it). The last one passed
 * both suites 48/48 while the guard was, in substance, exactly what they refuse.
 *
 * A rule people have to write around is a rule that will be written around, so the rule was
 * narrowed to what it actually protects. `github.event` still covers every
 * `${{ github.event.pull_request.* }}` expression — the genuinely request-scoped form — and
 * `BASE_SHA` covers the diff-base variable that only a pull_request event populates.
 */
export const PUSH_UNSAFE_TOKENS = ["github.event", "BASE_SHA"] as const;
