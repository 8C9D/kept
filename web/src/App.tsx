import { useCallback, useMemo, useState } from "react";
import { KeptApi } from "./api.js";
import { useReceiptOptions } from "./options.js";
import { clearToken, storeToken, storedToken } from "./session.js";
import { ConfirmQueue } from "./views/ConfirmQueue.js";
import { ExportView } from "./views/ExportView.js";
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
  | { name: "upload" };

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
    clearToken();
    setToken(null);
    setView({ name: "table" });
    setDeletion("idle");
    setDeletionError(null);
  }, []);

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
          setToken(newToken);
        }}
      />
    );
  }

  const changed = () => setDataVersion((version) => version + 1);

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
        </nav>
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
            onOpen={(id) => setView({ name: "detail", id })}
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
          />
        )}
        {view.name === "confirm" && (
          <ConfirmQueue
            api={api}
            options={options}
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
      </main>
    </div>
  );
}
