import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { LOCAL_DEV_DATABASE_URL } from "./client.js";
import { receiptImages, receipts, users } from "./schema.js";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? LOCAL_DEV_DATABASE_URL,
});
const db = drizzle(pool);

async function seed() {
  // Dev-only seed: reset in FK order, then insert synthetic rows.
  await db.delete(receiptImages);
  await db.delete(receipts);
  await db.delete(users);

  const [userA, userB] = await db
    .insert(users)
    .values([
      {
        appleSub: "synthetic-apple-sub-user-a",
        email: "user-a@example.invalid",
        displayName: "Synthetic User A",
      },
      {
        appleSub: "synthetic-apple-sub-user-b",
        email: null,
        displayName: "Synthetic User B",
      },
    ])
    .returning();

  const inserted = await db
    .insert(receipts)
    .values([
      {
        userId: userA.id,
        purchasedAt: "2026-01-14",
        capturedAt: new Date("2026-01-14T15:00:00Z"),
        vendor: "Synthetic Vendor One",
        vendorTaxNumber: "000000000RT0001",
        subtotalCents: 10000,
        hstCents: 1300,
        otherTaxCents: null,
        totalCents: 11300,
        category: "office supplies",
        paymentMethod: "visa",
        isBusiness: true,
        status: "confirmed",
      },
      {
        userId: userA.id,
        purchasedAt: "2026-02-02",
        capturedAt: new Date("2026-02-02T18:30:00Z"),
        vendor: "Synthetic Vendor Two",
        subtotalCents: null,
        hstCents: null,
        totalCents: 4200,
        isBusiness: false,
        status: "pending",
        ocrRawText: "SYNTHETIC OCR TEXT\nTOTAL 42.00",
      },
      {
        userId: userA.id,
        purchasedAt: "2026-03-20",
        capturedAt: new Date("2026-03-20T12:00:00Z"),
        vendor: "Synthetic Vendor Three",
        subtotalCents: 2500,
        hstCents: 325,
        otherTaxCents: 100,
        totalCents: 2925,
        category: "meals",
        isBusiness: true,
        status: "confirmed",
        notes: "synthetic note",
      },
      {
        userId: userB.id,
        purchasedAt: "2026-01-30",
        capturedAt: new Date("2026-01-30T09:15:00Z"),
        vendor: "Synthetic Vendor Four",
        totalCents: 999,
        currency: "USD",
        isBusiness: false,
        status: "confirmed",
      },
      {
        userId: userB.id,
        purchasedAt: "2026-04-01",
        capturedAt: new Date("2026-04-01T20:45:00Z"),
        vendor: "Synthetic Vendor Five",
        subtotalCents: 50000,
        hstCents: 6500,
        totalCents: 56500,
        category: "equipment",
        paymentMethod: "mastercard",
        isBusiness: true,
        status: "pending",
      },
    ])
    .returning({ id: receipts.id, vendor: receipts.vendor });

  console.log(`Seeded 2 users and ${inserted.length} receipts.`);
  await pool.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
