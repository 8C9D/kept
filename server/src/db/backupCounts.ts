/**
 * "Does the restored database hold what the source holds", per table: the one
 * comparison the nightly job and the operator drill (`db:verify-restore`) both
 * make, so that they cannot come to disagree about what it covers.
 *
 * The tables are discovered rather than listed. A list is a promise someone has
 * to keep: `verifyRestore.ts` named four tables by hand and went on naming four
 * after the schema reached six, so `receipt_field_options` and `user_events`
 * had been outside every restore drill since they were added, and a restore
 * that lost one of them would have passed. Reading the catalogue makes the next
 * table covered by the migration that creates it.
 *
 * Discovery runs on BOTH sides. Asking only the restored database would make
 * the most important case invisible: a table that did not survive the restore
 * is, by definition, not in the restored catalogue.
 *
 * `count(*)` rather than selecting rows and measuring the array, which is what
 * the drill used to do: it read every receipt into memory to learn a number.
 */

/** The shape of `pool.query` this needs; a `pg` Pool satisfies it. */
export interface Queryable {
  query(text: string): Promise<{ rows: unknown[] }>;
}

/** `null` means the table is not there on that side. */
export interface TableCount {
  table: string;
  source: number | null;
  restored: number | null;
}

/**
 * Outside the public schema, so catalogue discovery would miss it, and listed
 * here because a restore that lost the migration history would leave the next
 * `db:migrate` trying to replay every migration onto a populated database.
 */
const MIGRATIONS_TABLE = "drizzle.__drizzle_migrations";

export async function compareTableCounts(
  source: Queryable,
  restored: Queryable,
): Promise<TableCount[]> {
  const [sourceTables, restoredTables] = [await listTables(source), await listTables(restored)];
  const tables = [...new Set([...sourceTables, ...restoredTables, MIGRATIONS_TABLE])].sort();

  const counts: TableCount[] = [];
  for (const table of tables) {
    counts.push({
      table,
      source: sourceTables.has(table) ? await countRows(source, table) : null,
      restored: restoredTables.has(table) ? await countRows(restored, table) : null,
    });
  }
  return counts;
}

/** One line per table that does not match, in the words the drill has always used. */
export function countMismatches(counts: readonly TableCount[]): string[] {
  return counts.flatMap(({ table, source, restored }) => {
    if (source === null || restored === null) {
      const absentFrom = [source === null ? "source" : "", restored === null ? "restored" : ""]
        .filter((side) => side !== "")
        .join(" and ");
      return [`${table}: absent from ${absentFrom}`];
    }
    return source === restored ? [] : [`${table}: ${source} rows in source, ${restored} restored`];
  });
}

async function listTables(database: Queryable): Promise<Set<string>> {
  const { rows } = await database.query(
    `select schemaname, tablename from pg_catalog.pg_tables
     where schemaname = 'public'
        or (schemaname = 'drizzle' and tablename = '__drizzle_migrations')`,
  );
  return new Set(
    (rows as Array<{ schemaname: string; tablename: string }>).map(({ schemaname, tablename }) =>
      schemaname === "public" ? tablename : `${schemaname}.${tablename}`,
    ),
  );
}

async function countRows(database: Queryable, table: string): Promise<number> {
  const quoted = table
    .split(".")
    .map((part) => `"${part.replaceAll('"', '""')}"`)
    .join(".");
  const { rows } = await database.query(`select count(*) as count from ${quoted}`);
  return Number((rows as Array<{ count: string }>)[0]?.count);
}
