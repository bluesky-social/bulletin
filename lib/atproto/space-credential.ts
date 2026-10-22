import { Client, XrpcResponseError } from "@atproto/lex-client";
import { LexError } from "@atproto/lex-data";
import { asStringFormat } from "@atproto/lex-schema";
import { P256Keypair } from "@atproto/crypto";
import type { OAuthSession } from "@atproto/oauth-client-node";
import {
  COMMIT_MAC_TYPE,
  MAC_HEADER,
  WANT_MAC_HEADER,
  createSpaceSigHeaders,
  encapsulate,
  formatWantMacHeader,
  parseMacHeader,
  parseSpaceToken,
} from "@atproto/space";
import { com } from "../lexicons";
import { resolveKemKey, resolvePds } from "./identity";

const GET_SPACE_CREDENTIAL_PATH = "/xrpc/com.atproto.space.getSpaceCredential";

export type CommitMacRequest = {
  headers: Record<string, string>;
  /** The shared secret and the MAC the response carried, for `verifyCommit`. */
  params: (headers: Headers) => { sharedSecret: Uint8Array; mac: Uint8Array };
};

export class SpaceCredential {
  private invalidated = false;

  constructor(
    readonly token: string,
    readonly key: P256Keypair,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  needsRefresh(now = Date.now()): boolean {
    if (this.invalidated) return true;
    const { exp } = parseSpaceToken("credential", this.token).payload;
    return !Number.isFinite(exp) || now + 5_000 >= exp * 1000;
  }

  fetch = async (
    input: string | URL | Request,
    audience: string,
    init?: RequestInit,
  ): Promise<Response> => {
    if (this.needsRefresh()) {
      throw new LexError("JwtExpired", "Refresh the space credential");
    }
    const request = new Request(input, { ...init, redirect: "error" });
    const headers = await createSpaceSigHeaders(this.key, {
      authorization: `Atproto-Space-Credential ${this.token}`,
      audience: asStringFormat(audience, "did"),
    });
    for (const [name, value] of Object.entries(headers)) {
      request.headers.set(name, value);
    }
    const response = await this.fetchImpl(request);
    if (!response.ok) {
      const body = asObject(await readJson(response.clone()));
      if (body?.error === "CredentialRevoked" || body?.error === "JwtExpired") {
        this.invalidated = true;
        throw new LexError(
          body.error,
          typeof body.message === "string" ? body.message : undefined,
        );
      }
    }
    return response;
  };

  client(service: string, audience: string): Client {
    return new Client({
      service,
      fetch: (input, init) => this.fetch(input, audience, init),
    });
  }

  /**
   * Ask a repo host to MAC the commit in its response. Each request needs its own
   * key share against the author's `#atproto_kem` key, including every page.
   */
  async requestCommitMac(
    repo: string,
    refreshKey = false,
  ): Promise<CommitMacRequest> {
    const { keyShare, sharedSecret } = await encapsulate(
      await resolveKemKey(repo, refreshKey),
    );
    return {
      headers: {
        [WANT_MAC_HEADER]: formatWantMacHeader(COMMIT_MAC_TYPE, keyShare),
      },
      params: (headers) => ({
        sharedSecret,
        mac: parseMacHeader(headers.get(MAC_HEADER) ?? undefined, COMMIT_MAC_TYPE),
      }),
    };
  }
}

export async function mintSpaceCredential(
  session: OAuthSession,
  space: string,
): Promise<SpaceCredential> {
  const viewerClient = new Client(session);
  const delegation = await viewerClient.call(
    com.atproto.space.getDelegationToken,
    { space: asStringFormat(space, "space-ref") },
  );
  const authority = space.match(/^at:\/\/(did:[^/]+)\/space\//)?.[1];
  if (!authority) throw new Error("Invalid space URI");
  const authorityPds = await resolvePds(authority);
  const key = await P256Keypair.create();
  const credential = await exchangeSpaceCredential({
    authorityPds,
    delegationToken: delegation.token,
    space,
    key,
  });
  return new SpaceCredential(credential, key);
}

export async function exchangeSpaceCredential(input: {
  authorityPds: string;
  delegationToken: string;
  space: string;
  key: P256Keypair;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const url = new URL(GET_SPACE_CREDENTIAL_PATH, input.authorityPds);
  const request = new Request(url, {
    method: "POST",
    redirect: "error",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      space: input.space,
      credentialKid: input.key.did(),
      delegationToken: input.delegationToken,
    }),
  });
  const response = await (input.fetchImpl ?? fetch)(request);
  const body = await readJson(response);
  if (!response.ok) {
    const error = asObject(body);
    const errorCode =
      typeof error?.error === "string"
        ? error.error
        : response.status >= 500
          ? "UpstreamFailure"
          : "InvalidRequest";
    const message =
      typeof error?.message === "string" ? error.message : undefined;
    throw new XrpcResponseError(
      com.atproto.space.getSpaceCredential.main,
      response,
      {
        encoding: "application/json",
        body: { error: errorCode, ...(message ? { message } : {}) },
      },
    );
  }

  const output = asObject(body);
  if (typeof output?.credential !== "string" || !output.credential) {
    throw new LexError(
      "InvalidResponse",
      "Credential exchange returned no credential",
    );
  }
  return output.credential;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}
