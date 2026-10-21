# OpenAI-compatible HTTP API

This mode launches configured ACP agents and exposes an OpenAI-compatible HTTP
API. Requests are translated into ACP session prompts; the proxy does not call
OpenAI or another model provider directly.

## Start

Copy [the example configuration](../examples/openai-config.json), set the ACP
agent executable and model IDs, then run:

```powershell
acp-api --config .\openai-config.json
```

The default listener is `127.0.0.1:11435`. Set `server.api_key` or the
`ACP_OPENAI_PROXY_API_KEY` environment variable to require bearer authentication.
A key is required when binding to a non-loopback address.

`ACP_OPENAI_PROXY_API_KEY` overrides `server.api_key`. Agent environment values
and the server key support `${NAME}`, `${NAME:-fallback}`, `$NAME`,
`{var:NAME}`, `{env:NAME}`, and `{file:/absolute/path}` expansion. Secret file
contents are inserted literally and one trailing newline is removed.

## Endpoints

- `GET /health` and `GET /healthz`
- `GET /v1/models` and `GET /v1/models/{model}`
- `POST /v1/chat/completions`
- `POST /v1/completions`
- `POST /v1/responses`

Generation endpoints accept JSON and support streaming with server-sent events.
Responses include `X-Request-ID`, `X-ACP-Agent`, and `X-ACP-Model` headers. When
ACP model selection succeeds, they also include `X-ACP-Upstream-Model`.

## Agent pools and model selection

Each `agents[]` entry starts one long-lived ACP runtime. Multiple entries can
advertise the same model ID to form a pool. `models` lists the OpenAI IDs routed
to that runtime. The proxy supports `sticky_failover`, `primary_failover`,
`round_robin`, and `least_busy` routing strategies.

Server options include `host`, `port`, `api_key`, `routing_strategy`,
`max_retries`, `failure_cooldown_seconds`, `retry_backoff_seconds`,
`max_sessions`, `max_body_bytes`, and `request_timeout_ms`. Each agent entry
accepts `name`, `instance_id`, `command`, `args`, `cwd`, `env`, `models`,
`permission`, `acp_protocol`, and optional `model_selection`.

An ACP runtime's provider model stays at its own default unless it supports
`session/set_config_option` and the entry has `model_selection` configured:

```json
{
  "model_selection": {
    "config_id": "model",
    "required": true,
    "values": {
      "fast": "provider/fast-model",
      "smart": "provider/smart-model"
    }
  }
}
```

The proxy checks the options returned by `session/new` before setting the
requested value. Set `required` to `false` to let the ACP runtime use its current
model when a mapping is unavailable.

ACP permissions default to `deny`. `read_only` applies this project's existing
best-effort permission policy. `allow` approves ACP permission requests and
should only be used with trusted agents and workspaces.

## Request notes

Chat requests accept one choice (`n` omitted or `1`). OpenAI function tools are
returned as `tool_calls`; the proxy does not execute them. Inline image and audio
data and remote resource URLs are passed through only when the ACP runtime
advertises the matching prompt capability. Remote URLs are forwarded to the
agent and are not downloaded by the proxy. OpenAI-hosted `file_id` attachments
are not supported because a local ACP runtime cannot dereference them.
