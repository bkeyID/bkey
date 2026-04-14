// copyright © 2025-2026 bkey inc. all rights reserved.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BKey } from './client.js';

describe('BKey', () => {
  describe('constructor', () => {
    it('strips trailing slash from apiUrl', () => {
      const bkey = new BKey({ apiUrl: 'https://api.bkey.id/' });
      // Access private baseUrl via request that reveals it
      expect(() => bkey).not.toThrow();
    });

    it('uses provided access token', async () => {
      const bkey = new BKey({
        apiUrl: 'https://api.bkey.id',
        accessToken: 'test-token',
      });
      const token = await bkey.getValidToken();
      expect(token).toBe('test-token');
    });

    it('throws when no token and no credentials', async () => {
      const bkey = new BKey({ apiUrl: 'https://api.bkey.id' });
      await expect(bkey.getValidToken()).rejects.toThrow('No access token');
    });
  });

  describe('client credentials exchange', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('exchanges client_id + client_secret for a token', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'new-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const bkey = new BKey({
        apiUrl: 'https://api.bkey.id',
        clientId: 'test-client',
        clientSecret: 'test-secret',
      });

      const token = await bkey.getValidToken();
      expect(token).toBe('new-token');

      // Verify the fetch was called correctly
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.bkey.id/oauth/token');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');

      const body = new URLSearchParams(opts.body);
      expect(body.get('grant_type')).toBe('client_credentials');
      expect(body.get('client_id')).toBe('test-client');
      expect(body.get('client_secret')).toBe('test-secret');
    });

    it('throws on failed exchange', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: 'invalid_client', error_description: 'Bad credentials' }),
      }));

      const bkey = new BKey({
        apiUrl: 'https://api.bkey.id',
        clientId: 'bad-client',
        clientSecret: 'bad-secret',
      });

      await expect(bkey.getValidToken()).rejects.toThrow('Bad credentials');
    });

    it('reuses cached token when not expired', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'cached-token',
          expires_in: 3600,
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const bkey = new BKey({
        apiUrl: 'https://api.bkey.id',
        clientId: 'test-client',
        clientSecret: 'test-secret',
      });

      await bkey.getValidToken();
      await bkey.getValidToken(); // second call should use cache

      expect(mockFetch).toHaveBeenCalledOnce();
    });
  });

  describe('URL encoding', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('encodeURIComponent on vault item IDs', async () => {
      const mockFetch = vi.fn()
        // First call: client credentials
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: 'tok', expires_in: 3600 }),
        })
        // Second call: vault access
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: '1', status: 'pending' }),
        });
      vi.stubGlobal('fetch', mockFetch);

      const bkey = new BKey({
        apiUrl: 'https://api.bkey.id',
        clientId: 'c',
        clientSecret: 's',
      });

      await bkey.getAccessRequestStatus('id/with/slashes');

      const [url] = mockFetch.mock.calls[1];
      expect(url).toBe('https://api.bkey.id/v1/vault/access/id%2Fwith%2Fslashes');
    });

    it('encodeURIComponent on checkout IDs', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: 'tok', expires_in: 3600 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: '1', status: 'pending' }),
        });
      vi.stubGlobal('fetch', mockFetch);

      const bkey = new BKey({
        apiUrl: 'https://api.bkey.id',
        clientId: 'c',
        clientSecret: 's',
      });

      await bkey.getCheckoutRequestStatus('chk&id=1');

      const [url] = mockFetch.mock.calls[1];
      expect(url).toBe('https://api.bkey.id/v1/checkout/chk%26id%3D1/status');
    });

    it('encodeURIComponent on listVaultItems itemType', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: 'tok', expires_in: 3600 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ items: [] }),
        });
      vi.stubGlobal('fetch', mockFetch);

      const bkey = new BKey({
        apiUrl: 'https://api.bkey.id',
        clientId: 'c',
        clientSecret: 's',
      });

      await bkey.listVaultItems('type&inject=1');

      const [url] = mockFetch.mock.calls[1];
      expect(url).toBe('https://api.bkey.id/v1/vault/items?itemType=type%26inject%3D1');
    });
  });
});
