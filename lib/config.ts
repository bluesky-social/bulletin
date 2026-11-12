export const SPACE_TYPE = "my.bulletin.board";
export const POST_COLLECTION = "my.bulletin.post";
export const REMOVAL_COLLECTION = "my.bulletin.removal";
export const POSITION_COLLECTION = "my.bulletin.position";
export const BULLETIN_PERMISSION_SET = "my.bulletin.permissions";
export const BOARD_SKEY = "self";

export const OAUTH_SCOPE = [
  "atproto",
  "blob?accept=image/jpeg&accept=image/png&accept=image/webp",
  `include:${BULLETIN_PERMISSION_SET}`,
].join(" ");

export type Config = {
  development: boolean;
  publishLexicons: boolean;
  hostname: string;
  port: number;
  syncPollInterval?: number;
  /** Base URL registered for notifySpaceUpdate. Unset when notifications are off. */
  syncNotifyEndpoint?: string;
  managingAppPublicUrl: string;
  uiPublicUrl: string;
  syncInternalUrl: string;
  devIntrospectUrl?: string;
  plcUrl: string;
  bskyUrl: string;
  managingAppDid: string;
  managingAppService: string;
  databasePath: string;
  blobDirectory?: string;
};

type Environment = Record<string, string | undefined>;

export function getConfig(): Config {
  return readConfig(process.env);
}

export function readConfig(
  environment: Environment = process.env,
): Config {
  const managingAppDid =
    environment.MANAGING_APP_DID ?? "did:web:localhost%3A3000";
  const managingAppPublicUrl = absoluteUrl(
    "MANAGING_APP_PUBLIC_URL",
    environment.MANAGING_APP_PUBLIC_URL ?? "http://localhost:3000",
  );
  const syncInternalUrl = loopbackUrl(
    "SYNC_INTERNAL_URL",
    environment.SYNC_INTERNAL_URL ?? "http://127.0.0.1:3001",
  );
  return {
    development: environment.NODE_ENV !== "production",
    publishLexicons: boolean(
      environment.PUBLISH_LEXICONS ?? "false",
      "PUBLISH_LEXICONS",
    ),
    hostname: environment.BULLETIN_HOST ?? "127.0.0.1",
    port: integer(
      environment.BULLETIN_PORT ?? "3000",
      "BULLETIN_PORT",
      1,
      65535,
    ),
    syncPollInterval: optionalInteger(
      environment.SYNC_POLL_INTERVAL_MS,
      "SYNC_POLL_INTERVAL_MS",
      1000,
    ),
    // The space host must reach this URL, so turn notifications off when this
    // instance does not serve it (e.g. a local UI against production).
    syncNotifyEndpoint: boolean(
      environment.SYNC_NOTIFICATIONS ?? "true",
      "SYNC_NOTIFICATIONS",
    )
      ? managingAppPublicUrl
      : undefined,
    managingAppPublicUrl,
    uiPublicUrl: absoluteUrl(
      "UI_PUBLIC_URL",
      environment.UI_PUBLIC_URL ?? "http://127.0.0.1:3000",
    ),
    syncInternalUrl,
    devIntrospectUrl: optionalAbsoluteUrl(
      "DEV_INTROSPECT_URL",
      environment.DEV_INTROSPECT_URL,
    ),
    plcUrl: absoluteUrl(
      "PLC_URL",
      environment.PLC_URL ?? "http://localhost:2582",
    ),
    bskyUrl: absoluteUrl(
      "BSKY_URL",
      environment.BSKY_URL ?? "https://api.bsky.app",
    ),
    managingAppDid,
    managingAppService: `${managingAppDid}#bulletin`,
    databasePath: environment.DATABASE_PATH ?? "bulletin.db",
    blobDirectory: environment.BLOB_DIRECTORY,
  };
}

function boolean(value: string, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

export function boardUri(ownerDid: string): string {
  return `at://${ownerDid}/space/${SPACE_TYPE}/${BOARD_SKEY}`;
}

function absoluteUrl(name: string, value: string): string {
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
}

function loopbackUrl(name: string, value: string): string {
  const normalized = absoluteUrl(name, value);
  const url = new URL(normalized);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  ) {
    throw new Error(`${name} must be an HTTP loopback URL`);
  }
  return normalized;
}

function optionalAbsoluteUrl(
  name: string,
  value: string | undefined,
): string | undefined {
  return value ? absoluteUrl(name, value) : undefined;
}

function optionalInteger(
  value: string | undefined,
  name: string,
  minimum: number,
): number | undefined {
  return value === undefined || value === ""
    ? undefined
    : integer(value, name, minimum);
}

function integer(
  value: string,
  name: string,
  minimum: number,
  maximum?: number,
): number {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    (maximum !== undefined && parsed > maximum)
  ) {
    const range = maximum
      ? `from ${minimum} through ${maximum}`
      : `of at least ${minimum}`;
    throw new Error(`${name} must be an integer ${range}`);
  }
  return parsed;
}
