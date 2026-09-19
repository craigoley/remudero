# Remudero AIUC-1 internal gap assessment

**INTERNAL BENCHMARK — NOT A CERTIFICATION CLAIM**

This document is a dated engineering assessment of Remudero against the AIUC-1 control
themes. It is not an assertion that Remudero is certified or compliant. AIUC-1 is updated
quarterly, so this snapshot must be re-checked when the standard changes. The assessment uses
the [AIUC-1 standard overview](https://standard.aiuc-1.com/learn/about), the
[AIUC-1 changelog](https://www.aiuc-1.com/changelog), and the AIUC-1
[coding-agent research](https://www.aiuc-1.com/research/setting-the-standard-for-agentic-development)
available on 2026-09-19.

## Scope and decision rules

**OBSERVED — product scope.** The current operating model is one operator, one live account per
host, and autonomous repository work. The account-selection record says the current mode is a
serial switch rather than concurrent multi-account operation (`docs/account-selection.md:12-15,
40-59`). Multi-user, multi-tenant, customer isolation, and external certification are therefore
foundation/backlog concerns, not reasons to slow the current single-operator flow.

**USER-DECIDED — automation policy.** Normal work should continue without a human approval step.
An LLM judge may decide that a decision is needed; only then should the system escalate. A judge
must not turn ordinary uncertainty into a blanket stop. The existing corpus deliberately includes
healthy, repairable, debt-filing, and stop cases for that reason (`test/fixtures/risk-judge-dispositions/README.md:3-22`).

**OBSERVED — current evidence boundary.** A source-level control, test, task, or plan record is
not proof that a production path uses it. This assessment marks a control `BUILT` only when the
source, its tests, and its reachable caller support that conclusion. `PARTIAL` means a material
piece exists but the end-to-end claim is not proven. `GAP` means the needed behavior is not yet
implemented. `BACKLOG` means deliberately deferred by scope or product timing.

## Control map

| AIUC-1 theme | Current assessment | Evidence and remaining work |
|---|---|---|
| **A003 — limit agent data access** | **PARTIAL** | Worker homes are scratch directories with empty shell rc files and an explicit grant list (`src/lib/worker-home.ts:31-49, 99-120`). Isolation treats inherited shell state as unproven unless the probe proves zero aliases and functions (`src/lib/isolation.ts:130-160`). The remaining gap is an end-to-end inventory of every credential/config grant and the minimum data each production worker needs. |
| **A005 — prevent cross-customer exposure** | **BACKLOG / DEFERRED** | The current product scope is single-operator and serial-account, not multi-tenant. The foundation exists in per-account credential-store work, but customer/tenant isolation is not a current runtime promise. Revisit before allowing another person or tenant to share a host, ledger, console, or worker pool. |
| **A006 — prevent PII leakage** | **PARTIAL, immediate hardening** | The risk-judge boundary now clones and scrubs input, scrubs verdict reasons, and keeps ordinary PII redaction compatible with autonomous proceed (`src/lib/risk-judge.ts:249-293, 387-414, 676-699, 771-812`). Existing tests cover email, phone, home path, owner path, URL credentials, prompt context, and ledger output (`test/risk-judge-scrubbing.test.ts:29-104`). The remaining gap is corpus-wide and runtime-output coverage across non-judge logs, issue bodies, console payloads, and exported artifacts. |
| **A008 — prevent credentials/secrets leakage** | **PARTIAL, immediate hardening** | Credential-shaped material is scrubbed before the judge sees it; a confirmed credential finding deterministically forces `STOP` (`src/lib/risk-judge.ts:275-293, 408-414`). The worker credential grant is narrowed where possible to `.claude-fleet`, while GitHub auth remains an explicit grant (`src/lib/worker-home.ts:75-120`). The remaining gap is a positive-control audit proving that credentials do not reach argv, prompts, ledger rows, escalation details, PR bodies, or reports in every relevant path. |
| **B006.3 — execution-level safeguards** | **PARTIAL** | Isolation fails closed on inherited shell state and unproven probes (`src/lib/isolation.ts:130-160`), and the authority inventory names outward writes and their gates (`src/lib/authority.ts:126-162`). The remaining gap is an agent-executed-code evaluation that proves the safeguards hold for generated scripts, dependency commands, and repair callbacks without weakening normal flow. |
| **B010 — secure patterns in generated code** | **GAP / next research** | AIUC-1 added coding-agent secure-pattern controls in Q3 2026. Remudero has repository gates and review machinery, but this assessment found no bounded evaluation corpus that asks whether generated changes preserve secure defaults. Build this after the privacy-safe judge evaluation seam exists; do not add a blanket approval gate. |
| **C007 — judge only decisions that need intervention** | **PARTIAL, judgment required before production expansion** | Candidate changes already run through the risk judge; the production caller explicitly keeps deterministic gates authoritative if the judge is unavailable (`src/run-task.ts:15089-15162`). The gate-posture library can map a deterministic finding to `LAND`, `REPAIR`, `LAND+DEBT`, or `STOP`, and downgrades `STOP` for recoverable findings (`src/lib/gate-posture.ts:158-205`). However, source census only discovers gate surfaces (`src/lib/gate-posture.ts:291-382`); no production caller routes those surfaces through `decideGatePosture`. Choosing the first gate and its side-effect policy is a product/risk judgment, not an implementation detail. |
| **C009 — pause, override, or redirect** | **PARTIAL** | Escalation is durable and machine-classified; its residual judge may demote but never drop an item (`src/lib/escalate.ts:499-515`). The current risk-judge action is proceed or escalate, and gate posture has explicit repair/debt/stop outcomes. The remaining gap is proving that any new production gate integration has an idempotent redirect/repair path and a durable ledger record, with no routine operator approval inserted into the happy path. |
| **D001 — reduce hallucinated outputs** | **PARTIAL** | The risk judge receives a bounded change view and deterministic gate state, not a diff (`src/lib/risk-judge.ts:304-344, 416-435`), and the disposition corpus tests the controller path without LLM calls or spend (`test/risk-judge-disposition-goldens.test.ts:28-85`). The remaining gap is a privacy-safe replay/shadow evaluator over observed outcomes, including calibration and false-stop/false-proceed measurements. |
| **D003 — restrict unsafe tool calls** | **PARTIAL** | Outward GitHub/git writes are enumerated with gate kinds and ledger steps (`src/lib/authority.ts:126-162`), and current risk-judge escalation can withdraw an auto-merge attempt (`src/run-task.ts:15118-15162`). The remaining gap is an end-to-end map from each high-impact tool call to its deterministic precondition, judge decision, fallback, and postcondition. |
| **E001 — failure plan** | **PARTIAL, next planning item** | Judge unavailability is explicitly distinguished from an adverse LLM judgment, and the production caller preserves deterministic gate behavior (`src/lib/risk-judge.ts:669-699; src/run-task.ts:15159-15162`). The missing artifact is a single failure matrix for privacy breach, credential finding, judge outage, malformed verdict, repair failure, and ledger failure. |
| **E004 — ownership and accountability** | **PARTIAL / strong foundation** | Ledger rows carry an actor derived at write time (`src/lib/ledger.ts:85-132`), risk-judge decisions record verdict, reasons, confidence, consequence, action, and spend (`src/lib/risk-judge.ts:791-812`), and the authority table records outward effects. The remaining gap is a durable evidence bundle that joins input hash, scrub findings, judge result, side effect, and final repository outcome without retaining sensitive source text. |
| **Society / external impact** | **BACKLOG / scope-triggered** | No current evidence justifies adding social-use controls to the single-operator repository workflow. Reassess before customer-facing, public, high-impact, or multi-tenant use; do not invent a human review lane now. |

## What is already shipped

**OBSERVED.** These are not follow-up tasks to file again:

- The risk-judge disposition controller and its golden corpus are in main. The corpus covers
  candidate risk, healthy control, repair, debt, recoverable stop, unrecoverable stop, judge
  unavailability, and unparseable consequence cases (`test/fixtures/risk-judge-dispositions/README.md:3-22`).
- Judge outage compatibility behavior is shipped: the production candidate path retains
  deterministic gates when the LLM judge is unavailable (`src/run-task.ts:15159-15162`).
- Privacy and credential scrubbing is shipped at the judge boundary, with focused tests and a
  deterministic credential hard stop (`src/lib/risk-judge.ts:249-293; test/risk-judge-scrubbing.test.ts:29-104`).
- Worker-home narrowing, shell-isolation probes, outward-write authority inventory, and actor-
  stamped ledger evidence already provide useful control foundations.

## Priority and work plan

### Act now — preserve flow while closing evidence gaps

1. **Privacy-safe evaluation corpus and replay report.** Extend the existing disposition corpus
   into a bounded, offline replay/shadow evaluator. It must run without an LLM, network, or
   production side effect; accept only scrubbed/versioned inputs; emit one result per fixture; and
   measure false stops, false proceeds, fallback use, side-effect selection, and corpus coverage.
   This improves self-correction without inserting a human into normal execution.
2. **Runtime leak audit.** Add positive controls for credentials and PII at the judge prompt,
   ledger, escalation, PR metadata, console response, and export boundaries. A zero result is
   evidence only when the positive control proves the query could see its corpus. Preserve useful
   file paths and line counts; redact values, not the evidence shape.
3. **Failure matrix and evidence join.** Define the machine-readable outcomes for scrub finding,
   judge outage, malformed verdict, repair failure, debt-file failure, and ledger failure. Keep
   the existing compatibility behavior until a specific production gate is authorized.

### Judgment required before implementation

**JUDGMENT REQUIRED.** The gate-posture adapter is the only item where your policy choice changes
production behavior. Before wiring it, choose the first bounded gate and its consequence policy.
My recommendation is a non-security, recoverable finding with a deterministic local repair or
`LAND+DEBT`; do not begin with credential, destructive-migration, CI-red, or merge-authority
gates. The decision must preserve these invariants:

- healthy paths do not call the judge;
- a judge outage restores the gate's existing behavior;
- recoverable findings cannot become `STOP` solely because the model is conservative;
- unrecoverable security findings cannot land autonomously;
- repair and debt filing are idempotent and ledgered;
- no human approval is added unless the judge explicitly escalates.

### Backlog — important, but not current blockers

- Multi-user and multi-tenant identity, tenant-scoped credentials, ledger partitioning, console
  authorization, and cross-customer isolation. Start before the first non-operator user, not now.
- Third-party reliability and tool-call testing on a quarterly cadence, aligned with AIUC-1's
  current reliability guidance.
- Secure-pattern evaluation for generated code and dependency/supply-chain behavior.
- External AIUC-1 certification or an auditor evidence package. The current goal is internal gap
  knowledge, not certification.
- Revisit broader social/external-impact controls when Remudero is used beyond private repository
  automation.

## Decision ledger

| Item | Decision | Why |
|---|---|---|
| Human approval on ordinary work | **No** | It conflicts with the product principle of autonomous flow and is not required by the current scope. Escalation remains judge-triggered. |
| Agent changes reaching production | **Allowed in principle** | The control objective is bounded, observable automation, not a blanket human gate. Existing deterministic gates and authority records remain in force. |
| Scrubbing | **Do now, conservatively** | Privacy and credentials are high-consequence; redact values while preserving structure and useful diagnostics. |
| Gate-posture production integration | **Do not choose silently** | The first gate and its side effects determine whether the system can land, repair, file debt, or stop. This is the one current decision that needs your judgment. |
| Multi-user / multi-tenant | **Backlog** | The current one-operator scope is explicit; build the isolation foundation before expanding the audience. |
| Certification | **Out of scope** | Use AIUC-1 as an internal benchmark and evidence map only. |
