import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KeptApi, type UnauthorizedAttempt } from "./api.js";
import { configureEventLogging, logEvent } from "./events.js";
import { useReceiptOptions } from "./options.js";
import {
  clearToken,
  sameSessionUser,
  storeToken,
  storedToken,
} from "./session.js";
import { ConfirmQueue } from "./views/ConfirmQueue.js";
import { ExportView } from "./views/ExportView.js";
import { ManageValuesView } from "./views/ManageValues.js";
import { ReceiptDetailView } from "./views/ReceiptDetail.js";
import { ReceiptsTable } from "./views/ReceiptsTable.js";
import { SignIn, SignInControls } from "./views/SignIn.js";
import { UploadView, useUploadQueue } from "./views/UploadView.js";

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
  // The token this session STARTED with - what identifies the session, and
  // so what `api` and `<main>` are keyed on. A re-sign-in after an expiry
  // (`resumeSession`) renews the live token inside `api` and deliberately
  // leaves this alone, because changing it would rebuild both, and the
  // mounted form is the thing being kept.
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
  // A save came back 401 (2026-10). The view stays mounted under the banner
  // this drives, with whatever is typed in it. The ref is the same fact for
  // `onUnauthorized`, which runs outside a render and must not sign out
  // from under the banner when a read fails right behind the write.
  const [sessionExpired, setSessionExpiredState] = useState(false);
  const sessionExpiredRef = useRef(false);
  const setSessionExpired = useCallback((expired: boolean) => {
    sessionExpiredRef.current = expired;
    setSessionExpiredState(expired);
  }, []);

  const changed = useCallback(() => setDataVersion((version) => version + 1), []);

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
    setSessionExpired(false);
  }, [setSessionExpired]);

  /**
   * What a 401 on the person's own request does. A write keeps the view: it
   * is the click that was carrying their work, and the old behaviour - sign
   * out, unmount - took the form with it. A read has nothing to keep, and a
   * full sign-out is also what gets the app back on its feet, since it
   * remounts the screen whose load just failed. Never once the banner is up:
   * then there IS something to keep, whatever the read was.
   */
  const onUnauthorized = useCallback(
    (attempt: UnauthorizedAttempt) => {
      if (attempt === "write") {
        setSessionExpired(true);
      } else if (!sessionExpiredRef.current) {
        signOut();
      }
    },
    [setSessionExpired, signOut],
  );

  /** The tail both ways of signing in share; only what follows it differs. */
  const adoptToken = useCallback(
    (newToken: string) => {
      storeToken(newToken);
      // Configured here, before logging - not left to the useEffect below -
      // so the very first event of a session has a queue to land in rather
      // than being dropped while nothing is active yet.
      configureEventLogging(newToken);
      logEvent({ action: "sign_in" });
      setSessionExpired(false);
    },
    [setSessionExpired],
  );

  const beginSession = useCallback(
    (newToken: string) => {
      adoptToken(newToken);
      setToken(newToken);
    },
    [adoptToken],
  );

  // Safety net for the case neither `onSignedIn` nor `signOut` covers: a
  // page load with a session already in storage. Idempotent
  // (configureEventLogging no-ops on the token it is already configured
  // for), so this runs harmlessly alongside the explicit calls those two
  // make for their own ordering reasons.
  useEffect(() => {
    configureEventLogging(token);
  }, [token]);

  const api = useMemo(
    () => (token === null ? null : new KeptApi(token, onUnauthorized)),
    [token, onUnauthorized],
  );

  // One fetch of the reusable category and payment values per signed-in
  // session, held here because three screens offer them and none of them
  // owns the session. Unconditional, above the sign-in return: it clears
  // itself when `api` goes null, so one person's values never outlive
  // their session.
  const options = useReceiptOptions(api);
  // Here for the same reason, and because a batch has to keep reporting to
  // something while the person looks at another screen (UploadView.tsx).
  const uploads = useUploadQueue(api, changed);

  if (api === null || token === null) {
    return <SignIn onSignedIn={beginSession} />;
  }

  // Shared by the table's own row-open, the confirm queue's and the
  // detail view's "open the matching receipt" (proposal #8) - all three
  // want the identical view transition, so there is exactly one place
  // that knows what "open a receipt" means.
  const openReceipt = (id: string) => setView({ name: "detail", id });

  // Bound here, where the early return above has already established there
  // is one: narrowing on `api` does not follow into a closure.
  const signedInApi = api;
  const sessionToken = token;

  /**
   * A sign-in from the session-expired banner. The same person carries on
   * exactly where they were: `renew` swaps the token under every mounted
   * screen, nothing reloads, and the draft is still in its boxes for them to
   * press Save again. Anyone else gets a fresh app - what is on screen is not
   * theirs - and that costs a draft, which the alternative must never cost.
   */
  function resumeSession(newToken: string) {
    if (!sameSessionUser(sessionToken, newToken)) {
      signOut();
      beginSession(newToken);
      return;
    }
    signedInApi.renew(newToken);
    adoptToken(newToken);
  }

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
      {sessionExpired && (
        <div className="session-expired" role="alert">
          <p>
            Your session has expired, so that last change was not saved. What
            you have typed is still here - sign in again, then save once more.
          </p>
          <SignInControls onSignedIn={resumeSession} />
        </div>
      )}
      {deletionError !== null && (
        <p className="error" role="alert">
          Your account was not deleted: {deletionError}
        </p>
      )}
      {/* Keyed on the session: a different person signing in over the banner
          must not inherit one screen's worth of the last person's state. */}
      <main key={sessionToken}>
        {view.name === "table" && (
          <ReceiptsTable
            api={api}
            dataVersion={dataVersion}
            options={options}
            onOpen={openReceipt}
            onConfirmQueue={() => setView({ name: "confirm" })}
          />
        )}
        {view.name === "detail" && (
          // Keyed by id: everything this screen holds - the draft, its
          // edits, an armed Delete, an in-flight image write - belongs to
          // one receipt. Unkeyed, "Open" on a duplicate reused it for
          // another, and a page upload finishing afterwards paired
          // setReceipt(A) with B's draft, so Save PATCHed A with B's values.
          <ReceiptDetailView
            key={view.id}
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
        {view.name === "upload" && <UploadView uploads={uploads} />}
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
