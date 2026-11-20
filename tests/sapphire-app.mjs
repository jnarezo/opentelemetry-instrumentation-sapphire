import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire, register } from 'node:module';
import process from 'node:process';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';
import { context, SpanKind } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { SapphireInstrumentation } from '../dist/index.js';
import { verifyLifecycle } from './sapphire-lifecycle.mjs';

const exporter = new InMemorySpanExporter();
const tracerProvider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
const instrumentation = new SapphireInstrumentation();
const unregister = registerInstrumentations({ tracerProvider, instrumentations: [instrumentation] });

try {
  const format = process.argv[2];
  assert.ok(format === 'CommonJS' || format === 'ESM');
  if (format === 'ESM') {
    register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
  }
  const framework =
    format === 'ESM'
      ? await import('@sapphire/framework')
      : /** @type {typeof import('@sapphire/framework')} */ (createRequire(import.meta.url)('@sapphire/framework'));
  const { Listener, ListenerStore } = framework;

  const tracer = tracerProvider.getTracer('sapphire-test-app');
  const event = 'testEvent';
  const root = fileURLToPath(new URL('.', import.meta.url));
  const path = fileURLToPath(import.meta.url);

  async function dispatch() {
    const emitter = new EventEmitter();
    const store = new ListenerStore();
    /** @type {[string, string][]} */
    const calls = [];

    class TestListener extends Listener {
      /** @param {string} payload */
      async run(payload) {
        await Promise.resolve();
        calls.push([this.name, payload]);
        tracer.startSpan(`handle ${this.name}`).end();
      }
    }

    await store.insert(new TestListener({ store, root, path, name: 'regular' }, { emitter, event }));
    await store.insert(new TestListener({ store, root, path, name: 'one-shot' }, { emitter, event, once: true }));

    await tracer.startActiveSpan('dispatch', async (span) => {
      try {
        emitter.emit(event, 'payload');
        // EventEmitter returns immediately. Let Sapphire finish the async callbacks and unload the one-shot listener.
        await setImmediate();
      } finally {
        span.end();
      }
    });

    assert.deepEqual(calls, [
      ['regular', 'payload'],
      ['one-shot', 'payload'],
    ]);
    assert.deepEqual([...store.keys()], ['regular']);
    await store.unloadAll();
    await tracerProvider.forceFlush();
    return exporter.getFinishedSpans();
  }

  const spans = await dispatch();
  assert.deepEqual(spans.map((span) => span.name).sort(), [
    'dispatch',
    'handle one-shot',
    'handle regular',
    'on testEvent',
    'once testEvent',
  ]);
  const parent = spans.find((span) => span.name === 'dispatch');
  assert.ok(parent);
  for (const [name, frequency] of [
    ['regular', 'on'],
    ['one-shot', 'once'],
  ]) {
    const listener = spans.find((span) => span.name === `${frequency} ${event}`);
    const handler = spans.find((span) => span.name === `handle ${name}`);
    assert.ok(listener);
    assert.ok(handler);
    assert.equal(listener.instrumentationScope.name, 'opentelemetry-instrumentation-sapphire');
    assert.equal(listener.kind, SpanKind.INTERNAL);
    assert.deepEqual(listener.attributes, {
      'sapphire.piece.name': name,
      'sapphire.piece.type': 'listener',
      'sapphire.listener.event': event,
      'sapphire.listener.frequency': frequency,
      'messaging.system': 'eventemitter',
      'messaging.operation.name': frequency,
      'messaging.operation.type': 'process',
      'messaging.destination.name': event,
      'messaging.destination.temporary': frequency === 'once',
      'messaging.consumer.group.name': name,
    });
    assert.equal(listener.spanContext().traceId, parent.spanContext().traceId);
    assert.equal(listener.parentSpanContext?.spanId, parent.spanContext().spanId);
    assert.equal(handler.spanContext().traceId, parent.spanContext().traceId);
    assert.equal(handler.parentSpanContext?.spanId, listener.spanContext().spanId);
  }

  exporter.reset();
  await verifyLifecycle(framework, tracer, exporter, instrumentation);

  unregister();
  exporter.reset();
  const unpatchedSpans = await dispatch();
  assert.deepEqual(unpatchedSpans.map((span) => span.name).sort(), ['dispatch', 'handle one-shot', 'handle regular']);
} finally {
  unregister();
  context.disable();
  await tracerProvider.shutdown();
}
