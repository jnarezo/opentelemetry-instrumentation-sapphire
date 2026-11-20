import { diag } from '@opentelemetry/api';

type Method = (this: object, ...args: unknown[]) => unknown;

interface MethodPatch {
  label: string;
  descriptor: PropertyDescriptor | undefined;
  original: Method;
  wrapped: Method;
}

/** Keep unloaded pieces eligible for garbage collection, even while instrumentation is enabled. */
export class MethodPatches {
  private readonly loggedHooks = new Set<string>();
  private readonly methods = new WeakMap<object, Map<string, MethodPatch>>();
  private readonly targets = new Set<WeakRef<object>>();
  private readonly registry = new FinalizationRegistry<WeakRef<object>>((ref) => this.targets.delete(ref));
  private active = true;

  wrap<T extends object>(
    component: string,
    target: T | undefined,
    key: string,
    invoke: (receiver: T, args: unknown[], call: () => unknown) => unknown
  ): void {
    if (!target) {
      return;
    }

    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    let inherited = descriptor;
    for (
      let parent: object | null = Object.getPrototypeOf(target) as object | null;
      !inherited && parent;
      parent = Object.getPrototypeOf(parent) as object | null
    ) {
      inherited = Object.getOwnPropertyDescriptor(parent, key);
    }
    const original: unknown = inherited?.value;
    if (
      typeof original !== 'function' ||
      (descriptor
        ? !('value' in descriptor) || (!descriptor.configurable && !descriptor.writable)
        : !Object.isExtensible(target))
    ) {
      return;
    }

    let methods = this.methods.get(target);
    if (!methods) {
      methods = new Map();
      this.methods.set(target, methods);
      const ref = new WeakRef(target);
      this.targets.add(ref);
      this.registry.register(target, ref);
    }

    if (methods.get(key)?.wrapped === original) {
      return;
    }

    const method = original as Method;
    const isActive = () => this.active;
    const wrapped: Method = function (...args) {
      const call = () => {
        // Resolve inherited methods at call time so other instrumentation can patch the parent prototype later.
        if (descriptor) {
          return method.apply(this, args);
        }
        const parent = Object.getPrototypeOf(target) as object;
        return (Reflect.get(parent, key, this) as Method).apply(this, args);
      };
      return isActive() ? invoke(this as T, args, call) : call();
    };
    const patch = { label: `${component}.${key}`, descriptor, original: method, wrapped };
    methods.set(key, patch);
    this.install(target, key, patch);
  }

  setActive(active: boolean): void {
    if (this.active === active) {
      return;
    }

    this.active = active;
    if (!active) {
      this.loggedHooks.clear();
    }
    for (const ref of this.targets) {
      const target = ref.deref();
      const methods = target && this.methods.get(target);
      if (!target || !methods) {
        continue;
      }

      for (const [key, patch] of methods) {
        const current = Object.getOwnPropertyDescriptor(target, key);
        if (active) {
          if (current?.value === patch.original || (!current && !patch.descriptor && Object.isExtensible(target))) {
            this.install(target, key, patch, current);
          }
        } else if (current?.value === patch.wrapped && (current.configurable || current.writable)) {
          if (patch.descriptor) {
            Object.defineProperty(target, key, patch.descriptor);
          } else {
            Reflect.deleteProperty(target, key);
          }
        }
      }
    }
  }

  private install(target: object, key: string, patch: MethodPatch, descriptor = patch.descriptor): void {
    Object.defineProperty(target, key, {
      configurable: true,
      writable: true,
      ...descriptor,
      value: patch.wrapped,
    });
    if (!this.loggedHooks.has(patch.label)) {
      this.loggedHooks.add(patch.label);
      diag.debug(`sapphire instrumentation: successfully wrapped ${patch.label}`);
    }
  }
}
