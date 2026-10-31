import { useCallback, useEffect, useRef, useState } from "react";
import type { KeptApi } from "./api.js";
import { LatestRequest } from "./requests.js";
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

/** Where the lists stand, for the one screen whose subject they are. */
export type OptionsLoad =
  | { state: "loading" }
  | { state: "ready" }
  | { state: "failed"; detail: string };

export interface ReceiptOptionsHandle {
  /** The user's past values; empty until the first fetch answers. */
  values: ReceiptOptions;
  /**
   * How the latest fetch went (2026-10). The form's pickers ignore this: a
   * refused fetch degrades them to plain free text with nothing for anyone
   * to do about it. The manage-values screen cannot ignore it, because there
   * the lists ARE the content, and an empty list is a statement about the
   * person's data rather than a missing convenience.
   */
  load: OptionsLoad;
  /** Report a saved receipt: re-fetches only if it used a new value. */
  noteSaved: (saved: SavedValues) => void;
  /**
   * Re-fetch unconditionally (2026-09-01, for the manage-values screen).
   * `noteSaved` above is the cheap path for the common case - a save that
   * introduced nothing new costs no request - but a rename or a delete
   * changes the lists in ways no saved receipt describes, so that screen
   * asks for the lists again outright rather than trying to predict them.
   */
  reload: () => void;
}

/**
 * One fetch per signed-in session, held at the top of the app: a new
 * `KeptApi` means a new token means a different person's values, so the
 * lists reset with it rather than leaking across a sign-out.
 */
export function useReceiptOptions(api: KeptApi | null): ReceiptOptionsHandle {
  const [values, setValues] = useState<ReceiptOptions>(NO_OPTIONS);
  const [loadState, setLoadState] = useState<OptionsLoad>({ state: "loading" });
  const requests = useRef(new LatestRequest());

  const load = useCallback(async () => {
    if (api === null) {
      return;
    }
    const ticket = requests.current.begin();
    setLoadState({ state: "loading" });
    try {
      const loaded = await api.receiptOptions();
      if (requests.current.isLatest(ticket)) {
        setValues(loaded);
        setLoadState({ state: "ready" });
      }
    } catch (caught) {
      // The last good lists are kept - a failed refresh must not empty a
      // working picker - and the failure goes in `load` for the one screen
      // that has to say so (see its comment above).
      if (requests.current.isLatest(ticket)) {
        setLoadState({
          state: "failed",
          detail: caught instanceof Error ? caught.message : String(caught),
        });
      }
    }
  }, [api]);

  useEffect(() => {
    // Cleared whichever way the session changed, so one person's values
    // never sit on screen while the next person's are on their way.
    setValues(NO_OPTIONS);
    if (api === null) {
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

  const reload = useCallback(() => {
    void load();
  }, [load]);

  return { values, load: loadState, noteSaved, reload };
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
