import { InstrumentationBase, InstrumentationNodeModuleDefinition } from '@opentelemetry/instrumentation';
import { Hooks, type SapphireModule } from './hooks.ts';
import type { SapphireInstrumentationConfig } from './types.ts';

export class SapphireInstrumentation extends InstrumentationBase<SapphireInstrumentationConfig> {
  constructor(config: SapphireInstrumentationConfig = {}) {
    super('opentelemetry-instrumentation-sapphire', '0.1.0', config);
  }

  protected init() {
    const modules = new Map<object, Hooks>();
    return [
      new InstrumentationNodeModuleDefinition(
        '@sapphire/framework',
        ['>=5.0.0'],
        (framework: SapphireModule | undefined) => {
          if (framework?.Listener) {
            // OpenTelemetry can load both the CommonJS and ESM versions of the framework.
            for (const hooks of modules.values()) {
              hooks.enable();
            }
            if (!modules.has(framework.Listener.prototype)) {
              modules.set(
                framework.Listener.prototype,
                new Hooks(
                  framework,
                  () => this.tracer,
                  () => this.getConfig()
                )
              );
            }
          }
          return framework;
        },
        () => {
          for (const hooks of modules.values()) {
            hooks.disable();
          }
        }
      ),
    ];
  }
}
