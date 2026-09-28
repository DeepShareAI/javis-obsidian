/**
 * The connection line in the settings tab (javis-server spec
 * 2026-09-27-account-email-in-connection-design §3): the account's email when
 * connected and the token carries one, today's text otherwise.
 */

import { describe, expect, it } from 'vitest';

import { STATUS_TEXT, connectionStatusText } from '../src/shell/connection-status';

describe('connectionStatusText', () => {
  it('names the account when connected with an email', () => {
    expect(connectionStatusText('connected', 'sam@example.com')).toBe(
      'Connected as sam@example.com. Your wiki pages sync into this vault, one way.',
    );
  });

  it('keeps the old text when connected without an email', () => {
    expect(connectionStatusText('connected', null)).toBe('Connected. Your wiki pages sync into this vault, one way.');
  });

  it('never shows an email unless connected', () => {
    expect(connectionStatusText('disconnected', 'sam@example.com')).toBe(STATUS_TEXT.disconnected);
    expect(connectionStatusText('needs-reconnect', 'sam@example.com')).toBe(STATUS_TEXT['needs-reconnect']);
  });

  it('keeps the disconnected and needs-reconnect wording unchanged', () => {
    expect(STATUS_TEXT.disconnected).toBe('Not connected. Connect to sign in with your Javis account.');
    expect(STATUS_TEXT['needs-reconnect']).toBe(
      'The saved sign-in was rejected. Reconnect to sign in again — no notes have been changed.',
    );
  });
});
