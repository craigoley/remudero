# 0005. Apache-2.0, and the core is never relicensed

Status: Accepted
Date: 2026-07-14

## Context

`LICENSE` (Apache-2.0) was added in the repository's initial commit (PR #1,
"WS-0 spike," 2026-07-14). The same day, PR #3 ("WS-1 T1B: CI + green-merge
gate on remudero") added MASTER-PLAN §6A, which states the policy this ADR
records:

> Open core does NOT require a CLA: contributions to the core stay under
> Apache-2.0 and are never relicensed... **One-way door, accepted knowingly**:
> a DCO likely cannot support a later relicense (its grant is tied to the
> license in effect at contribution time), so the BSL/SSPL escape hatch
> Elastic/Redis/MongoDB used is CLOSED to us. That is the point — each of
> those relicensings cost enormous trust... We publish the never-relicense
> commitment as a CONTRACT (README + GOVERNANCE.md), not an internal note.

§6A ties this to a DCO-not-CLA contribution model (MASTER-PLAN's D-9, "RESOLVED:
DCO... Reversal requires a CLA from day one; retrofitting is impossible") and
to a "no crippled core" commitment: the full daemon/CLI/containment/principles
loop is free forever, and any commercial surface is *hosted convenience* only.

A later entry, DECISIONS.md's 2026-08-11 record, is explicitly labeled
**"PROPOSAL (AWAITING RATIFICATION)"** and its own text says "the operator...
has **not** ratified the recommendation below." That entry does not decide
the never-relicense question this ADR records — it re-argues, and ultimately
reaffirms, *where the commercial boundary sits* (recommending the boundary
live at an as-yet-unbuilt relay/hosting layer, never in the harness itself),
explicitly citing §6A as the constraint it is checking against, not proposing
to change. It is cited here for completeness, not as this decision's
provenance — the ratified decision is §6A, dated 2026-07-14, and the 2026-08-11
entry's own boundary-placement recommendation remains unratified as of this
ADR.

## Decision

The Remudero core (daemon, CLI, containment stack, principles engine,
retros/knowledge, campaigns, single-project control panel, MCP) is licensed
Apache-2.0 and will never be relicensed. Any commercial offering attaches as
hosted convenience at a boundary outside the core (relay/sync, portfolio
views, team seats, org-brain sync per §6A) rather than by changing or
crippling the core's license or feature set.

## Consequences

- The DCO (not CLA) contribution model this decision is bound to means a
  future relicense cannot get retroactive consent from past contributors
  short of tracking every one down — §6A calls retrofitting a CLA
  "effectively impossible," and D-9 repeats the same conclusion independently.
- Every future "should this be paywalled" question about core functionality
  is foreclosed by "no crippled core" — the answer is decided here, not
  re-litigated per feature.
- The commitment is supposed to be published externally as a contract
  (README + GOVERNANCE.md), per §6A's own words; this checkout was not asked
  to verify whether that publication has happened, and this ADR does not
  claim it has.
- The 2026-08-11 DECISIONS.md proposal shows the boundary-placement question
  is still live and unratified even though the underlying license commitment
  is not; a future ADR should record that boundary decision separately once
  ratified, rather than folding it into this one.

**How to reverse:** per §6A and D-9, this is a stated one-way door: an
Apache-2.0 release is irrevocable for everything already published (anyone
holding today's tree may fork and continue under Apache-2.0 forever,
regardless of any later relicense), and the DCO contribution model makes a
forward relicense require either universal past-contributor consent or a
CLA adopted from day one going forward — neither exists today. Reversal cost
is therefore not "revert a PR"; it is closer to "re-found the project's
contribution model" before a relicense could even be attempted.
