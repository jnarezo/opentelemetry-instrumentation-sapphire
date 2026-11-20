import { expect, test, vi } from 'vitest';
import { MethodPatches } from '../src/patches.ts';

/** @type {Parameters<MethodPatches['wrap']>[3]} */
const invokeOriginal = (_receiver, _args, call) => call();

test('wraps inherited methods, preserving the receiver and resolving later parent patches', () => {
  class Piece {
    prefix = 'piece';

    /** @param {string} argument */
    run(argument) {
      return argument;
    }
  }
  const inherited = new Piece();
  const patches = new MethodPatches();
  const invoke = vi.fn(invokeOriginal);
  patches.wrap('Piece', inherited, 'run', invoke);

  /** @param {string} argument */
  Piece.prototype.run = function (argument) {
    return `${this.prefix}:${argument}`;
  };
  expect(inherited.run('payload')).toBe('piece:payload');
  expect(invoke).toHaveBeenCalledExactlyOnceWith(inherited, ['payload'], expect.any(Function));

  patches.setActive(false);
  expect(Object.hasOwn(inherited, 'run')).toBe(false);
  expect(inherited.run('again')).toBe('piece:again');
  expect(invoke).toHaveBeenCalledTimes(1);
});

test('restores the original descriptor and wraps only once after repeated enable calls', () => {
  const original = vi.fn(() => 'returned');
  const target = { run: original };
  Object.defineProperty(target, 'run', { enumerable: false, writable: false, configurable: true });
  const descriptor = Object.getOwnPropertyDescriptor(target, 'run');
  const patches = new MethodPatches();
  const invoke = vi.fn(invokeOriginal);
  patches.wrap('Piece', target, 'run', invoke);
  patches.wrap('Piece', target, 'run', invoke);
  expect(target.run()).toBe('returned');
  expect(invoke).toHaveBeenCalledTimes(1);

  patches.setActive(false);
  patches.setActive(false);
  expect(Object.getOwnPropertyDescriptor(target, 'run')).toEqual(descriptor);
  expect(target.run()).toBe('returned');
  expect(invoke).toHaveBeenCalledTimes(1);

  patches.setActive(true);
  patches.setActive(true);
  expect(target.run()).toBe('returned');
  expect(original).toHaveBeenCalledTimes(3);
  expect(invoke).toHaveBeenCalledTimes(2);
});
