# Integration tests

Run `npm ci && npm run verify`. Nothing is deployed and no credentials are needed.

- `integrations.ts` calls real Hono middleware, Langfuse observations, Effect fibers, Braintrust compatibility mode, and the published SvelteKit/Next tracing helpers. It runs against the independent native model and in real Worker/DO invocations. Framework helpers are imported directly from pinned packages; these are not full framework deployment tests.
- `node-instrumentation.test.ts` installs real Node require hooks before importing Pino, pg and GraphQL. It checks correlation, successful and failing queries, GraphQL errors, and the adapter's non-recording fallbacks. `postgres-server.ts` supplies deterministic PostgreSQL wire responses; it is not a PostgreSQL engine test.
- `bundled-instrumentation.ts` confirms the latest Pino/pg/GraphQL instrumentation constructors fail with the default Worker/browser resolution. The older API 1.9 variants initialize but do not intercept bundled imports. It also runs the underlying logger, GraphQL query, and pg queries in Workers and DOs. An initialization failure or inactive hook is an explicit compatibility boundary, not a successful instrumentation result.
- `prisma.ts` runs a generated Prisma client against local D1, including a uniqueness error. The runtime harness checks client operation span IDs and parents and verifies timestamped engine spans were not fabricated.
- `wide/producers.mjs` exercises ten additional producers/wrappers, including published Firestore/Pub/Sub helpers and Mastra span conversion. Node tests cover callback behavior and native-model parents; Worker/DO tests inspect native spans or assert exact runtime failures. LangSmith's unended spans are reproduced and cleaned up explicitly. No full database, queue or workflow service is implied.
- `wide/node-hooks.test.mjs` adds Azure, Redis, ioredis, MongoDB, Knex, AWS, KafkaJS, amqplib, Winston and Undici. Loader hooks precede real module imports. RESP/Mongo/PostgreSQL fixtures test wire encoding and errors, not database engines; AWS/amqplib use transport doubles and KafkaJS exercises disconnected sends.
- `wide/bundled.mjs` tests each instrumentation constructor in actual Worker/DO bundles and verifies the fetch wrapper's non-recording CLIENT spans. Constructor success alone is not treated as functioning instrumentation.
- `wide/sentry-registration.test.mjs` checks both setup orders; `wide/sentry-durable.ts` exercises the real Sentry Durable Object wrapper with an in-memory transport.
- `suppression.test.ts` uses the real OTel core suppression functions and verifies no native span is created. The regression fails against version 0.1.2.
- `runtime.test.mjs` verifies native spans through Local Explorer, including overlapping Worker/DO calls and an actual Vite module reload. The existing AI SDK, waitUntil, alarm and WebSocket regressions remain in place.

Braintrust uses its own in-memory background logger; lazy export metadata is not evaluated, so no login or network export occurs. Langfuse tests install no processor/exporter. All payloads are synthetic.

The root npm overrides keep exactly one OTel API in this test environment: some pinned instrumentation packages require API 1.10 while SDK 2 peer ranges exclude it. The bridge supplies the provider; normal producers use the bridge provider; conflict tests intentionally initialize Sentry's provider. SvelteKit's TypeScript peer is overridden to the project's compiler because only its published JS helper is used. These overrides are not required by consumers of the adapter.

CI exercises API 1.9 and 1.10. `api-version.mjs` selects compatible, pinned instrumentation versions for each job. Instrumentation 0.300 and newer Pino/Winston packages import the Logs API from API 1.10; overriding their peer range cannot supply those exports. The API 1.9 job uses the preceding instrumentation generation. Other producer versions remain unchanged.

To run both variants locally:

```sh
node test/api-version.mjs 1.9.0
npm install --package-lock=false
npm run verify
node test/api-version.mjs 1.10.0
npm ci
npm run verify
```

`test/generated/` is ignored and regenerated for type/runtime checks. Dependency versions are pinned so changes in library behavior require a compatibility review. The version in the registration symbol in `src/index.ts` must be updated with the package version; it prevents reusing an older implementation after an adapter upgrade.

See [all tested versions and limitations](../docs/compatibility.md#broader-ecosystem-checks). Integration dependencies are development-only and are not included in the vendored adapter or package runtime.
