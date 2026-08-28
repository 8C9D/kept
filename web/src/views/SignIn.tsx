import { useEffect, useRef, useState } from "react";
import { KeptApi } from "../api.js";

/**
 * Sign in with Apple for the web (spec §7A). Apple's JS drives a popup
 * against the Services ID and hands back an identity token, which the same
 * POST /api/auth/apple the iOS app uses exchanges for a session.
 *
 * The Services ID and its verified domain are Apple-portal artifacts that
 * exist only for the deployed site, so the DEV build signs in differently:
 * `npm run dev:session-token` (server/) prints a session token signed with
 * the local server's own secret, pasted into the entry below. That entry is
 * compiled only into dev builds - the production bundle carries the Apple
 * path and nothing else.
 */

/** The Services ID the owner registers in the Apple portal (wave-7 gate §3). */
const APPLE_WEB_CLIENT_ID = "com.arthurzhang.kept.web";
const APPLE_JS_URL =
  "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js";

interface AppleSignInResponse {
  authorization: { id_token: string };
  user?: { name?: { firstName?: string; lastName?: string } };
}

interface AppleIdAuth {
  auth: {
    init(config: {
      clientId: string;
      scope: string;
      redirectURI: string;
      usePopup: boolean;
    }): void;
    signIn(): Promise<AppleSignInResponse>;
  };
}

export function SignIn({
  onSignedIn,
}: {
  onSignedIn: (token: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const appleReady = useRef<Promise<AppleIdAuth> | null>(null);

  useEffect(() => {
    if (import.meta.env.DEV) {
      return;
    }
    appleReady.current = loadAppleJs();
  }, []);

  async function signInWithApple() {
    setBusy(true);
    setError(null);
    try {
      const apple = await (appleReady.current ?? loadAppleJs());
      const result = await apple.auth.signIn();
      const name = result.user?.name;
      const displayName = [name?.firstName, name?.lastName]
        .filter((part): part is string => part !== undefined && part !== "")
        .join(" ");
      const signedIn = await KeptApi.signInWithApple(
        result.authorization.id_token,
        displayName === "" ? undefined : displayName,
      );
      onSignedIn(signedIn.token);
    } catch (caught) {
      // Apple's popup rejects with an object carrying `error` when the
      // person closes it; that is a cancel, not a failure to report.
      const detail =
        caught instanceof Error ? caught.message : describeAppleError(caught);
      if (detail !== null) {
        setError(detail);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <h1>Kept</h1>
      <p>Sign in to see your receipts.</p>
      {!import.meta.env.DEV && (
        <button className="primary" disabled={busy} onClick={() => void signInWithApple()}>
          Sign in with Apple
        </button>
      )}
      {import.meta.env.DEV && <DevTokenEntry onSignedIn={onSignedIn} />}
      {error !== null && <p className="error">{error}</p>}
    </div>
  );
}

/**
 * Dev builds only - and structurally so, the way the iOS settings sheet is
 * compiled out of Release (wave 6): the production bundle contains neither
 * this component nor the string on its button, which the gate's bundle
 * check asserts.
 */
function DevTokenEntry({
  onSignedIn,
}: {
  onSignedIn: (token: string) => void;
}) {
  const [value, setValue] = useState("");
  if (!import.meta.env.DEV) {
    return null;
  }
  return (
    <form
      className="dev-token"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim() !== "") {
          onSignedIn(value.trim());
        }
      }}
    >
      <label>
        Dev session token (from <code>npm run dev:session-token</code>)
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="paste token"
        />
      </label>
      <button className="primary" type="submit">
        Use dev token
      </button>
    </form>
  );
}

function loadAppleJs(): Promise<AppleIdAuth> {
  return new Promise((resolve, reject) => {
    const existing = (window as { AppleID?: AppleIdAuth }).AppleID;
    if (existing !== undefined) {
      resolve(existing);
      return;
    }
    const script = document.createElement("script");
    script.src = APPLE_JS_URL;
    script.onload = () => {
      const apple = (window as { AppleID?: AppleIdAuth }).AppleID;
      if (apple === undefined) {
        reject(new Error("Apple's sign-in script loaded but exposed nothing"));
        return;
      }
      apple.auth.init({
        clientId: APPLE_WEB_CLIENT_ID,
        scope: "name email",
        redirectURI: `${window.location.origin}/`,
        usePopup: true,
      });
      resolve(apple);
    };
    script.onerror = () =>
      reject(new Error("Apple's sign-in script failed to load"));
    document.head.appendChild(script);
  });
}

/** Null for a user cancel; a sentence for anything else. */
function describeAppleError(caught: unknown): string | null {
  if (typeof caught === "object" && caught !== null && "error" in caught) {
    const code = String((caught as { error: unknown }).error);
    if (code === "popup_closed_by_user" || code === "user_cancelled_authorize") {
      return null;
    }
    return `Apple sign-in failed: ${code}`;
  }
  return "Apple sign-in failed";
}
