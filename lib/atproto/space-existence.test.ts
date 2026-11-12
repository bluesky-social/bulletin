import assert from "node:assert/strict";
import test from "node:test";
import { LexError } from "@atproto/lex-data";
import type { OAuthSession } from "@atproto/oauth-client-node";
import { probeSpaceExists } from "./space-existence";

const session = {} as OAuthSession;
const space = "at://did:plc:owner/space/example/self";

test("a minted credential proves the space exists", async () => {
  assert.equal(await probeSpaceExists(session, space, async () => ({})), true);
});

test("an authorization denial still proves the space exists", async () => {
  for (const error of ["AccountNotAuthorized", "NotAuthorized"] as const) {
    assert.equal(
      await probeSpaceExists(session, space, async () => {
        throw new LexError(error);
      }),
      true,
    );
  }
});

test("missing and deleted spaces are absent", async () => {
  for (const error of ["SpaceNotFound", "SpaceDeleted"] as const) {
    assert.equal(
      await probeSpaceExists(session, space, async () => {
        throw new LexError(error);
      }),
      false,
    );
  }
});

test("transient failures remain failures", async () => {
  await assert.rejects(
    probeSpaceExists(session, space, async () => {
      throw new Error("PDS unavailable");
    }),
    /PDS unavailable/,
  );
});
