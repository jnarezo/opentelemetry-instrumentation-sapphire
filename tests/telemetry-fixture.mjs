import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { clearTimeout, setTimeout } from 'node:timers';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';

/** @typedef {import('@opentelemetry/sdk-trace').ReadableSpan} ReadableSpan */

export class TestSpanExporter extends InMemorySpanExporter {
  #events = new EventEmitter();

  /** @type {InMemorySpanExporter['export']} */
  export(spans, callback) {
    super.export(spans, callback);
    this.#events.emit('export');
  }

  /**
   * @param {string} name
   * @param {Record<string, string>} [attributes]
   */
  matching(name, attributes = {}) {
    return this.getFinishedSpans().filter(
      (span) => span.name === name && Object.entries(attributes).every(([key, value]) => span.attributes[key] === value)
    );
  }

  /**
   * @param {string} name
   * @param {Record<string, string>} [attributes]
   */
  span(name, attributes = {}) {
    const spans = this.matching(name, attributes);
    assert.equal(spans.length, 1, `expected one span named ${name} with ${JSON.stringify(attributes)}`);
    return spans[0];
  }

  /**
   * @param {string} name
   * @param {Record<string, string>} [attributes]
   */
  async waitForSpan(name, attributes = {}) {
    await waitForSignal(this.#events, 'export', () => this.matching(name, attributes).length > 0, name);
  }
}

/**
 * @param {EventEmitter} emitter
 * @param {string} event
 * @param {() => boolean} [ready]
 * @param {string} [description]
 */
export function waitForSignal(emitter, event, ready, description = event) {
  if (ready?.()) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, onSignal);
      reject(new Error(`Timed out waiting for ${description}`));
    }, 3_000);

    function onSignal() {
      if (ready && !ready()) {
        return;
      }
      clearTimeout(timer);
      emitter.off(event, onSignal);
      resolve(undefined);
    }

    emitter.on(event, onSignal);
  });
}

/** @param {ReadableSpan} child @param {ReadableSpan} parent */
export function assertParent(child, parent) {
  assert.equal(child.spanContext().traceId, parent.spanContext().traceId, `trace ID of ${child.name}`);
  assert.equal(child.parentSpanContext?.spanId, parent.spanContext().spanId, `parent span ID of ${child.name}`);
}
