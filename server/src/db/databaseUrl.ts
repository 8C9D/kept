/**
 * Reading a Postgres URL as an identity rather than as a string, and the
 * guard the destructive dev scripts run before they touch anything.
 *
 * Both live here because the test harness and the dev scripts need the same
 * parsing and were about to have two copies of it: wave 4 built
 * `assertSeparateTestDatabase` for `npm test`, and the August 2026 audit
 * found `db:seed` issuing three unconditional deletes with no equivalent -
 * on the one thing §10B calls non-deferrable, six-year retention. Two
 * near-identical URL parsers would be the duplication that lets one of them
 * quietly get a case wrong.
 */

export interface DatabaseIdentity {
  host: string;
  port: string;
  database: string;
}

export function databaseIdentity(url: string, label: string): DatabaseIdentity {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new Error(`${label} is not a parseable URL: ${url}`, { cause: error });
  }
  return {
    host: normalizeHost(parsed.hostname),
    // Postgres URLs may omit the port; both sides then default alike.
    port: parsed.port === "" ? "5432" : parsed.port,
    database: parsed.pathname.replace(/^\//, ""),
  };
}

/**
 * The loopback spellings all reach the same local Postgres; comparing them
 * literally would let "127.0.0.1" slip past a guard written as "localhost".
 * General DNS aliases stay unresolved - these guards protect the local dev
 * database, not every topology.
 */
export function normalizeHost(host: string): string {
  return LOOPBACK_ALIASES.has(host.toLowerCase())
    ? "localhost"
    : host.toLowerCase();
}

const LOOPBACK_ALIASES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Refuse to run a destructive dev script against anything but a database on
 * this machine.
 *
 * Loopback only, deliberately. A `.local` mDNS name or a LAN address
 * resolves to *a* machine on the network, not necessarily this one, and the
 * whole value of this guard is that it cannot be argued with in the moment
 * someone exports a `DATABASE_URL` to try something. The deployment target
 * is Neon, whose hostnames are remote by construction, so the production
 * database can never satisfy this check.
 *
 * @param action what the caller is about to do, stated in the refusal - a
 * guard that says only "refused" leaves the reader to guess the stakes.
 */
export function assertLocalDatabase(
  url: string,
  label: string,
  action: string,
): void {
  const identity = databaseIdentity(url, label);
  if (identity.host !== "localhost") {
    throw new Error(
      `Refusing to run against ${identity.host}:${identity.port}/${identity.database}: ` +
        `${action}, and ${label} names a database that is not on this machine. ` +
        `Dev scripts run against the local docker-compose database only.`,
    );
  }
}

/**
 * Whether a Postgres URL asks for an encrypted connection.
 *
 * ⚠ `pg` negotiates nothing on its own. A URL with no `sslmode` connects in
 * cleartext, so the only thing standing between receipt data and the wire is
 * what the URL says, and `assertProductionEnv` refuses a production URL that
 * says nothing.
 *
 * Measured at the layer that actually decides, `client.connectionParameters.ssl`
 * (installed `pg`, `pg-connection-string@2.14.0`):
 *
 *   (none)                -> false   cleartext
 *   ?sslmode=disable      -> false   cleartext
 *   ?sslmode=allow        -> {}      encrypted
 *   ?sslmode=prefer       -> {}      encrypted
 *   ?sslmode=require      -> {}      encrypted
 *   ?sslmode=verify-full  -> {}      encrypted
 *   ?ssl=true / ?ssl=1    -> true    encrypted
 *
 * NOT `pool.options.ssl`, which is what the first version of this comment
 * quoted. `Pool` does not parse the connection string at all - it hands it to
 * `Client` at connect time - so `pool.options.ssl` is `undefined` for EVERY
 * url, including `?sslmode=require`. It reproduces identically on a
 * configuration this check considers correct, which makes it no evidence at
 * all (REVIEW-FINAL F-2).
 *
 * ⚠ `prefer` and `allow` are refused even though the table above shows they
 * encrypt today, and the reason is forward-compatibility rather than current
 * behaviour. `pg-connection-string` currently sets `ssl` for any `sslmode` but
 * `disable`, so both fail closed; `pg`'s own runtime deprecation warning says
 * v3 / `pg` v9 will adopt libpq semantics, under which both fall back to
 * CLEARTEXT when the server declines. Refusing them now costs a deployment
 * nothing that `require` does not give it, and means this check does not
 * silently become decorative on a dependency bump. Stated as the forward-
 * looking choice it is, because the first version of this comment claimed
 * libpq semantics were "what `pg` parses", and that was false of the installed
 * version (REVIEW-FINAL F-3).
 */
export function requiresTls(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Unparseable is not "requires TLS". The caller has its own refusal for a
    // malformed URL; saying "yes" here would let one skip the other.
    return false;
  }
  const sslmode = parsed.searchParams.get("sslmode");
  if (sslmode !== null) {
    return ENCRYPTING_SSLMODES.has(sslmode.toLowerCase());
  }
  // `pg-connection-string` treats `ssl=1` exactly as `ssl=true`, so refusing
  // one and accepting the other would refuse a connection that does encrypt.
  const ssl = parsed.searchParams.get("ssl");
  return ssl === "true" || ssl === "1";
}

const ENCRYPTING_SSLMODES = new Set(["require", "verify-ca", "verify-full"]);
