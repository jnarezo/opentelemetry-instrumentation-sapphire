import assert from 'node:assert/strict';
import { fileURLToPath, URL } from 'node:url';
import { SpanStatusCode } from '@opentelemetry/api';
import { ChannelType, Client, Collection } from 'discord.js';
import { assertParent, waitForSignal } from './telemetry-fixture.mjs';

/**
 * @typedef {object} Telemetry
 * @property {typeof import('@sapphire/framework')} framework
 * @property {import('@opentelemetry/api').Tracer} tracer
 * @property {import('./telemetry-fixture.mjs').TestSpanExporter} exporter
 * @property {import('../dist/index.js').SapphireInstrumentation} instrumentation
 * @property {string[]} debugLogs
 * @typedef {Telemetry & {client: import('@sapphire/framework').SapphireClient}} Fixture
 */

const location = { root: fileURLToPath(new URL('.', import.meta.url)), path: fileURLToPath(import.meta.url) };

/** @param {Telemetry} telemetry @param {(fixture: Fixture) => Promise<void>} scenario */
async function withClient(telemetry, scenario) {
  const { SapphireClient } = telemetry.framework;
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

  try {
    if (scenario !== verifyLogin) {
      await Promise.all([...client.stores.values()].map((store) => store.loadAll()));
      await telemetry.exporter.forceFlush();
      telemetry.exporter.reset();
    }
    await scenario({ ...telemetry, client });
  } finally {
    await client.destroy();
  }
}

/** @param {string} name @param {'chat' | 'context' | 'autocomplete'} [type] */
function commandInteraction(name, type = 'chat') {
  return /** @type {import('discord.js').Interaction} */ (
    /** @type {unknown} */ ({
      commandId: 'test-id',
      commandName: name,
      isChatInputCommand: () => type === 'chat',
      isContextMenuCommand: () => type === 'context',
      isAutocomplete: () => type === 'autocomplete',
    })
  );
}

/** @param {string} customId */
function button(customId) {
  return /** @type {import('discord.js').Interaction} */ (
    /** @type {unknown} */ ({
      customId,
      isChatInputCommand: () => false,
      isContextMenuCommand: () => false,
      isAutocomplete: () => false,
      isMessageComponent: () => true,
      isButton: () => true,
    })
  );
}

/** @param {string} name */
const piece = (name) => ({ 'sapphire.piece.name': name });

/** @param {Fixture} fixture */
async function verifyLogin({ framework: { SapphireClient }, client, exporter }) {
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
  } finally {
    Object.defineProperty(Client.prototype, 'login', originalLogin);
    SapphireClient.plugins.registry.clear();
  }

  assert.deepEqual(startup, ['pre', 'discord', 'post']);
  const login = exporter.span('sapphire.client.login');
  const stores = exporter.matching('sapphire.store.load_all');
  assert.ok(stores.length > 0);
  for (const store of stores) {
    assertParent(store, login);
  }
  for (const name of ['pre-test', 'post-test']) {
    assertParent(exporter.span('sapphire.plugin.hook', { 'sapphire.plugin.name': name }), login);
  }
  assert.equal(exporter.matching('sapphire.plugin.hook').length, 2);
}

/** @param {Fixture} fixture */
async function verifyCommandFailure({ framework: { Command, Events }, client, tracer, exporter, debugLogs }) {
  const failure = new Error('command failed');
  const store = client.stores.get('commands');
  class ExampleCommand extends Command {
    chatInputRun = async () => {
      await Promise.resolve();
      tracer.startSpan('command dependency').end();
      throw failure;
    };
  }
  await store.insert(new ExampleCommand({ ...location, store, name: 'example' }));

  let emittedError;
  client.once(Events.ChatInputCommandError, (error) => {
    emittedError = error;
  });
  await tracer.startActiveSpan('discord dispatch', async (upstream) => {
    try {
      client.emit(Events.InteractionCreate, commandInteraction('example'));
      await exporter.waitForSpan('on chatInputCommandAccepted');
    } finally {
      upstream.end();
    }
  });

  const command = exporter.span('sapphire.command.chatInputRun', piece('example'));
  assert.equal(emittedError, failure);
  assert.equal(command.status.code, SpanStatusCode.ERROR);
  assert.equal(
    command.events.find((event) => event.name === 'exception')?.attributes?.['exception.message'],
    failure.message
  );
  assertParent(exporter.span('command dependency'), command);
  const accepted = exporter.span('on chatInputCommandAccepted');
  const preRun = exporter.span('on preChatInputCommandRun');
  const possible = exporter.span('on possibleChatInputCommand');
  const interaction = exporter.span('on interactionCreate');
  assertParent(command, accepted);
  assertParent(accepted, preRun);
  assertParent(preRun, possible);
  assertParent(possible, interaction);
  assertParent(interaction, exporter.span('discord dispatch'));
  assert.equal(exporter.span('sapphire.preconditions.global').attributes['sapphire.outcome'], 'allowed');
  assert.equal(exporter.span('sapphire.preconditions.command').attributes['sapphire.outcome'], 'allowed');
  assert.ok(debugLogs.includes('sapphire instrumentation: successfully wrapped Command.chatInputRun'));
}

/** @param {Fixture} fixture */
async function verifyUnknownCommand({ framework: { Events }, client, exporter }) {
  const interaction = commandInteraction('does-not-exist');
  let reportedInteraction;
  client.once(Events.UnknownChatInputCommand, (payload) => {
    reportedInteraction = payload.interaction;
  });
  client.emit(Events.InteractionCreate, interaction);
  await exporter.waitForSpan('on possibleChatInputCommand');

  assert.equal(reportedInteraction, interaction);
  assert.equal(exporter.span('on possibleChatInputCommand').attributes['sapphire.outcome'], 'unknown_command');
  assert.equal(exporter.span('on interactionCreate').parentSpanContext, undefined);
  assert.equal(exporter.matching('sapphire.command.chatInputRun').length, 0);
}

/** @param {Fixture} fixture @param {boolean} traceIndividualPreconditions */
async function verifyDenial(
  { framework: { Command, Events, Precondition }, client, exporter, instrumentation },
  traceIndividualPreconditions
) {
  let calls = 0;
  class DeniedCommand extends Command {
    chatInputRun() {
      calls++;
    }
  }
  class Gate extends Precondition {
    chatInputRun() {
      return this.error({ identifier: 'gate_closed' });
    }
  }
  const commands = client.stores.get('commands');
  const preconditions = client.stores.get('preconditions');
  await preconditions.insert(new Gate({ ...location, store: preconditions, name: 'gate' }));
  const denied = new DeniedCommand({ ...location, store: commands, name: 'denied' });
  denied.preconditions.append(/** @type {import('@sapphire/framework').SimplePreconditionKeys} */ ('gate'));
  await commands.insert(denied);
  if (traceIndividualPreconditions) {
    instrumentation.setConfig({ traceIndividualPreconditions });
  }

  let denialIdentifier;
  client.once(Events.ChatInputCommandDenied, (error) => {
    denialIdentifier = error.identifier;
  });
  client.emit(Events.InteractionCreate, commandInteraction('denied'));
  await exporter.waitForSpan('on preChatInputCommandRun');

  assert.equal(denialIdentifier, 'gate_closed');
  assert.equal(calls, 0);
  const denial = exporter.span('sapphire.preconditions.command');
  assert.equal(denial.attributes['sapphire.outcome'], 'denied');
  assert.equal(denial.attributes['sapphire.error.identifier'], 'gate_closed');
  assert.equal(denial.status.code, SpanStatusCode.UNSET);
  assert.equal(exporter.matching('sapphire.command.chatInputRun').length, 0);
  if (traceIndividualPreconditions) {
    assertParent(exporter.span('sapphire.precondition.run', piece('gate')), denial);
  } else {
    assert.equal(exporter.matching('sapphire.precondition.run').length, 0);
  }
}

/** @param {Fixture} fixture @param {boolean} traceInteractionHandlerParse */
async function verifyHandlers(
  {
    framework: { Events, InteractionHandler, InteractionHandlerTypes },
    client,
    exporter,
    tracer,
    instrumentation,
    debugLogs,
  },
  traceInteractionHandlerParse
) {
  const failure = new Error('handler failed');
  /** @type {[string, string][]} */
  const calls = [];
  /** @type {unknown[]} */
  const errors = [];
  const store = client.stores.get('interaction-handlers');
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
      calls.push([this.name, parsed]);
      if (this.name === 'throws') {
        throw failure;
      }
      tracer.startSpan('handler dependency').end();
    }
  }

  for (const name of ['matched', 'unmatched', 'throws', 'broken']) {
    await store.insert(
      new ButtonHandler({ ...location, store, name }, { interactionHandlerType: InteractionHandlerTypes.Button })
    );
  }
  if (traceInteractionHandlerParse) {
    instrumentation.setConfig({ traceInteractionHandlerParse });
  }
  client.on(Events.InteractionHandlerError, (error) => errors.push(error));
  client.on(Events.InteractionHandlerParseError, (error) => errors.push(error));

  client.emit(Events.InteractionCreate, button(traceInteractionHandlerParse ? 'none' : 'match'));
  await exporter.waitForSpan('on interactionCreate');

  const listener = exporter.span('on interactionCreate');
  assert.ok(debugLogs.includes('sapphire instrumentation: successfully wrapped InteractionHandler.parse'));
  if (traceInteractionHandlerParse) {
    assert.deepEqual(calls, []);
    assert.deepEqual(errors, [failure]);
    assert.equal(listener.attributes['sapphire.outcome'], 'no_matching_handler');
    assert.equal(
      exporter.span('sapphire.interaction_handler.parse', piece('unmatched')).attributes['sapphire.outcome'],
      'unmatched'
    );
    assert.equal(
      exporter.span('sapphire.interaction_handler.parse', piece('broken')).status.code,
      SpanStatusCode.ERROR
    );
    assert.equal(exporter.matching('sapphire.interaction_handler.run').length, 0);
  } else {
    assert.deepEqual(calls, [
      ['matched', 'parsed'],
      ['throws', 'parsed'],
    ]);
    assert.deepEqual(errors, [failure, failure]);
    const matched = exporter.span('sapphire.interaction_handler.run', piece('matched'));
    const throws = exporter.span('sapphire.interaction_handler.run', piece('throws'));
    assertParent(matched, listener);
    assertParent(throws, listener);
    assertParent(exporter.span('handler dependency'), matched);
    assert.equal(throws.status.code, SpanStatusCode.ERROR);
    assert.equal(listener.attributes['sapphire.outcome'], 'matched');
    assert.ok(listener.events.some((event) => event.name === 'sapphire.interaction_handler.parse_error'));
    assert.equal(exporter.matching('sapphire.interaction_handler.parse').length, 0);
  }
}

/** @param {Fixture} fixture */
async function verifyListenerFailure({ framework: { Events, Listener }, client, exporter }) {
  const failure = new Error('listener failed');
  const store = client.stores.get('listeners');
  class BrokenListener extends Listener {
    async run() {
      await Promise.resolve();
      throw failure;
    }
  }
  await store.insert(new BrokenListener({ ...location, store, name: 'broken' }, { event: 'traceTestFailure' }));

  let emittedError;
  client.once(Events.ListenerError, (error) => {
    emittedError = error;
  });
  client.emit('traceTestFailure');
  await exporter.waitForSpan('on traceTestFailure');

  assert.equal(emittedError, failure);
  const span = exporter.span('on traceTestFailure');
  assert.equal(span.status.code, SpanStatusCode.ERROR);
  assert.equal(span.events.filter(({ name }) => name === 'exception').length, 1);
}

/** @param {Fixture} fixture */
async function verifyMessageArguments({ framework: { Command, Events }, client, exporter, instrumentation }) {
  const store = client.stores.get('commands');
  let invalidArgument;
  class ExampleCommand extends Command {
    /** @param {import('discord.js').Message} _message @param {import('@sapphire/framework').Args} args */
    async messageRun(_message, args) {
      invalidArgument = (await args.pickResult('integer')).isErr();
    }
  }
  await store.insert(new ExampleCommand({ ...location, store, name: 'example' }));
  const message = /** @type {import('discord.js').ClientEvents['messageCreate'][0]} */ (
    /** @type {unknown} */ ({
      author: { bot: false },
      channel: { type: ChannelType.DM },
      client,
      content: '!example private-input',
    })
  );

  client.emit(Events.MessageCreate, message);
  await exporter.waitForSpan('on messageCommandAccepted');
  assert.equal(invalidArgument, true);
  assert.equal(exporter.matching('sapphire.arguments.pickResult').length, 0);

  instrumentation.setConfig({ traceArguments: true });
  exporter.reset();
  invalidArgument = undefined;
  client.emit(Events.MessageCreate, message);
  await exporter.waitForSpan('on messageCommandAccepted');

  assert.equal(invalidArgument, true);
  exporter.span('sapphire.message.fetch_prefix');
  exporter.span('sapphire.command.messagePreParse', piece('example'));
  const argument = exporter.span('sapphire.arguments.pickResult');
  assert.equal(argument.attributes['sapphire.outcome'], 'invalid');
  assert.equal(argument.status.code, SpanStatusCode.UNSET);
  assertParent(argument, exporter.span('sapphire.command.messageRun', piece('example')));
  for (const span of exporter.getFinishedSpans()) {
    assert.equal(
      JSON.stringify([span.attributes, span.events, span.status]).includes('private-input'),
      false,
      span.name
    );
  }
}

/** @param {Fixture} fixture @param {'context' | 'autocomplete'} type */
async function verifyCommandSuccess({ framework: { Command, Events }, client, exporter }, type) {
  const store = client.stores.get('commands');
  class ExampleCommand extends Command {
    contextMenuRun() {
      return 'context menu completed';
    }

    autocompleteRun() {
      return 'autocomplete completed';
    }
  }
  await store.insert(new ExampleCommand({ ...location, store, name: 'example' }));

  const interaction = commandInteraction('example', type);
  let result;
  let reportedInteraction;
  if (type === 'context') {
    client.once(Events.ContextMenuCommandSuccess, (payload) => {
      result = payload.result;
      reportedInteraction = payload.interaction;
    });
  } else {
    client.once(Events.CommandAutocompleteInteractionSuccess, (payload) => {
      reportedInteraction = payload.interaction;
    });
  }

  client.emit(Events.InteractionCreate, interaction);
  const method = type === 'context' ? 'contextMenuRun' : 'autocompleteRun';
  const listener = type === 'context' ? 'on contextMenuCommandAccepted' : 'on possibleAutocompleteInteraction';
  await exporter.waitForSpan(listener);

  assert.equal(reportedInteraction, interaction);
  if (type === 'context') {
    assert.equal(result, 'context menu completed');
  }
  const command = exporter.span(`sapphire.command.${method}`, piece('example'));
  assert.equal(command.attributes['sapphire.outcome'], 'success');
  assertParent(command, exporter.span(listener));
}

/** @param {Fixture} fixture */
async function verifyRegistryFailure({ framework: { Command, Events }, client, exporter }) {
  const failure = new Error('registration callback failed');
  const registryFailure = new Error('registry API failed');
  const store = client.stores.get('commands');
  class ValidRegistration extends Command {
    /** @param {import('@sapphire/framework').ApplicationCommandRegistry} registry */
    registerApplicationCommands(registry) {
      registry.registerChatInputCommand({ name: 'example', description: 'Example' });
    }
  }
  class BrokenRegistration extends Command {
    registerApplicationCommands() {
      throw failure;
    }
  }
  await store.insert(new ValidRegistration({ ...location, store, name: 'example' }));
  await store.insert(new BrokenRegistration({ ...location, store, name: 'broken' }));
  let registrationError;
  client.once(Events.CommandApplicationCommandRegistryError, (error) => {
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
  await exporter.waitForSpan('once clientReady');

  assert.equal(registrationError, failure);
  const registration = exporter.span('sapphire.command.registerApplicationCommands', piece('broken'));
  assert.equal(registration.status.code, SpanStatusCode.ERROR);
  assertParent(registration, exporter.span('once clientReady'));
  const sync = exporter.span('sapphire.application_command_registry.sync', { 'sapphire.command.name': 'example' });
  assert.equal(sync.status.code, SpanStatusCode.ERROR);
  assert.equal(
    sync.events.find(({ name }) => name === 'exception')?.attributes?.['exception.message'],
    registryFailure.message
  );
  assertParent(sync, exporter.span('once clientReady'));
}

/** @param {Fixture} fixture */
async function verifyReenable({ framework: { Command, Events }, client, exporter, instrumentation }) {
  const store = client.stores.get('commands');
  /** @type {string[]} */
  const calls = [];
  class ExampleCommand extends Command {
    contextMenuRun() {
      calls.push(this.name);
      return 'context menu completed';
    }
  }
  const existing = new ExampleCommand({ ...location, store, name: 'existing' });
  await store.insert(existing);
  assert.equal(existing.contextMenuRun(), 'context menu completed');
  exporter.span('sapphire.command.contextMenuRun', piece('existing'));

  instrumentation.disable();
  exporter.reset();
  assert.equal(existing.contextMenuRun(), 'context menu completed');
  await store.insert(new ExampleCommand({ ...location, store, name: 'added-while-disabled' }));
  const completed = waitForSignal(client, Events.ContextMenuCommandFinish);
  client.emit(Events.InteractionCreate, commandInteraction('added-while-disabled', 'context'));
  await completed;
  assert.deepEqual(exporter.getFinishedSpans(), []);

  instrumentation.enable();
  instrumentation.enable();
  client.emit(Events.InteractionCreate, commandInteraction('added-while-disabled', 'context'));
  await exporter.waitForSpan('on contextMenuCommandAccepted');
  assert.equal(existing.contextMenuRun(), 'context menu completed');

  assert.deepEqual(calls, ['existing', 'existing', 'added-while-disabled', 'added-while-disabled', 'existing']);
  exporter.span('sapphire.command.contextMenuRun', piece('existing'));
  exporter.span('sapphire.command.contextMenuRun', piece('added-while-disabled'));
}

/** @type {Record<string, (fixture: Fixture) => Promise<void>>} */
const scenarios = {
  'traces stores and plugin hooks during login': verifyLogin,
  'preserves trace context and errors for a failed slash command': verifyCommandFailure,
  'records an unknown slash command without a command span': verifyUnknownCommand,
  'skips the command callback when a precondition denies it': (fixture) => verifyDenial(fixture, false),
  'exports individual precondition spans when enabled': (fixture) => verifyDenial(fixture, true),
  'traces matched handlers and records parse errors on the listener by default': (fixture) =>
    verifyHandlers(fixture, false),
  'traces unmatched and failed parses when enabled': (fixture) => verifyHandlers(fixture, true),
  'records an exception even when Sapphire catches the listener error': verifyListenerFailure,
  'traces invalid message arguments without exporting their input': verifyMessageArguments,
  'traces a successful context menu command': (fixture) => verifyCommandSuccess(fixture, 'context'),
  'traces a successful autocomplete callback': (fixture) => verifyCommandSuccess(fixture, 'autocomplete'),
  'traces registry callback and API failures': verifyRegistryFailure,
  'resumes tracing existing and newly added commands after re-enable': verifyReenable,
};

export const lifecycleScenarioNames = Object.keys(scenarios);

/** @param {string} name @param {Telemetry} telemetry */
export async function verifyLifecycle(name, telemetry) {
  assert.ok(Object.hasOwn(scenarios, name), `Unknown lifecycle scenario ${name}`);
  await withClient(telemetry, scenarios[name]);
}
