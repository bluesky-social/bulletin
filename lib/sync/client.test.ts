import assert from "node:assert/strict";
import test from "node:test";
import { discoverBoard } from "./client";

test("board discovery distinguishes missing boards from sync failures", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () =>
    Response.json({ error: "Board not found" }, { status: 404 });
  assert.equal(await discoverBoard("at:space/did:plc:test/example/self"), false);

  globalThis.fetch = async () => new Response(null, { status: 404 });
  await assert.rejects(
    discoverBoard("at:space/did:plc:test/example/self"),
    /Board sync failed \(404\)/,
  );

  globalThis.fetch = async () => new Response(null, { status: 200 });
  assert.equal(await discoverBoard("at:space/did:plc:test/example/self"), true);

  globalThis.fetch = async () => new Response(null, { status: 503 });
  await assert.rejects(
    discoverBoard("at:space/did:plc:test/example/self"),
    /Board sync failed \(503\)/,
  );
});
