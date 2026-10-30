import Keycloak from "keycloak-js";

// VITE_KEYCLOAK_URL="" turns login off, for running against an orchestrator without AUTH_ISSUER.
const env = (import.meta as any).env ?? {};
const URL_ = env.VITE_KEYCLOAK_URL ?? "http://localhost:8180";
const REALM = env.VITE_KEYCLOAK_REALM ?? "ramlaal";
const CLIENT_ID = env.VITE_KEYCLOAK_CLIENT_ID ?? "ramlaal-ui";

let kc: Keycloak | undefined;

// Redirects to the Keycloak login page (authorization code + PKCE) until the user is signed in.
export async function initAuth(): Promise<void> {
  if (!URL_) return;
  kc = new Keycloak({ url: URL_, realm: REALM, clientId: CLIENT_ID });
  kc.onTokenExpired = () => void kc?.updateToken(30).catch(() => kc?.login());
  await kc.init({ onLoad: "login-required", pkceMethod: "S256", checkLoginIframe: false });
}

export function signOut() {
  void kc?.logout({ redirectUri: window.location.origin });
}

export function userName(): string | undefined {
  return kc?.tokenParsed?.preferred_username;
}

// Headers for an API call; refreshes the token first when it is about to expire.
export async function authHeaders(): Promise<Record<string, string>> {
  if (!kc) return {};
  await kc.updateToken(30).catch(() => kc!.login());
  return kc.token ? { Authorization: `Bearer ${kc.token}` } : {};
}

// EventSource cannot set headers, so the stream takes the token as a query parameter.
export function withStreamToken(url: string): string {
  return kc?.token ? `${url}?access_token=${encodeURIComponent(kc.token)}` : url;
}
