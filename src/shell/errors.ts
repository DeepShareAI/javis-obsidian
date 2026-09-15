/**
 * The shell's error vocabulary.
 *
 * Spec: docs/superpowers/specs/2026-09-13-obsidian-wiki-sync-design.md §D, §F.
 *
 * Why classes in a contracts-only layer: `auth` throws these, `api` throws
 * these, `sync` catches them and decides whether to keep going, and `main`
 * turns them into a `Notice`. Three modules written in parallel need one
 * definition, and a caught value has to be *identifiable*. Each carries a
 * literal `code` as well as its class, so narrowing works both ways —
 * `instanceof` inside the bundle, `err.code` for anything that crosses a
 * boundary where prototype identity is not guaranteed.
 *
 * The only distinction that really matters at the call site is the one §D
 * step 6 draws: some failures are worth retrying, and one of them means "stop,
 * and tell the user to reconnect."
 */

/** Discriminant carried by every error in this module. */
export type JavisErrorCode =
  | 'auth-required'
  | 'auth-expired'
  | 'auth-revoked'
  | 'auth-cancelled'
  | 'network'
  | 'http'
  | 'rate-limited'
  | 'protocol'
  | 'vault-write'
  | 'cancelled';

/**
 * Base class. Never thrown directly; `catch (e) { if (e instanceof JavisError) }`
 * is the one check that covers everything this plugin raises on purpose.
 */
export abstract class JavisError extends Error {
  abstract readonly code: JavisErrorCode;

  /**
   * True when running the SAME operation again could plausibly succeed without
   * the user doing anything. Drives the retry/backoff decision in `api` and the
   * "keep going" decision in `sync`; it is not a promise that a retry will work.
   */
  abstract readonly retryable: boolean;

  /**
   * Whether the user must act before sync can work again. When true, `main`
   * shows a Notice and stops the run rather than scheduling a retry.
   */
  readonly needsUserAction: boolean = false;

  /**
   * The underlying failure, when there was one.
   *
   * Declared here rather than inherited: `Error.cause` is an ES2022 addition and
   * this project compiles against `lib: ES2021`. Same name, same meaning, so it
   * reads identically at the call site and will simply shadow the built-in if
   * the lib is raised later.
   */
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

// ---------------------------------------------------------------------------
// §D — authentication
// ---------------------------------------------------------------------------

/**
 * Nothing was ever stored: the user has not connected, or has disconnected.
 *
 * Distinct from `AuthRevokedError` on purpose. "Connect your Javis account" and
 * "your Javis connection expired, reconnect" are different sentences, and the
 * settings tab shows a different button for each.
 */
export class AuthRequiredError extends JavisError {
  readonly code = 'auth-required' as const;
  readonly retryable = false;
  override readonly needsUserAction = true;
}

/**
 * The access token was rejected (HTTP 401) and a refresh has not fixed it.
 *
 * `JavisApiClient` refreshes once and retries the request once before this is
 * raised; seeing it means the second 401 arrived with a freshly minted token,
 * which is a server-side or scope problem rather than ordinary expiry.
 */
export class AuthExpiredError extends JavisError {
  readonly code = 'auth-expired' as const;
  readonly retryable = false;
  override readonly needsUserAction = true;
}

/**
 * The refresh token is gone or the server answered `invalid_grant`.
 *
 * This is §D step 6's terminal state: "show a 'reconnect' notice and stop." The
 * thrower MUST have already cleared both secrets, so the plugin cannot sit in a
 * loop presenting a dead token. Do not retry — refresh tokens rotate on every
 * use (javis_mcp/oauth/token.py), so a replayed one is invalid by construction
 * and retrying only burns the server's rate limit.
 */
export class AuthRevokedError extends JavisError {
  readonly code = 'auth-revoked' as const;
  readonly retryable = false;
  override readonly needsUserAction = true;
}

/**
 * The user walked away from the browser flow, or the loopback listener timed
 * out waiting for the redirect.
 *
 * Not a failure to report loudly: a closed tab is a decision. The listener is
 * closed in a `finally` regardless.
 *
 * Give the timeout real headroom — the `/oauth/callback` page makes three
 * sequential fetches through Clerk before it redirects, so a budget anywhere
 * near the 60s authorization-code TTL will fire on a slow network while the
 * flow is still working.
 */
export class AuthCancelledError extends JavisError {
  readonly code = 'auth-cancelled' as const;
  readonly retryable = false;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * The request never produced an HTTP response: DNS, TLS, offline, dropped
 * socket.
 *
 * Deliberately NOT an auth failure. A refresh that fails this way must leave the
 * stored tokens alone — treating a flight-mode laptop as a revocation would log
 * the user out for being on a train.
 */
export class NetworkError extends JavisError {
  readonly code = 'network' as const;
  readonly retryable = true;
}

/**
 * A response arrived with a status >= 400 that no other class covers.
 *
 * 400 is the interesting one: both doors map a malformed `since` or `cursor` to
 * `invalid_request` rather than a 500, so `body` names the offending parameter.
 * A 400 is not retryable — the same request will be rejected the same way; the
 * cursor has to be discarded and the run restarted from a rescan.
 */
export class HttpError extends JavisError {
  readonly code = 'http' as const;
  readonly retryable: boolean;

  constructor(
    readonly status: number,
    /** Response body, truncated by the thrower. May be JSON or plain text. */
    readonly body: string,
    message?: string,
    options?: { cause?: unknown },
  ) {
    super(message ?? `HTTP ${status}: ${body.slice(0, 200)}`, options);
    // 5xx is the server having a bad moment; 4xx is us asking wrongly.
    this.retryable = status >= 500;
  }
}

/**
 * HTTP 429 from the OAuth door's per-user token bucket — 60 requests per minute
 * (javis_mcp/wiki_export.py:28).
 *
 * Reachable in normal operation: a full export of a large wiki at 500 rows a
 * request is a burst. Back off and resume from the same `cursor`; the run is
 * resumable precisely because the cursor is opaque and stable.
 */
export class RateLimitedError extends JavisError {
  readonly code = 'rate-limited' as const;
  readonly retryable = true;

  constructor(
    /** From `Retry-After` when the server sent one, else null — then back off. */
    readonly retryAfterMs: number | null,
    message = 'Rate limited by the Javis server',
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * A 200 whose body is not the shape §B promises — `pages` missing, `server_time`
 * absent, JSON that will not parse.
 *
 * Raised rather than coped with. A cursor derived from a half-understood
 * response would advance past rows that were never written, and the loop's
 * recovery story (§F.1) assumes the cursor only ever moves over rows the vault
 * has actually seen.
 */
export class ProtocolError extends JavisError {
  readonly code = 'protocol' as const;
  readonly retryable = false;
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

/**
 * A write to one note failed: folder creation refused, the file vanished
 * mid-process, a name the filesystem rejected.
 *
 * Per-note by design. §F.2 processes a batch of independent pages, and one bad
 * note must not abandon the other 499; `sync` collects these into
 * `SyncResult.failures` and keeps going. What it must NOT do is advance the
 * cursor past a batch it could not fully write — re-delivery is free because
 * every write in the loop is idempotent.
 */
export class VaultWriteError extends JavisError {
  readonly code = 'vault-write' as const;
  readonly retryable = true;

  constructor(
    readonly path: string,
    message?: string,
    options?: { cause?: unknown },
  ) {
    super(message ?? `Failed to write ${path}`, options);
  }
}

// ---------------------------------------------------------------------------
// Control flow
// ---------------------------------------------------------------------------

/**
 * The run was aborted — plugin unload, or a second trigger superseding this one.
 *
 * An expected outcome, not an error to surface. `main` swallows it; the cursor
 * is left where it was and the next run re-delivers.
 */
export class SyncCancelledError extends JavisError {
  readonly code = 'cancelled' as const;
  readonly retryable = true;
}

// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------

/** True for anything this plugin threw on purpose. */
export function isJavisError(value: unknown): value is JavisError {
  return value instanceof JavisError;
}

/**
 * True when the user must reconnect before sync can work again: the three
 * auth-fatal codes, and nothing else. This is the check `main` uses to decide
 * between a "reconnect" Notice and a quiet retry.
 */
export function isAuthFatal(
  value: unknown,
): value is AuthRequiredError | AuthExpiredError | AuthRevokedError {
  return (
    isJavisError(value) &&
    (value.code === 'auth-required' ||
      value.code === 'auth-expired' ||
      value.code === 'auth-revoked')
  );
}

/** True when running the same operation again could plausibly succeed. */
export function isRetryable(value: unknown): boolean {
  return isJavisError(value) && value.retryable;
}
