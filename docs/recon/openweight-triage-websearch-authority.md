# Openweight triage WebSearch authority

**Date:** 2026-09-14
**Task:** W1-T3549
**Decision:** refuse the authority; do not route `synthesis.triage`.

## Question and standard of proof

`TRIAGE_WORKER_TOOLS` in `src/run-task.ts` declares `WebSearch`. The Phase Two
adapter's `openWeightTools` deliberately rejects that declaration before it reads
`RMD_OPENWEIGHT_API_KEY` or contacts Azure. That is the correct current boundary:
a model function call is not a web-search result. A successful probe therefore
needed both a provider-issued web-search output and URL-citation provenance. An
HTTP 2xx, a model-authored citation, or a request to a local function could not
meet this standard.

## Observed

Microsoft's current [Foundry model capability table](https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/concepts/models?view=azure-node-latest)
lists `gpt-oss-120b` as text-only with Chat Completions and function calling. It
does not list the Responses API. Microsoft's current [web-search documentation](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/web-search?view=foundry-classic)
places the `web_search` tool on the Responses API.

I made five bounded calls to the existing `synthwatch-foundry` eastus2
`gpt-oss-120b` deployment. The Azure key was retrieved on the fleet host into
process memory only. No key or response body was written to this repository or
to this report.

| Probe | Result | Evidence retained |
| --- | --- | --- |
| Chat Completions function-call positive control, three attempts | HTTP 200, but each response had `choices: []`; no function call was returned | 1 prompt token and 1 completion token per attempt |
| Responses API with `tools: [{ type: "web_search" }]` | HTTP 400, `ApiSamplingErrorUnprocessableInput` | no `web_search_call`, no URL citation, no usage |
| Chat Completions with `tools: [{ type: "web_search" }]` | HTTP 422 | no `web_search_call`, no URL citation, no usage |

The three billed positive-control attempts used three input and three output
tokens in total. At the documented routing price of $0.15 per million input
tokens and $0.60 per million output tokens, their observed charge is
$0.00000225. The two rejected requests returned no usage. The five-call total
is below W1-T3549's $2.00 limit.

## Conclusion

The current deployment does not supply a real bounded WebSearch authority.
The Responses request did not return a web-search result with provider
provenance, and the configured Chat Completions surface rejects the web-search
tool. The empty Chat function-control responses also do not establish a usable
function loop. This is a deployment/surface finding, not evidence that the model
itself can never use web search through a differently authorized Azure surface.

`W1-T3547 remains blocked`. Do not remove, filter, fabricate, or locally emulate
the declared `WebSearch` tool in order to route triage. No adapter bridge task is
filed because the positive condition for one did not occur. Reconsider routing
only after an Azure deployment/surface produces an actual web-search output with
provider provenance and URL-citation evidence within the configured cash guard.

## Addendum: an existing Azure Responses surface satisfies the authority condition

After this report, one bounded probe against the existing `synthwatch-aoai`
eastus2 Azure OpenAI resource's `gpt-5-mini` deployment returned the required
surface: output item types `reasoning`, `web_search_call`, `reasoning`, and
`message`, with two structured `url_citation` annotations. It used 8,569 input
and 1,117 output tokens. The key was retrieved into process memory on the fleet
host; neither the key nor response body was retained.

This does not change the gpt-oss finding: its Chat Completions deployment still
cannot supply WebSearch. It establishes that an existing Azure surface can serve
as a search authority. Pending plan task `W1-T3558` therefore owns a separate,
explicitly configured and cash-bounded bridge from a gpt-oss `WebSearch`
function call to the Azure Responses API. The gpt-oss worker remains the triage
author. The bridge must return only provider-issued URL-citation evidence and
must fail closed on absent consent, credential, endpoint, allowance, or required
provenance. Until it is implemented and proven, `W1-T3547` remains blocked and
its mount stays on Claude.

## Follow-up quality probe: route admission remains unproven

Five zero-temperature direct Chat Completions authoring probes against
`gpt-oss-120b` each returned all expected task fields and parseable YAML, but
none satisfied the required double-quoted `proof:`-value dialect check. The
authoring success rate under that full contract was therefore 0/5. Five
zero-temperature classification probes produced four expected terminal markers;
the fifth returned `AMBIGUOUS` for a settled cash-cap case. The classification
success rate was 4/5. The ten calls used 1,955 input and 5,820 output tokens.

This is a bounded synthetic quality signal, not a substitute for W1-T3547's
production measurement: it does not reproduce the complete triage worktree or
its deterministic downstream checks, and only aggregate outcomes were retained.
It nevertheless fails the required repeated-probe threshold. Completing the
WebSearch bridge cannot authorize the triage mount on its own. Before any route,
repeat the exact lane-shaped evaluation with retained non-sensitive outcome
evidence; a failure to meet its accepted-output retry bound is a stop result.

## Falsifier

This conclusion is false if a bounded request to the existing deployment returns
both a provider `web_search_call` and a URL citation. That result would establish
the missing authority, require a separate adapter-bridge task with provenance,
timeout, spend, and refusal tests, and leave W1-T3547 as the mount-only routing
task.
