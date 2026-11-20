import type { InstrumentationConfig } from '@opentelemetry/instrumentation';

export interface SapphireInstrumentationConfig extends InstrumentationConfig {
  /** Emit a span for each eligible interaction handler's parse call. Defaults to false. */
  traceInteractionHandlerParse?: boolean;
  /** Emit a span for each individual precondition evaluation. Defaults to false. */
  traceIndividualPreconditions?: boolean;
  /** Emit spans for message command argument resolution. Defaults to false. */
  traceArguments?: boolean;
}
