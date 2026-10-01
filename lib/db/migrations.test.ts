import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { CamelCasePlugin, Kysely, sql, SqliteDialect } from "kysely";
import type { DatabaseSchema } from "./schema";
import {
  INITIAL_MIGRATION_NAME,
  SPACE_REV_MIGRATION_NAME,
  migrateDatabase,
} from "./migrations";

test("a fresh database records the initial schema and space checkpoint migration", async () => {
  const db = createDatabase();
  try {
    await migrateDatabase(db);

    assert.deepEqual(await migrationNames(db), [
      INITIAL_MIGRATION_NAME,
      SPACE_REV_MIGRATION_NAME,
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

test("an already migrated database gains a nullable checkpoint without losing repo state", async () => {
  const db = createDatabase();
  try {
    await migrateDatabase(db);
    // Reconstruct a database on 001, rather than just testing a fresh schema.
    await db.schema.alterTable("syncSpace").dropColumn("spaceRev").execute();
    await sql`DELETE FROM kysely_migration WHERE name = ${SPACE_REV_MIGRATION_NAME}`.execute(
      db,
    );
    await sql`INSERT INTO sync_space (space_uri, authority_did, updated_at)
      VALUES ('space', 'did:plc:owner', 'now')`.execute(db);
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
    assert.equal(
      (await db.selectFrom("syncSpace").selectAll().executeTakeFirstOrThrow())
        .spaceRev,
      null,
    );
    assert.equal(
      (await db.selectFrom("syncRepo").selectAll().executeTakeFirstOrThrow())
        .rev,
      "3m22222222222",
    );
    assert.deepEqual(await migrationNames(db), [
      INITIAL_MIGRATION_NAME,
      SPACE_REV_MIGRATION_NAME,
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
