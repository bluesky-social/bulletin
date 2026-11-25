import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_PATH = ":memory:";

const { migrate } = await import("./migrations");
const {
  deleteSyncedReposExcept,
  getAccount,
  getPost,
  getSyncedRepo,
  hasBoard,
  hasSpaceWatch,
  hideSyncedSpace,
  listBoardPosts,
  listBoards,
  saveAccount,
  saveBoard,
  saveSpaceWatch,
  saveSyncedRepo,
  upsertRemoval,
  upsertPosition,
  upsertPost,
} = await import("./queries");

await migrate();

test("account and board queries return typed application rows", async () => {
  await saveAccount({
    did: "did:plc:owner",
    handle: "owner.test",
    pdsUrl: "https://pds.test",
  });
  await saveAccount({ did: "did:plc:owner" });
  await saveBoard("at:space/did:plc:owner/example.board/self", "did:plc:owner");

  assert.deepEqual(await getAccount("did:plc:owner"), {
    did: "did:plc:owner",
    handle: "owner.test",
    pdsUrl: "https://pds.test",
  });
  assert.equal(await hasBoard("did:plc:owner"), true);
  assert.deepEqual(await listBoards(), [
    { ownerDid: "did:plc:owner", handle: "owner.test" },
  ]);
});

test("space watches can be checked without materializing a board", async () => {
  const spaceUri = "at:space/did:plc:watched/example.board/self";
  assert.equal(await hasSpaceWatch(spaceUri), false);
  await saveBoard(spaceUri, "did:plc:watched");
  await saveSpaceWatch({ spaceUri, authorityDid: "did:plc:watched" });
  assert.equal(await hasSpaceWatch(spaceUri), true);
  assert.equal(await hasBoard("did:plc:watched"), true);
  await hideSyncedSpace(spaceUri);
  assert.equal(await hasSpaceWatch(spaceUri), false);
  assert.equal(await hasBoard("did:plc:watched"), false);
});

test("board materialization applies owner moderation and positioning", async () => {
  const spaceUri = "at:space/did:plc:owner/example.board/self";
  const postUri = `${spaceUri}/did:plc:author/example.post/one`;
  const createdAt = new Date().toISOString();
  await saveAccount({ did: "did:plc:author", handle: "author.test" });
  await upsertPost({
    uri: postUri,
    cid: "post-cid",
    spaceUri,
    authorDid: "did:plc:author",
    text: "hello",
    color: "pink",
    rotation: 4,
    x: 10,
    y: 20,
    createdAt,
  });
  await upsertPosition({
    uri: `${spaceUri}/did:plc:owner/example.position/one`,
    cid: "position-cid",
    spaceUri,
    authorDid: "did:plc:owner",
    subjectUri: postUri,
    subjectCid: "post-cid",
    x: 30,
    y: 40,
    createdAt,
  });
  await upsertRemoval({
    uri: `${spaceUri}/did:plc:owner/example.removal/one`,
    cid: "removal-cid",
    spaceUri,
    authorDid: "did:plc:owner",
    subjectUri: postUri,
    subjectCid: "post-cid",
    createdAt,
  });

  assert.deepEqual(await listBoardPosts(spaceUri, "did:plc:owner"), [
    {
      uri: postUri,
      cid: "post-cid",
      spaceUri,
      authorDid: "did:plc:author",
      authorHandle: "author.test",
      text: "hello",
      imageCid: null,
      imageMime: null,
      imageSize: null,
      imageAlt: null,
      color: "pink",
      rotation: 4,
      x: 30,
      y: 40,
      createdAt,
      hidden: true,
    },
  ]);
});

test("sync repository hashes round-trip as byte arrays", async () => {
  await saveSyncedRepo({
    spaceUri: "at:space/did:plc:owner/example.board/self",
    repoDid: "did:plc:author",
    pdsUrl: "https://pds.test",
    rev: "1",
    ltHash: new Uint8Array([1, 2]),
    commitHash: new Uint8Array([3, 4]),
  });

  assert.deepEqual(
    await getSyncedRepo(
      "at:space/did:plc:owner/example.board/self",
      "did:plc:author",
    ),
    {
      spaceUri: "at:space/did:plc:owner/example.board/self",
      repoDid: "did:plc:author",
      pdsUrl: "https://pds.test",
      rev: "1",
      ltHash: new Uint8Array([1, 2]),
      commitHash: new Uint8Array([3, 4]),
    },
  );
});

test("reconciliation removes repositories absent from the remote space", async () => {
  const spaceUri = "at:space/did:plc:owner/example.board/recreated";
  const retainedDid = "did:plc:retained";
  const staleDid = "did:plc:stale";
  for (const repoDid of [retainedDid, staleDid]) {
    await saveSyncedRepo({
      spaceUri,
      repoDid,
      pdsUrl: "https://pds.test",
      rev: "1",
      ltHash: new Uint8Array([1]),
      commitHash: new Uint8Array([2]),
    });
  }
  const stalePostUri = `${spaceUri}/${staleDid}/example.post/old`;
  await upsertPost({
    uri: stalePostUri,
    cid: "stale-cid",
    spaceUri,
    authorDid: staleDid,
    text: "from the deleted board",
    createdAt: new Date().toISOString(),
  });

  assert.equal(
    await deleteSyncedReposExcept(spaceUri, new Set([retainedDid])),
    true,
  );
  assert.notEqual(await getSyncedRepo(spaceUri, retainedDid), null);
  assert.equal(await getSyncedRepo(spaceUri, staleDid), null);
  assert.equal(await getPost(stalePostUri), null);
  assert.equal(
    await deleteSyncedReposExcept(spaceUri, new Set([retainedDid])),
    false,
  );
});
