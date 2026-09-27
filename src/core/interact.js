// Arbitrates context-sensitive button prompts so one key press triggers exactly one thing.
//
// Any system may call, every frame while an interaction is available (from update or lateUpdate):
//   ctx.interact.offer({ id: 'deliver', label: 'Deliver to the Pacific Star', key: 'interact', priority: 50,
//                        onPress: () => {...} })
// key is an input action name ('interact' = E, 'action' = Space). After lateUpdate the main loop calls resolve():
// the highest-priority offer per key wins, is published as ctx.interact.current[key] = { id, label, hold } for the
// HUD, and its onPress runs if that key was pressed this frame. Offers are cleared every frame.
//
// Offers with hold: true are display-only prompts for press-and-hold mechanics that the owner polls itself via
// input.action(key); they still block lower-priority offers on the same key.
//
// Priority guide: 100 fishing set actions, 80 skiff/boarding, 60 deliver/dock, 40 go ashore, 20 inspect/landmark.

export function createInteract(input) {
  let offers = [];
  const interact = {
    current: {},
    offer(o) {
      if (!o || !o.label) return;
      offers.push({ key: 'interact', priority: 0, ...o });
    },
    resolve() {
      const best = {};
      for (const o of offers) {
        if (!best[o.key] || o.priority > best[o.key].priority) best[o.key] = o;
      }
      interact.current = {};
      for (const [key, o] of Object.entries(best)) {
        interact.current[key] = { id: o.id, label: o.label, hold: !!o.hold };
        if (!o.hold && o.onPress && input.pressed(key)) {
          try {
            o.onPress();
          } catch (err) {
            console.error(`[interact] ${o.id} onPress threw`, err);
          }
        }
      }
      offers = [];
    },
  };
  return interact;
}
