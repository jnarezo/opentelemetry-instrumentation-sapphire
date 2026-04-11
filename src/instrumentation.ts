import { context, diag, SpanKind, SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { InstrumentationBase, InstrumentationNodeModuleDefinition, isWrapped } from '@opentelemetry/instrumentation';
import {
  ATTR_MESSAGING_CONSUMER_GROUP_NAME,
  ATTR_MESSAGING_DESTINATION_NAME,
  ATTR_MESSAGING_DESTINATION_TEMPORARY,
  ATTR_MESSAGING_OPERATION_NAME,
  ATTR_MESSAGING_OPERATION_TYPE,
  ATTR_MESSAGING_SYSTEM,
  MESSAGING_OPERATION_TYPE_VALUE_PROCESS,
} from '@opentelemetry/semantic-conventions/incubating';
import type { Listener } from '@sapphire/framework';
import type { ClientEvents } from 'discord.js';
import { isPromise } from 'node:util/types';
import type { SapphireInstrumentationConfig } from './types.ts';

export class SapphireInstrumentation extends InstrumentationBase<SapphireInstrumentationConfig> {
  constructor(config: SapphireInstrumentationConfig = {}) {
    super('opentelemetry-instrumentation-sapphire', '0.1.0', config);
  }

  protected init() {
    return [
      new InstrumentationNodeModuleDefinition(
        '@sapphire/framework',
        ['>=5.0.0'],
        (moduleExports, moduleVersion) => {
          if (moduleExports === undefined || moduleExports === null) {
            diag.info('sapphire instrumentation: no module found, skipping');
            return moduleExports;
          }

          diag.debug(`sapphire instrumentation: applying patch to @sapphire/framework@${moduleVersion}`);

          if (isWrapped(moduleExports.Listener.prototype._run)) {
            this._unwrap(moduleExports.Listener.prototype, '_run');
          }
          this._wrap(moduleExports.Listener.prototype, '_run', this._patchListenerInternalRun.bind(this));

          diag.info(`sapphire instrumentation: successfully wrapped @sapphire/framework@${moduleVersion}`);

          return moduleExports;
        },
        (moduleExports) => {
          if (moduleExports === undefined || moduleExports === null) {
            return moduleExports;
          }

          this._unwrap(moduleExports.Listener.prototype, '_run');
          return moduleExports;
        }
      ),
    ];
  }

  // private _patchSapphireClientEmit(original: typeof SapphireClient.prototype.emit) {
  //   const self = this;

  //   return function <Event extends keyof ClientEvents | string | symbol>(
  //     this: SapphireClient,
  //     event: Event,
  //     ...args: unknown[]
  //   ) {
  //     return context.with(context.active(), () => _endSpan(() => original.call(this, event, ...args), span));
  //   };
  // }

  private _patchListenerInternalRun(original: (this: Listener, ...args: unknown[]) => Promise<void>) {
    const self = this;

    return function (this: Listener, ...args: unknown[]) {
      // const [root, links]
      const span = self.tracer.startSpan(`${this.once ? 'once' : 'on'} ${String(this.event)}`, {
        kind: SpanKind.INTERNAL,
        attributes: {
          'sapphire.piece.name': this.name,
          'sapphire.piece.type': 'listener',
          'sapphire.listener.event': String(this.event),
          'sapphire.listener.frequency': this.once ? 'once' : 'on',
          [ATTR_MESSAGING_SYSTEM]: 'eventemitter',
          [ATTR_MESSAGING_OPERATION_NAME]: this.once ? 'once' : 'on',
          [ATTR_MESSAGING_OPERATION_TYPE]: MESSAGING_OPERATION_TYPE_VALUE_PROCESS,
          [ATTR_MESSAGING_DESTINATION_NAME]: String(this.event),
          [ATTR_MESSAGING_DESTINATION_TEMPORARY]: this.once,
          [ATTR_MESSAGING_CONSUMER_GROUP_NAME]: this.name,
        },
      });

      return context.with(trace.setSpan(context.active(), span), () =>
        _endSpan(() => original.call(this, ...args), span)
      );
    };
  }
}

function _endSpan<F extends () => unknown>(fn: F, span: Span) {
  try {
    const result = fn() as ReturnType<F>;
    if (isPromise(result)) {
      return Promise.resolve(result)
        .catch((err) => {
          if (err instanceof Error) {
            span.recordException(err);
            span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
          } else {
            span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
          }
          throw err;
        })
        .finally(() => {
          // span.setStatus({ code: SpanStatusCode.OK });
          span.end();
        });
    } else {
      // span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return result;
    }
  } catch (err) {
    if (err instanceof Error) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    } else {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
    }
    span.end();
    throw err;
  }
}
