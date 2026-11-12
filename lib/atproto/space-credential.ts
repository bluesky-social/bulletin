import { Client, XrpcResponseError } from "@atproto/lex-client";
import { LexError } from "@atproto/lex-data";
import { asStringFormat } from "@atproto/lex-schema";
import { P256Keypair } from "@atproto/crypto";
import type { OAuthSession } from "@atproto/oauth-client-node";
import {
  COMMIT_MAC_PROFILE,
  createSpaceSigHeaders,
  encapsulate,
  formatMacRequest,
  parseSpaceToken,
  type VerifyMacParams,
} from "@atproto/space";
import { com } from "../lexicons";
import { resolveKemKey, resolvePds } from "./identity";

const AUTHORIZE_SPACE_SYNC_PATH = "/xrpc/com.atproto.space.authorizeSpaceSync";

/** Where the space host sends notifySpaceUpdate, registered by authorizeSpaceSync. */
export type NotifyRegistration = { endpoint: string; token: string };

export type CommitMacRequest = {
  headers: Record<string, string>;
  /** The key share, shared secret, and response headers, for `verifyCommit`. */
  params: (headers: Headers) => VerifyMacParams;
};

export class SpaceCredential {
  private invalidated = false;

  constructor(
    readonly token: string,
    readonly key: P256Keypair,
    private readonly fetchImpl: typeof fetch = fetch,
    /** From authorizeSpaceSync: the space revision, and the notify token it renewed. */
    readonly authorization: { spaceRev?: string; notifyToken?: string } = {},
  ) {}

  needsRefresh(now = Date.now()): boolean {
    if (this.invalidated) return true;
    const { exp } = parseSpaceToken("credential", this.token).payload;
    return !Number.isFinite(exp) || now + 5_000 >= exp * 1000;
  }

  /** When the credential, and any registration it renewed, expires. */
  get expiresAt(): string {
    const { exp } = parseSpaceToken("credential", this.token).payload;
    return new Date(exp * 1000).toISOString();
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
    const { headers } = await createSpaceSigHeaders({
      authorization: `Atproto-Space-Credential ${this.token}`,
      audience: asStringFormat(audience, "did"),
      keypair: this.key,
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
      asStringFormat(await resolveKemKey(repo, refreshKey), "did"),
    );
    return {
      headers: {
        "accept-signature": formatMacRequest(COMMIT_MAC_PROFILE, keyShare),
      },
      params: (headers) => ({ keyShare, sharedSecret, headers }),
    };
  }
}

export async function mintSpaceCredential(
  session: OAuthSession,
  space: string,
  notify?: NotifyRegistration,
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
  const { credential, spaceRev } = await exchangeSpaceCredential({
    authorityPds,
    delegationToken: delegation.token,
    space,
    key,
    notify,
  });
  return new SpaceCredential(credential, key, fetch, {
    spaceRev,
    notifyToken: notify?.token,
  });
}

export async function exchangeSpaceCredential(input: {
  authorityPds: string;
  delegationToken: string;
  space: string;
  key: P256Keypair;
  notify?: NotifyRegistration;
  fetchImpl?: typeof fetch;
}): Promise<{ credential: string; spaceRev?: string }> {
  const url = new URL(AUTHORIZE_SPACE_SYNC_PATH, input.authorityPds);
  const request = new Request(url, {
    method: "POST",
    redirect: "error",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      space: input.space,
      credentialKey: input.key.did(),
      delegationToken: input.delegationToken,
      ...(input.notify ? { notify: input.notify } : {}),
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
      com.atproto.space.authorizeSpaceSync.main,
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
  return {
    credential: output.credential,
    spaceRev: typeof output.spaceRev === "string" ? output.spaceRev : undefined,
  };
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
