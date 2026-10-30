import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from "jose";
import { makeAuthenticator, authConfigFromEnv } from "../src/auth.ts";

const cfg = { issuer: "http://kc/realms/r", discoveryUrl: "http://kc/realms/r", audience: "ramlaal", peerRole: "swarm-peer" };

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), alg: "RS256", kid: "k1" };
  const sign = (claims, o = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(o.iss ?? cfg.issuer)
      .setAudience(o.aud ?? cfg.audience)
      .setSubject("svc")
      .setExpirationTime("5m")
      .sign(privateKey);
  return { authenticate: makeAuthenticator(cfg, createLocalJWKSet({ keys: [jwk] })), sign };
}

test("only service accounts with the peer role are accepted", async () => {
  const { authenticate, sign } = await setup();
  assert.equal(await authenticate(`Bearer ${await sign({ realm_access: { roles: ["swarm-peer"] } })}`), true);
  assert.equal(await authenticate(`Bearer ${await sign({ realm_access: { roles: [] } })}`), false, "a user token");
  assert.equal(await authenticate(`Bearer ${await sign({ realm_access: { roles: ["swarm-peer"] } }, { aud: "other" })}`), false, "wrong audience");
  assert.equal(await authenticate(`Bearer ${await sign({ realm_access: { roles: ["swarm-peer"] } }, { iss: "http://evil" })}`), false, "wrong issuer");
  assert.equal(await authenticate("Bearer garbage"), false);
  assert.equal(await authenticate(undefined), false);
});

test("auth is off without AUTH_ISSUER", () => {
  assert.equal(authConfigFromEnv({}), undefined);
  assert.equal(authConfigFromEnv({ AUTH_ISSUER: "http://x/realms/r" })?.peerRole, "swarm-peer");
});
