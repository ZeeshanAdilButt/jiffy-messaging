// Applies src/adapters/postgres/schema.sql, then every dated .sql file
// beside it in filename order, to DATABASE_URL.
//
// There is no migration framework here. schema.sql is the base schema and
// each later change is its own dated file next to it. Every statement in
// all of them is CREATE ... IF NOT EXISTS or ALTER TABLE ... ADD COLUMN IF
// NOT EXISTS, so running this against a database that is already current
// does nothing and running it against an empty one builds the whole thing.
// That is what makes it safe on every deploy rather than once by hand, and
// it is also why the files are applied in order rather than tracked in a
// migrations table: re-applying is a no-op, so there is nothing to track.
//
// It goes through pg rather than psql because the host this deploys to is
// a Windows box with node on it and no guarantee of a psql client, and pg
// is already a dependency of the service. A multi statement query with no
// parameters uses the simple query protocol, which Postgres runs as one
// implicit transaction, so a failure part way through one file leaves
// nothing half created.
//
// Usage: DATABASE_URL=... node scripts/apply-schema.mjs

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import pg from 'pg'

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('Missing required environment variable: DATABASE_URL')
  process.exit(1)
}

const here = dirname(fileURLToPath(import.meta.url))
const schemaDir = join(here, '..', 'src', 'adapters', 'postgres')

// schema.sql first, always: everything else only ever alters what it
// creates. The rest are dated (YYYY-MM-DD-*.sql), which sorts
// chronologically as plain text.
const laterFiles = readdirSync(schemaDir)
  .filter((name) => name.endsWith('.sql') && name !== 'schema.sql')
  .sort()
const files = ['schema.sql', ...laterFiles]

const pool = new pg.Pool({ connectionString })

try {
  for (const file of files) {
    const path = join(schemaDir, file)
    try {
      await pool.query(readFileSync(path, 'utf8'))
    } catch (error) {
      console.error(`applying ${path} failed: ${error.message}`)
      process.exitCode = 1
      break
    }
    console.log(`applied ${file}`)
  }

  if (process.exitCode !== 1) {
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

    // The tables existing is not enough once a later file only adds columns
    // to them: a dated file that never ran leaves every table present and
    // the service failing on its first query. Check the columns the code
    // actually depends on, for the same reason the table check above exists.
    const { rows: columns } = await pool.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = ANY (current_schemas(false))
          AND (table_name, column_name) IN
              (('messages', 'deleted_at'), ('conversation_participants', 'cleared_at'))`,
    )
    if (columns.length !== 2) {
      console.error(
        `expected messages.deleted_at and conversation_participants.cleared_at, found ${columns.length} of 2`,
      )
      process.exitCode = 1
    }
  }
} catch (error) {
  console.error(`applying the schema failed: ${error.message}`)
  process.exitCode = 1
} finally {
  await pool.end()
}
