# opentelemetry-instrumentation-sapphire

Adds OpenTelemetry tracing for `@sapphire/framework` listeners, commands, interaction handlers, preconditions, and startup.

## Installation

Install with your favorite package manager

```sh
# npm
npm install opentelemetry-instrumentation-sapphire

# pnpm
pnpm add opentelemetry-instrumentation-sapphire

# yarn
yarn add opentelemetry-instrumentation-sapphire

```

## Usage

You must register instrumentation using the OpenTelemetry Node SDK. As with other instrumentation libraries, you must initialize instrumentation as-soon-as-possible before `@sapphire/framework` is imported elsewhere by your app.

```typescript
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { SapphireInstrumentation } from "opentelemetry-instrumentation-sapphire";

registerInstrumentations({
  tracerProvider,
  instrumentations: [
    new SapphireInstrumentation({
      // see below for configuration options
    })
  ]
});
```

If you are missing spans or do not see the instrumentation being loaded in OTEL debug logs, try the following:
- Preload your telemetry code separately by launching `node` with `--require telemetry.cjs` / `--import telemetry.mjs`. This guarantees the import script will finish completely before your app launches.
- Convert your app to CommonJS. Native ESM import hooks are still unreliable.

If you want, you can [read more about the above issues](https://github.com/open-telemetry/opentelemetry-js/blob/1cf5ef37f4f6d552f00a74d4533b218772b1168f/doc/esm-support.md) or [look at this thread](https://github.com/open-telemetry/opentelemetry-js-contrib/issues/2390#issuecomment-2299738738).

## Config

| Option | Default | Adds |
| --- | --- | --- |
| `traceInteractionHandlerParse` | `false` | A span for each eligible interaction handler's `parse` callback, with a matched or unmatched outcome |
| `traceIndividualPreconditions` | `false` | A span for each registered precondition evaluated |
| `traceArguments` | `false` | Spans for message command argument resolution through `Args` |

## Span coverage

- **Listeners and routing** keep the existing `on <event>` and `once <event>` spans. Callback exceptions set error status even when Sapphire catches them. Unknown commands, missing command handlers, and unmatched interactions appear as routing outcomes when available.
- **Commands** get spans for message, slash, context menu, and command autocomplete callbacks. Message commands also trace prefix lookup and `messagePreParse`.
- **Interaction handlers** get a run span for each matched handler. With per-handler parse tracing disabled, parse exceptions are recorded on the enclosing Sapphire listener span.
- **Preconditions** get separate spans for global and command-local evaluation. Expected denials have a `sapphire.outcome` of `denied` and include the Sapphire error identifier.
- **Startup** traces login, framework store loading, pre-login and post-login plugin hooks, and application command registration callbacks and per-command registry sync.

Sapphire spans use the active OpenTelemetry context. Discord gateway or WebSocket spans can be parents when their instrumentation propagates context to Sapphire. Discord REST spans started during a Sapphire callback can appear as its descendants. For asynchronous event fan-out, each Sapphire listener span measures its own execution.
