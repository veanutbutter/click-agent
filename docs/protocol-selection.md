# Wire-protocol selection

Click's provider layer speaks four wire protocols: **chat completions**
(`POST {baseUrl}/chat/completions`), the **Responses API**
(`POST {baseUrl}/responses`), the **Anthropic Messages API**
(`POST {baseUrl}/v1/messages`) and the **Gemini API**
(`POST {baseUrl}/v1beta/models/{model}:streamGenerateContent`). Which one a
request uses is chosen **automatically from model metadata**. There is no
setting, no environment variable and no UI knob for it — by design (see the
Click task list, items 4/6).

## The field

`ModelInfo.protocol` in `packages/contracts/src/model.ts`:

```ts
export type WireProtocol = "chat" | "responses" | "anthropic" | "google";

export interface ModelInfo {
  // …
  /**
   * Which wire protocol this model speaks. Chosen from model metadata, never by
   * the user. Absent means "use the provider's default" (`selectProtocol`).
   */
  protocol?: WireProtocol;
  /** Registry `provider.api`, when a model lives somewhere other than the provider base. */
  baseUrl?: string;
  /** The effort levels the model declares, in registry order. */
  effortLevels?: string[];
  /** Whether the model declares a plain reasoning on/off toggle. */
  supportsReasoningToggle?: boolean;
}
```

The four values mirror Zed's `protocol` exactly: `chat`/`responses` are Zed's
`openai_chat`/`openai_responses`, `anthropic` is the Messages API and `google`
is the Gemini API.

Every field is optional, so every existing catalogue entry keeps working
unchanged. All of them are **metadata**, never a user setting.

## Defaults per provider

`defaultProtocolFor(providerId)` in `packages/providers/src/protocol.ts` is the
id-based default, and it follows Zed's rule exactly:

| Providers | Default | Why |
| --- | --- | --- |
| `openai` (native) | `responses` | Zed's `uses_responses_api()` is always true for built-in OpenAI models (`crates/open_ai/src/open_ai.rs:387`). |
| `xai`, `deepseek`, `mistral`, `ollama`, `openai-compatible`, `opencode`, `opencode-go`, and every `CATALOGUE` entry with `protocol: "openai"` | `chat` | Zed's OpenAI-compatible provider defaults to chat completions; Responses only happens when a capability turns chat *off* (`crates/language_models/src/provider/open_ai_compatible.rs:301`, `default_supports_chat_completions()`). |
| `anthropic`, `google`, ACP agents | n/a | They use their own clients and never consult this field — unless a model *carries* an `anthropic`/`google` protocol (see below), in which case the OpenAI-compatible provider routes to those clients. |

A provider can also declare the default explicitly on its spec
(`OpenAiCompatibleSpec.defaultProtocol`); `OPENAI_SPEC` sets `"responses"` and
the generic `OPENAI_COMPATIBLE_SPEC` leaves it unset, i.e. `"chat"`. Note the
base-URL override does **not** change the default: pointing the `openai`
provider at a chat-only gateway is not supported — use the `openai-compatible`
provider for that, which defaults to chat.

## Where metadata comes from

1. **OpenCode registry** — `packages/providers/src/opencode.ts` reads
   `https://models.opencode.ai/api.json`. The registry does not always carry a
   literal `protocol`; where it does it is read first. Otherwise the transport is
   implied by the AI SDK package (`provider.npm`, falling back to the entry's
   `npm`), exactly as Zed maps it
   (`crates/language_models/src/provider/opencode.rs:1165-1173`):

   | registry token | Click protocol |
   | --- | --- |
   | `responses`, `openai_responses`, `@ai-sdk/openai` | `responses` |
   | `chat`, `openai_chat`, `@ai-sdk/openai-compatible` | `chat` |
   | `anthropic`, `anthropic_messages`, `@ai-sdk/anthropic` | `anthropic` |
   | `google`, `google_generative_ai`, `@ai-sdk/google` | `google` |
   | anything else | absent → provider default |

2. **Per-model base URL** — the registry gives each model a `provider.api`
   (falling back to the entry's `api`). This is carried onto
   `ModelInfo.baseUrl`. It matters because one gateway can serve several
   protocols at different paths: on OpenCode Go, `provider.api` is
   `…/go/openai/v1` for chat models but `…/go/anthropic/v1` for
   Anthropic-protocol models and `…/go/google/v1beta` for Google-protocol ones.
   The path is taken from the registry — never hard-coded. Click's native
   clients append the protocol version themselves, so a trailing version
   segment is trimmed before the client is built (`nativeBaseUrl`): `…/anthropic/v1`
   becomes `…/anthropic`, and the client adds `/v1/messages`.

3. **Effort levels** — the registry's `reasoning_options` is parsed into
   `ModelInfo.effortLevels` (the `values` of every `{type:"effort"}` entry, in
   registry order) and `supportsReasoningToggle` (whether a `{type:"toggle"}`
   entry exists). Where the registry lists no options at all, a model that does
   reason falls back to `DEFAULT_EFFORT_LEVELS` in `protocol.ts` (Zed's ordered
   `minimal, low, medium, high, xhigh, max`). A model that does not reason gets
   no levels. This is what lets the picker offer — and clamp to — exactly the
   levels a model supports.

4. **Declared models** — `buildDescriptor()` in `openaiCompatible.ts` stamps the
   provider default onto every declared/custom model that has no protocol, so
   `listModels()` and `ProviderDescriptor.models` always surface it. The OpenCode
   fallback model lists (used when the registry is unreachable) also carry the
   native protocol and base URL for their Claude/Gemini entries.

5. **Discovery** — `listModels()` stamps the provider default onto models found
   via `{baseUrl}/models`.

## The selection site

The one place that decides is `selectProtocol` in
`packages/providers/src/protocol.ts`:

```ts
export function selectProtocol(model, providerId, providerDefault?) {
  return model?.protocol ?? providerDefault ?? defaultProtocolFor(providerId);
}
```

`OpenAiCompatibleProvider` resolves the model's metadata (`descriptor.models`
plus any catalogue injected via `setModelCatalog`) and dispatches in `stream()`.
This switch is the **only** place a protocol turns into a transport:

```ts
const baseUrl = this.endpointFor(chatRequest.model);
switch (this.protocolFor(chatRequest.model)) {
  case "anthropic":
    yield* this.nativeClient("anthropic", baseUrl).stream(chatRequest);
    return;
  case "google":
    yield* this.nativeClient("google", baseUrl).stream(chatRequest);
    return;
  case "responses":
    yield* this.responsesClient(baseUrl).stream(chatRequest);
    return;
  default:
    yield* this.streamChatCompletions(chatRequest, baseUrl);
}
```

The `anthropic` and `google` arms reuse the existing `AnthropicProvider` and
`GoogleProvider` clients, built on the same `ProviderContext` and the provider's
API key, pointed at the model's own base URL. The `responses` and `chat` arms
use the OpenAI clients as before. `OpenCodeProvider` loads its registry (once)
before streaming and hands the per-model protocol, base URL and effort levels to
the inner client with `setModelCatalog`.

## Effort mapping per protocol

The same reasoning-effort value (`ChatRequest.options.reasoningEffort`) is
written differently per protocol by `applyReasoningEffort`:

| Protocol | Request body field |
| --- | --- |
| chat completions | `reasoning_effort: "high"` |
| Responses | `reasoning: { effort: "high" }` |
| Anthropic | none here — the Messages client owns `thinking`/budget |
| Google | none here — the Gemini client owns its thinking config |

(Matches Zed: `crates/open_ai/src/completion.rs:258` vs `:359-380`.)

## Gateway

`GET /v1/models` exposes the chosen protocol and reasoning metadata under each
entry's `click` metadata:

* `click.protocol` — from `ModelInfo.protocol`.
* `click.effort_levels` — from `ModelInfo.effortLevels` (array of strings).
* `click.supports_thinking` — from `ModelInfo.supportsThinking`.
* `click.supports_reasoning_toggle` — from `ModelInfo.supportsReasoningToggle`.

Routing is unchanged: model ids are still `provider/model`, and the provider
picks the protocol when it streams.

## Adding a new protocol later

1. Add the variant to `WireProtocol` in `packages/contracts/src/model.ts`.
2. Teach `defaultProtocolFor` (and, if the provider is configurable per spec,
   `OpenAiCompatibleSpec.defaultProtocol`) about it.
3. Add a client module next to `openaiResponses.ts` that maps the wire stream to
   `ChatStreamEvent`, reusing `ProviderContext`, `request`/`ensureOk` and
   `ToolCallAccumulator`.
4. Add a case to the switch in `OpenAiCompatibleProvider.stream()` — still the
   single dispatch point.
5. Extend `applyReasoningEffort` with the new body shape (or leave it to the
   native client, as Anthropic/Google do).
6. Add a metadata mapping (a token in `protocolFromToken` and, if needed, a
   `provider.api` base URL) so the protocol can actually be discovered.
