import { useCallback, useEffect, useMemo, useState } from "react";
import { KeptApi } from "./api.js";
import { configureEventLogging, logEvent } from "./events.js";
import { useReceiptOptions } from "./options.js";
import { clearToken, storeToken, storedToken } from "./session.js";
import { ConfirmQueue } from "./views/ConfirmQueue.js";
import { ExportView } from "./views/ExportView.js";
import { ManageValuesView } from "./views/ManageValues.js";
import { ReceiptDetailView } from "./views/ReceiptDetail.js";
import { ReceiptsTable } from "./views/ReceiptsTable.js";
import { SignIn } from "./views/SignIn.js";
import { UploadView } from "./views/UploadView.js";

/**
 * The web client (spec §7A): the year-end pass and bulk correction, used
 * rarely and intensely - density over friendliness. One view at a time,
 * plain state instead of a router: there are five views and no deep links
 * to keep.
 */
export type View =
  | { name: "table" }
  | { name: "detail"; id: string }
  | { name: "confirm" }
  | { name: "export" }
  | { name: "upload" }
  /** The three reusable-value lists, renameable and removable
   * (2026-09-01). Six views now; still no router - there are still no deep
   * links to keep. */
  | { name: "values" };

export function App() {
  const [token, setToken] = useState<string | null>(storedToken);
  const [view, setView] = useState<View>({ name: "table" });
  // Bumped whenever another view changed data the table should re-fetch.
  const [dataVersion, setDataVersion] = useState(0);
  // Account deletion, in the topbar: idle → confirming → deleting, with the
  // same inline confirm the receipt detail's Delete uses rather than a
  // modal. A separate value for the failure, because a refused deletion
  // returns to idle with something to say.
  const [deletion, setDeletion] = useState<
    "idle" | "confirming" | "deleting"
  >("idle");
  const [deletionError, setDeletionError] = useState<string | null>(null);

  const signOut = useCallback(() => {
    // Logged before the queue tears down, not after (events.ts's own
    // ordering note): configureEventLogging(null) below flushes and clears
    // the active queue, so this event has to land in it first or it is
    // dropped with nothing sent.
    logEvent({ action: "sign_out" });
    configureEventLogging(null);
    clearToken();
    setToken(null);
    setView({ name: "table" });
    setDeletion("idle");
    setDeletionError(null);
  }, []);

  // Safety net for the case neither `onSignedIn` nor `signOut` covers: a
  // page load with a session already in storage. Idempotent
  // (configureEventLogging no-ops on the token it is already configured
  // for), so this runs harmlessly alongside the explicit calls those two
  // make for their own ordering reasons.
  useEffect(() => {
    configureEventLogging(token);
  }, [token]);

  const api = useMemo(
    () => (token === null ? null : new KeptApi(token, signOut)),
    [token, signOut],
  );

  // One fetch of the reusable category and payment values per signed-in
  // session, held here because three screens offer them and none of them
  // owns the session. Unconditional, above the sign-in return: it clears
  // itself when `api` goes null, so one person's values never outlive
  // their session.
  const options = useReceiptOptions(api);

  if (api === null) {
    return (
      <SignIn
        onSignedIn={(newToken) => {
          storeToken(newToken);
          // Configured here, before logging - not left to the useEffect
          // below - so the very first event of a session has a queue to
          // land in rather than being dropped while nothing is active yet.
          configureEventLogging(newToken);
          logEvent({ action: "sign_in" });
          setToken(newToken);
        }}
      />
    );
  }

  const changed = () => setDataVersion((version) => version + 1);
  // Shared by the table's own row-open, the confirm queue's and the
  // detail view's "open the matching receipt" (proposal #8) - all three
  // want the identical view transition, so there is exactly one place
  // that knows what "open a receipt" means.
  const openReceipt = (id: string) => setView({ name: "detail", id });

  // Bound here, where the early return above has already established there
  // is one: narrowing on `api` does not follow into a closure.
  const signedInApi = api;

  async function deleteAccount() {
    setDeletion("deleting");
    setDeletionError(null);
    try {
      await signedInApi.deleteAccount();
    } catch (error) {
      setDeletion("idle");
      setDeletionError(
        error instanceof Error ? error.message : "The account was not deleted.",
      );
      return;
    }
    // The session token is dead the moment the user row is - every route
    // 401s on it now - so the local copy goes with it.
    signOut();
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Kept</span>
        <nav>
          <button
            className={view.name === "table" ? "active" : ""}
            onClick={() => setView({ name: "table" })}
          >
            Receipts
          </button>
          <button
            className={view.name === "upload" ? "active" : ""}
            onClick={() => setView({ name: "upload" })}
          >
            Upload
          </button>
          <button
            className={view.name === "export" ? "active" : ""}
            onClick={() => setView({ name: "export" })}
          >
            Export
          </button>
          <button
            className={view.name === "values" ? "active" : ""}
            onClick={() => setView({ name: "values" })}
          >
            Values
          </button>
        </nav>
        <div className="topbar-actions">
          <button className="signout" onClick={signOut}>
            Sign out
          </button>
          {deletion === "idle" ? (
            <button className="danger" onClick={() => setDeletion("confirming")}>
              Delete account…
            </button>
          ) : deletion === "confirming" ? (
            <span className="delete-confirm">
              Permanently delete your account and every receipt in it, images
              included? This cannot be undone - export first if you need the
              records.
              <button className="danger" onClick={() => void deleteAccount()}>
                Delete account
              </button>
              <button onClick={() => setDeletion("idle")}>Keep my account</button>
            </span>
          ) : (
            <span className="muted">Deleting your account…</span>
          )}
        </div>
      </header>
      {deletionError !== null && (
        <p className="error" role="alert">
          Your account was not deleted: {deletionError}
        </p>
      )}
      <main>
        {view.name === "table" && (
          <ReceiptsTable
            api={api}
            dataVersion={dataVersion}
            options={options}
            onOpen={openReceipt}
            onConfirmQueue={() => setView({ name: "confirm" })}
            onChanged={changed}
          />
        )}
        {view.name === "detail" && (
          <ReceiptDetailView
            api={api}
            receiptId={view.id}
            options={options}
            onBack={() => setView({ name: "table" })}
            onChanged={changed}
            onOpenReceipt={openReceipt}
          />
        )}
        {view.name === "confirm" && (
          <ConfirmQueue
            api={api}
            options={options}
            onOpenReceipt={openReceipt}
            onDone={() => {
              changed();
              setView({ name: "table" });
            }}
          />
        )}
        {view.name === "export" && <ExportView api={api} />}
        {view.name === "upload" && (
          <UploadView api={api} onChanged={changed} />
        )}
        {view.name === "values" && (
          // `changed` is not wired here on purpose: a rename rewrites
          // receipts, but this screen never shows them, and the table
          // re-fetches whenever it is opened.
          <ManageValuesView api={api} options={options} />
        )}
      </main>
    </div>
  );
}
