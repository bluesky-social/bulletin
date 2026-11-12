import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { CamelCasePlugin, Kysely, sql, SqliteDialect } from "kysely";
import type { DatabaseSchema } from "./schema";
import {
  INITIAL_MIGRATION_NAME,
  NOTIFY_TOKEN_MIGRATION_NAME,
  SPACE_REV_MIGRATION_NAME,
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
    await sql`DELETE FROM kysely_migration WHERE name IN (${SPACE_REV_MIGRATION_NAME}, ${NOTIFY_TOKEN_MIGRATION_NAME})`.execute(
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
    ]);
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
