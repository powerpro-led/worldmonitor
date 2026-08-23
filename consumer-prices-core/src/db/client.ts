import pg from 'pg';

const { Pool } = pg;

let _pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!_pool) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is not set');

    _pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 20_000,
      ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false },
      // Migrations and every query in this codebase use unqualified table names
      // (e.g. `CREATE TABLE retailers`, not `consumer_prices.retailers`) and rely
      // entirely on the connection's default search_path. Without this, a plain
      // Supabase pooler connection defaults to `public` — which is a SHARED schema
      // with an unrelated app's 38 tables in this project. Pin it explicitly so a
      // stray migrate run can never recreate consumer-prices tables there again
      // (see the session-38 incident: it did exactly that, cleaned up manually).
      options: '-c search_path=consumer_prices',
    });

    _pool.on('error', (err) => {
      console.error('[db] pool error:', err.message);
    });
  }
  return _pool;
}

export async function query<T extends pg.QueryResultRow = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  const pool = getPool();
  return pool.query<T>(sql, params);
}

export async function closePool(): Promise<void> {
  await _pool?.end();
  _pool = null;
}
