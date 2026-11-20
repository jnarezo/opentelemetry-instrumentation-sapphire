import { SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { expect, test, vi } from 'vitest';
import { SapphireInstrumentation } from '../src/index.ts';

class TestInstrumentation extends SapphireInstrumentation {
  listenerModule() {
    const [definition] = this.init();
    return definition;
  }
}

const failure = new Error('listener failed');
const result = { accepted: true };

test.each([
  {
    description: 'returns synchronously',
    callback: () => result,
    assertResult: (/** @type {() => unknown} */ invoke) => expect(invoke()).toBe(result),
    status: SpanStatusCode.UNSET,
  },
  {
    description: 'resolves asynchronously',
    callback: () => Promise.resolve(result),
    assertResult: (/** @type {() => unknown} */ invoke) => expect(invoke()).resolves.toBe(result),
    status: SpanStatusCode.UNSET,
  },
  {
    description: 'throws synchronously',
    callback: () => {
      throw failure;
    },
    assertResult: (/** @type {() => unknown} */ invoke) => expect(invoke).toThrow(failure),
    status: SpanStatusCode.ERROR,
  },
  {
    description: 'rejects asynchronously',
    callback: () => Promise.reject(failure),
    assertResult: (/** @type {() => unknown} */ invoke) => expect(invoke()).rejects.toBe(failure),
    status: SpanStatusCode.ERROR,
  },
])(
  'preserves the callback contract and exports one span when it $description',
  async ({ callback, assertResult, status }) => {
    const run = vi.fn(callback);
    class Listener {
      name = 'example';
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
      await assertResult(() => listener._run());
      expect(run).toHaveBeenCalledTimes(1);

      await tracerProvider.forceFlush();
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]).toMatchObject({
        name: 'on testEvent',
        status: status === SpanStatusCode.ERROR ? { code: status, message: failure.message } : { code: status },
        events:
          status === SpanStatusCode.ERROR
            ? [
                {
                  name: 'exception',
                  attributes: { 'exception.type': 'Error', 'exception.message': failure.message },
                },
              ]
            : [],
      });
    } finally {
      definition.unpatch?.(moduleExports);
      await tracerProvider.shutdown();
    }
  }
);
