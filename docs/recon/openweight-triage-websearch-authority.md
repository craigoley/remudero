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

## Falsifier

This conclusion is false if a bounded request to the existing deployment returns
both a provider `web_search_call` and a URL citation. That result would establish
the missing authority, require a separate adapter-bridge task with provenance,
timeout, spend, and refusal tests, and leave W1-T3547 as the mount-only routing
task.
