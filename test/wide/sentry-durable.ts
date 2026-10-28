import assert from 'node:assert/strict';
import { DurableObject } from 'cloudflare:workers';
import { trace } from '@opentelemetry/api';
import * as Sentry from '@sentry/cloudflare';

class SentryProbe extends DurableObject<Env> {
  async probe() {
    const root = trace.getActiveSpan()!.spanContext();
    let processed = 0;
    await Sentry.withScope(async scope => {
      scope.addEventProcessor(event => { processed++; return event; });
      Sentry.captureException(new Error('synthetic Durable Object error'));
      await Sentry.flush(1000);
      assert.deepEqual(trace.getActiveSpan()?.spanContext(), root);
    });
    assert.equal(processed, 1);
    return root;
  }
}
export const SentryObject = Sentry.instrumentDurableObjectWithSentry(() => ({
  dsn: 'https://synthetic@example.invalid/1', cacheClient: false, defaultIntegrations: false,
  transport: () => ({ send: async () => ({}), flush: async () => true }),
}), SentryProbe);
