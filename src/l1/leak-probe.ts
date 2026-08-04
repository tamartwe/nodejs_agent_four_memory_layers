/**
 * FinalizationRegistry is useless for correctness — GC timing is unspecified and the
 * callback may never run. It is excellent for a live demo: it proves on stage that a
 * run object was actually collected.
 *
 * NEVER build correctness on this. Instrumentation only.
 */
const collected = new Set<string>();
const registry = new FinalizationRegistry<string>((runId) => {
  collected.add(runId);
});

export function trackForCollection(obj: object, id: string): void {
  registry.register(obj, id);
}

export const wasCollected = (id: string): boolean => collected.has(id);
export const collectedCount = (): number => collected.size;

/** Give the GC a chance to run finalizers. Requires --expose-gc. */
export async function settleGc(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    global.gc?.();
    await new Promise((r) => {
      setImmediate(r);
    });
  }
}
