// Generates a VAPID key pair for Web Push and prints the private JWK as one line.
// Usage:
//   node scripts/gen-vapid-key.mjs | npx wrangler secret put VAPID_PRIVATE_JWK
// The public key is derived from it at runtime (GET /api/push/key).
import { webcrypto } from "node:crypto";

const { subtle } = webcrypto;
const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = await subtle.exportKey("jwk", pair.privateKey);
const secret = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x, y: jwk.y });

process.stdout.write(secret);
if (process.stdout.isTTY) {
  process.stdout.write("\n");
  console.error("\n上の 1 行（JSON）を VAPID_PRIVATE_JWK という名前の Secret として登録してください。Git にはコミットしないでください。");
}
