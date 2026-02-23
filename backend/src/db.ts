import { Pool, QueryResult, QueryResultRow } from "pg";
import { requireDatabaseUrl } from "./config";

export const pool = new Pool({
  connectionString: requireDatabaseUrl(),
  max: 12
});

export async function dbQuery<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<QueryResult<T>> {
  return pool.query<T>(sql, params);
}
