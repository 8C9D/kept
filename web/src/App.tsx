import { useCallback, useMemo, useState } from "react";
import { KeptApi } from "./api.js";
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

  const signOut = useCallback(() => {
    clearToken();
    setToken(null);
    setView({ name: "table" });
  }, []);

  const api = useMemo(
    () => (token === null ? null : new KeptApi(token, signOut)),
    [token, signOut],
  );

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
      </header>
      <main>
        {view.name === "table" && (
          <ReceiptsTable
            api={api}
            dataVersion={dataVersion}
            onOpen={(id) => setView({ name: "detail", id })}
            onConfirmQueue={() => setView({ name: "confirm" })}
            onChanged={changed}
          />
        )}
        {view.name === "detail" && (
          <ReceiptDetailView
            api={api}
            receiptId={view.id}
            onBack={() => setView({ name: "table" })}
            onChanged={changed}
          />
        )}
        {view.name === "confirm" && (
          <ConfirmQueue
            api={api}
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
