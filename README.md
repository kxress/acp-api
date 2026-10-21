# acp-api

`acp-api` runs configured Agent Client Protocol (ACP) agents behind OpenAI- and
Anthropic-compatible HTTP APIs. It starts ACP agents as local stdio subprocesses,
reuses their long-lived sessions, and translates HTTP requests into ACP prompts.
The service does not call model providers directly.

## Requirements

- Node.js 24.12 or newer
- One or more ACP-compatible agent commands installed and authenticated

## Configure and run

Copy `examples/openai-config.json` and update the command and model ID. Then
install dependencies and start the service:

```powershell
npm install
npm run build
node .\dist\acp-api.mjs --config .\openai-config.json
```

The service listens on `127.0.0.1:11435` by default. Set
`ACP_API_KEY` or `server.api_key` to require authentication. The legacy
`ACP_OPENAI_PROXY_API_KEY` variable is also accepted. An API key is required
when the server binds to a non-loopback host.

The API endpoints are:

- `GET /health` and `GET /healthz`
- `GET /v1/models` and `GET /v1/models/{model}`
- `POST /v1/chat/completions`
- `POST /v1/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`

Generation endpoints return JSON or server-sent events when `stream` is true.
Response headers identify the selected ACP runtime and model.

## ACP runtime behavior

Each configured agent is started once and keeps one ACP session open. Multiple
agents can advertise the same OpenAI model ID to form a pool. The router supports
sticky failover, primary failover, round-robin, and least-busy selection. A
failed runtime is cooled down briefly while another pool member is tried.

`agents[].models` lists the OpenAI model IDs routed to that runtime. It does not
change the provider model selected inside the ACP agent. Configure
`model_selection` when the agent advertises a model config option from
`session/new`; the proxy then maps the request model to that ACP config value.

ACP permission requests default to `deny`. `read_only` uses the existing
best-effort read permission policy. `allow` approves permission requests and is
intended only for trusted agents and workspaces.

## Input support

Chat Completions, Completions, and Responses accept text input. Chat function
OpenAI function tools and Anthropic tools are returned to the client as tool
calls; the proxy does not execute them. The client executes each tool and sends
the result in its next request. Inline images, audio, and embedded resources are
sent only when the ACP agent advertises the corresponding prompt capability.
Remote HTTP and HTTPS resource URLs are forwarded without being downloaded.
OpenAI-hosted `file_id` attachments are not supported by local ACP agents.

See [the HTTP API guide](docs/openai-api.md) for the configuration fields and
request details. The [mocked API contract](docs/api-contract.md) describes the
offline compatibility test suite.

## Development

```powershell
npm run check
npm run lint
npm test
npm run build
```

## Releases

Tagged releases publish a Node.js archive and standalone native packages for
Windows x86_64, Linux x86_64, and macOS ARM64. Each archive includes the
project and dependency licenses, a SHA-256 checksum, and a manifest. The
release workflow checks the tag against `src/version.ts`, validates each
package, publishes the assets, and downloads them again to verify the public
release.

Use the Node archive with Node.js 24.12 or newer, or install a native package
from the repository's Releases page. For a local native package, run
`npm run release` with Node.js 26 or newer. Install a verified local package
with:

```powershell
npm run install-release -- --release-dir .\dist\releases\acp-api-0.1.0-windows-x86_64
```
