# Mocked API contract

Run the contract suite with `npm test`. It starts the HTTP server in-process and
injects a fake ACP runtime with fixed text or tool-call returns. Tests use only
local loopback HTTP and never contact OpenAI, Anthropic, DeepSeek, or another
model service.

## Supported contract

The tested OpenAI-compatible surface is:

- `GET /v1/models` with Bearer authentication.
- `POST /v1/chat/completions` for text, streamed text, function tool calls, and
  client tool results in follow-up messages.
- `POST /v1/responses` for function tool calls and streamed function-call events.
- OpenAI-shaped authentication errors and standard completion response fields.

The tested Anthropic-compatible surface is:

- `GET /v1/models` with `x-api-key` and `anthropic-version`.
- `POST /v1/messages` for text, streamed text, `tool_use`, and client tool
  results in follow-up messages.
- `POST /v1/messages/count_tokens`, using the local token estimate without
  invoking the fake runtime.
- Anthropic-shaped authentication errors and Messages response fields.

Both tool formats follow the client tool loop: the API returns a tool request,
the client executes it, and the next API request includes the result. ACP-agent
tools remain available to the ACP agent itself.

## Compatibility boundary

This contract targets the portable Chat Completions and Anthropic Messages
patterns used by LangMem's chat-model integrations. It does not claim full
parity with every OpenAI, Anthropic, or DeepSeek extension. In particular, ACP
does not provide provider-neutral controls for sampling or hard output-token
limits; `max_tokens`, usage, and token counting are best-effort prompt guidance
or local estimates.
