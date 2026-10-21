# acp-api

**Expose local ACP agents through OpenAI- and Anthropic-compatible HTTP APIs.**

`acp-api` is a small translation layer between HTTP clients and agents that
implement the Agent Client Protocol (ACP). It starts configured ACP commands,
keeps their processes and protocol connections available, and translates API
requests into ACP prompts. It does not call model providers directly or supply
provider accounts or credentials.

```text
OpenAI or Anthropic client
          |
          v
       acp-api
          |
          +--> ACP agent --> model/provider
          |
          +--> ACP agent --> model/provider
```

Use it to connect standard API clients to the ACP agents and model access you
already run locally. Configure one or more agents, expose model IDs to clients,
and keep using familiar OpenAI or Anthropic request formats.

## Features

- OpenAI-compatible Models, Chat Completions, Completions, and Responses routes.
- Anthropic-compatible Models and Messages routes, including token counting.
- Client-supplied function tools and Anthropic tools, returned for the client to
  execute.
- Text and server-sent event streaming.
- ACP v1 and v2 session drivers.
- Agent pools with sticky failover, primary failover, round-robin, or least-busy
  routing.
- Request authentication, configurable ACP permission handling, and local
  health routes.
- Native release packages for Windows x86_64, Linux x86_64, and macOS ARM64.

The supported request subset and known protocol limits are listed in the
[API contract](docs/api-contract.md).

## Install

The release workflow is configured to publish validated version tags. Check
[GitHub Releases](https://github.com/kxress/acp-api/releases) for available
packages. Release targets are:

| Platform | Artifact |
| --- | --- |
| Windows | `acp-api-<version>-windows-x86_64.zip` |
| Linux | `acp-api-<version>-linux-x86_64.tar.gz` |
| macOS | `acp-api-<version>-macos-arm64.tar.gz` |
| Any platform with Node.js | `acp-api-<version>-node.zip` |

Native packages include the executable and required runtime. The Node archive
requires Node.js 24.12 or newer. Release assets include a SHA-256 checksum and
a manifest. The checksum verifies the archive against its published hash; it
does not authenticate the publisher. Intel macOS is not a native release
target.

<details>
<summary><strong>Install a Windows x86_64 release</strong></summary>

Download the ZIP and its `.sha256` file from the release page, then verify and
extract it:

```powershell
$version = "0.1.0"
$archive = ".\acp-api-$version-windows-x86_64.zip"

$expected = (Get-Content "${archive}.sha256").Split()[0]
$actual = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) { throw "SHA-256 mismatch" }

$install = Join-Path $env:LOCALAPPDATA "Programs\acp-api"
Expand-Archive -LiteralPath $archive -DestinationPath $install -Force
& (Join-Path $install "acp-api.exe") --version
```

</details>

<details>
<summary><strong>Install a Linux x86_64 release</strong></summary>

```sh
version=0.1.0
archive="acp-api-$version-linux-x86_64.tar.gz"

sha256sum -c "$archive.sha256"
mkdir -p "$HOME/.local/share/acp-api/$version" "$HOME/.local/bin"
tar -xzf "$archive" -C "$HOME/.local/share/acp-api/$version"
install -m 0755 "$HOME/.local/share/acp-api/$version/acp-api" \
  "$HOME/.local/bin/acp-api"
"$HOME/.local/bin/acp-api" --version
```

</details>

<details>
<summary><strong>Install a macOS ARM64 release</strong></summary>

```sh
version=0.1.0
archive="acp-api-$version-macos-arm64.tar.gz"

shasum -a 256 -c "$archive.sha256"
mkdir -p "$HOME/.local/share/acp-api/$version" "$HOME/.local/bin"
tar -xzf "$archive" -C "$HOME/.local/share/acp-api/$version"
install -m 0755 "$HOME/.local/share/acp-api/$version/acp-api" \
  "$HOME/.local/bin/acp-api"
"$HOME/.local/bin/acp-api" --version
```

</details>

<details>
<summary><strong>Run the Node.js archive</strong></summary>

Download `acp-api-<version>-node.zip` and its checksum, verify and extract it,
then run the bundled `acp-api.mjs` with Node.js 24.12 or newer:

```powershell
$archive = ".\acp-api-0.1.0-node.zip"
$expected = (Get-Content "${archive}.sha256").Split()[0]
$actual = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) { throw "SHA-256 mismatch" }

Expand-Archive -LiteralPath $archive -DestinationPath .\acp-api-node -Force
node .\acp-api-node\acp-api.mjs --version
```

</details>

<details>
<summary><strong>Build from source</strong></summary>

Install Node.js 24.12 or newer, then:

```sh
git clone https://github.com/kxress/acp-api.git
cd acp-api
npm ci
npm run build
```

Run the built entry point with an explicit configuration file. For a local
native package, Node.js 26 or newer is required:

```sh
npm run release
```

To install a verified local native package, point the repository installer at
the release directory produced by the build:

```powershell
npm run install-release -- --release-dir .\dist\releases\acp-api-0.1.0-windows-x86_64
```

</details>

## Quick start

Install and authenticate at least one ACP agent on the machine running the
proxy. Copy the example configuration and set the command, arguments, and
model IDs for that agent:

```powershell
Copy-Item .\examples\config.example.json .\config.json
$env:ACP_API_KEY = "local-development-token"
```

Edit `config.json` as needed, then start the server using the native executable
or Node build:

```powershell
& "$env:LOCALAPPDATA\Programs\acp-api\acp-api.exe" --config .\config.json
# Or, when running from source:
node .\dist\acp-api.mjs --config .\config.json
```

The default listener is `127.0.0.1:11435`. The example requires the API key
`local-development-token` unless you change it. Use `ACP_API_KEY` or
`server.api_key` for a different key. An API key is mandatory when binding to a
non-loopback interface.

Check the configuration and agent executables before starting the proxy:

```powershell
acp-api doctor --config .\config.json
```

The doctor checks configuration, listener settings, agent working directories,
and executable lookup. It does not start ACP agents or send model requests. Add
`--json` for machine-readable results.

Check readiness:

```sh
curl http://127.0.0.1:11435/health
```

Make an OpenAI-compatible request:

```sh
curl http://127.0.0.1:11435/v1/chat/completions \
  -H "Authorization: Bearer local-development-token" \
  -H "Content-Type: application/json" \
  -d '{"model":"local-model","messages":[{"role":"user","content":"Hello"}]}'
```

For Anthropic Messages clients, send `x-api-key` and `anthropic-version`; the
official client SDKs set the version header automatically.

## Supported ACP agents

`acp-api` launches the command you configure and communicates with it over ACP
stdio. These are common ACP launchers; install and authenticate each one
separately. The agent command and `args` below go in an `agents[]` entry. The
proxy does not install these agents or choose their provider backends.

| Agent or adapter | Command | Args | Notes |
| --- | --- | --- | --- |
| OpenCode | `opencode` | `["acp"]` | [Install OpenCode](https://opencode.ai/download), then authenticate with `opencode auth login`. |
| Codex ACP | `codex-acp` | `[]` | Install with `npm install -g @agentclientprotocol/codex-acp`; authenticate the Codex CLI it uses. |
| Claude Agent ACP | `claude-agent-acp` | `[]` | Install with `npm install -g @agentclientprotocol/claude-agent-acp`; the adapter requires Node.js 22 or newer. |
| Google Antigravity ACP | `agy_acp_server` | adapter-specific | Install the official ACP adapter from the [ACP registry](https://agentclientprotocol.com/registry); use its absolute executable path when needed. |
| Refined Antigravity ACP | `refined-antigravity-acp` | `[]` | Install with `npm install -g @simonepri/refined-antigravity-acp`; set `REFINED_AGY_ACP_BIN` to the official adapter path. |
| `agy` ACP adapter | `agy-acp-windows-x64.exe` on Windows x64 | adapter-specific | [Community adapter](https://github.com/shubzkothekar/antigravity-acp); configure `AGY_BIN` for the installed Antigravity CLI and review its provider-account terms notice. |

Claude Agent ACP can be configured for ACP v1 or v2 when the adapter supports
it. To select its experimental v2 mode, configure both the protocol and the
adapter's opt-in environment variable:

```json
{
  "acp_protocol": "v2",
  "env": { "CLAUDE_AGENT_ACP_EXPERIMENTAL_V2": "1" }
}
```

Other adapters may support only one version. `acp-api` does not automatically
retry a request using a different protocol.

Any other ACP-compatible stdio command can be configured the same way. The
agent may expose different models or capabilities over ACP than it exposes in
its own interactive interface; use the model IDs supported by that adapter.

## Compatibility and CI coverage

The adapter names below are documented launch options. Automated tests use
local fake ACP processes, so they verify the protocol and HTTP translation
without requiring provider credentials or installing those third-party agents.

| ACP integration | Example coverage | CI coverage |
| --- | --- | --- |
| OpenCode | Starter config uses `opencode acp` | No live OpenCode process; fake ACP v1/v2 fixtures cover protocol paths. |
| Codex ACP | Launch instructions; configure with the generic `agents[]` shape | No live adapter coverage. |
| Claude Agent ACP | Launch instructions, including optional v2 setting | No live adapter coverage. |
| Google Antigravity ACP | Launch instructions; adapter-specific command and args | No live adapter coverage. |
| Refined Antigravity ACP | Launch instructions; generic config plus its executable environment setting | No live adapter coverage. |
| Community `agy` ACP | Launch instructions; adapter-specific command and environment | No live adapter coverage. |
| Other stdio ACP agents | Generic `agents[]` configuration shape documented in this README | Fake ACP v1/v2 fixtures cover protocol paths. |

CI coverage by platform:

| Platform | Installation/config examples | CI coverage |
| --- | --- | --- |
| Windows x86_64 | Native and Node archive installation; PowerShell quick start | Native release build and smoke check; tagged releases are downloaded and verified. The full Node test suite does not run on Windows. |
| Linux x86_64 | Native and Node archive installation; source quick start | Full API/ACP test suite and Node archive build on Ubuntu; native release build and smoke check; tagged release verification. |
| macOS ARM64 | Native installation instructions; shared JSON agent config | Native release build and smoke check; tagged releases are downloaded and verified. The full Node test suite does not run on macOS. |
| Other Node.js platforms, including Intel macOS | Node archive installation instructions | Node archive is built and verified on Ubuntu; other platform/architecture combinations are not covered by CI. Intel macOS has no native release. |

The API and ACP tests use mocked clients and local fake ACP processes. CI does
not install, authenticate, or make live requests through third-party agents.

## Configuration

Configuration is a JSON file passed explicitly with `--config`. The starter
file is [`examples/config.example.json`](examples/config.example.json):

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 11435,
    "api_key": "${ACP_API_KEY:-local-development-token}",
    "routing_strategy": "sticky_failover",
    "max_retries": 1,
    "max_sessions": 32
  },
  "agents": [
    {
      "name": "example-agent",
      "instance_id": "example-agent-a",
      "command": "opencode",
      "args": ["acp"],
      "models": ["local-model"],
      "permission": "deny"
    }
  ]
}
```

The `models` array contains IDs presented to API clients. If the ACP agent
supports `session/set_config_option`, `model_selection` can map those IDs to
the agent's own model option. Without that mapping, the ACP agent uses its
configured default model.

Multiple entries can advertise the same client model ID to create a pool. The
router supports `sticky_failover`, `primary_failover`, `round_robin`, and
`least_busy`. Retry and cooldown settings control how it handles an unavailable
agent.

Each agent entry can set `name`, `instance_id`, `command`, `args`, `cwd`, `env`,
`models`, `permission`, `acp_protocol`, and `model_selection`. Server settings
include `host`, `port`, `api_key`, `routing_strategy`, `max_retries`,
`failure_cooldown_seconds`, `retry_backoff_seconds`, `max_sessions`,
`max_body_bytes`, and `request_timeout_ms`. See the
[HTTP API guide](docs/http-api.md)
for field details and examples.

Environment values support `${NAME}`, `${NAME:-fallback}`, `$NAME`,
`{var:NAME}`, `{env:NAME}`, and `{file:/absolute/path}`. Secret file contents
are inserted literally and one trailing newline is removed. `ACP_API_KEY`
overrides the configured `server.api_key`; the legacy
`ACP_OPENAI_PROXY_API_KEY` variable is also accepted.

ACP permission requests default to `deny`. `read_only` uses a best-effort
permission policy; it is not an operating-system sandbox. `allow` approves ACP
permission requests and should be used only with trusted agents and workspaces.

## Security and operational boundaries

- Keep the listener on loopback unless remote access is needed. For remote
  access, configure an API key and put the service behind a trusted network or
  TLS reverse proxy.
- ACP child processes run with the launching user's operating-system
  privileges. Permission policies do not provide an OS sandbox; only launch
  trusted agents.
- Prompts and tool results are sent to the configured ACP agent. Provider
  credentials are managed by that agent and are not supplied by `acp-api`.
- Remote resource URLs are forwarded to the agent without being downloaded by
  the proxy.

## HTTP API

| Method | Route | API shape |
| --- | --- | --- |
| `GET` | `/health`, `/healthz` | Local health status |
| `GET` | `/v1/models`, `/v1/models/{model}` | OpenAI shape; Anthropic model shape when `anthropic-version` is sent |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/completions` | OpenAI Completions |
| `POST` | `/v1/responses` | OpenAI Responses |
| `POST` | `/v1/messages` | Anthropic Messages |
| `POST` | `/v1/messages/count_tokens` | Local Anthropic-style token estimate |

OpenAI clients authenticate with `Authorization: Bearer <key>`. Anthropic
clients authenticate with `x-api-key: <key>` and send `anthropic-version`.
Generation endpoints accept JSON and support server-sent event streaming when
`stream` is true. Responses include an `X-Request-ID` and identify the selected
ACP agent and model in response headers.

Client-supplied function tools and Anthropic tools are returned as tool calls;
the client runs them and sends their results in a later request. The proxy does
not execute client tools. ACP-agent tools are separate and remain available to
the agent. Inline image, audio, and resource input is passed only when the ACP
agent advertises the corresponding capability. Remote URLs are forwarded to the
agent without being downloaded by the proxy. OpenAI-hosted `file_id` attachments
are not supported by local ACP agents.

## Sessions and context

Each configured agent process and ACP connection stays warm. Each API
generation request opens a fresh ACP session on that connection and closes the
session when the request completes. The request's full message history is sent
once; the proxy does not preserve conversation state, compact history, or
summarize earlier turns between requests. Clients control which history they
send. Any provider prompt caching is determined by the downstream ACP agent and
provider, and is not managed or guaranteed by `acp-api`.

## API completeness tests

The main mocked HTTP and ACP lifecycle tests run offline:

```powershell
npm ci
npm test
npm run check
npm run lint
npm run format:check
npm run build
```

An optional suite sends requests through the official OpenAI and Anthropic
Python SDKs to a local fake ACP runtime. Install its pinned dependencies and run
it with `npm run test:api-completeness`; it does not contact provider services
or incur model usage. See the [API contract](docs/api-contract.md) for coverage
and limitations. The release workflow runs this suite as part of validation.

## Releases and development

The release workflow publishes Node.js and standalone native packages when a
version tag passes validation. Release assets include project and dependency
licenses, a SHA-256 checksum, and a manifest. The workflow checks that the tag
matches `src/version.ts`, validates the packaged executable, and downloads
published assets for verification.

The Node archive requires Node.js 24.12 or newer. Native package builds use
Node.js 26 or newer. Common development commands:

```powershell
npm ci
npm run check
npm test
npm run lint
npm run format:check
npm run build
npm run release
```

## License

Licensed under the [WTFPL, Version 2](LICENSE).

See [CHANGELOG.md](CHANGELOG.md) for project changes.
