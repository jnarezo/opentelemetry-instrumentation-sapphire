# opentelemetry-instrumentation-sapphire

Adds opentelemetry tracing instrumentation for the `@sapphire/framework` library. Enables and adds tracing across registered listeners.

Additional instrumentation is work-in-progress.

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

Additional configuration is still WIP.