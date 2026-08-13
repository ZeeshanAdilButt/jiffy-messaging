// Applies src/adapters/postgres/schema.sql to DATABASE_URL.
//
// There is no migration framework here. schema.sql is the whole schema and
// every statement in it is CREATE TABLE IF NOT EXISTS or CREATE INDEX IF
// NOT EXISTS, so running this against a database that already has the
// tables does nothing and running it against an empty one creates them.
// That is what makes it safe on every deploy rather than once by hand.
//
// It goes through pg rather than psql because the host this deploys to is
// a Windows box with node on it and no guarantee of a psql client, and pg
// is already a dependency of the service. A multi statement query with no
// parameters uses the simple query protocol, which Postgres runs as one
// implicit transaction, so a failure part way through leaves nothing
// half created.
//
// Usage: DATABASE_URL=... node scripts/apply-schema.mjs

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import pg from 'pg'

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('Missing required environment variable: DATABASE_URL')
  process.exit(1)
}

const here = dirname(fileURLToPath(import.meta.url))
const schemaPath = join(here, '..', 'src', 'adapters', 'postgres', 'schema.sql')
const schema = readFileSync(schemaPath, 'utf8')

const pool = new pg.Pool({ connectionString })

try {
  await pool.query(schema)

  // to_regclass resolves a bare name through this connection's search_path
  // and answers NULL when nothing is there, which is the same resolution
  // the adapter's own unqualified queries get. A separate-schema deployment
  // whose search_path is not pinned lands the tables in public and fails
  // here rather than at the first request.
  const { rows } = await pool.query(
    `SELECT name
       FROM (VALUES ('conversations'), ('conversation_participants'), ('messages')) AS t (name)
      WHERE to_regclass(name) IS NOT NULL
      ORDER BY name`,
  )
  console.log(`schema applied, tables reachable: ${rows.map((row) => row.name).join(', ')}`)

  if (rows.length !== 3) {
    console.error(`expected three tables on the connection search_path, found ${rows.length}`)
    process.exitCode = 1
  }
} catch (error) {
  console.error(`applying ${schemaPath} failed: ${error.message}`)
  process.exitCode = 1
} finally {
  await pool.end()
}
