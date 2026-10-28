# Compatibility details

[← Quick start](../README.md)

This bridge supports part of the OTel tracing API. Cloudflare owns sampling,
storage and export. It is not a full OTel SDK.

## Registration

`register()` returns an OTel `TracerProvider` for libraries that accept a custom tracer. It is idempotent while installed, including across dev module reloads and duplicate bundles of the same adapter version. It also activates previously acquired global tracers and throws on competing registrations or missing required native APIs. After removing **both** OTel globals (`context.disable()` and `trace.disable()`), it can register again. Partial teardown fails explicitly. Keep one compatible OTel API dependency; libraries with private providers must use the global API or the returned provider instead. Restart the isolate when updating the adapter version.

The runtime must provide `getActiveSpan()`, `startSpan()`, `startActiveSpan()`,
`spanContext()`, `setStatus()` and `updateName()`. The README's compatibility date
enables Node compatibility, which supplies `node:async_hooks`. Existing Wrangler
projects can keep their configuration and enable `observability.traces.enabled`
and `head_sampling_rate`.

## Tested libraries

AI SDK and Agents have a separate [compatibility matrix below](#ai-sdk-and-agents).

The following ten integrations have tests using their published code. **Passing a compatibility test does not mean every operation records a native span.**

| Integration (pinned test version) | Verified behavior / limitation |
| --- | --- |
| Pino 10.4.0 / instrumentation 0.70.0 | Node instrumentation correlates invocation/child IDs. Bundled Worker logger accepts explicit IDs; the Node instrumentation constructor fails with the default browser resolution. |
| Braintrust 3.40.0 / OTel 1.1.0 | Native parent correlation, logical Braintrust context, errors and restoration; its own spans are not translated. |
| SvelteKit 3.1.0 | Published tracing helper records nested spans and exceptions in Workers/DOs. Full framework deployment is not tested. |
| Hono 4.13.14 / OTel 1.3.0 | Requests, handled errors and child correlation work; middleware SERVER spans are non-recording. |
| Prisma 7.10.1 / D1 adapter | Real D1 create/read/delete and duplicate-key errors; client operation spans record under the invocation. Timestamped engine spans are non-recording. |
| Langfuse tracing 6.0.2 | Active observations, manual child observations, errors and restoration record in Workers/DOs; SDK processors/export are outside scope. |
| Effect 4.0.6 / OTel 4.0.6 | Concurrent fibers preserve context/results/errors; its timestamped spans are non-recording. Ordinary active OTel children still record under the retained native parent. |
| Next.js 16.4.3 | Published tracing helper records nested spans and errors in Workers/DOs. Full Next/OpenNext deployment is not tested. |
| pg 8.23.1 / instrumentation 0.77.0 | Real driver connects/queries/errors against a local wire fixture; CLIENT spans are non-recording. Node instrumentation cannot initialize in the default Worker bundle. |
| GraphQL 16.14.2 / instrumentation 0.72.0 | Node instrumentation records parse/validate/execute; resolver descendants are non-recording because manual activation cannot change the native parent. Node instrumentation cannot initialize in the default Worker bundle. |

The latest tested Pino, pg and GraphQL Node instrumentation packages throw `this.enable is not a function` when resolved against the browser instrumentation base in the default Cloudflare Vite bundle. The older versions tested with API 1.9 initialize but do not intercept bundled imports. The bridge cannot install their Node loader hooks. Their libraries themselves run in Workers; do not copy Node auto-instrumentation setup into a Worker. GraphQL 16 is pinned because this instrumentation's supported range excludes 17. New Pino instrumentation also requires API 1.10; the adapter's API 1.9 support does not relax a library's own requirements. See [test details](../test/README.md).

### Broader ecosystem checks

These are **specific test results**, not full-library support promises. Versions below are from the API 1.10 job and are pinned as development dependencies. No vendor credentials or remote services are used.

The API 1.9 job uses the previous instrumentation releases, selected in `test/api-version.mjs`: Redis/ioredis 0.71.0, MongoDB 0.76.0, Knex 0.67.0, AWS 0.78.0, KafkaJS 0.32.0, amqplib 0.70.0, Undici 0.33.0, fetch 0.223.0 and Winston 0.68.0. Those older Node instrumentation constructors initialize in Workers, but initialization does not install their Node require hooks. Newer instrumentation uses Logs API exports absent from API 1.9, regardless of its declared peer range.

| Integration | Tested behavior and boundary |
| --- | --- |
| LangSmith 0.11.3 | `traceable` promises expose nested native spans and preserve errors/context. Its OTel mode does not end those spans, and async-generator bodies see the caller's span. Tests reproduce this and explicitly clean up test-owned spans. Not a drop-in integration without a LangSmith fix or a tracer wrapper that owns span lifetime. |
| Firestore 9.4.0 | Published tracing helper handles sync/async nesting and errors with global/injected providers in Node. Importing the complete package in our Worker bundle fails on string-based code generation. No Firestore database operations are claimed. |
| Azure core-tracing 1.4.0 / instrumentation 1.0.0 | Node loader hook records INTERNAL operations and errors; manual activation prevents native descendants, and CLIENT spans fall back. Its Worker bundle initializes but cannot install Node require hooks. |
| OpenInference OpenAI 4.4.2 / OpenAI 7.45.1 | Manual instrumentation in Node records completion, streaming and error spans using an injected HTTP response. Logical context is active; native descendants cannot follow the manually activated span. The default Worker bundle fails in its loader dependency before instrumentation runs. |
| OpenInference LangChain 4.1.5 / LangChain core 1.3.0 | Real runnable chain and failure; explicit-parent descendants fall back, and background callbacks are awaited. Same Worker loader failure as the OpenAI integration. |
| Inngest 4.26.1 | Edge request handler executes a real function and records its execution span in Workers/DOs, including concurrent calls. No hosted scheduler, durable replay, step orchestration, Extended Traces processor or `@inngest/otel` provider is tested. |
| Sentry Cloudflare 11.9.0 | Worker wrapper and actual Durable Object RPC wrapper preserve OTel correlation while processing errors through a local transport. Optional Sentry OTel setup conflicts explicitly when installed first and cannot replace an already installed bridge. Sentry's own spans/export remain separate. |
| Fastify 5.12.7 / OTel 0.21.4 | Node plugin handles request injection, responses and errors. Uninstrumented Fastify request injection already fails on string-based code generation in our Worker bundle. This is not a full Workers HTTP-server deployment test. |
| Google Pub/Sub 6.3.1 | Published publisher helper returns non-recording PRODUCER spans and injects native IDs using its own propagator in Node/Workers/DOs. No broker round trip. Native trace flags still do not describe Cloudflare sampling. |
| BullMQ 6.5.0 / bullmq-otel 2.0.1 | Published telemetry wrapper executes callbacks/errors, records INTERNAL spans and skips PRODUCER/CONSUMER spans in Node/Workers/DOs. No Redis-backed queue worker. Cross-job propagation is absent unless separately configured. |
| Redis 6.3.0 / instrumentation 0.72.0; ioredis 6.0.0 / instrumentation 0.72.0 | Real concurrent clients, pipelined commands, wire responses and errors against a local RESP fixture. Node CLIENT spans fall back. Worker instrumentation constructors fail. |
| MongoDB 7.7.0 / instrumentation 0.77.0 | Real handshake, command and error against a minimal local wire fixture. Node CLIENT spans fall back; Worker instrumentation constructor fails. Not a MongoDB engine test. |
| Knex 3.3.0 / instrumentation 0.68.0 | Real PostgreSQL driver query/error against the local wire fixture. CLIENT spans fall back; Worker instrumentation constructor fails. |
| AWS S3 3.1158.0 / instrumentation 0.79.0 | Real command middleware and success/error responses through an injected request handler. CLIENT spans fall back; Worker instrumentation constructor fails. |
| KafkaJS 2.2.4 / instrumentation 0.33.0 | Disconnected producer and batched-send errors preserve context with non-recording PRODUCER spans. Worker instrumentation constructor fails. No Kafka broker or consumer test. |
| amqplib 2.2.0 / instrumentation 0.71.0 | Real confirm-channel publish/ack/error with a transport double. PRODUCER spans fall back; Worker instrumentation constructor fails. No RabbitMQ broker test. |
| Winston 3.19.0 / instrumentation 0.69.0 | Node logger receives invocation/child IDs and drops correlation outside requests. Worker instrumentation constructor fails. API 1.9 tests use instrumentation 0.68.0, which initializes in Workers but cannot install require hooks. |
| Undici instrumentation 0.34.0 | Actual Node fetch success/error, native parent restoration and suppression. CLIENT spans fall back; Worker instrumentation constructor fails. |
| Fetch instrumentation 0.300.0 | Wraps fetch where `PerformanceObserver` is available, including this Workers runtime. Responses survive, CLIENT spans fall back and native HTTP spans are not duplicated by the adapter. |
| Mastra OTel exporter 1.4.9 / observability 1.21.0 | Real `SpanConverter` produces an SDK `ReadableSpan` without calling the global provider. Conversion creates no native span; this exporter is not a bridge-compatible span producer. |

Tests assert exact known runtime failures so an unexpected error or changed dependency behavior fails the suite. Passing a boundary test means the limitation was reproduced, not that native spans were recorded.

## AI SDK and Agents

Tested with AI SDK **6.0.316**, AI SDK **7.0.155**, `@ai-sdk/otel` **1.0.155** and Agents **0.31.0**. Synthetic models exercise generation, failures, deferred stream consumption, in-band stream errors, cancellation, early consumer exit, and streaming tools. The same cases run in Workers and Durable Objects; native exported IDs and parents are checked.

| Setup | What the tests establish |
| --- | --- |
| AI SDK v6 + bridge | Generation and normally consumed streams record nested OTel spans. Cancellation leaves `ai.streamText.doStream` open in this AI SDK release. |
| AI SDK v7 + `@ai-sdk/otel` + bridge | Operation spans record. Explicit-parent step/tool spans and CLIENT model spans fall back to non-recording spans. This is partial tracing, not a complete model/tool tree. |
| Agents `wrapAISDK()` + bridge, AI SDK v6 or v7 | Agents creates native operation/model/tool spans. The bridge exposes the active native span to OTel code; supported OTel children nest beneath it. |
| Agents wrapper + AI SDK OTel instrumentation + bridge | Both producers run and create duplicate operation instrumentation. Prefer one producer for each AI call. |

### AI SDK v7 setup

The v6 `experimental_telemetry.isEnabled` setting alone is insufficient in v7. Install `@ai-sdk/otel` and configure its integration, in addition to registering this bridge:

```ts
import { generateText } from 'ai'; // v7
import { OpenTelemetry } from '@ai-sdk/otel';

await generateText({
  model,
  prompt,
  telemetry: {
    integrations: [new OpenTelemetry()],
    recordInputs: false,
    recordOutputs: false,
  },
});
```

The integration uses `startSpan()` plus manual context activation, and CLIENT spans for model calls. The bridge cannot turn those into a faithful native child tree with the current runtime APIs.

### Agents coexistence

For the Agents span structure, use its wrapper and disable the AI SDK's separate OTel producer for that call:

```ts
import * as ai from 'ai';
import { wrapAISDK } from 'agents/observability/ai';

const tracedAI = wrapAISDK(ai);
await tracedAI.generateText({
  model,
  prompt,
  telemetry: { isEnabled: false }, // AI SDK v7; use experimental_telemetry in v6
});
```

The bridge preserves span names and attributes supplied by each producer. It does not convert arbitrary OTel spans into Agents dashboard semantics, add agent identity, or redact payloads. Configure identity and payload capture using the [Agents tracing documentation](https://developers.cloudflare.com/agents/runtime/operations/observability/tracing/).

### Span lifetime

Always consume or cancel streams according to the producer's contract. Early exit from AI SDK's text stream can leave other stream branches running; our tests abort and drain the remaining stream before checking completion. Even after that, v6's model span remains open on cancellation. `reference-sdk.test.ts` reproduces this with the reference OTel SDK and an always-on sampler. Tests report the leak before cleaning up their own spans. The bridge does not automatically end producer-owned spans or infer error/cancellation status.

Agents manages its own span lifetime, including streaming tools. Its async-context snapshots are specific to those wrappers. The bridge deliberately does not restore all application async-local state when activating an OTel context.

## Workers and Durable Objects

**Pi Durable:** [PiHarness supports Pi Durable in Agents/Durable Objects](https://developers.cloudflare.com/changelog/post/2026-10-02-pi-harness/). Register in the hosting Worker when its libraries use the OTel API. This does not add Pi-specific instrumentation or preserve live contexts across durable restarts; PiHarness has not been integration-tested here.

**Durable Objects:** register at Worker module scope, and start/end spans inside each RPC, fetch, alarm, or WebSocket handler. Reuse tracers, but do not store live spans, contexts, or bound callbacks in object fields or durable storage for later invocations. Persist plain IDs if you need historical log correlation. Root IDs and cross-service trace continuity belong to the runtime; a Durable Object's calls can share a native root in local development. The bridge creates distinct child spans and isolates logical context during concurrent calls. RPC, fetch, alarms, and WebSocket messages using the hibernation API are tested locally; eviction/restart continuity is not claimed.

Some WebSocket events have a native tracing parent but no exposed `getActiveSpan()`. Default `startSpan()` / `startActiveSpan()` calls still use that native parent. Logger IDs become available inside the active span; they may be absent before it starts. Explicit parent arguments, `{ root: true }`, and `context.with(ROOT_CONTEXT, ...)` do not use this fallback.

**Background work:** use `ctx.waitUntil()` and end the span when that work finishes. Returning a response does not keep arbitrary asynchronous work alive. Start the background task inside `startActiveSpan()` to inherit its context.

## API support

| Operation | Behavior |
| --- | --- |
| Native active span / invocation | OTel wrapper with real native IDs; cached identity remains readable after `end()` and request disposal; invocation lifetime stays runtime-owned (`end()` has no effect on it) |
| `startSpan()` | Native span under the matching ambient parent; does not activate it |
| `startActiveSpan()` | All overloads; sync/async result and error preservation; native nesting; caller owns `end()` |
| `context.with()` / function `bind()` | Preserves logical OTel contexts, baggage, `this`, arguments, and async isolation; cannot reactivate native spans |
| Scalar attributes | Strings, booleans, and numbers forwarded unchanged; empty keys and undefined values ignored |
| Arrays / objects / other attribute types | Dropped with a diagnostic, never serialized or coerced |
| Status, rename, exception, recording state | Mapped to native APIs; `isRecording()` reflects `isTraced`, not final sampling |
| Unsupported parent/root, non-INTERNAL kind, explicit start time, creation links | **No native span created**; return a non-recording span |
| Events / links added later | Unsupported; dropped; fluent methods still return the span |
| End / exception timestamps | Unsupported; end/record at runtime time, with a diagnostic |
| Scope name/version/options | Unsupported; ignored; no synthetic `otel.scope.*` attributes |
| `context.attach()`, EventEmitter binding | Unsupported; use callback context APIs |
| `@opentelemetry/core` tracing suppression | Suppressed creation returns invalid, non-recording spans; callbacks still run and context is restored |
| Metrics, logs SDK, SDK processors/exporters and SDK-specific configuration | Outside this tracing adapter |

### Context boundaries

When an active native span is exposed, creation requires the requested parent's IDs and trace flags to match it, with no remote flag or nonempty `TraceState`. If no native span is exposed, default creation with no OTel parent delegates to the runtime's ambient parent (including contexts containing only baggage/other values). Workers currently lacks the APIs to activate an arbitrary existing span/context or start a detached trace.

For unsupported creation, a valid requested parent's entire `SpanContext` is retained in a non-recording span. `{ root: true }`, explicit parent contexts without a span, and invalid contexts produce an invalid, all-zero context. Descendant OTel calls follow the same rules. No new IDs or incorrect parent relationships are invented, and callbacks still execute normally. This is a deliberate fallback, not support for creating remote-parented or detached native traces.

`context.with()` and bound callbacks change **OTel's logical context only**. For example, `startSpan()` followed by `context.with(trace.setSpan(...), ...)` cannot activate that native span: OTel child creation becomes non-recording, and native platform operations still use the ambient native parent. Use `startActiveSpan()` around work needing native children. A nested native `tracing.enterSpan()` becomes visible to OTel as well. Contexts cannot be reused across requests or durable restarts. No whole-async-context snapshots are restored, so unrelated application `AsyncLocalStorage` values stay intact.

No propagator is registered. Native `traceFlags` currently does not express Cloudflare's sampling decision: it is returned unchanged and must not be used to construct outbound `traceparent` headers. Observability-disabled IDs may be zero; logs-only invocations may have IDs without stored traces. When a native child has no valid IDs, the adapter retains its requested parent's IDs in a non-recording span. See the [native API contract](https://developers.cloudflare.com/workers/observability/traces/custom-spans/).

Telemetry failures, including expired native request objects and invalid annotation data, are contained and reported without payloads. Application callbacks still run once, and their return values, promises, and exceptions are preserved. This does not reactivate expired spans or allow I/O across requests. Native limits also apply: span names are limited to 64 bytes and attribute/exception data to 64 KiB per span. The bridge truncates names at a complete UTF-8 character within 64 bytes, including renames; the runtime can drop annotations that exceed its data budget. Tests verify that oversized attributes/exceptions do not break application work or later spans.

Unsupported creation and annotations produce once-per-feature OTel diagnostics, with no user payloads. Enable diagnostics before running instrumented code to see them:

```ts
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
```

