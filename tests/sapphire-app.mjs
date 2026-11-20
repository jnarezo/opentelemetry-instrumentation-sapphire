import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire, register } from 'node:module';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { context, diag, DiagLogLevel, SpanKind } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { SapphireInstrumentation } from '../dist/index.js';
import { assertParent, TestSpanExporter, waitForSignal } from './telemetry-fixture.mjs';

const exporter = new TestSpanExporter();
const tracerProvider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
/** @type {string[]} */
const debugLogs = [];
/** @type {string[]} */
const infoLogs = [];
diag.setLogger(
  {
    debug: (message) => debugLogs.push(message),
    info: (message) => infoLogs.push(message),
    error: () => {},
    warn: () => {},
    verbose: () => {},
  },
  DiagLogLevel.DEBUG
);
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
  const scenario = process.argv[3];
  if (scenario === 'loader') {
    await verifyLoader(framework);
  } else {
    const { verifyLifecycle } = await import('./sapphire-lifecycle.mjs');
    assert.ok(scenario, 'Expected a scenario name');
    await verifyLifecycle(scenario, {
      framework,
      tracer: tracerProvider.getTracer('sapphire-test-app'),
      exporter,
      instrumentation,
      debugLogs,
    });
  }
} finally {
  unregister();
  diag.disable();
  context.disable();
  await tracerProvider.shutdown();
}

/** @param {typeof import('@sapphire/framework')} framework */
async function verifyLoader(framework) {
  const { Listener, ListenerStore } = framework;
  const moduleLabel = `@sapphire/framework@${framework.version}`;
  assert.ok(debugLogs.includes(`sapphire instrumentation: applying patch to ${moduleLabel}`));
  assert.ok(infoLogs.includes(`sapphire instrumentation: successfully wrapped ${moduleLabel}`));
  for (const hook of [
    'Listener._run',
    'CommandStore.set',
    'InteractionHandlerStore.run',
    'PreconditionStore.chatInputRun',
    'SapphireClient.login',
  ]) {
    assert.ok(debugLogs.includes(`sapphire instrumentation: successfully wrapped ${hook}`));
  }

  const tracer = tracerProvider.getTracer('sapphire-test-app');
  const event = 'testEvent';
  const root = fileURLToPath(new URL('.', import.meta.url));
  const path = fileURLToPath(import.meta.url);

  /** @param {boolean} instrumented */
  async function dispatch(instrumented) {
    const emitter = new EventEmitter();
    const store = new ListenerStore();
    const completion = new EventEmitter();
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

    class OneShotListener extends TestListener {
      async unload() {
        await super.unload();
        completion.emit('unloaded');
      }
    }

    await store.insert(new TestListener({ store, root, path, name: 'regular' }, { emitter, event }));
    await store.insert(new OneShotListener({ store, root, path, name: 'one-shot' }, { emitter, event, once: true }));

    await tracer.startActiveSpan('dispatch', async (span) => {
      try {
        const unloaded = waitForSignal(completion, 'unloaded');
        emitter.emit(event, 'payload');
        await unloaded;
        if (instrumented) {
          await exporter.waitForSpan(`on ${event}`);
          await exporter.waitForSpan(`once ${event}`);
        }
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

  const spans = await dispatch(true);
  assert.equal(
    debugLogs.filter((message) => message === 'sapphire instrumentation: successfully wrapped Listener.run').length,
    1
  );
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
    assertParent(listener, parent);
    assertParent(handler, listener);
  }

  debugLogs.length = 0;
  infoLogs.length = 0;
  unregister();
  assert.ok(debugLogs.includes(`sapphire instrumentation: removing patch from ${moduleLabel}`));
  assert.ok(infoLogs.includes(`sapphire instrumentation: successfully unwrapped ${moduleLabel}`));
  exporter.reset();
  const unpatchedSpans = await dispatch(false);
  assert.deepEqual(unpatchedSpans.map((span) => span.name).sort(), ['dispatch', 'handle one-shot', 'handle regular']);
}
