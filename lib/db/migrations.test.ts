import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { CamelCasePlugin, Kysely, sql, SqliteDialect } from "kysely";
import type { DatabaseSchema } from "./schema";
import {
  INITIAL_MIGRATION_NAME,
  NOTIFY_TOKEN_MIGRATION_NAME,
  SPACE_REV_MIGRATION_NAME,
  SPACE_URI_FORM_MIGRATION_NAME,
  migrateDatabase,
} from "./migrations";

test("a fresh database records the initial schema and later migrations", async () => {
  const db = createDatabase();
  try {
    await migrateDatabase(db);

    assert.deepEqual(await migrationNames(db), [
      INITIAL_MIGRATION_NAME,
      SPACE_REV_MIGRATION_NAME,
      NOTIFY_TOKEN_MIGRATION_NAME,
      SPACE_URI_FORM_MIGRATION_NAME,
    ]);
    const tables = (await db.introspection.getTables()).map(({ name }) => name);
    assert.equal(tables.includes("removal"), true);
    assert.equal(
      (await db.introspection.getTables()).some(
        ({ name }) => name === "migration",
      ),
      false,
    );
  } finally {
    await db.destroy();
  }
});

test("an already migrated database gains a nullable checkpoint and notify token without losing repo state", async () => {
  const db = createDatabase();
  try {
    await migrateDatabase(db);
    // Reconstruct a database on 001, rather than just testing a fresh schema.
    await db.schema.alterTable("syncSpace").dropColumn("notifyToken").execute();
    await db.schema.alterTable("syncSpace").dropColumn("spaceRev").execute();
    await sql`DELETE FROM kysely_migration WHERE name IN (${SPACE_REV_MIGRATION_NAME}, ${NOTIFY_TOKEN_MIGRATION_NAME}, ${SPACE_URI_FORM_MIGRATION_NAME})`.execute(
      db,
    );
    // A registerNotify registration is not carried over.
    await sql`INSERT INTO sync_space (space_uri, authority_did, registration_expires_at, updated_at)
      VALUES ('space', 'did:plc:owner', '2026-11-13T00:00:00.000Z', 'now')`.execute(db);
    await db
      .insertInto("syncRepo")
      .values({
        spaceUri: "space",
        repoDid: "did:plc:writer",
        pdsUrl: "https://pds.test",
        rev: "3m22222222222",
        lthash: new Uint8Array([1]),
        commitHash: new Uint8Array([2]),
        updatedAt: "now",
      })
      .execute();
    await migrateDatabase(db);
    await migrateDatabase(db);
    const space = await db
      .selectFrom("syncSpace")
      .selectAll()
      .executeTakeFirstOrThrow();
    assert.equal(space.spaceRev, null);
    assert.equal(space.registrationExpiresAt, null);
    assert.match(space.notifyToken ?? "", /^[0-9a-f]{64}$/);
    assert.equal(
      (await db.selectFrom("syncRepo").selectAll().executeTakeFirstOrThrow())
        .rev,
      "3m22222222222",
    );
    assert.deepEqual(await migrationNames(db), [
      INITIAL_MIGRATION_NAME,
      SPACE_REV_MIGRATION_NAME,
      NOTIFY_TOKEN_MIGRATION_NAME,
      SPACE_URI_FORM_MIGRATION_NAME,
    ]);
  } finally {
    await db.destroy();
  }
});

test("stored space URIs move to the at:space/ form, and only once", async () => {
  const db = createDatabase();
  try {
    await migrateDatabase(db);
    await sql`DELETE FROM kysely_migration WHERE name = ${SPACE_URI_FORM_MIGRATION_NAME}`.execute(
      db,
    );
    const oldSpace = "at://did:plc:owner/space/my.bulletin.board/self";
    const newSpace = "at:space/did:plc:owner/my.bulletin.board/self";
    const oldPost = `${oldSpace}/did:plc:writer/my.bulletin.post/3mpost`;
    const newPost = `${newSpace}/did:plc:writer/my.bulletin.post/3mpost`;
    const oldRemoval = `${oldSpace}/did:plc:owner/my.bulletin.removal/3mremoval`;
    const oldPosition = `${oldSpace}/did:plc:owner/my.bulletin.position/3mposition`;
    // Already rewritten, and a public URI: both are left as they are.
    const otherSpace = "at:space/did:plc:other/my.bulletin.board/self";
    const publicUri = "at://did:plc:writer/app.bsky.feed.post/3mpublic";

    await db
      .insertInto("board")
      .values([
        { spaceUri: oldSpace, ownerDid: "did:plc:owner", createdAt: "now" },
        { spaceUri: otherSpace, ownerDid: "did:plc:other", createdAt: "now" },
      ])
      .execute();
    await db
      .insertInto("post")
      .values({
        uri: oldPost,
        cid: "bafypost",
        spaceUri: oldSpace,
        authorDid: "did:plc:writer",
        text: "hi",
        imageCid: null,
        imageMime: null,
        imageSize: null,
        imageAlt: null,
        color: null,
        rotation: null,
        x: null,
        y: null,
        createdAt: "now",
        indexedAt: "now",
      })
      .execute();
    await db
      .insertInto("removal")
      .values([
        {
          uri: oldRemoval,
          cid: "bafyremoval",
          spaceUri: oldSpace,
          authorDid: "did:plc:owner",
          subjectUri: oldPost,
          subjectCid: "bafypost",
          createdAt: "now",
          indexedAt: "now",
        },
        {
          uri: `${oldRemoval}2`,
          cid: "bafyremoval2",
          spaceUri: oldSpace,
          authorDid: "did:plc:owner",
          subjectUri: publicUri,
          subjectCid: "bafypublic",
          createdAt: "now",
          indexedAt: "now",
        },
      ])
      .execute();
    await db
      .insertInto("notePosition")
      .values({
        uri: oldPosition,
        cid: "bafyposition",
        spaceUri: oldSpace,
        authorDid: "did:plc:owner",
        subjectUri: oldPost,
        subjectCid: "bafypost",
        x: 1,
        y: 2,
        createdAt: "now",
        indexedAt: "now",
      })
      .execute();
    await db
      .insertInto("syncSpace")
      .values({
        spaceUri: oldSpace,
        authorityDid: "did:plc:owner",
        spaceRev: "3mspace",
        registrationExpiresAt: null,
        notifyToken: "token",
        lastError: null,
        updatedAt: "now",
      })
      .execute();
    await db
      .insertInto("syncRepo")
      .values({
        spaceUri: oldSpace,
        repoDid: "did:plc:writer",
        pdsUrl: "https://pds.test",
        rev: "3mrepo",
        lthash: new Uint8Array([1]),
        commitHash: new Uint8Array([2]),
        updatedAt: "now",
      })
      .execute();
    await db
      .insertInto("spaceBlob")
      .values({
        spaceUri: oldSpace,
        repoDid: "did:plc:writer",
        cid: "bafyblob",
        mimeType: "image/png",
        size: 1,
        updatedAt: "now",
      })
      .execute();

    await migrateDatabase(db);
    // Rewriting again leaves new-form values alone.
    await sql`DELETE FROM kysely_migration WHERE name = ${SPACE_URI_FORM_MIGRATION_NAME}`.execute(
      db,
    );
    await migrateDatabase(db);

    assert.deepEqual(
      (await db.selectFrom("board").select("spaceUri").orderBy("spaceUri").execute())
        .map(({ spaceUri }) => spaceUri),
      [otherSpace, newSpace],
    );
    assert.deepEqual(
      await db.selectFrom("post").select(["uri", "spaceUri"]).execute(),
      [{ uri: newPost, spaceUri: newSpace }],
    );
    assert.deepEqual(
      await db
        .selectFrom("removal")
        .select(["uri", "spaceUri", "subjectUri"])
        .orderBy("uri")
        .execute(),
      [
        {
          uri: `${newSpace}/did:plc:owner/my.bulletin.removal/3mremoval`,
          spaceUri: newSpace,
          subjectUri: newPost,
        },
        {
          uri: `${newSpace}/did:plc:owner/my.bulletin.removal/3mremoval2`,
          spaceUri: newSpace,
          subjectUri: publicUri,
        },
      ],
    );
    assert.deepEqual(
      await db
        .selectFrom("notePosition")
        .select(["uri", "spaceUri", "subjectUri"])
        .execute(),
      [
        {
          uri: `${newSpace}/did:plc:owner/my.bulletin.position/3mposition`,
          spaceUri: newSpace,
          subjectUri: newPost,
        },
      ],
    );
    for (const table of ["syncSpace", "syncRepo", "spaceBlob"] as const) {
      assert.deepEqual(
        await db.selectFrom(table).select("spaceUri").execute(),
        [{ spaceUri: newSpace }],
      );
    }
  } finally {
    await db.destroy();
  }
});

function createDatabase(): Kysely<DatabaseSchema> {
  return new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({ database: new Database(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
}

async function migrationNames(db: Kysely<DatabaseSchema>): Promise<string[]> {
  const result = await sql<{ name: string }>`
    SELECT name FROM kysely_migration ORDER BY name
  `.execute(db);
  return result.rows.map(({ name }) => name);
}
