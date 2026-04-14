import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function query<T = unknown>(text: string, params: unknown[] = []) {
  const result = await pool.query<T>(text, params);
  return result;
}
