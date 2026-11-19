import { SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { expect, test } from 'vitest';
import { SapphireInstrumentation } from '../src/index.ts';

class TestInstrumentation extends SapphireInstrumentation {
  listenerModule() {
    const [definition] = this.init();
    return definition;
  }
}

const failure = new Error('listener failed');

test.each([
  [
    'throws synchronously',
    () => {
      throw failure;
    },
  ],
  ['rejects asynchronously', () => Promise.reject(failure)],
])('ends and exports an error span when the wrapped callback %s', async (_description, run) => {
  class Listener {
    name = 'broken';
    event = 'testEvent';
    once = false;

    _run() {
      return run();
    }
  }

  const exporter = new InMemorySpanExporter();
  const tracerProvider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const instrumentation = new TestInstrumentation({ enabled: false });
  instrumentation.setTracerProvider(tracerProvider);
  const definition = instrumentation.listenerModule();
  const moduleExports = { Listener };
  try {
    definition.patch?.(moduleExports);
    const listener = new Listener();
    await expect(Promise.resolve().then(() => listener._run())).rejects.toBe(failure);

    await tracerProvider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      name: 'on testEvent',
      status: { code: SpanStatusCode.ERROR, message: failure.message },
      events: [
        {
          name: 'exception',
          attributes: { 'exception.type': 'Error', 'exception.message': failure.message },
        },
      ],
    });
  } finally {
    definition.unpatch?.(moduleExports);
    await tracerProvider.shutdown();
  }
});
