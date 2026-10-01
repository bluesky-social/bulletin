import { Client, XrpcResponseError } from "@atproto/lex-client";
import { LexError } from "@atproto/lex-data";
import { asStringFormat } from "@atproto/lex-schema";
import { P256Keypair } from "@atproto/crypto";
import type { OAuthSession } from "@atproto/oauth-client-node";
import { createSpaceSigHeaders, parseSpaceToken } from "@atproto/space";
import { com } from "../lexicons";
import { resolvePds } from "./identity";

const GET_SPACE_CREDENTIAL_PATH = "/xrpc/com.atproto.space.getSpaceCredential";

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
      authorization: `Atproto-Space ${this.token}`,
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
      ...(await createSpaceSigHeaders(input.key, {
        authorization: `Bearer ${input.delegationToken}`,
      })),
      "content-type": "application/json",
    },
    body: JSON.stringify({ space: input.space }),
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
