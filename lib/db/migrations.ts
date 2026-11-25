import { sql, type Kysely } from "kysely";
import {
  Migrator,
  type Migration,
  type MigrationProvider,
} from "kysely/migration";
import { getQueryDb } from "./index";
import type { DatabaseSchema } from "./schema";

export const INITIAL_MIGRATION_NAME = "001_initial";
export const SPACE_REV_MIGRATION_NAME = "002_space_revision";
export const NOTIFY_TOKEN_MIGRATION_NAME = "003_notify_token";
export const SPACE_URI_FORM_MIGRATION_NAME = "004_space_uri_form";

/** Columns that hold space refs, or URIs of records in a space. */
const SPACE_URI_COLUMNS = [
  ["board", "space_uri"],
  ["post", "uri"],
  ["post", "space_uri"],
  ["removal", "uri"],
  ["removal", "space_uri"],
  ["removal", "subject_uri"],
  ["note_position", "uri"],
  ["note_position", "space_uri"],
  ["note_position", "subject_uri"],
  ["sync_space", "space_uri"],
  ["sync_repo", "space_uri"],
  ["space_blob", "space_uri"],
] as const;

const APPLICATION_TABLES = [
  "account",
  "auth_session",
  "auth_state",
  "board",
  "removal",
  "note_position",
  "post",
  "space_blob",
  "sync_repo",
  "sync_space",
  "web_session",
] as const;

const initialMigration: Migration = {
  async up(db) {
    const tables = new Set(
      (await db.introspection.getTables()).map(({ name }) => name),
    );

    const existingTables = APPLICATION_TABLES.filter((table) =>
      tables.has(table),
    );
    if (existingTables.length > 0) {
      throw new Error(
        `Cannot initialize over an unversioned schema: ${existingTables.join(", ")}`,
      );
    }

    await createInitialSchema(db);
  },

  async down(db) {
    for (const table of [...APPLICATION_TABLES].reverse()) {
      await db.schema.dropTable(table).ifExists().execute();
    }
  },
};

const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return {
      [INITIAL_MIGRATION_NAME]: initialMigration,
      [SPACE_REV_MIGRATION_NAME]: {
        async up(db) {
          // Existing installations bootstrap a space checkpoint on their next sync.
          // syncRepo.rev remains the repo commit revision, not a listing cursor.
          await db.schema
            .alterTable("syncSpace")
            .addColumn("spaceRev", "text")
            .execute();
        },
        async down(db) {
          await db.schema
            .alterTable("syncSpace")
            .dropColumn("spaceRev")
            .execute();
        },
      },
      [NOTIFY_TOKEN_MIGRATION_NAME]: {
        async up(db) {
          // Notifications are registered through authorizeSpaceSync with a token
          // per space. Earlier registerNotify registrations are not carried over,
          // so each watch registers again on its next authorization.
          await db.schema
            .alterTable("syncSpace")
            .addColumn("notifyToken", "text")
            .execute();
          await sql`UPDATE sync_space
            SET notify_token = lower(hex(randomblob(32))),
              registration_expires_at = NULL`.execute(db);
        },
        async down(db) {
          await db.schema
            .alterTable("syncSpace")
            .dropColumn("notifyToken")
            .execute();
        },
      },
      [SPACE_URI_FORM_MIGRATION_NAME]: {
        // Space hosts now send `at:space/{spaceDid}/{rest}` in place of
        // `at://{spaceDid}/space/{rest}`. Synced repo state stays valid, so this
        // only rewrites the stored URIs. Values already in the new form, and
        // public `at://` URIs, are left as they are.
        // No down(): an older release can't talk to upgraded space hosts.
        async up(db) {
          for (const [table, column] of SPACE_URI_COLUMNS) {
            await rewriteLegacySpaceUris(db, table, column);
          }
        },
      },
    };
  },
};

async function rewriteLegacySpaceUris(
  db: Kysely<unknown>,
  table: string,
  column: string,
): Promise<void> {
  const ref = sql.raw(column);
  // In `at://{authority}/space/{rest}`, the authority starts at character 6.
  const slash = sql`instr(substr(${ref}, 6), '/')`;
  await sql`UPDATE ${sql.raw(table)}
    SET ${ref} = 'at:space/' || substr(${ref}, 6, ${slash} - 1) || '/'
      || substr(${ref}, 6 + ${slash} + length('space/'))
    WHERE substr(${ref}, 1, 5) = 'at://'
      AND ${slash} > 1
      AND substr(${ref}, 6 + ${slash}, length('space/')) = 'space/'`.execute(db);
}

export async function migrate(): Promise<void> {
  await migrateDatabase(getQueryDb());
}

export async function migrateDatabase(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  const migrator = new Migrator({ db, provider: migrationProvider });
  const { error } = await migrator.migrateToLatest();
  if (error) throw new Error("Database migration failed", { cause: error });
}

async function createInitialSchema(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("authState")
    .addColumn("key", "text", (column) => column.primaryKey())
    .addColumn("value", "text", (column) => column.notNull())
    .execute();

  await db.schema
    .createTable("authSession")
    .addColumn("key", "text", (column) => column.primaryKey())
    .addColumn("value", "text", (column) => column.notNull())
    .execute();

  await db.schema
    .createTable("account")
    .addColumn("did", "text", (column) => column.primaryKey())
    .addColumn("handle", "text")
    .addColumn("pdsUrl", "text")
    .addColumn("updatedAt", "text", (column) => column.notNull())
    .execute();

  await db.schema
    .createTable("board")
    .addColumn("spaceUri", "text", (column) => column.primaryKey())
    .addColumn("ownerDid", "text", (column) => column.notNull().unique())
    .addColumn("createdAt", "text", (column) => column.notNull())
    .execute();

  await db.schema
    .createTable("post")
    .addColumn("uri", "text", (column) => column.primaryKey())
    .addColumn("cid", "text", (column) => column.notNull())
    .addColumn("spaceUri", "text", (column) => column.notNull())
    .addColumn("authorDid", "text", (column) => column.notNull())
    .addColumn("text", "text", (column) => column.notNull())
    .addColumn("imageCid", "text")
    .addColumn("imageMime", "text")
    .addColumn("imageSize", "integer")
    .addColumn("imageAlt", "text")
    .addColumn("color", "text")
    .addColumn("rotation", "integer")
    .addColumn("x", "integer")
    .addColumn("y", "integer")
    .addColumn("createdAt", "text", (column) => column.notNull())
    .addColumn("indexedAt", "text", (column) => column.notNull())
    .execute();
  await db.schema
    .createIndex("postBoardCreatedIdx")
    .on("post")
    .columns(["spaceUri", "createdAt desc"])
    .execute();

  await createRemovalTable(db);

  await db.schema
    .createTable("notePosition")
    .addColumn("uri", "text", (column) => column.primaryKey())
    .addColumn("cid", "text", (column) => column.notNull())
    .addColumn("spaceUri", "text", (column) => column.notNull())
    .addColumn("authorDid", "text", (column) => column.notNull())
    .addColumn("subjectUri", "text", (column) => column.notNull())
    .addColumn("subjectCid", "text", (column) => column.notNull())
    .addColumn("x", "integer", (column) => column.notNull())
    .addColumn("y", "integer", (column) => column.notNull())
    .addColumn("createdAt", "text", (column) => column.notNull())
    .addColumn("indexedAt", "text", (column) => column.notNull())
    .execute();
  await db.schema
    .createIndex("notePositionSubjectCreatedIdx")
    .on("notePosition")
    .columns(["spaceUri", "subjectUri", "subjectCid", "createdAt desc"])
    .execute();

  await db.schema
    .createTable("syncSpace")
    .addColumn("spaceUri", "text", (column) => column.primaryKey())
    .addColumn("authorityDid", "text", (column) => column.notNull())
    .addColumn("registrationExpiresAt", "text")
    .addColumn("lastError", "text")
    .addColumn("updatedAt", "text", (column) => column.notNull())
    .execute();

  await db.schema
    .createTable("syncRepo")
    .addColumn("spaceUri", "text", (column) => column.notNull())
    .addColumn("repoDid", "text", (column) => column.notNull())
    .addColumn("pdsUrl", "text", (column) => column.notNull())
    .addColumn("rev", "text", (column) => column.notNull())
    .addColumn("lthash", "blob", (column) => column.notNull())
    .addColumn("commitHash", "blob", (column) => column.notNull())
    .addColumn("updatedAt", "text", (column) => column.notNull())
    .addPrimaryKeyConstraint("syncRepoPrimaryKey", ["spaceUri", "repoDid"])
    .execute();

  await db.schema
    .createTable("spaceBlob")
    .addColumn("spaceUri", "text", (column) => column.notNull())
    .addColumn("repoDid", "text", (column) => column.notNull())
    .addColumn("cid", "text", (column) => column.notNull())
    .addColumn("mimeType", "text", (column) => column.notNull())
    .addColumn("size", "integer", (column) => column.notNull())
    .addColumn("updatedAt", "text", (column) => column.notNull())
    .addPrimaryKeyConstraint("spaceBlobPrimaryKey", [
      "spaceUri",
      "repoDid",
      "cid",
    ])
    .execute();

  await db.schema
    .createTable("webSession")
    .addColumn("tokenHash", "text", (column) => column.primaryKey())
    .addColumn("did", "text", (column) => column.notNull())
    .addColumn("createdAt", "text", (column) => column.notNull())
    .addColumn("expiresAt", "text", (column) => column.notNull())
    .execute();
  await db.schema
    .createIndex("webSessionDidIdx")
    .on("webSession")
    .column("did")
    .execute();
}

async function createRemovalTable(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("removal")
    .addColumn("uri", "text", (column) => column.primaryKey())
    .addColumn("cid", "text", (column) => column.notNull())
    .addColumn("spaceUri", "text", (column) => column.notNull())
    .addColumn("authorDid", "text", (column) => column.notNull())
    .addColumn("subjectUri", "text", (column) => column.notNull())
    .addColumn("subjectCid", "text", (column) => column.notNull())
    .addColumn("createdAt", "text", (column) => column.notNull())
    .addColumn("indexedAt", "text", (column) => column.notNull())
    .execute();
  await db.schema
    .createIndex("removalSubjectCreatedIdx")
    .on("removal")
    .columns(["spaceUri", "subjectUri", "createdAt desc"])
    .execute();
}
