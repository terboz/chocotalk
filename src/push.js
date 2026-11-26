// Web Push sender for Cloudflare Workers, using only the Web Crypto API.
//   RFC 8030 (Web Push), RFC 8291 (aes128gcm message encryption), RFC 8292 (VAPID)
// The VAPID key pair is kept as one secret: VAPID_PRIVATE_JWK = {"kty":"EC","crv":"P-256","d":..,"x":..,"y":..}

const encoder = new TextEncoder();

// Push services the server is allowed to POST to (prevents SSRF via fake endpoints).
const PUSH_HOST_SUFFIXES = [
  ".push.apple.com",                 // Safari / iOS / iPadOS / macOS
  ".notify.windows.com",             // Edge on Windows (WNS)
  ".push.services.mozilla.com",      // Firefox
];
const PUSH_HOSTS = new Set([
  "fcm.googleapis.com",              // Chrome / Android / Edge (FCM)
  "updates.push.services.mozilla.com",
]);

const JWT_LIFETIME_SEC = 12 * 60 * 60;
const JWT_REUSE_SEC = 60 * 60;

export function b64urlEncode(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(text) {
  const normalized = String(text).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "===".slice((normalized.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concatBytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function isAllowedPushEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length > 1024) return false;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.has(host) || PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

export function isValidSubscriptionKeys(p256dh, auth) {
  if (typeof p256dh !== "string" || typeof auth !== "string") return false;
  if (p256dh.length > 120 || auth.length > 64) return false;
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(p256dh) || !/^[A-Za-z0-9_-]+={0,2}$/.test(auth)) return false;
  try {
    const key = b64urlDecode(p256dh);
    const secret = b64urlDecode(auth);
    return key.length === 65 && key[0] === 4 && secret.length >= 16;
  } catch {
    return false;
  }
}

// ---- VAPID ----

const vapidCache = new Map(); // secret text -> Promise<{ privateKey, publicKey }>
const jwtCache = new Map();   // audience -> { token, reuseUntil }

export function loadVapidKeys(secretText) {
  if (typeof secretText !== "string" || !secretText.trim()) return Promise.resolve(null);
  if (!vapidCache.has(secretText)) {
    vapidCache.set(secretText, importVapidKeys(secretText).catch((error) => {
      console.error("VAPID key import failed:", error);
      vapidCache.delete(secretText);
      return null;
    }));
  }
  return vapidCache.get(secretText);
}

async function importVapidKeys(secretText) {
  const jwk = JSON.parse(secretText.trim());
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d || !jwk.x || !jwk.y) {
    throw new Error("VAPID_PRIVATE_JWK must be a P-256 EC private JWK");
  }
  const publicRaw = concatBytes(Uint8Array.of(4), b64urlDecode(jwk.x), b64urlDecode(jwk.y));
  if (publicRaw.length !== 65) throw new Error("VAPID public key has a wrong length");
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: jwk.d, x: jwk.x, y: jwk.y, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return { privateKey, publicKey: b64urlEncode(publicRaw) };
}

export async function createVapidJwt(keys, audience, subject, nowSec) {
  const header = b64urlEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlEncode(encoder.encode(JSON.stringify({
    aud: audience,
    exp: nowSec + JWT_LIFETIME_SEC,
    sub: subject,
  })));
  const unsigned = `${header}.${claims}`;
  // Web Crypto returns the raw r||s (64 bytes) signature that JWS ES256 expects.
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keys.privateKey,
    encoder.encode(unsigned),
  );
  return `${unsigned}.${b64urlEncode(signature)}`;
}

async function vapidAuthorization(keys, endpoint, subject) {
  const audience = new URL(endpoint).origin;
  const nowSec = Math.floor(Date.now() / 1000);
  const cacheKey = `${keys.publicKey}|${subject}|${audience}`;
  const cached = jwtCache.get(cacheKey);
  let token = cached && cached.reuseUntil > nowSec ? cached.token : null;
  if (!token) {
    token = await createVapidJwt(keys, audience, subject, nowSec);
    jwtCache.set(cacheKey, { token, reuseUntil: nowSec + JWT_REUSE_SEC });
  }
  return `vapid t=${token}, k=${keys.publicKey}`;
}

// ---- RFC 8291 encryption ----

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

// options.asKeyPair / options.salt exist only for tests (RFC 8291 Appendix A).
export async function encryptPushPayload(payload, p256dh, auth, options = {}) {
  const uaPublic = b64urlDecode(p256dh);
  const authSecret = b64urlDecode(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("invalid p256dh");
  if (authSecret.length < 16) throw new Error("invalid auth secret");

  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const asKeyPair = options.asKeyPair || await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeyPair.publicKey));
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: uaKey },
    asKeyPair.privateKey,
    256,
  ));

  const keyInfo = concatBytes(encoder.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = options.salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

  const data = typeof payload === "string" ? encoder.encode(payload) : payload;
  const plaintext = concatBytes(data, Uint8Array.of(2)); // single (last) record delimiter
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    aesKey,
    plaintext,
  ));

  // aes128gcm header: salt(16) | record size(4) | key id length(1) | key id (as_public)
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concatBytes(header, ciphertext);
}

// Returns the push service HTTP status (201 = accepted, 404/410 = subscription gone).
export async function sendWebPush({ subscription, payload, keys, subject, ttl = 86400, urgency = "high" }) {
  const body = await encryptPushPayload(payload, subscription.p256dh, subscription.auth);
  const authorization = await vapidAuthorization(keys, subscription.endpoint, subject);
  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttl),
      Urgency: urgency,
    },
    body,
  });
  if (!response.ok && response.status !== 404 && response.status !== 410) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      // ignore
    }
    console.error(`push rejected (${response.status}) by ${new URL(subscription.endpoint).host}: ${detail}`);
  } else if (response.body) {
    try {
      await response.body.cancel();
    } catch {
      // ignore
    }
  }
  return response.status;
}
