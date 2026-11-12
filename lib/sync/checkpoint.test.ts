import assert from "node:assert/strict";
import test from "node:test";
import { asStringFormat } from "@atproto/lex-schema";
import { LexError } from "@atproto/lex-data";
import type { SpaceCredential } from "../atproto/space-credential";
import { com } from "../lexicons";
import { SyncEngine } from "./engine";
import { parseSpaceUpdate, repoUpdateRev } from "./service";

process.env.DATABASE_PATH = ":memory:";
const { migrate } = await import("../db/migrations");
const {
  applySyncedChanges,
  getSyncedRepo,
  listSpaceWatches,
  saveAccount,
  saveSpaceWatch,
  saveSyncedRepo,
  updateSpaceWatch,
} = await import("../db/queries");
await migrate();

const rev = (n: number) => asStringFormat(`3m2222222222${n}`, "tid");
const writer = "did:plc:writer";
const NOTIFY_ENDPOINT = "https://bulletin.test";
const entry = (n: number, did = writer) => ({
  $type: "com.atproto.space.defs#repoWrite" as const,
  repo: asStringFormat(did, "did"),
  repoRev: rev(n),
  spaceRev: rev(n),
  data: new Uint8Array([n]),
});
const removed = (n: number, did = writer) => ({
  $type: "com.atproto.space.defs#repoRemoved" as const,
  repo: asStringFormat(did, "did"),
  spaceRev: rev(n),
});
type Page = {
  repos: (ReturnType<typeof entry> | ReturnType<typeof removed>)[];
  cursor?: string;
};

async function fixture(
  name: string,
  list: (cursor?: string) => Promise<Page>,
  initial = rev(2),
) {
  const authorityDid = `did:plc:${name}`;
  const space = `at://${authorityDid}/space/my.bulletin.board/self`;
  await saveAccount({ did: authorityDid, pdsUrl: "https://authority.test" });
  const token = await saveSpaceWatch({ spaceUri: space, authorityDid });
  await updateSpaceWatch({
    spaceUri: space,
    spaceRev: initial,
    registrationExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const engine = new SyncEngine(() => {}, NOTIFY_ENDPOINT);
  const credential = {
    authorization: {},
    client: (_service: string, audience: string) => {
      assert.equal(audience, authorityDid);
      return {
        call: async (method: unknown, params: { cursor?: string }) => {
          assert.equal(method, com.atproto.space.listWriters);
          return list(params.cursor);
        },
      };
    },
  } as unknown as SpaceCredential;
  engine["credentialFor"] = async () => credential;
  const synced: string[] = [];
  engine["syncRepoWithCredential"] = async (_watch, did) => {
    synced.push(did);
    await saveSyncedRepo({
      spaceUri: space,
      repoDid: did,
      pdsUrl: "https://repo.test",
      rev: rev(7),
      ltHash: new Uint8Array([1]),
      commitHash: new Uint8Array([2]),
    });
  };
  const notify = (n: number) => engine.notify({ space, spaceRev: rev(n) });
  const checkpoint = async () =>
    (await listSpaceWatches()).find((w) => w.spaceUri === space)!.spaceRev;
  return { engine, space, token, credential, notify, checkpoint, synced };
}

test("notification gaps catch up from the checkpoint, through short and empty pages", async (t) => {
  const cursors: (string | undefined)[] = [];
  const f = await fixture("gap", async (cursor) => {
    cursors.push(cursor);
    if (cursor === rev(2)) return { repos: [entry(3)], cursor: rev(3) };
    if (cursor === rev(3))
      return { repos: [entry(4, "did:plc:other")], cursor: rev(4) };
    return { repos: [] };
  });
  t.after(() => f.engine.stop());
  await f.notify(4);
  assert.deepEqual(cursors, [rev(2), rev(3), rev(4)]);
  assert.deepEqual(f.synced, [writer, "did:plc:other"]);
  assert.equal(await f.checkpoint(), rev(4));
  await f.notify(3);
  await f.notify(4);
  assert.equal(cursors.length, 3);
  await f.notify(5); // Empty catch-up must not replace the checkpoint with the notification.
  assert.equal(await f.checkpoint(), rev(4));
});

test("repeated writers and listed revisions behind the repo host are idempotent", async (t) => {
  const f = await fixture("repeat", async (cursor) => {
    if (cursor === rev(2)) return { repos: [entry(3)], cursor: rev(3) };
    if (cursor === rev(3)) return { repos: [entry(4)], cursor: rev(4) };
    return { repos: [] };
  });
  t.after(() => f.engine.stop());
  await f.notify(4);
  assert.deepEqual(f.synced, [writer]); // First fetch already reached repo revision 7.
  assert.equal(await f.checkpoint(), rev(4));
});

test("failed work leaves the durable checkpoint for the next engine to replay", async (t) => {
  const list = async (cursor?: string): Promise<Page> =>
    cursor === rev(2)
      ? { repos: [entry(3), entry(4, "did:plc:other")], cursor: rev(4) }
      : { repos: [] };
  const f = await fixture("failure", list);
  t.after(() => f.engine.stop());
  const sync = f.engine["syncRepoWithCredential"].bind(f.engine);
  f.engine["syncRepoWithCredential"] = async (watch, did, credential) => {
    if (did !== writer) throw new Error("repo unavailable");
    await sync(watch, did, credential);
  };
  await assert.rejects(f.notify(4), /repo unavailable/);
  assert.ok(await getSyncedRepo(f.space, writer));
  assert.equal(await f.checkpoint(), rev(2));
  f.engine.stop();

  const restarted = new SyncEngine(() => {}, NOTIFY_ENDPOINT);
  t.after(() => restarted.stop());
  restarted["credentialFor"] = f.engine["credentialFor"];
  restarted["syncRepoWithCredential"] = sync;
  await restarted.notify({ space: f.space, spaceRev: rev(4) });
  assert.equal(await f.checkpoint(), rev(4));
});

test("a notification arriving during the final empty response queues another pass", async (t) => {
  let release!: () => void;
  let entered!: () => void;
  const finalPage = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const f = await fixture("concurrent", async (cursor) => {
    calls++;
    if (calls === 1) {
      entered();
      await gate;
      return { repos: [] };
    }
    return cursor === rev(2)
      ? { repos: [entry(4)], cursor: rev(4) }
      : { repos: [] };
  });
  t.after(() => f.engine.stop());
  const first = f.notify(3);
  await finalPage;
  const second = f.notify(4);
  release();
  await Promise.all([first, second]);
  assert.equal(await f.checkpoint(), rev(4));
});

test("repo recovery does not retry a revoked credential", async (t) => {
  const f = await fixture("revoked", async () => ({ repos: [] }));
  t.after(() => f.engine.stop());
  const watch = (await listSpaceWatches()).find((w) => w.spaceUri === f.space)!;
  f.engine["bindWatch"](watch);
  await saveSyncedRepo({
    spaceUri: f.space,
    repoDid: writer,
    pdsUrl: "https://repo.test",
    rev: rev(2),
    ltHash: new Uint8Array(2048),
    commitHash: new Uint8Array([2]),
  });
  const credential = {
    requestCommitMac: async () => ({ headers: {}, params: () => undefined }),
    client: () => ({
      xrpc: async () => {
        throw new LexError("CredentialRevoked");
      },
    }),
  } as unknown as SpaceCredential;
  let recovered = false;
  f.engine["recoverRepo"] = async () => {
    recovered = true;
  };
  await assert.rejects(
    SyncEngine.prototype["syncRepoWithCredential"].call(
      f.engine,
      watch,
      writer,
      credential,
    ),
    (error) => error instanceof LexError && error.error === "CredentialRevoked",
  );
  assert.equal(recovered, false);
});

test("a removal drops the repo's local copy, and full listings leave it out", async (t) => {
  const f = await fixture("removal", async (cursor) => {
    if (cursor === rev(2)) return { repos: [removed(3)], cursor: rev(3) };
    if (cursor === undefined) {
      return { repos: [removed(3), entry(4, "did:plc:other")], cursor: rev(4) };
    }
    return { repos: [] };
  });
  t.after(() => f.engine.stop());
  await saveSyncedRepo({
    spaceUri: f.space,
    repoDid: writer,
    pdsUrl: "https://repo.test",
    rev: rev(2),
    ltHash: new Uint8Array([1]),
    commitHash: new Uint8Array([2]),
  });
  const postUri = `${f.space}/${writer}/my.bulletin.post/post`;
  await applySyncedChanges([
    {
      kind: "post",
      value: {
        uri: postUri,
        cid: "bafyreipost",
        spaceUri: f.space,
        authorDid: writer,
        text: "hello",
        createdAt: "2026-11-12T12:00:00.000Z",
      },
    },
  ]);

  await f.notify(3);
  assert.equal(await getSyncedRepo(f.space, writer), null);
  assert.equal(await f.checkpoint(), rev(3));

  // A full inventory keeps listing the removed repo, but must not resync it.
  const watch = (await listSpaceWatches()).find((w) => w.spaceUri === f.space)!;
  f.engine["bindWatch"](watch);
  await f.engine["runReconcile"](watch);
  assert.deepEqual(f.synced, ["did:plc:other"]);
  assert.equal(await getSyncedRepo(f.space, writer), null);
  assert.ok(await getSyncedRepo(f.space, "did:plc:other"));
});

test("only the token registered for a space authenticates its notifications", async (t) => {
  const f = await fixture("token", async () => ({ repos: [] }));
  t.after(() => f.engine.stop());
  assert.ok(f.token);
  assert.equal(await f.engine.isNotifyToken(f.space, f.token), true);
  assert.equal(await f.engine.isNotifyToken(f.space, "x".repeat(64)), false);
  assert.equal(
    await f.engine.isNotifyToken(
      "at://did:plc:elsewhere/space/my.bulletin.board/self",
      f.token,
    ),
    false,
  );
  // Without a notify endpoint, nothing was registered.
  const disabled = new SyncEngine(() => {});
  t.after(() => disabled.stop());
  assert.equal(await disabled.isNotifyToken(f.space, f.token), false);
});

test("an expiry notice reauthorizes, then catches up past the checkpoint", async (t) => {
  const events: (string | undefined)[] = [];
  const f = await fixture("expired", async (cursor) => {
    events.push(cursor);
    return cursor === rev(2)
      ? { repos: [entry(4)], cursor: rev(4) }
      : { repos: [] };
  });
  t.after(() => f.engine.stop());
  f.engine["credentialFor"] = async () => {
    events.push("authorize");
    return Object.assign(Object.create(f.credential), {
      authorization: { spaceRev: rev(4), notifyToken: f.token },
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
  };
  await f.engine.reauthorize(f.space);
  assert.equal(events[0], "authorize");
  assert.deepEqual(
    events.filter((event) => event !== "authorize"),
    [rev(2), rev(4)],
  );
  assert.equal(await f.checkpoint(), rev(4));
  assert.ok(f.engine["maintenanceTimers"].has(f.space));
});

test("a deletion notice drops the space only once reauthorizing confirms it", async (t) => {
  const f = await fixture("deleted", async () => ({ repos: [] }));
  t.after(() => f.engine.stop());
  f.engine["credentialFor"] = async () => {
    throw new LexError("SpaceDeleted");
  };
  await f.engine.reauthorize(f.space);
  await f.engine["removals"].get(f.space);
  assert.equal(
    (await listSpaceWatches()).some((w) => w.spaceUri === f.space),
    false,
  );
});

test("space updates decode Lexicon bytes and match update types in full", () => {
  const body = {
    space: "at://did:plc:owner/space/my.bulletin.board/self",
    token: "notify-token",
    update: {
      $type: "com.atproto.space.defs#repoWrite",
      repo: writer,
      repoRev: rev(3),
      spaceRev: rev(4),
      data: { $bytes: "AQI=" },
    },
  };
  const parsed = parseSpaceUpdate(body);
  assert.deepEqual(
    (parsed?.update as { data?: Uint8Array }).data,
    new Uint8Array([1, 2]),
  );
  assert.equal(repoUpdateRev(parsed!.update), rev(4));
  const removal = parseSpaceUpdate({
    ...body,
    update: {
      $type: "com.atproto.space.defs#repoRemoved",
      repo: writer,
      spaceRev: rev(5),
    },
  });
  assert.equal(repoUpdateRev(removal!.update), rev(5));
  for (const update of [
    { $type: "com.atproto.space.notifySpaceUpdate#spaceDeleted" },
    {
      $type: "com.atproto.space.notifySpaceUpdate#registrationExpired",
      spaceRev: rev(5),
    },
  ]) {
    const notice = parseSpaceUpdate({ ...body, update });
    assert.ok(notice);
    assert.equal(repoUpdateRev(notice.update), undefined);
  }
  assert.equal(parseSpaceUpdate({ ...body, token: undefined }), undefined);
  assert.equal(
    parseSpaceUpdate({ ...body, update: { ...body.update, repoRev: "nope" } }),
    undefined,
  );
});
