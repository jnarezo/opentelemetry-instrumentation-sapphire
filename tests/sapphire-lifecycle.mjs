import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';
import { SpanStatusCode } from '@opentelemetry/api';
import { ChannelType, Client, Collection } from 'discord.js';

/**
 * @param {typeof import('@sapphire/framework')} framework
 * @param {import('@opentelemetry/api').Tracer} tracer
 * @param {import('@opentelemetry/sdk-trace').InMemorySpanExporter} exporter
 * @param {import('../dist/index.js').SapphireInstrumentation} instrumentation
 */
export async function verifyLifecycle(framework, tracer, exporter, instrumentation) {
  const { Command, Events, InteractionHandler, InteractionHandlerTypes, Listener, Precondition, SapphireClient } =
    framework;
  const client = new SapphireClient({
    intents: [],
    baseUserDirectory: null,
    enableLoaderTraceLoggings: false,
    loadDefaultErrorListeners: false,
    loadApplicationCommandRegistriesStatusListeners: false,
    loadMessageCommandListeners: true,
    disableMentionPrefix: true,
    typing: false,
    fetchPrefix: async () => {
      await Promise.resolve();
      return '!';
    },
  });

  const root = fileURLToPath(new URL('.', import.meta.url));
  const path = fileURLToPath(import.meta.url);
  const failure = new Error('callback failed');
  const registryFailure = new Error('registry API failed');
  const commandStore = client.stores.get('commands');
  const handlerStore = client.stores.get('interaction-handlers');
  const listenerStore = client.stores.get('listeners');
  const preconditionStore = client.stores.get('preconditions');

  class Gate extends Precondition {
    /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
    chatInputRun(interaction) {
      return interaction.commandName === 'denied' ? this.error({ identifier: 'gate_closed' }) : this.ok();
    }
  }

  class ExampleCommand extends Command {
    chatInputRun = async () => {
      await Promise.resolve();
      tracer.startSpan('command dependency').end();
      throw failure;
    };

    /** @param {import('discord.js').Message} _message @param {import('@sapphire/framework').Args} args */
    async messageRun(_message, args) {
      assert.equal((await args.pickResult('integer')).isErr(), true);
    }

    contextMenuRun() {
      return 'context menu completed';
    }

    autocompleteRun() {
      return 'autocomplete completed';
    }

    /** @param {import('@sapphire/framework').ApplicationCommandRegistry} registry */
    registerApplicationCommands(registry) {
      if (this.name === 'denied') {
        throw failure;
      }
      registry.registerChatInputCommand({ name: 'example', description: 'Example' });
    }
  }

  class ButtonHandler extends InteractionHandler {
    /** @param {import('discord.js').ButtonInteraction} interaction */
    parse(interaction) {
      if (this.name === 'broken') {
        throw failure;
      }
      return interaction.customId === 'match' && this.name !== 'unmatched' ? this.some('parsed') : this.none();
    }

    /** @param {import('discord.js').ButtonInteraction} _interaction @param {string} parsed */
    async run(_interaction, parsed) {
      await Promise.resolve();
      assert.equal(parsed, 'parsed');
      if (this.name === 'throws') {
        throw failure;
      }
      tracer.startSpan('handler dependency').end();
    }
  }

  class BrokenListener extends Listener {
    async run() {
      await Promise.resolve();
      throw failure;
    }
  }

  /** @param {string} name @param {'chat' | 'context' | 'autocomplete'} [type] */
  const commandInteraction = (name, type = 'chat') =>
    /** @type {import('discord.js').Interaction} */ (
      /** @type {unknown} */ ({
        commandId: 'test-id',
        commandName: name,
        isChatInputCommand: () => type === 'chat',
        isContextMenuCommand: () => type === 'context',
        isAutocomplete: () => type === 'autocomplete',
      })
    );
  /** @param {string} customId */
  const button = (customId) =>
    /** @type {import('discord.js').Interaction} */ (
      /** @type {unknown} */ ({
        customId,
        isChatInputCommand: () => false,
        isContextMenuCommand: () => false,
        isAutocomplete: () => false,
        isMessageComponent: () => true,
        isButton: () => true,
      })
    );
  const message = /** @type {import('discord.js').ClientEvents['messageCreate'][0]} */ (
    /** @type {unknown} */ ({
      author: { bot: false },
      channel: { type: ChannelType.DM },
      client,
      content: '!example private-input',
    })
  );

  const originalLogin = Object.getOwnPropertyDescriptor(Client.prototype, 'login');
  assert.ok(originalLogin);
  /** @type {string[]} */
  const startup = [];
  Client.prototype.login = function () {
    startup.push('discord');
    return Promise.resolve('test-login');
  };
  SapphireClient.plugins.registerPreLoginHook(() => startup.push('pre'), 'pre-test');
  SapphireClient.plugins.registerPostLoginHook(async () => {
    await Promise.resolve();
    startup.push('post');
  }, 'post-test');

  try {
    assert.equal(await client.login(), 'test-login');
    assert.deepEqual(startup, ['pre', 'discord', 'post']);
  } finally {
    Object.defineProperty(Client.prototype, 'login', originalLogin);
    SapphireClient.plugins.registry.clear();
  }

  /** @param {string} name @param {string} [piece] */
  const span = (name, piece) => {
    const found = exporter
      .getFinishedSpans()
      .find((item) => item.name === name && (!piece || item.attributes['sapphire.piece.name'] === piece));
    assert.ok(found, `missing span ${name} ${piece ?? ''}`);
    return found;
  };
  /** @param {ReturnType<typeof span>} child @param {ReturnType<typeof span>} parent */
  const assertParent = (child, parent) => {
    assert.equal(child.spanContext().traceId, parent.spanContext().traceId);
    assert.equal(child.parentSpanContext?.spanId, parent.spanContext().spanId);
  };

  assertParent(span('sapphire.store.load_all'), span('sapphire.client.login'));
  assert.equal(exporter.getFinishedSpans().filter((item) => item.name === 'sapphire.plugin.hook').length, 2);
  assertParent(span('sapphire.plugin.hook'), span('sapphire.client.login'));
  exporter.reset();

  const example = new ExampleCommand({ store: commandStore, root, path, name: 'example' });
  await commandStore.insert(example);
  const denied = await commandStore.insert(new ExampleCommand({ store: commandStore, root, path, name: 'denied' }));
  denied.preconditions.append(/** @type {import('@sapphire/framework').SimplePreconditionKeys} */ ('gate'));
  await preconditionStore.insert(new Gate({ store: preconditionStore, root, path, name: 'gate' }));
  for (const name of ['matched', 'unmatched', 'throws', 'broken']) {
    await handlerStore.insert(
      new ButtonHandler(
        { store: handlerStore, root, path, name },
        { interactionHandlerType: InteractionHandlerTypes.Button }
      )
    );
  }
  await listenerStore.insert(
    new BrokenListener({ store: listenerStore, root, path, name: 'broken' }, { event: 'traceTestFailure' })
  );

  /** @type {unknown[]} */
  const errors = [];
  client.on(Events.ListenerError, (error) => errors.push(error));
  client.on(Events.ChatInputCommandError, (error) => errors.push(error));
  client.on(Events.InteractionHandlerError, (error) => errors.push(error));
  client.on(Events.InteractionHandlerParseError, (error) => errors.push(error));

  try {
    await tracer.startActiveSpan('discord dispatch', async (upstream) => {
      client.emit(Events.InteractionCreate, commandInteraction('example'));
      await setImmediate();
      upstream.end();
    });
    const command = span('sapphire.command.chatInputRun', 'example');
    assert.equal(command.status.code, SpanStatusCode.ERROR);
    assert.equal(
      command.events.find((event) => event.name === 'exception')?.attributes?.['exception.message'],
      failure.message
    );
    assertParent(span('command dependency'), command);
    assert.equal(command.spanContext().traceId, span('discord dispatch').spanContext().traceId);
    assert.equal(span('sapphire.preconditions.global').attributes['sapphire.outcome'], 'allowed');
    assert.equal(span('sapphire.preconditions.command').attributes['sapphire.outcome'], 'allowed');

    exporter.reset();
    client.emit(Events.InteractionCreate, commandInteraction('does-not-exist'));
    await setImmediate();
    assert.equal(span('on possibleChatInputCommand').attributes['sapphire.outcome'], 'unknown_command');
    assert.equal(span('on interactionCreate').parentSpanContext, undefined);

    exporter.reset();
    client.emit(Events.InteractionCreate, commandInteraction('denied'));
    await setImmediate();
    const denial = span('sapphire.preconditions.command');
    assert.equal(denial.attributes['sapphire.outcome'], 'denied');
    assert.equal(denial.attributes['sapphire.error.identifier'], 'gate_closed');
    assert.equal(denial.status.code, SpanStatusCode.UNSET);
    assert.equal(
      exporter.getFinishedSpans().some((item) => item.name === 'sapphire.command.chatInputRun'),
      false
    );
    assert.equal(
      exporter.getFinishedSpans().some((item) => item.name === 'sapphire.precondition.run'),
      false
    );

    exporter.reset();
    client.emit(Events.InteractionCreate, button('match'));
    await setImmediate();
    assertParent(span('sapphire.interaction_handler.run', 'matched'), span('on interactionCreate'));
    assertParent(span('sapphire.interaction_handler.run', 'throws'), span('on interactionCreate'));
    assertParent(span('handler dependency'), span('sapphire.interaction_handler.run', 'matched'));
    assert.equal(span('sapphire.interaction_handler.run', 'throws').status.code, SpanStatusCode.ERROR);
    assert.equal(span('on interactionCreate').attributes['sapphire.outcome'], 'matched');
    assert.ok(
      span('on interactionCreate').events.some((event) => event.name === 'sapphire.interaction_handler.parse_error')
    );
    assert.equal(
      exporter.getFinishedSpans().some((item) => item.name === 'sapphire.interaction_handler.parse'),
      false
    );

    exporter.reset();
    client.emit('traceTestFailure');
    await setImmediate();
    assert.equal(span('on traceTestFailure').status.code, SpanStatusCode.ERROR);
    assert.deepEqual(errors, [failure, failure, failure, failure]);

    instrumentation.setConfig({
      traceInteractionHandlerParse: true,
      traceIndividualPreconditions: true,
      traceArguments: true,
    });
    exporter.reset();
    client.emit(Events.InteractionCreate, button('none'));
    await setImmediate();
    assert.equal(span('on interactionCreate').attributes['sapphire.outcome'], 'no_matching_handler');
    assert.equal(span('sapphire.interaction_handler.parse', 'unmatched').attributes['sapphire.outcome'], 'unmatched');
    assert.equal(span('sapphire.interaction_handler.parse', 'broken').status.code, SpanStatusCode.ERROR);
    assert.equal(
      exporter.getFinishedSpans().some((item) => item.name === 'sapphire.interaction_handler.run'),
      false
    );

    exporter.reset();
    client.emit(Events.InteractionCreate, commandInteraction('denied'));
    await setImmediate();
    assertParent(span('sapphire.precondition.run', 'gate'), span('sapphire.preconditions.command'));

    exporter.reset();
    client.emit(Events.MessageCreate, message);
    await setImmediate();
    span('sapphire.message.fetch_prefix');
    span('sapphire.command.messagePreParse', 'example');
    const argument = span('sapphire.arguments.pickResult');
    assert.equal(argument.attributes['sapphire.outcome'], 'invalid');
    assert.equal(argument.status.code, SpanStatusCode.UNSET);
    assertParent(argument, span('sapphire.command.messageRun', 'example'));
    assert.equal(JSON.stringify(argument.attributes).includes('private-input'), false);

    exporter.reset();
    client.emit(Events.InteractionCreate, commandInteraction('example', 'context'));
    client.emit(Events.InteractionCreate, commandInteraction('example', 'autocomplete'));
    await setImmediate();
    assert.equal(span('sapphire.command.contextMenuRun', 'example').attributes['sapphire.outcome'], 'success');
    span('sapphire.command.autocompleteRun', 'example');

    exporter.reset();
    /** @type {unknown} */
    let registrationError;
    client.on(Events.CommandApplicationCommandRegistryError, (error) => {
      registrationError = error;
    });
    client.application = /** @type {import('discord.js').ClientApplication} */ (
      /** @type {unknown} */ ({
        commands: {
          fetch: () => Promise.resolve(new Collection()),
          create: () => Promise.reject(registryFailure),
        },
      })
    );
    client.emit(Events.ClientReady, /** @type {import('discord.js').Client<true>} */ (client));
    await setImmediate();
    const registration = span('sapphire.command.registerApplicationCommands', 'denied');
    assert.equal(registration.status.code, SpanStatusCode.ERROR);
    assertParent(registration, span('once clientReady'));
    assert.equal(registrationError, failure);
    const sync = exporter
      .getFinishedSpans()
      .find(
        (item) =>
          item.name === 'sapphire.application_command_registry.sync' &&
          item.attributes['sapphire.command.name'] === 'example'
      );
    assert.ok(sync);
    assert.equal(sync.status.code, SpanStatusCode.ERROR);
    assert.equal(sync.events[0]?.attributes?.['exception.message'], registryFailure.message);

    instrumentation.disable();
    try {
      exporter.reset();
      client.emit('traceTestFailure');
      assert.equal(example.contextMenuRun(), 'context menu completed');
      await commandStore.insert(new ExampleCommand({ store: commandStore, root, path, name: 'added-while-disabled' }));
      await setImmediate();
      assert.deepEqual(exporter.getFinishedSpans(), []);
    } finally {
      instrumentation.enable();
    }

    client.emit('traceTestFailure');
    client.emit(Events.InteractionCreate, commandInteraction('added-while-disabled', 'context'));
    await setImmediate();
    assert.equal(span('on traceTestFailure').status.code, SpanStatusCode.ERROR);
    span('sapphire.command.contextMenuRun', 'added-while-disabled');
  } finally {
    await client.destroy();
  }
}
