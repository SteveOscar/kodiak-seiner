// Minimal synchronous event bus. Event names and payloads are catalogued in SPEC.md §Events.

export function createEvents() {
  const handlers = new Map();
  return {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
      return () => handlers.get(name)?.delete(fn);
    },
    once(name, fn) {
      const off = this.on(name, (p) => {
        off();
        fn(p);
      });
      return off;
    },
    off(name, fn) {
      handlers.get(name)?.delete(fn);
    },
    emit(name, payload) {
      const set = handlers.get(name);
      if (!set) return;
      for (const fn of [...set]) {
        try {
          fn(payload);
        } catch (err) {
          console.error(`[events] handler for "${name}" threw`, err);
        }
      }
    },
  };
}
