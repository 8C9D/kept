import { useCallback, useEffect, useState } from "react";
import type { KeptApi } from "./api.js";
import type { ReceiptOptions } from "./types.js";

/**
 * Category, payment method and vendor stay free text (engineering rule: no
 * enum, no taxonomy) - but a person retyping "Food Basics" for the two-
 * hundredth time is not free text, it is friction. GET /api/receipts/options
 * returns the user's own past values, and every category/payment/vendor
 * input offers them through a <datalist>: a picker over a text box, not a
 * closed list. Vendor added 2026-08-28 (the owner's first-use feedback:
 * "vendors should be reusable the way categories already are") - same
 * derivation, same ordering, same free-text-in-free-text-out rule as the
 * other two.
 */

export const NO_OPTIONS: ReceiptOptions = {
  categories: [],
  paymentMethods: [],
  vendors: [],
  vendorDefaults: {},
};

/** The one document id each list is referenced by, from `list=`. */
export const CATEGORY_LIST_ID = "category-options";
export const PAYMENT_LIST_ID = "payment-options";
export const VENDOR_LIST_ID = "vendor-options";

/** What a save has to say for the fetched lists to be out of date. */
export interface SavedValues {
  category: string | null;
  paymentMethod: string | null;
  vendor: string | null;
}

/**
 * Whether a just-saved receipt used a value the lists do not carry - the
 * only condition that makes them stale, so the only one that costs a
 * re-fetch. Compared exactly, as the server's own filters compare: free
 * text is the user's own data and is never normalized here (the 2026-08-26
 * ruling on a doubled-space category, which applies to vendor exactly as it
 * does to category and payment method).
 */
export function introducesNewValue(
  options: ReceiptOptions,
  saved: SavedValues,
): boolean {
  return (
    (saved.category !== null && !options.categories.includes(saved.category)) ||
    (saved.paymentMethod !== null &&
      !options.paymentMethods.includes(saved.paymentMethod)) ||
    (saved.vendor !== null && !options.vendors.includes(saved.vendor))
  );
}

export interface ReceiptOptionsHandle {
  /** The user's past values; empty until the first fetch answers. */
  values: ReceiptOptions;
  /** Report a saved receipt: re-fetches only if it used a new value. */
  noteSaved: (saved: SavedValues) => void;
}

/**
 * One fetch per signed-in session, held at the top of the app: a new
 * `KeptApi` means a new token means a different person's values, so the
 * lists reset with it rather than leaking across a sign-out.
 */
export function useReceiptOptions(api: KeptApi | null): ReceiptOptionsHandle {
  const [values, setValues] = useState<ReceiptOptions>(NO_OPTIONS);

  const load = useCallback(async () => {
    if (api === null) {
      return;
    }
    try {
      setValues(await api.receiptOptions());
    } catch {
      // Deliberately silent, and the only silent failure in this client:
      // these are suggestions over an input that works without them, so a
      // refused fetch degrades to plain free text with nothing for the
      // person to do about it. The last good lists are kept - a failed
      // refresh must not empty a working picker.
    }
  }, [api]);

  useEffect(() => {
    if (api === null) {
      setValues(NO_OPTIONS);
      return;
    }
    void load();
  }, [api, load]);

  const noteSaved = useCallback(
    (saved: SavedValues) => {
      if (introducesNewValue(values, saved)) {
        void load();
      }
    },
    [values, load],
  );

  return { values, noteSaved };
}

/**
 * All three lists, rendered once by whichever screen owns the inputs that
 * name them. Only one such screen is mounted at a time (App renders one
 * view), so the three ids stay unique in the document.
 */
export function ReceiptOptionsDatalists({
  values,
}: {
  values: ReceiptOptions;
}) {
  return (
    <>
      <datalist id={CATEGORY_LIST_ID}>
        {values.categories.map((value) => (
          <option key={value} value={value} />
        ))}
      </datalist>
      <datalist id={PAYMENT_LIST_ID}>
        {values.paymentMethods.map((value) => (
          <option key={value} value={value} />
        ))}
      </datalist>
      <datalist id={VENDOR_LIST_ID}>
        {values.vendors.map((value) => (
          <option key={value} value={value} />
        ))}
      </datalist>
    </>
  );
}
