// Owner-keyed values (speed limits, control locks). Each owner sets or clears its own entry; consumers read the
// combined result, so two systems limiting the seiner never overwrite each other.
//   set(owner, value)   null / undefined / false clears the owner's entry
//   min()               smallest numeric value, or null when empty
//   has(owner), size(), owners()

export function createOwnerMap() {
  const m = new Map();
  return {
    set(owner, value) {
      if (value === null || value === undefined || value === false || (typeof value === 'number' && Number.isNaN(value))) {
        m.delete(owner);
      } else {
        m.set(owner, value);
      }
    },
    get: (owner) => m.get(owner),
    has: (owner) => m.has(owner),
    min() {
      let r = null;
      for (const v of m.values()) {
        const n = typeof v === 'number' ? v : null;
        if (n !== null && (r === null || n < r)) r = n;
      }
      return r;
    },
    size: () => m.size,
    owners: () => [...m.keys()],
    clear: () => m.clear(),
  };
}
