/**
 * HTTPS, or this machine: the one rule for every request that carries a
 * Javis credential.
 *
 * Spec: javis-server/docs/superpowers/specs/2026-09-24-obsidian-notes-ingest-design.md
 *       §C (the `wiki:write` grant), §F.5 (the README promises HTTPS).
 *
 * Since 0.2.0 a connected device's bearer is issued for the `/wiki` resource
 * and, once a folder is selected, carries `wiki:write`: it can replace or
 * delete every source the user has uploaded. The first review refused plain
 * `http:` only on the upload routes (sources-api.ts), but the same bearer
 * went to `/wiki/export` on every download, and the OAuth calls — register,
 * the code exchange, every refresh, revoke — sent the refresh token that
 * mints it. The download runs before the upload on every trigger, so on an
 * `http://` server URL the write token was in the clear before the upload
 * guard ever ran (second review). So the rule now lives here, and every
 * client that builds a credentialed URL asks it first. Cleartext stays
 * allowed to a loopback host, for a development server on this computer.
 *
 * Throws a plain `Error`, like the other URL builders: a server URL that is
 * not allowed is a configuration mistake, not a protocol failure, and its
 * message is the sentence the settings tab and the Notice show.
 */

/** `localhost`, `127.0.0.0/8`, or `::1` — as `URL.hostname` spells them. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** True when a credential may be sent to `url`: https, or http to this machine. */
export function isSecureUrl(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && isLoopbackHost(url.hostname);
}

/** Throws unless `url` is https, or http to this machine. */
export function assertSecureUrl(url: URL): void {
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new Error(
      `The Javis server URL must use https; ${url.origin} is plain http. ` +
        'Only a server on this computer (localhost) may use http.',
    );
  }
}

/**
 * `baseUrl` (already trimmed of trailing slashes) if it is an absolute
 * http(s) URL that passes `assertSecureUrl`; throws otherwise.
 */
export function secureOrigin(baseUrl: string): string {
  const trimmed = (baseUrl ?? '').trim().replace(/\/+$/, '');
  if (trimmed === '') throw new Error('Javis server URL is not set.');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Javis server URL is not a valid URL: ${trimmed}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Javis server URL must be http or https, got ${url.protocol}`);
  }
  assertSecureUrl(url);
  return trimmed;
}
