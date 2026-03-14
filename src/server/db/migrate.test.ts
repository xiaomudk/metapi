import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type MigrationJournalEntry = {
  tag: string;
  when: number;
};

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../drizzle');

function readMigrationJournalEntries(): MigrationJournalEntry[] {
  const journalPath = join(migrationsDir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries?: MigrationJournalEntry[] };
  return journal.entries ?? [];
}

function applyMigrationSql(sqlite: Database.Database, sqlText: string) {
  const statements = sqlText
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

  for (const statement of statements) {
    sqlite.exec(statement);
  }
}

describe('sqlite migrate bootstrap', () => {
  afterEach(() => {
    delete process.env.DATA_DIR;
    delete process.env.DB_URL;
    vi.resetModules();
  });

  it('accepts an already-synced sqlite schema with an empty drizzle journal', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'metapi-migrate-'));
    const dbPath = join(dataDir, 'hub.db');
    const sqlite = new Database(dbPath);
    const journalEntries = readMigrationJournalEntries();

    for (const entry of journalEntries) {
      const sqlText = readFileSync(join(migrationsDir, `${entry.tag}.sql`), 'utf8');
      applyMigrationSql(sqlite, sqlText);
    }

    sqlite.close();

    process.env.DATA_DIR = dataDir;
    vi.resetModules();

    await expect(import('./migrate.js')).resolves.toMatchObject({
      runSqliteMigrations: expect.any(Function),
    });

    const verified = new Database(dbPath, { readonly: true });
    const appliedRows = verified
      .prepare('select created_at from __drizzle_migrations order by created_at asc')
      .all() as Array<{ created_at: number }>;

    expect(appliedRows.map((row) => Number(row.created_at))).toEqual(
      journalEntries.map((entry) => entry.when),
    );

    verified.close();
  });

  it('recovers from duplicate-column errors for single-statement migrations', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'metapi-migrate-recover-'));
    process.env.DATA_DIR = dataDir;
    vi.resetModules();

    const migrateModule = await import('./migrate.js');
    const { __migrateTestUtils } = migrateModule;

    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE account_tokens (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        token_group text
      );
    `);

    const tempMigrationsDir = mkdtempSync(join(tmpdir(), 'metapi-migration-files-'));
    mkdirSync(join(tempMigrationsDir, 'meta'), { recursive: true });

    writeFileSync(
      join(tempMigrationsDir, 'meta', '_journal.json'),
      JSON.stringify({
        entries: [
          {
            tag: '0007_account_token_group',
            when: 1772500000000,
          },
        ],
      }),
    );

    writeFileSync(
      join(tempMigrationsDir, '0007_account_token_group.sql'),
      'ALTER TABLE `account_tokens` ADD `token_group` text;\n',
    );

    const duplicateColumnError = new Error(
      "DrizzleError: Failed to run the query 'ALTER TABLE `account_tokens` ADD `token_group` text;\n' duplicate column name: token_group",
    );

    const recovered = __migrateTestUtils.tryRecoverDuplicateColumnMigrationError(
      sqlite,
      tempMigrationsDir,
      duplicateColumnError,
    );

    expect(recovered).toBe(true);

    const applied = sqlite
      .prepare('SELECT hash, created_at FROM __drizzle_migrations')
      .all() as Array<{ hash: string; created_at: number }>;

    expect(applied).toHaveLength(1);
    expect(Number(applied[0].created_at)).toBe(1772500000000);

    sqlite.close();
  });

  it('recovers when duplicate-column message appears only in error cause', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'metapi-migrate-recover-cause-'));
    process.env.DATA_DIR = dataDir;
    vi.resetModules();

    const migrateModule = await import('./migrate.js');
    const { __migrateTestUtils } = migrateModule;

    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE account_tokens (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        token_group text
      );
    `);

    const tempMigrationsDir = mkdtempSync(join(tmpdir(), 'metapi-migration-files-cause-'));
    mkdirSync(join(tempMigrationsDir, 'meta'), { recursive: true });

    writeFileSync(
      join(tempMigrationsDir, 'meta', '_journal.json'),
      JSON.stringify({
        entries: [
          {
            tag: '0007_account_token_group',
            when: 1772500000001,
          },
        ],
      }),
    );

    writeFileSync(
      join(tempMigrationsDir, '0007_account_token_group.sql'),
      'ALTER TABLE `account_tokens` ADD `token_group` text;\n',
    );

    const drizzleLikeError = {
      message: "DrizzleError: Failed to run the query 'ALTER TABLE `account_tokens` ADD `token_group` text;\n'",
      cause: {
        message: 'SqliteError: duplicate column name: token_group',
      },
    };

    const recovered = __migrateTestUtils.tryRecoverDuplicateColumnMigrationError(
      sqlite,
      tempMigrationsDir,
      drizzleLikeError,
    );

    expect(recovered).toBe(true);

    const applied = sqlite
      .prepare('SELECT hash, created_at FROM __drizzle_migrations')
      .all() as Array<{ hash: string; created_at: number }>;

    expect(applied).toHaveLength(1);
    expect(Number(applied[0].created_at)).toBe(1772500000001);

    sqlite.close();
  });
});
