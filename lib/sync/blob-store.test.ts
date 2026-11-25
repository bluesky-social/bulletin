import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cidForRawBytes } from "@atproto/lex-data";

test("deletes a blob file after its last note reference is removed", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "bulletin-blobs-"));
  process.env.DATABASE_PATH = path.join(directory, "bulletin.db");
  process.env.BLOB_DIRECTORY = path.join(directory, "blobs");

  const [{ migrate }, queries, blobStore, database] = await Promise.all([
    import("../db/migrations"),
    import("../db/queries"),
    import("../blob-store"),
    import("../db/index"),
  ]);

  try {
    await migrate();
    const bytes = new Uint8Array([1, 2, 3]);
    const cid = (await cidForRawBytes(bytes)).toString();
    const first = post("did:plc:first", "one", cid);
    const second = post("did:plc:second", "two", cid);

    await queries.applySyncedChanges(
      [first.change, second.change],
      [first.blob, second.blob],
    );
    blobStore.storeBlobFile(cid, bytes);

    await queries.applySyncedChanges([
      {
        ...first.change,
        value: {
          ...first.change.value,
          cid: "record-without-image",
          image: undefined,
        },
      },
    ]);
    assert.deepEqual(blobStore.readBlobFile(cid), bytes);

    await queries.deleteStoredPost(second.change.value.uri);
    assert.equal(blobStore.readBlobFile(cid), null);
  } finally {
    database.getDb().close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function post(authorDid: string, rkey: string, cid: string) {
  const spaceUri = `at:space/${authorDid}/my.bulletin.board/self`;
  const uri = `${spaceUri}/${authorDid}/my.bulletin.post/${rkey}`;
  return {
    change: {
      kind: "post" as const,
      value: {
        uri,
        cid: `record-${rkey}`,
        spaceUri,
        authorDid,
        text: rkey,
        image: {
          cid,
          mimeType: "image/png" as const,
          size: 3,
          alt: null,
        },
        createdAt: new Date().toISOString(),
      },
    },
    blob: {
      spaceUri,
      repoDid: authorDid,
      cid,
      mimeType: "image/png",
      size: 3,
    },
  };
}
