import {
  context,
  createContextKey,
  diag,
  SpanKind,
  trace,
  type Attributes,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import {
  ATTR_MESSAGING_CONSUMER_GROUP_NAME,
  ATTR_MESSAGING_DESTINATION_NAME,
  ATTR_MESSAGING_DESTINATION_TEMPORARY,
  ATTR_MESSAGING_OPERATION_NAME,
  ATTR_MESSAGING_OPERATION_TYPE,
  ATTR_MESSAGING_SYSTEM,
  MESSAGING_OPERATION_TYPE_VALUE_PROCESS,
} from '@opentelemetry/semantic-conventions/incubating';
import type { ApplicationCommandRegistry, Command, SapphireClient } from '@sapphire/framework';
import { MethodPatches } from './patches.ts';
import { observe, recordFailure, recordSuccess } from './spans.ts';
import type { SapphireInstrumentationConfig } from './types.ts';

export type SapphireModule = typeof import('@sapphire/framework');

const listenerKey = createContextKey('sapphire.listener');
const registrySyncKey = createContextKey('sapphire.application_command_registry');
interface ListenerExecution {
  piece: object;
  span: Span;
  failed: boolean;
}

interface RegistrySync {
  registry: ApplicationCommandRegistry;
  span: Span | undefined;
}

const commandMethods = ['messageRun', 'chatInputRun', 'contextMenuRun'] as const;
const preconditionConfigurationErrors = new Set([
  'preconditionUnavailable',
  'preconditionMissingMessageHandler',
  'preconditionMissingChatInputHandler',
  'preconditionMissingContextMenuHandler',
]);
const storeNames = [
  'ArgumentStore',
  'CommandStore',
  'InteractionHandlerStore',
  'ListenerStore',
  'PreconditionStore',
] as const;

export class Hooks {
  private readonly patches = new MethodPatches();
  private readonly framework: SapphireModule;
  private readonly moduleLabel: string;
  private readonly tracer: () => Tracer;
  private readonly config: () => SapphireInstrumentationConfig;
  private enabled = false;

  constructor(
    framework: SapphireModule,
    version: string | undefined,
    tracer: () => Tracer,
    config: () => SapphireInstrumentationConfig
  ) {
    this.framework = framework;
    this.moduleLabel = version ? `@sapphire/framework@${version}` : '@sapphire/framework';
    this.tracer = tracer;
    this.config = config;
    this.enable();
  }

  enable(): void {
    if (this.enabled) {
      return;
    }
    diag.debug(`sapphire instrumentation: applying patch to ${this.moduleLabel}`);
    this.enabled = true;
    this.patches.setActive(true);
    // Revisit registered pieces and plugins that may have been loaded while tracing was disabled.
    this.patchListeners();
    this.patchCommands();
    this.patchInteractionHandlers();
    this.patchPreconditions();
    this.patchMessageParsing();
    this.patchStartup();
    this.patchRoutingOutcomes();
    diag.info(`sapphire instrumentation: successfully wrapped ${this.moduleLabel}`);
  }

  disable(): void {
    if (!this.enabled) {
      return;
    }
    diag.debug(`sapphire instrumentation: removing patch from ${this.moduleLabel}`);
    this.enabled = false;
    this.patches.setActive(false);
    diag.info(`sapphire instrumentation: successfully unwrapped ${this.moduleLabel}`);
  }

  private span(
    name: string,
    attributes: Attributes,
    call: () => unknown,
    success: (value: unknown, span: Span) => void = () => {},
    failure: (error: unknown, span: Span) => void = (error, span) => recordFailure(span, error)
  ): unknown {
    return this.tracer().startActiveSpan(name, { kind: SpanKind.INTERNAL, attributes }, (span) =>
      observe(
        call,
        (value) => success(value, span),
        (error) => failure(error, span),
        () => span.end()
      )
    );
  }

  private patchListeners(): void {
    this.patches.wrap('Listener', this.framework.Listener.prototype, '_run', (listener, _args, call) => {
      const event = String(listener.event);
      const frequency = listener.once ? 'once' : 'on';
      const span = this.tracer().startSpan(`${frequency} ${event}`, {
        kind: SpanKind.INTERNAL,
        attributes: {
          'sapphire.piece.name': listener.name,
          'sapphire.piece.type': 'listener',
          'sapphire.listener.event': event,
          'sapphire.listener.frequency': frequency,
          [ATTR_MESSAGING_SYSTEM]: 'eventemitter',
          [ATTR_MESSAGING_OPERATION_NAME]: frequency,
          [ATTR_MESSAGING_OPERATION_TYPE]: MESSAGING_OPERATION_TYPE_VALUE_PROCESS,
          [ATTR_MESSAGING_DESTINATION_NAME]: event,
          [ATTR_MESSAGING_DESTINATION_TEMPORARY]: listener.once,
          [ATTR_MESSAGING_CONSUMER_GROUP_NAME]: listener.name,
        },
      });
      if (!span.isRecording()) {
        return context.with(trace.setSpan(context.active(), span), () => {
          span.end();
          return call();
        });
      }

      if (listener.event === this.framework.Events?.PreMessageParsed) {
        this.patchPrefix(listener.container.client);
      }
      const execution: ListenerExecution = { piece: listener, span, failed: false };
      const active = trace.setSpan(context.active(), span).setValue(listenerKey, execution);
      this.patches.wrap('Listener', listener, 'run', (piece, _args, run) => {
        const current = context.active().getValue(listenerKey) as ListenerExecution | undefined;
        if (current?.piece !== piece || trace.getActiveSpan() !== current.span) {
          return run();
        }
        // Sapphire handles callback errors inside _run and emits ListenerError.
        return observe(
          run,
          () => {},
          (error) => {
            if (!current.failed) {
              current.failed = true;
              recordFailure(current.span, error);
            }
          }
        );
      });
      return context.with(active, () =>
        observe(
          call,
          () => {},
          (error) => {
            if (!execution.failed) {
              recordFailure(span, error);
            }
          },
          () => span.end()
        )
      );
    });
  }

  private patchCommands(): void {
    const { CommandStore } = this.framework;
    this.patches.wrap('CommandStore', CommandStore?.prototype, 'set', (_store, [, piece], call) => {
      this.patchCommand(piece as Command);
      return call();
    });
    this.framework.container?.stores.get('commands')?.forEach((command) => this.patchCommand(command));
  }

  private patchCommand(command: Command): void {
    for (const method of [
      ...commandMethods,
      'autocompleteRun',
      'messagePreParse',
      'registerApplicationCommands',
    ] as const) {
      this.patches.wrap('Command', command, method, (piece, _args, call) =>
        this.span(
          `sapphire.command.${method}`,
          {
            'sapphire.piece.name': piece.name,
            'sapphire.piece.type': 'command',
          },
          call,
          recordSuccess
        )
      );
    }
  }

  private patchInteractionHandlers(): void {
    const { InteractionHandlerStore } = this.framework;
    const patchHandler = (handler: InstanceType<SapphireModule['InteractionHandler']>) => {
      const attributes = (piece: typeof handler): Attributes => ({
        'sapphire.piece.name': piece.name,
        'sapphire.piece.type': 'interaction_handler',
        'sapphire.interaction_handler.type': piece.interactionHandlerType,
      });
      this.patches.wrap('InteractionHandler', handler, 'run', (piece, _args, call) =>
        this.span('sapphire.interaction_handler.run', attributes(piece), call, recordSuccess)
      );
      this.patches.wrap('InteractionHandler', handler, 'parse', (piece, _args, call) => {
        if (this.config().traceInteractionHandlerParse) {
          return this.span('sapphire.interaction_handler.parse', attributes(piece), call, (value, span) => {
            if (value instanceof this.framework.Option) {
              span.setAttribute('sapphire.outcome', value.isSome() ? 'matched' : 'unmatched');
            }
          });
        }

        const parent = this.activeListener()?.span;
        if (!parent) {
          return call();
        }
        return observe(
          call,
          () => {},
          (error) => {
            parent.addEvent('sapphire.interaction_handler.parse_error', attributes(piece));
            if (error instanceof Error) {
              parent.recordException(error);
            }
          }
        );
      });
    };
    this.patches.wrap(
      'InteractionHandlerStore',
      InteractionHandlerStore?.prototype,
      'set',
      (_store, [, piece], call) => {
        patchHandler(piece as InstanceType<SapphireModule['InteractionHandler']>);
        return call();
      }
    );
    this.framework.container?.stores.get('interaction-handlers')?.forEach(patchHandler);

    this.patches.wrap('InteractionHandlerStore', InteractionHandlerStore?.prototype, 'run', (_store, _args, call) => {
      const parent = this.activeListener()?.span;
      return parent
        ? observe(
            call,
            (value) => parent.setAttribute('sapphire.outcome', value ? 'matched' : 'no_matching_handler'),
            () => {}
          )
        : call();
    });
  }

  private patchPreconditions(): void {
    const { PreconditionStore, PreconditionContainerArray } = this.framework;
    for (const method of commandMethods) {
      this.patches.wrap('PreconditionStore', PreconditionStore?.prototype, method, (_store, [, command], call) =>
        this.preconditions('global', method, command as Command, call)
      );
      this.patches.wrap(
        'PreconditionContainerArray',
        PreconditionContainerArray?.prototype,
        method,
        (container, [, command], call) => {
          if ((command as Command | undefined)?.preconditions !== container) {
            return call();
          }
          return this.preconditions('command', method, command as Command, call);
        }
      );
    }

    const patchPrecondition = (piece: InstanceType<SapphireModule['Precondition']>) => {
      for (const method of commandMethods) {
        this.patches.wrap('Precondition', piece, method, (check, [, command], call) => {
          if (!this.config().traceIndividualPreconditions) {
            return call();
          }
          return this.span(
            'sapphire.precondition.run',
            {
              'sapphire.piece.name': check.name,
              'sapphire.piece.type': 'precondition',
              'sapphire.command.name': (command as Command).name,
              'sapphire.command.method': method,
            },
            call,
            (value, span) => this.recordResult(span, value, 'allowed', 'denied')
          );
        });
      }
    };

    this.patches.wrap('PreconditionStore', PreconditionStore?.prototype, 'set', (_store, [, piece], call) => {
      patchPrecondition(piece as InstanceType<SapphireModule['Precondition']>);
      return call();
    });
    this.framework.container?.stores.get('preconditions')?.forEach(patchPrecondition);
  }

  private preconditions(scope: string, method: string, command: Command, call: () => unknown): unknown {
    return this.span(
      `sapphire.preconditions.${scope}`,
      {
        'sapphire.command.name': command.name,
        'sapphire.command.method': method,
      },
      call,
      (value, span) => this.recordResult(span, value, 'allowed', 'denied')
    );
  }

  private recordResult(span: Span, value: unknown, success: string, rejection: string): void {
    if (!(value instanceof this.framework.Result)) {
      return;
    }
    if (value.isOk()) {
      span.setAttribute('sapphire.outcome', success);
      return;
    }
    const error: unknown = value.unwrapErr();
    if (error instanceof this.framework.UserError) {
      span.setAttribute('sapphire.error.identifier', error.identifier);
      if (rejection !== 'denied' || !preconditionConfigurationErrors.has(error.identifier)) {
        span.setAttribute('sapphire.outcome', rejection);
        return;
      }
    }
    recordFailure(span, error);
  }

  private patchPrefix(client: SapphireClient): void {
    this.patches.wrap('SapphireClient', client, 'fetchPrefix', (_client, _args, call) =>
      this.span('sapphire.message.fetch_prefix', {}, call)
    );
  }

  private patchMessageParsing(): void {
    for (const method of ['pickResult', 'restResult', 'repeatResult', 'peekResult'] as const) {
      this.patches.wrap('Args', this.framework.Args?.prototype, method, (args, [type], call) => {
        // Other forms of peekResult delegate to pickResult.
        if (!this.config().traceArguments || (method === 'peekResult' && typeof type !== 'function')) {
          return call();
        }
        return this.span(
          `sapphire.arguments.${method}`,
          {
            'sapphire.command.name': args.command.name,
            'sapphire.argument.type': typeof type === 'string' ? type : undefined,
          },
          call,
          (value, span) => this.recordResult(span, value, 'resolved', 'invalid')
        );
      });
    }
  }

  private patchStartup(): void {
    const { SapphireClient, ApplicationCommandRegistry, PluginHook } = this.framework;
    this.patches.wrap('SapphireClient', SapphireClient?.prototype, 'login', (_client, _args, call) =>
      this.span('sapphire.client.login', {}, call)
    );
    for (const store of storeNames) {
      this.patches.wrap(store, this.framework[store]?.prototype, 'loadAll', (pieceStore, _args, call) =>
        this.span('sapphire.store.load_all', { 'sapphire.store.name': pieceStore.name }, call)
      );
    }
    this.patches.wrap(
      'ApplicationCommandRegistry',
      ApplicationCommandRegistry?.prototype,
      'runAPICalls',
      (registry, _args, call) =>
        this.span(
          'sapphire.application_command_registry.sync',
          { 'sapphire.command.name': registry.commandName },
          () => {
            const sync: RegistrySync = { registry, span: trace.getActiveSpan() };
            return context.with(context.active().setValue(registrySyncKey, sync), call);
          }
        )
    );
    // Registry API failures are sometimes caught and reported only through Sapphire's logger.
    this.patches.wrap(
      'ApplicationCommandRegistry',
      ApplicationCommandRegistry?.prototype,
      'error',
      (registry, [, error], call) => {
        const sync = context.active().getValue(registrySyncKey) as RegistrySync | undefined;
        if (sync?.registry === registry && sync.span) {
          recordFailure(sync.span, error);
        }
        return call();
      }
    );

    const plugins = SapphireClient?.plugins;
    const patchPlugins = () => {
      for (const entry of plugins?.registry ?? []) {
        if (entry.type === PluginHook.PreLogin || entry.type === PluginHook.PostLogin) {
          this.patches.wrap('Plugin', entry, 'hook', (_client, _args, call) =>
            this.span(
              'sapphire.plugin.hook',
              { 'sapphire.plugin.hook': entry.type, 'sapphire.plugin.name': entry.name },
              call
            )
          );
        }
      }
    };
    patchPlugins();
    this.patches.wrap('PluginManager', plugins, 'registerHook', (_manager, _args, call) => {
      const result = call();
      patchPlugins();
      return result;
    });
  }

  private activeListener(): ListenerExecution | undefined {
    const execution = context.active().getValue(listenerKey) as ListenerExecution | undefined;
    return execution?.span === trace.getActiveSpan() ? execution : undefined;
  }

  private patchRoutingOutcomes(): void {
    const { Events, SapphireClient } = this.framework;
    if (!Events) {
      return;
    }
    const outcomes = new Map<string, string>([
      [Events.UnknownChatInputCommand, 'unknown_command'],
      [Events.UnknownContextMenuCommand, 'unknown_command'],
      [Events.UnknownMessageCommand, 'unknown_command'],
      [Events.UnknownMessageCommandName, 'unknown_command'],
      [Events.CommandDoesNotHaveChatInputCommandHandler, 'missing_command_handler'],
      [Events.CommandDoesNotHaveContextMenuCommandHandler, 'missing_command_handler'],
      [Events.CommandDoesNotHaveMessageCommandHandler, 'missing_command_handler'],
      [Events.NonPrefixedMessage, 'no_prefix'],
    ]);
    this.patches.wrap('SapphireClient', SapphireClient?.prototype, 'emit', (_client, [event, error], call) => {
      if (typeof event === 'string') {
        const outcome = outcomes.get(event);
        if (outcome) {
          this.activeListener()?.span.setAttribute('sapphire.outcome', outcome);
        } else if (event === Events.ApplicationCommandRegistriesBulkOverwriteError) {
          const span = this.activeListener()?.span;
          if (span) {
            recordFailure(span, error);
          }
        }
      }
      return call();
    });
  }
}
