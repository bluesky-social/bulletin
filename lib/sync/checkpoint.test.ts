import assert from "node:assert/strict";
import test from "node:test";
import { asStringFormat } from "@atproto/lex-schema";
import { LexError } from "@atproto/lex-data";
import type { SpaceCredential } from "../atproto/space-credential";
import { com } from "../lexicons";
import { SyncEngine } from "./engine";
import { parseWriteNotification } from "./service";

process.env.DATABASE_PATH = ":memory:";
const { migrate } = await import("../db/migrations");
const {
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
const entry = (n: number, did = writer) => ({
  did: asStringFormat(did, "did"),
  repoRev: rev(n),
  spaceRev: rev(n),
  data: new Uint8Array([n]),
});
type Page = { repos: ReturnType<typeof entry>[]; cursor?: string };

async function fixture(
  name: string,
  list: (cursor?: string) => Promise<Page>,
  initial = rev(2),
) {
  const authorityDid = `did:plc:${name}`;
  const space = `at://${authorityDid}/space/my.bulletin.board/self`;
  await saveAccount({ did: authorityDid, pdsUrl: "https://authority.test" });
  await saveSpaceWatch({ spaceUri: space, authorityDid });
  await updateSpaceWatch({
    spaceUri: space,
    spaceRev: initial,
    registrationExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const engine = new SyncEngine(() => {}, "did:web:bulletin.test#bulletin");
  const credential = {
    client: (_service: string, audience: string) => {
      assert.equal(audience, authorityDid);
      return {
        call: async (method: unknown, params: { cursor?: string }) => {
          assert.equal(method, com.atproto.space.listRepos);
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
  const notify = (n: number, previous = n - 1) =>
    engine.notify({
      space,
      repo: writer,
      repoRev: rev(n),
      spaceRev: rev(n),
      prevSpaceRev: rev(previous),
    });
  const checkpoint = async () =>
    (await listSpaceWatches()).find((w) => w.spaceUri === space)!.spaceRev;
  return { engine, space, notify, checkpoint, synced };
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

  const restarted = new SyncEngine(() => {}, "did:web:bulletin.test#bulletin");
  t.after(() => restarted.stop());
  restarted["credentialFor"] = f.engine["credentialFor"];
  restarted["syncRepoWithCredential"] = sync;
  await restarted.notify({
    space: f.space,
    repo: writer,
    repoRev: rev(4),
    spaceRev: rev(4),
  });
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

test("forwarded notifications require the new revision fields and decode Lexicon bytes", () => {
  const body = {
    space: "at://did:plc:owner/space/my.bulletin.board/self",
    repo: writer,
    repoRev: rev(3),
    spaceRev: rev(4),
    data: { $bytes: "AQI=" },
  };
  assert.deepEqual(parseWriteNotification(body)?.data, new Uint8Array([1, 2]));
  assert.equal(
    parseWriteNotification({ ...body, spaceRev: undefined }),
    undefined,
  );
  assert.equal(
    parseWriteNotification({ ...body, repoRev: undefined, rev: rev(3) }),
    undefined,
  );
  assert.equal(
    parseWriteNotification({ ...body, prevSpaceRev: "not-a-tid" }),
    undefined,
  );
});
