import { context, trace } from '@opentelemetry/api';
import { register } from '../src/index.js';

register();
const tracer = trace.getTracer('example');

export default {
  async fetch(): Promise<Response> {
    const invocation = trace.getActiveSpan()?.spanContext();
    return tracer.startActiveSpan('application', async span => {
      try {
        span.setAttribute('example.enabled', true);
        await Promise.resolve();
        // Existing libraries and loggers use their ordinary OTel imports.
        const active = trace.getSpan(context.active())?.spanContext();
        console.log(JSON.stringify({ message: 'Handling request', ...active }));
        return Response.json({ invocation, active });
      } finally {
        span.end();
      }
    });
  },
} satisfies ExportedHandler;
