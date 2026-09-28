/**
 * What the settings tab's Connection section says (spec §D; javis-server spec
 * 2026-09-27-account-email-in-connection-design §3).
 *
 * Pure, and outside settings.ts, so it can be tested: settings.ts imports
 * `obsidian` and is not unit-tested (see settings-load.ts for the same split).
 */

import type { AuthStatus } from './contracts';

/** What the three connection states say when no account email is known. */
export const STATUS_TEXT: Record<AuthStatus, string> = {
  disconnected: 'Not connected. Connect to sign in with your Javis account.',
  connected: 'Connected. Your wiki pages sync into this vault, one way.',
  'needs-reconnect':
    'The saved sign-in was rejected. Reconnect to sign in again — no notes have been changed.',
};

/**
 * The status line. `email` is `JavisOAuth.accountEmail()`: shown only when
 * connected, so a rejected sign-in whose access token is still in the keychain
 * never claims an account. The caller renders it as text, never as HTML.
 */
export function connectionStatusText(status: AuthStatus, email: string | null): string {
  if (status === 'connected' && email !== null) {
    return `Connected as ${email}. Your wiki pages sync into this vault, one way.`;
  }
  return STATUS_TEXT[status];
}
