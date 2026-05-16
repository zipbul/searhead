import { describe, test, expect, mock } from "bun:test";
import { enqueueEnrichment, pendingCount } from "../../src/fqa/queue";

// Mock runEnrichment so the queue test doesn't hit the DB.
const calls: string[] = [];
mock.module("../../src/fqa/enrich", () => ({
  runEnrichment: async (id: string) => {
    calls.push(id);
    return null;
  },
  // The module also exports other names; provide stubs so the
  // mock substitutes cleanly.
  auditAndEnrich: async () => ({ scanned: 0, enriched: 0, skipped: [] }),
  expireStalePullTasks: async () => 0,
}));

describe("fqa queue — event-driven drain", () => {
  test("enqueue dispatches in order, idle when drained", async () => {
    calls.length = 0;
    enqueueEnrichment("a");
    enqueueEnrichment("b");
    enqueueEnrichment("c");
    // Worker drains as a microtask chain; wait for it.
    for (let i = 0; i < 10 && pendingCount() > 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(calls).toEqual(["a", "b", "c"]);
    expect(pendingCount()).toBe(0);
  });

  test("subsequent enqueue restarts the drainer", async () => {
    calls.length = 0;
    enqueueEnrichment("x");
    for (let i = 0; i < 10 && pendingCount() > 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(calls).toEqual(["x"]);
    enqueueEnrichment("y");
    for (let i = 0; i < 10 && pendingCount() > 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(calls).toEqual(["x", "y"]);
  });
});
