import assert from "node:assert/strict";
import test from "node:test";
import { XrpcResponseError } from "@atproto/lex-client";
import { LexError } from "@atproto/lex-data";
import { P256Keypair } from "@atproto/crypto";
import { asStringFormat } from "@atproto/lex-schema";
import {
  COMMIT_MAC_TYPE,
  MAC_HEADER,
  RepoCommit,
  SpaceMacError,
  WANT_MAC_HEADER,
  computeCommitMac,
  decapsulate,
  formatMacHeader,
  parseWantMacHeader,
  verifyCommit,
  verifyCredentialSig,
} from "@atproto/space";
import { com } from "../lexicons";
import { getIdResolver } from "./identity";
import { exchangeSpaceCredential, SpaceCredential } from "./space-credential";

const AUTHORITY_PDS = "https://authority.example";
const EXCHANGE_URL = `${AUTHORITY_PDS}/xrpc/com.atproto.space.getSpaceCredential`;
const SPACE = "at://did:plc:owner/space/my.bulletin.board/self";
const DELEGATION_TOKEN = "delegation-token";

test("credential requests carry the delegation token and binding key in an unsigned body", async () => {
  const key = await P256Keypair.create();
  let requestSeen = false;

  const credential = await exchangeSpaceCredential({
    authorityPds: AUTHORITY_PDS,
    delegationToken: DELEGATION_TOKEN,
    space: SPACE,
    key,
    fetchImpl: async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      requestSeen = true;
      assert.equal(request.method, "POST");
      assert.equal(request.url, EXCHANGE_URL);
      assert.equal(request.redirect, "error");
      assert.deepEqual(await request.json(), {
        space: SPACE,
        credentialKid: key.did(),
        delegationToken: DELEGATION_TOKEN,
      });

      assert.equal(request.headers.get("authorization"), null);
      assert.equal(request.headers.get("dpop"), null);
      assert.equal(request.headers.get("atproto-space-audience"), null);
      assert.equal(request.headers.get("signature-input"), null);
      assert.equal(request.headers.get("signature"), null);

      return Response.json({ credential: "space-credential" });
    },
  });

  assert.equal(requestSeen, true);
  assert.equal(credential, "space-credential");
});

test("credential exchange preserves structured XRPC errors", async () => {
  const key = await P256Keypair.create();

  await assert.rejects(
    exchangeSpaceCredential({
      authorityPds: AUTHORITY_PDS,
      delegationToken: DELEGATION_TOKEN,
      space: SPACE,
      key,
      fetchImpl: async () =>
        Response.json(
          { error: "SpaceDeleted", message: "Space has been deleted" },
          { status: 400, headers: { "x-test-header": "preserved" } },
        ),
    }),
    (error) =>
      error instanceof XrpcResponseError &&
      error.status === 400 &&
      error.response.headers.get("x-test-header") === "preserved" &&
      error.error === "SpaceDeleted" &&
      error.message === "Space has been deleted",
  );
});

test("credential reads sign each repo audience, including accounts sharing a PDS", async () => {
  const key = await P256Keypair.create();
  const token = credentialToken(key);
  const seen: string[] = [];
  const credential = new SpaceCredential(token, key, async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    const url = new URL(request.url);
    const audience = url.pathname.endsWith("listRepos")
      ? "did:plc:owner"
      : url.searchParams.get("repo");
    assert.ok(audience);
    seen.push(audience);
    assert.equal(request.redirect, "error");
    assert.equal(
      request.headers.get("authorization"),
      `Atproto-Space-Credential ${token}`,
    );
    assert.equal(request.headers.get("atproto-space-audience"), audience);
    assert.equal(request.headers.get("dpop"), null);
    assert.equal(
      request.headers.get("signature-input"),
      'atproto-space-credential=("authorization" "atproto-space-audience");tag="atproto-space-credential"',
    );
    const headers = Object.fromEntries(request.headers);
    const keyId = asStringFormat(key.did(), "did");
    await verifyCredentialSig(headers, keyId);
    await assert.rejects(
      verifyCredentialSig(
        { ...headers, "atproto-space-audience": "did:plc:wrong" },
        keyId,
      ),
    );
    return Response.json(
      url.pathname.endsWith("listRepos") ? { repos: [] } : { ops: [] },
    );
  });

  const service = "https://shared-pds.example";
  for (const repo of ["did:plc:writer", "did:plc:other"] as const) {
    await credential
      .client(service, repo)
      .call(com.atproto.space.listRepoOps, { space: SPACE, repo });
    // Recovery uses raw fetch, but still signs for the account rather than the host.
    const url = `${service}/xrpc/com.atproto.space.getRepo?repo=${repo}`;
    assert.equal((await credential.fetch(url, repo)).ok, true);
  }
  await credential
    .client(service, "did:plc:owner")
    .call(com.atproto.space.listRepos, { space: SPACE });
  assert.deepEqual(seen, [
    "did:plc:writer",
    "did:plc:writer",
    "did:plc:other",
    "did:plc:other",
    "did:plc:owner",
  ]);
});

test("commit MAC requests use a fresh key share against the author's KEM key", async (t) => {
  const kem = await P256Keypair.create();
  const didResolver = getIdResolver().did;
  const originalResolve = didResolver.resolve;
  t.after(() => {
    didResolver.resolve = originalResolve;
  });
  const refreshes: boolean[] = [];
  didResolver.resolve = async (did, forceRefresh) => {
    refreshes.push(forceRefresh === true);
    return {
      id: did,
      verificationMethod: [
        {
          id: `${did}#atproto_kem`,
          type: "Multikey",
          controller: did,
          publicKeyMultibase: kem.did().slice("did:key:".length),
        },
      ],
    };
  };

  const key = await P256Keypair.create();
  const credential = new SpaceCredential(credentialToken(key), key);
  const repo = asStringFormat("did:plc:writer", "did");
  const space = asStringFormat(SPACE, "space-ref");
  const first = await credential.requestCommitMac(repo);
  const retry = await credential.requestCommitMac(repo, true);
  assert.deepEqual(refreshes, [false, true]);
  const keyShare = parseWantMacHeader(
    first.headers[WANT_MAC_HEADER],
    COMMIT_MAC_TYPE,
  );
  assert.notEqual(
    keyShare,
    parseWantMacHeader(retry.headers[WANT_MAC_HEADER], COMMIT_MAC_TYPE),
  );

  // Repo host side: MAC the commit with the secret from the first key share.
  const commit = new RepoCommit().toCommit({ space, repo, rev: "3m22222222222" });
  const mac = computeCommitMac(decapsulate(kem, keyShare), commit);
  const response = new Headers({
    [MAC_HEADER]: formatMacHeader(COMMIT_MAC_TYPE, mac),
  });
  assert.equal(verifyCommit(commit, { space, repo, ...first.params(response) }), true);
  assert.equal(verifyCommit(commit, { space, repo, ...retry.params(response) }), false);
  assert.equal(
    verifyCommit(commit, {
      space,
      repo: asStringFormat("did:plc:other", "did"),
      ...first.params(response),
    }),
    false,
  );
  assert.throws(() => first.params(new Headers()), SpaceMacError);
});

test("refresh follows the credential's actual expiry, with a five-second lead", async () => {
  const key = await P256Keypair.create();
  const now = Date.now();
  for (const lifetime of [60, 600, 3600]) {
    const exp = Math.floor(now / 1000) + lifetime;
    const credential = new SpaceCredential(credentialToken(key, exp), key);
    assert.equal(credential.needsRefresh(exp * 1000 - 5001), false);
    assert.equal(credential.needsRefresh(exp * 1000 - 5000), true);
  }
});

test("a revoked credential is not sent again, including raw repo fetches", async () => {
  const key = await P256Keypair.create();
  let calls = 0;
  const credential = new SpaceCredential(
    credentialToken(key),
    key,
    async () => {
      calls++;
      return Response.json({ error: "CredentialRevoked" }, { status: 401 });
    },
  );
  await assert.rejects(
    credential.fetch("https://pds.test/repo", "did:plc:writer"),
    (error) => error instanceof LexError && error.error === "CredentialRevoked",
  );
  assert.equal(credential.needsRefresh(), true);
  await assert.rejects(
    credential.fetch("https://pds.test/repo", "did:plc:writer"),
  );
  assert.equal(calls, 1);
});

function credentialToken(
  key: P256Keypair,
  exp = Math.floor(Date.now() / 1000) + 600,
): string {
  // Client expiry hints only; the receiving service verifies the JWT.
  const header = {
    typ: "atproto-space-credential+jwt",
    alg: "ES256",
    kid: "#atproto",
  };
  const payload = {
    iss: "did:plc:owner",
    sub: SPACE,
    iat: exp - 600,
    exp,
    jti: "credential-id",
    cnf: { kid: key.did() },
  };
  return (
    [header, payload]
      .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
      .join(".") + ".AA"
  );
}
