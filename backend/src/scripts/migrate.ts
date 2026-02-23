import { readdir, readFile } from "fs/promises";
import path from "path";
import { pool } from "../db";

type AppliedMigrationRow = {
  filename: string;
};

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function listMigrationFiles(migrationsDir: string): Promise<string[]> {
  const files = await readdir(migrationsDir, { withFileTypes: true });
  return files
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function getAppliedMigrations(): Promise<Set<string>> {
  const result = await pool.query<AppliedMigrationRow>("SELECT filename FROM schema_migrations");
  return new Set(result.rows.map((row: AppliedMigrationRow) => row.filename));
}

async function applyMigration(migrationsDir: string, filename: string): Promise<void> {
  const sqlPath = path.join(migrationsDir, filename);
  const sql = await readFile(sqlPath, "utf8");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
    await client.query("COMMIT");
    console.log(`[migrate] applied ${filename}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function runMigrations(): Promise<void> {
  const migrationsDir = path.resolve(process.cwd(), "migrations");
  await ensureMigrationsTable();

  const files = await listMigrationFiles(migrationsDir);
  const applied = await getAppliedMigrations();

  let appliedCount = 0;
  for (const filename of files) {
    if (applied.has(filename)) continue;
    await applyMigration(migrationsDir, filename);
    appliedCount += 1;
  }

  if (appliedCount === 0) {
    console.log("[migrate] no pending migrations");
  } else {
    console.log(`[migrate] complete. applied=${appliedCount}`);
  }
}

if (require.main === module) {
  runMigrations()
    .then(async () => {
      await pool.end();
      process.exit(0);
    })
    .catch(async (error) => {
      console.error("[migrate] failed", error);
      await pool.end();
      process.exit(1);
    });
}
