import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface AuthConfig {
  issuer: string;
  discoveryUrl: string;
  audience?: string;
  peerRole: string;
}

// Returns undefined (authentication off) when AUTH_ISSUER is unset.
export function authConfigFromEnv(env: NodeJS.ProcessEnv): AuthConfig | undefined {
  if (!env.AUTH_ISSUER) return undefined;
  return {
    issuer: env.AUTH_ISSUER,
    discoveryUrl: (env.AUTH_DISCOVERY_URL || env.AUTH_ISSUER).replace(/\/$/, ""),
    audience: env.AUTH_AUDIENCE || undefined,
    peerRole: env.AUTH_PEER_ROLE || "swarm-peer",
  };
}

// The gateway runs shell commands, so only Ramlaal instances (service accounts holding the peer role)
// may call it, never end users directly.
export function makeAuthenticator(cfg: AuthConfig, keys?: JWTVerifyGetKey) {
  const jwks = keys ?? createRemoteJWKSet(new URL(`${cfg.discoveryUrl}/protocol/openid-connect/certs`));
  return async (authorization: string | undefined): Promise<boolean> => {
    const m = /^Bearer (.+)$/.exec(authorization ?? "");
    if (!m) return false;
    try {
      const { payload } = await jwtVerify(m[1], jwks, { issuer: cfg.issuer, audience: cfg.audience });
      const roles = (payload.realm_access as { roles?: string[] } | undefined)?.roles ?? [];
      return roles.includes(cfg.peerRole);
    } catch {
      return false;
    }
  };
}
