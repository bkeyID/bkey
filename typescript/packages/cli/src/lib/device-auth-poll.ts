// copyright © 2025-2026 bkey inc. all rights reserved.

interface DeviceAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

/**
 * Poll the OAuth token endpoint for device authorization completion.
 * Handles: authorization_pending, slow_down, expired_token, access_denied.
 */
export async function pollDeviceAuth(
  apiUrl: string,
  deviceCode: string,
  clientId: string,
  interval = 5,
  timeoutMs = 600_000,
  serverExpiresIn?: number,
): Promise<DeviceAuthTokenResponse> {
  const effectiveTimeout = serverExpiresIn
    ? Math.min(timeoutMs, serverExpiresIn * 1000)
    : timeoutMs;
  const deadline = Date.now() + effectiveTimeout;
  let currentInterval = interval;

  while (Date.now() < deadline) {
    const res = await fetch(`${apiUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_id: clientId,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const json = (await res.json()) as Record<string, unknown>;

    if (res.ok) {
      return json as unknown as DeviceAuthTokenResponse;
    }

    const error = json.error as string;

    if (error === 'authorization_pending') {
      await new Promise((resolve) => setTimeout(resolve, currentInterval * 1000));
      continue;
    }

    if (error === 'slow_down') {
      currentInterval += 5;
      await new Promise((resolve) => setTimeout(resolve, currentInterval * 1000));
      continue;
    }

    if (error === 'access_denied') {
      throw new Error('Device authorization was denied by the user.');
    }

    if (error === 'expired_token') {
      throw new Error('Device authorization code expired. Run: bkey auth login');
    }

    throw new Error(`Device auth failed: ${json.error_description ?? error ?? res.status}`);
  }

  throw new Error(`Device authorization timed out after ${timeoutMs / 1000}s.`);
}
