import { describe, expect, it } from "vitest";
import {
  compareTableCounts,
  countMismatches,
  type Queryable,
} from "../../src/db/backupCounts.js";

/**
 * A database as a fake that answers the two queries this module makes. The
 * real catalogue is exercised by the integration test; what is pinned here is
 * the comparison, and above all that a table which did not survive a restore
 * cannot go unnoticed by being absent from the restored catalogue.
 */
function database(tables: Record<string, number>): Queryable & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async query(text: string) {
      queries.push(text);
      if (text.includes("pg_tables")) {
        return {
          rows: Object.keys(tables).map((name) => {
            const [schema, table] = name.includes(".") ? name.split(".") : ["public", name];
            return { schemaname: schema, tablename: table };
          }),
        };
      }
      const match = /from (?:"(\w+)"\.)?"(\w+)"/.exec(text);
      const name = match?.[1] === undefined ? match?.[2] : `${match[1]}.${match[2]}`;
      return { rows: [{ count: String(tables[name as string]) }] };
    },
  };
}

const MIGRATIONS = "drizzle.__drizzle_migrations";

describe("compareTableCounts", () => {
  it("covers every table either side has, plus the migration history", async () => {
    const counts = await compareTableCounts(
      database({ receipts: 3, users: 2, [MIGRATIONS]: 10 }),
      database({ receipts: 3, users: 2, [MIGRATIONS]: 10 }),
    );
    expect(counts).toEqual([
      { table: MIGRATIONS, source: 10, restored: 10 },
      { table: "receipts", source: 3, restored: 3 },
      { table: "users", source: 2, restored: 2 },
    ]);
    expect(countMismatches(counts)).toEqual([]);
  });

  it("discovers a table nobody listed", async () => {
    const counts = await compareTableCounts(
      database({ a_table_added_next_year: 1, [MIGRATIONS]: 1 }),
      database({ a_table_added_next_year: 2, [MIGRATIONS]: 1 }),
    );
    expect(countMismatches(counts)).toEqual([
      "a_table_added_next_year: 1 rows in source, 2 restored",
    ]);
  });

  it("catches a table that did not survive the restore", async () => {
    const counts = await compareTableCounts(
      database({ receipts: 3, user_events: 900, [MIGRATIONS]: 10 }),
      database({ receipts: 3, [MIGRATIONS]: 10 }),
    );
    expect(countMismatches(counts)).toEqual(["user_events: absent from restored"]);
  });

  it("catches a table the source does not have", async () => {
    const counts = await compareTableCounts(
      database({ receipts: 3, [MIGRATIONS]: 10 }),
      database({ receipts: 3, stray: 1, [MIGRATIONS]: 10 }),
    );
    expect(countMismatches(counts)).toEqual(["stray: absent from source"]);
  });

  it("will not call a missing migration history a match, even on both sides", async () => {
    const counts = await compareTableCounts(database({ receipts: 3 }), database({ receipts: 3 }));
    expect(countMismatches(counts)).toEqual([`${MIGRATIONS}: absent from source and restored`]);
  });

  it("asks count(*), never for the rows", async () => {
    const source = database({ receipts: 3, [MIGRATIONS]: 1 });
    await compareTableCounts(source, database({ receipts: 3, [MIGRATIONS]: 1 }));
    const reads = source.queries.filter((text) => !text.includes("pg_tables"));
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read).toMatch(/^select count\(\*\)/);
    }
  });

  it("quotes identifiers, so a table name cannot be read as SQL", async () => {
    const source = database({ receipts: 3, [MIGRATIONS]: 1 });
    await compareTableCounts(source, database({ receipts: 3, [MIGRATIONS]: 1 }));
    expect(source.queries.join("\n")).toContain('"drizzle"."__drizzle_migrations"');
  });
});
