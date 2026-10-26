import { neon } from '@neondatabase/serverless';

export function createDbClient(role: string, fleetId: string, companyId: string, userId = '') {
  const sql = neon(process.env.DATABASE_URL!);

  return async function query(queryStr: string, params?: any[]) {
    const results = await sql.transaction([
      sql`SELECT set_config('app.user_role', ${role}, true)`,
      sql`SELECT set_config('app.user_fleet_id', ${fleetId}, true)`,
      sql`SELECT set_config('app.user_company_id', ${companyId}, true)`,
      sql`SELECT set_config('app.user_id', ${userId}, true)`,
      sql.query(queryStr, params),
    ]);
    return results[4];
  };
}

export function createPublicDbClient() {
  return neon(process.env.DATABASE_URL!);
}
