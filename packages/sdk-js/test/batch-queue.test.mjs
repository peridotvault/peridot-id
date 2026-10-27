// Phase-1a batch queue SDK shapes (ANT-762): submit + status polling.
// Transport is stubbed; polling is exercised with a scripted lifecycle.
import test from "node:test";
import assert from "node:assert/strict";
import { pollBatchStatus, submitBatch } from "../dist/esm/index.js";

test("submitBatch posts to the batch submit route and returns the status", async () => {
  const seen = [];
  const api = {
    get: async () => ({ ok: true, data: {} }),
    post: async (path, body) => {
      seen.push([path, body]);
      return { ok: true, data: { batchId: "b1", lifecycle: "queued", perOp: [], fees: {} } };
    },
  };
  const status = await submitBatch(api, {
    from: "0x1111111111111111111111111111111111111111",
    ops: [],
    quoteId: "qb.1.abcdef12.2.2",
    idempotencyKey: "idem-sdk-1",
  });
  assert.equal(status.batchId, "b1");
  assert.equal(seen[0][0], "/v1/wallet/execute/batch/submit");
});

test("pollBatchStatus resolves on the first terminal lifecycle", async () => {
  const script = [
    { batchId: "b1", lifecycle: "queued", perOp: [], fees: {} },
    { batchId: "b1", lifecycle: "submitted", perOp: [], fees: {} },
    { batchId: "b1", lifecycle: "settled", perOp: [{ index: 0, status: "ok" }], fees: {} },
  ];
  let calls = 0;
  const api = {
    get: async () => ({ ok: true, data: script[Math.min(calls++, script.length - 1)] }),
    post: async () => ({ ok: true, data: {} }),
  };
  const status = await pollBatchStatus(api, "b1", { intervalMs: 1, maxAttempts: 10 });
  assert.equal(status.lifecycle, "settled");
  assert.equal(calls, 3);
});

test("pollBatchStatus rejects with the last status on timeout", async () => {
  const api = {
    get: async () => ({ ok: true, data: { batchId: "b1", lifecycle: "queued", perOp: [], fees: {} } }),
    post: async () => ({ ok: true, data: {} }),
  };
  await assert.rejects(() => pollBatchStatus(api, "b1", { intervalMs: 1, maxAttempts: 3 }), /timed out/);
});
