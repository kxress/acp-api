# Mocked API contract

Run the HTTP contract suite with `npm test`. It starts the HTTP server
in-process and injects a fake ACP runtime with fixed text or tool-call returns.
Tests use only local loopback HTTP and never contact OpenAI, Anthropic, or
another model service.

The optional LangChain client suite uses the official Python provider clients
and LangMem against the same kind of local fake ACP runtime. Install its pinned
test dependencies and run `npm run test:langchain` from an activated virtual
environment:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements-langchain-test.txt
npm run test:langchain
```

## Supported contract

The tested OpenAI-compatible surface is:

- `GET /v1/models` with Bearer authentication.
- `POST /v1/chat/completions` for text, streamed text, function tool calls, and
  client tool results in follow-up messages, plus JSON object and JSON Schema
  response formats.
- `POST /v1/responses` for function tool calls and streamed function-call events.
- OpenAI-shaped authentication errors and standard completion response fields.

The tested Anthropic-compatible surface is:

- `GET /v1/models` with `x-api-key` and `anthropic-version`.
- `POST /v1/messages` for text, streamed text, `tool_use`, and client tool
  results in follow-up messages, plus JSON Schema output format.
- `POST /v1/messages/count_tokens`, using the local token estimate without
  invoking the fake runtime.
- Anthropic-shaped authentication errors and Messages response fields.

Both tool formats follow the client tool loop: the API returns a tool request,
the client executes it, and the next API request includes the result. ACP-agent
tools remain available to the ACP agent itself.

The real-client suite covers `ChatOpenAI`, `ChatAnthropic`, both clients'
streaming and tool-result round trips, and LangMem's structured memory manager
with each provider. All model responses come from the fake ACP runtime.

## Compatibility boundary

This contract targets official OpenAI Chat Completions and Anthropic Messages
features exercised by LangMem and the tested LangChain clients. JSON Schema
requests are passed to the ACP agent as instructions; ACP does not guarantee
schema-constrained output. ACP also does not expose provider-neutral controls
for sampling or hard output-token limits, so `max_tokens`, usage, and token
counting are best-effort prompt guidance or local estimates. Third-party-only
request extensions are outside this contract.
