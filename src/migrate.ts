import { readFileSync } from 'node:fs';
import pg from 'pg';

/** Applique db/schema.sql (idempotent). N'utilise que DATABASE_URL (pas la config complète). */
export async function migrate(): Promise<void> {
  const sql = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(sql);
  } finally {
    await pool.end();
  }
}
