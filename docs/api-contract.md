# Mocked API contract

Run the main HTTP contract suite with `npm test`. It starts the server
in-process and injects a fake ACP runtime with fixed text or tool-call returns.
The tests use loopback HTTP only; they do not call a model provider.

ACP session lifecycle tests also launch a fake local agent with ACP v1 and v2.
They verify that each generation gets and closes an isolated session while the
agent process and ACP connection stay warm.

The optional client suite exercises the official OpenAI and Anthropic Python
SDKs against a local fake ACP runtime. Install its pinned dependencies and run
it from an activated virtual environment:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements-api-completeness.txt
npm run test:api-completeness
```

On macOS or Linux, activate with `source .venv/bin/activate` instead.

All responses in this suite come from the fake runtime. It requires no API
credentials, provider access, or usage spend.

## Supported contract

The mocked tests cover these OpenAI-compatible routes:

- `GET /v1/models` and `GET /v1/models/{model}` with Bearer authentication.
- `POST /v1/chat/completions` for text, streaming, function tools, client tool
  results in follow-up messages, JSON object output, and JSON Schema output.
- `POST /v1/completions` for text completions.
- `POST /v1/responses` for text, function calls, and streamed function-call
  events.
- OpenAI-shaped authentication errors and completion response fields.

The mocked tests cover these Anthropic-compatible routes:

- `GET /v1/models` and `GET /v1/models/{model}` with `x-api-key` and
  `anthropic-version`.
- `POST /v1/messages` for text, streaming, `tool_use`, client tool results in
  follow-up messages, and JSON Schema output.
- `POST /v1/messages/count_tokens`, using a local token estimate without
  invoking the fake runtime.
- Anthropic-shaped authentication errors and Messages response fields.

The client SDK suite checks model listing, OpenAI Completions, Chat Completions,
Responses, streaming, tool-choice handling, tool-result round trips, and JSON
Schema request handling. Both tool formats use the client tool loop: the API
returns a tool request, the client executes it, and the next API request
includes the result. ACP-agent tools remain available to the ACP agent itself.

## Compatibility boundary

This project implements the documented request and response shapes listed
above; it does not claim complete coverage of every feature in either provider
API. JSON Schema requests are passed to the ACP agent as instructions, so ACP
does not guarantee schema-constrained output. ACP also does not expose
provider-neutral controls for sampling or hard output-token limits. `max_tokens`,
reported usage, and token-count results are best-effort prompt guidance or local
estimates. Provider-specific extensions outside the documented contract are
not part of the compatibility target.
