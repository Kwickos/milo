import pg from 'pg';
import { env } from './config';

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

export function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as never);
}
