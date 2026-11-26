import { AccountService, type StoredAccount } from '../arcane-launcher/src/main/services/account';
import { MICROSOFT_APPLICATION } from '../arcane-launcher/src/shared/microsoft-app';

export function launchTestAccount(options: { owned?: boolean; allowed?: boolean; expiresIn?: number } = {}) {
  const clientId = MICROSOFT_APPLICATION.clientId;
  const profile = { id: 'b'.repeat(32), name: 'OfficialPlayer', model: 'default' as const };
  const initial: StoredAccount = { clientId, accessToken: 'old-test-token', refreshToken: 'test-refresh', expiresAt: 0, xuid: '1234567890', profile };
  const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  let entitlementChecks = 0;
  const service = new AccountService(clientId, initial, {
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith('/token')) return respond({ access_token: 'test-ms-token', refresh_token: 'test-refresh' });
      if (url.endsWith('/user/authenticate')) return respond({ Token: 'test-xbox-token' });
      if (url.endsWith('/xsts/authorize')) return respond({ Token: 'test-xsts-token', DisplayClaims: { xui: [{ uhs: '123', xid: initial.xuid }] } });
      if (url.endsWith('/login_with_xbox')) return options.allowed === false ? respond({}, 403) : respond({ access_token: 'do-not-expose-this-secret', expires_in: options.expiresIn ?? 3600 });
      if (url.endsWith('/entitlements/mcstore')) {
        entitlementChecks++;
        return respond({ items: options.owned === false ? [] : [{ name: 'game_minecraft' }] });
      }
      if (url.endsWith('/minecraft/profile')) return respond(profile);
      throw new Error('Unexpected account fixture request');
    },
    persist: async () => {},
    changed: () => {},
  });
  return { service, entitlementChecks: () => entitlementChecks };
}
