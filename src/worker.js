import { DurableObject } from "cloudflare:workers";
import {
  isAllowedPushEndpoint,
  isValidSubscriptionKeys,
  loadVapidKeys,
  sendWebPush,
} from "./push.js";

const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const CODE_PATTERN = /^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/;
const HOST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const IMAGE_PATTERN = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const MEDIA_PATH_PATTERN = /^\/api\/rooms\/[^/]+\/messages\/[^/]+\/media$/;
const NAME_CONTROL_PATTERN = /[\u0000-\u001F\u007F-\u009F]/g;
const MESSAGE_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

const MAX_IMAGE_LENGTH = 250000;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_STAMP_LENGTH = 8;
const MAX_WELCOME_MESSAGES = 200;
const MAX_STORED_MESSAGES = 300;
const MAX_DIRECTORY_ROOMS = 3000;
const MAX_READS = 200;
const READ_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_JSON_LENGTH = 10000;
const MAX_RAW_TEXT_LENGTH = 3000;

// Web Push
const MAX_PUSH_SUBSCRIPTIONS = 100;   // per room
const MAX_PUSH_PER_MESSAGE = 40;      // keep well below the subrequest limit
const PUSH_TTL_SECONDS = 24 * 60 * 60;
const PUSH_BODY_LENGTH = 120;
const DEFAULT_VAPID_SUBJECT = "mailto:noreply@chocotalk.invalid";

const SEND_WINDOW_MS = 10000;
const SEND_CLIENT_LIMIT = 20;
const SEND_IP_LIMIT = 40;
const READ_WINDOW_MS = 5000;
const READ_CLIENT_LIMIT = 10;
const READ_IP_LIMIT = 20;
const RENAME_WINDOW_MS = 10000;
const RENAME_CLIENT_LIMIT = 3;
const RATE_MAX_WINDOW_MS = Math.max(SEND_WINDOW_MS, READ_WINDOW_MS, RENAME_WINDOW_MS);

const API_RATE_LIMIT = 240;
const API_RATE_WINDOW_MS = 60000;
const ROOM_CREATE_LIMIT = 60;
const ROOM_CREATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_RATE_ENTRIES = 2000;

const apiRateLimits = new Map();
const roomCreateLimits = new Map();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function jsonError(message, status) {
  return json({ error: message }, status);
}

// 本文は最大 MAX_JSON_LENGTH バイトまで読み、超過時は 413 を返す。
// 成功時は { value }、失敗時は { response } を返す。
async function readJson(request) {
  if (!request.body) {
    return { response: jsonError("リクエストの形式が正しくありません", 400) };
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let length = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_JSON_LENGTH) {
        try {
          await reader.cancel();
        } catch {
          // 中断済みの場合は無視する
        }
        return { response: jsonError("リクエストが大きすぎます", 413) };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    return { response: jsonError("リクエストの形式が正しくありません", 400) };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 解放済みの場合は無視する
    }
  }

  try {
    return { value: JSON.parse(text) };
  } catch {
    return { response: jsonError("リクエストの形式が正しくありません", 400) };
  }
}

function isBodyTooLarge(request) {
  const header = request.headers.get("content-length");
  if (header === null) return false;
  const length = Number(header);
  return Number.isFinite(length) && length > MAX_JSON_LENGTH;
}

function charLength(value) {
  return Array.from(value).length;
}

function cleanName(value, maxLength) {
  if (typeof value !== "string") return null;
  const name = value.replace(NAME_CONTROL_PATTERN, "").trim();
  if (name.length === 0 || charLength(name) > maxLength) return null;
  return name;
}

function cleanMessageText(value) {
  return value.replace(MESSAGE_CONTROL_PATTERN, "").trim();
}

function parseSettings(value) {
  if (value === undefined) return { readReceipts: true };
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const readReceipts = value.readReceipts === undefined ? true : value.readReceipts;
  if (typeof readReceipts !== "boolean") return null;
  return { readReceipts };
}

function parseSettingsUpdate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.readReceipts !== "boolean") return null;
  return { readReceipts: value.readReceipts };
}

function readSettings(text) {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    // 壊れた設定は既定値で扱う
  }
  return {};
}

function roomToJson(row) {
  const settings = readSettings(row.settings);
  if (typeof settings.readReceipts !== "boolean") settings.readReceipts = true;
  return {
    code: row.code,
    name: row.name,
    hostName: row.host_name,
    closed: Boolean(row.closed),
    createdAt: row.created_at,
    settings,
  };
}

// welcome 用。media 本体は含めず、有無だけ返す。
function messageToJson(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    role: row.role,
    kind: row.kind,
    text: row.text,
    hasMedia: Boolean(row.has_media),
    createdAt: row.created_at,
  };
}

function generateRoomCode() {
  const chars = [];
  const limit = 256 - (256 % CODE_ALPHABET.length);
  while (chars.length < 8) {
    for (const byte of crypto.getRandomValues(new Uint8Array(8))) {
      if (byte < limit) {
        chars.push(CODE_ALPHABET[byte % CODE_ALPHABET.length]);
        if (chars.length === 8) break;
      }
    }
  }
  return chars.join("");
}

function roomStub(env, code) {
  const id = env.ROOMS.idFromName(code);
  return env.ROOMS.get(id);
}

function directoryStub(env) {
  const id = env.DIRECTORY.idFromName("global");
  return env.DIRECTORY.get(id);
}

async function directoryExists(env, code) {
  const response = await directoryStub(env).fetch(
    `https://directory.internal/exists?code=${encodeURIComponent(code)}`,
    { method: "GET" },
  );
  if (!response.ok) throw new Error("Directory lookup failed");
  const data = await response.json();
  return data.exists === true;
}

function getClientIp(request) {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

// 期限切れのレート制限エントリを削除する（Worker は {count, resetAt}、DO は時刻配列を保持）
function pruneRateLimits(map, now) {
  for (const [key, entry] of map) {
    if (Array.isArray(entry)) {
      const recent = entry.filter((time) => now - time < RATE_MAX_WINDOW_MS);
      if (recent.length === 0) {
        map.delete(key);
      } else {
        map.set(key, recent);
      }
    } else if (entry.resetAt <= now) {
      map.delete(key);
    }
  }
  while (map.size > MAX_RATE_ENTRIES) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

function isRateLimited(map, key, limit, windowMs) {
  const now = Date.now();
  let entry = map.get(key);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    map.set(key, entry);
  }
  entry.count += 1;
  if (map.size > MAX_RATE_ENTRIES) pruneRateLimits(map, now);
  return entry.count > limit;
}

function getAttachment(ws) {
  try {
    return ws.deserializeAttachment();
  } catch {
    return null;
  }
}

function safeSend(ws, payload) {
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    // 切断済みのソケットは無視する
    return false;
  }
}

function noStore(response) {
  if (response.status === 101) {
    return new Response(null, {
      status: 101,
      webSocket: response.webSocket,
      headers: { "cache-control": "no-store" },
    });
  }
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ---- Worker ----

async function createRoom(request, env) {
  if (isBodyTooLarge(request)) return jsonError("リクエストが大きすぎます", 413);

  const parsed = await readJson(request);
  if (parsed.response) return parsed.response;
  const body = parsed.value;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonError("リクエストの形式が正しくありません", 400);
  }

  const name = cleanName(body.roomName, 40);
  if (!name) return jsonError("ルーム名は1〜40文字で入力してください", 400);

  const hostName = cleanName(body.hostName, 20);
  if (!hostName) return jsonError("ホスト名は1〜20文字で入力してください", 400);

  if (typeof body.hostId !== "string" || !HOST_ID_PATTERN.test(body.hostId)) {
    return jsonError("hostIdの形式が正しくありません", 400);
  }

  const settings = parseSettings(body.settings);
  if (!settings) return jsonError("設定の形式が正しくありません", 400);

  const ip = getClientIp(request);
  if (isRateLimited(roomCreateLimits, ip, ROOM_CREATE_LIMIT, ROOM_CREATE_WINDOW_MS)) {
    return jsonError("ルーム作成が多すぎます", 429);
  }

  const directory = directoryStub(env);

  // 衝突時は最大5回までコードを再生成する
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = generateRoomCode();

    // 先に Directory へ予約し、Room だけ存在する孤児DOを防ぐ
    const registerResponse = await directory.fetch("https://directory.internal/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });

    if (registerResponse.status === 409) continue;
    if (registerResponse.status === 507) {
      return jsonError("ルーム数が上限に達しました", 503);
    }
    if (!registerResponse.ok) return jsonError("ルームの作成に失敗しました", 500);

    const response = await roomStub(env, code).fetch("https://room.internal/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        roomName: name,
        hostName,
        hostId: body.hostId,
        settings,
      }),
    });

    if (!response.ok) {
      // Room の初期化に失敗したら予約を取り消す
      try {
        await directory.fetch("https://directory.internal/unregister", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code }),
        });
      } catch (error) {
        console.error("Directory unregister failed:", error);
      }
      if (response.status === 409) continue;
      return jsonError("ルームの作成に失敗しました", 500);
    }

    const data = await response.json();
    return json({ code, room: data.room }, 201);
  }

  return jsonError("ルームコードの生成に失敗しました", 500);
}

async function getRoomInfo(env, code, url) {
  if (!(await directoryExists(env, code))) {
    return jsonError("ルームが見つかりません", 404);
  }

  const hostId = url.searchParams.get("hostId");
  const query = hostId && HOST_ID_PATTERN.test(hostId)
    ? `?hostId=${encodeURIComponent(hostId)}`
    : "";
  const response = await roomStub(env, code).fetch(
    `https://room.internal/info${query}`,
    { method: "GET" },
  );
  return noStore(response);
}

async function closeRoom(request, env, code) {
  if (isBodyTooLarge(request)) return jsonError("リクエストが大きすぎます", 413);

  const parsed = await readJson(request);
  if (parsed.response) return parsed.response;
  const body = parsed.value;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonError("リクエストの形式が正しくありません", 400);
  }

  const hostId = body.hostId;
  if (typeof hostId !== "string" || !HOST_ID_PATTERN.test(hostId)) {
    return jsonError("ホスト権限がありません", 403);
  }

  if (!(await directoryExists(env, code))) {
    return jsonError("ルームが見つかりません", 404);
  }

  const response = await roomStub(env, code).fetch("https://room.internal/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostId }),
  });

  if (response.ok) {
    try {
      await directoryStub(env).fetch("https://directory.internal/markClosed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
    } catch (error) {
      console.error("Directory markClosed failed:", error);
    }
  }

  return noStore(response);
}

async function deleteRoom(request, env, code) {
  if (isBodyTooLarge(request)) return jsonError("リクエストが大きすぎます", 413);

  const parsed = await readJson(request);
  if (parsed.response) return parsed.response;
  const body = parsed.value;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonError("リクエストの形式が正しくありません", 400);
  }

  const hostId = body.hostId;
  if (typeof hostId !== "string" || !HOST_ID_PATTERN.test(hostId)) {
    return jsonError("ホスト権限がありません", 403);
  }

  if (!(await directoryExists(env, code))) {
    return jsonError("ルームが見つかりません", 404);
  }

  const response = await roomStub(env, code).fetch("https://room.internal/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostId }),
  });

  if (response.ok) {
    try {
      await directoryStub(env).fetch("https://directory.internal/markClosed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
    } catch (error) {
      console.error("Directory markClosed failed:", error);
    }
  }

  return noStore(response);
}

async function updateRoomSettings(request, env, code) {
  if (isBodyTooLarge(request)) return jsonError("リクエストが大きすぎます", 413);

  const parsed = await readJson(request);
  if (parsed.response) return parsed.response;
  const body = parsed.value;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonError("リクエストの形式が正しくありません", 400);
  }

  const hostId = body.hostId;
  if (typeof hostId !== "string" || !HOST_ID_PATTERN.test(hostId)) {
    return jsonError("ホスト権限がありません", 403);
  }

  const settings = parseSettingsUpdate(body.settings);
  if (!settings) return jsonError("設定の形式が正しくありません", 400);

  if (!(await directoryExists(env, code))) {
    return jsonError("ルームが見つかりません", 404);
  }

  const response = await roomStub(env, code).fetch("https://room.internal/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostId, settings }),
  });
  return noStore(response);
}

async function getPushKey(env) {
  const keys = await loadVapidKeys(env.VAPID_PRIVATE_JWK);
  if (!keys) return jsonError("プッシュ通知は設定されていません", 404);
  return json({ publicKey: keys.publicKey });
}

async function updatePushSubscription(request, env, code) {
  if (isBodyTooLarge(request)) return jsonError("リクエストが大きすぎます", 413);

  const parsed = await readJson(request);
  if (parsed.response) return parsed.response;
  const body = parsed.value;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonError("リクエストの形式が正しくありません", 400);
  }

  if (!(await directoryExists(env, code))) {
    return jsonError("ルームが見つかりません", 404);
  }

  const response = await roomStub(env, code).fetch("https://room.internal/push", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return noStore(response);
}

function pushMessageBody(message) {
  const name = message.name || "ゲスト";
  let body;
  if (message.kind === "image") {
    body = "画像を送信しました";
  } else if (message.kind === "stamp") {
    body = typeof message.text === "string" && message.text.trim() ? message.text : "スタンプを送信しました";
  } else {
    body = typeof message.text === "string" ? message.text : "";
  }
  body = body.replace(/\s+/g, " ").trim();
  if (charLength(body) > PUSH_BODY_LENGTH) {
    body = `${Array.from(body).slice(0, PUSH_BODY_LENGTH - 1).join("")}…`;
  }
  return `${name}: ${body}`;
}

async function getMessageMedia(env, code, id) {
  if (!/^[1-9][0-9]*$/.test(id)) {
    return jsonError("メッセージが見つかりません", 404);
  }
  if (!(await directoryExists(env, code))) {
    return jsonError("ルームが見つかりません", 404);
  }

  // media のキャッシュヘッダーを維持するため noStore で包まない
  return roomStub(env, code).fetch(`https://room.internal/media/${id}`, {
    method: "GET",
  });
}

async function openWebSocket(request, env, code, url) {
  if (!(await directoryExists(env, code))) {
    return jsonError("ルームが見つかりません", 404);
  }

  const hostId = url.searchParams.get("hostId");
  // 空文字は未指定（ゲスト）として扱う
  if (hostId !== null && hostId !== "" && !HOST_ID_PATTERN.test(hostId)) {
    return jsonError("hostIdの形式が正しくありません", 400);
  }

  const params = new URLSearchParams();
  const name = url.searchParams.get("name");
  if (name !== null) params.set("name", name);
  const clientId = url.searchParams.get("clientId");
  if (clientId !== null) params.set("clientId", clientId);
  if (hostId) params.set("hostId", hostId);

  // クライアント指定の ip は使わず、Worker 側で付与する
  params.set("ip", request.headers.get("CF-Connecting-IP") ?? "");

  const doRequest = new Request(
    `https://room.internal/ws?${params.toString()}`,
    request,
  );
  const response = await roomStub(env, code).fetch(doRequest);
  return noStore(response);
}

async function handleApi(request, env, url) {
  const pathname = url.pathname;

  if (pathname === "/api/health") {
    if (request.method !== "GET") return jsonError("許可されていないメソッドです", 405);
    return json({ ok: true, time: Date.now() });
  }

  if (pathname === "/api/rooms") {
    if (request.method !== "POST") return jsonError("許可されていないメソッドです", 405);
    return createRoom(request, env);
  }

  if (pathname === "/api/push/key") {
    if (request.method !== "GET") return jsonError("許可されていないメソッドです", 405);
    return getPushKey(env);
  }

  const mediaMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/messages\/([^/]+)\/media$/);
  if (mediaMatch) {
    const code = mediaMatch[1];
    if (!CODE_PATTERN.test(code)) {
      return jsonError("ルームコードの形式が正しくありません", 400);
    }
    if (request.method !== "GET") return jsonError("許可されていないメソッドです", 405);
    return getMessageMedia(env, code, mediaMatch[2]);
  }

  const match = pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(close|delete|settings|ws|push))?$/);
  if (!match) return jsonError("APIが見つかりません", 404);

  const code = match[1];
  const action = match[2];
  if (!CODE_PATTERN.test(code)) {
    return jsonError("ルームコードの形式が正しくありません", 400);
  }

  if (!action) {
    if (request.method !== "GET") return jsonError("許可されていないメソッドです", 405);
    return getRoomInfo(env, code, url);
  }

  if (action === "close") {
    if (request.method !== "POST") return jsonError("許可されていないメソッドです", 405);
    return closeRoom(request, env, code);
  }

  if (action === "delete") {
    if (request.method !== "POST") return jsonError("許可されていないメソッドです", 405);
    return deleteRoom(request, env, code);
  }

  if (action === "settings") {
    if (request.method !== "POST") return jsonError("許可されていないメソッドです", 405);
    return updateRoomSettings(request, env, code);
  }

  if (action === "ws") {
    if (request.method !== "GET") return jsonError("許可されていないメソッドです", 405);
    return openWebSocket(request, env, code, url);
  }

  if (action === "push") {
    if (request.method !== "POST") return jsonError("許可されていないメソッドです", 405);
    return updatePushSubscription(request, env, code);
  }

  return jsonError("APIが見つかりません", 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      try {
        const isMedia = request.method === "GET" && MEDIA_PATH_PATTERN.test(url.pathname);
        if (url.pathname !== "/api/health" && !isMedia) {
          const ip = getClientIp(request);
          if (isRateLimited(apiRateLimits, ip, API_RATE_LIMIT, API_RATE_WINDOW_MS)) {
            return jsonError("リクエストが多すぎます", 429);
          }
        }
        return await handleApi(request, env, url);
      } catch (error) {
        console.error("API error:", error);
        return jsonError("サーバーエラーが発生しました", 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};

// ---- Durable Object ----

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rateLimits = new Map();

    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS room (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          code TEXT NOT NULL,
          name TEXT NOT NULL,
          host_name TEXT NOT NULL,
          host_id TEXT NOT NULL,
          settings TEXT NOT NULL,
          closed INTEGER NOT NULL DEFAULT 0,
          deleted INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        )
      `);
      // 既存DBには列を後付けする（PRAGMA で列の有無を確認する）
      let hasDeletedColumn = false;
      try {
        hasDeletedColumn = ctx.storage.sql
          .exec("PRAGMA table_info(room)")
          .toArray()
          .some((column) => column.name === "deleted");
      } catch (error) {
        console.error("deleted 列の確認に失敗しました:", error);
      }
      if (!hasDeletedColumn) {
        try {
          ctx.storage.sql.exec("ALTER TABLE room ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
        } catch (error) {
          console.error("deleted 列の追加に失敗しました:", error);
        }
      }
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          client_id TEXT NOT NULL,
          name TEXT NOT NULL,
          role TEXT NOT NULL,
          kind TEXT NOT NULL,
          text TEXT,
          media TEXT,
          created_at INTEGER NOT NULL
        )
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS reads (
          client_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          last_read_id INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        )
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS push_subs (
          endpoint TEXT PRIMARY KEY,
          client_id TEXT NOT NULL,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
    });
  }

  getRoomRow() {
    return this.ctx.storage.sql.exec(
      "SELECT id, code, name, host_name, host_id, settings, closed, deleted, created_at FROM room WHERE id = 1",
    ).toArray()[0] ?? null;
  }

  getMessages() {
    const rows = this.ctx.storage.sql.exec(
      `SELECT id, client_id, name, role, kind, text,
         CASE WHEN media IS NOT NULL AND media <> '' THEN 1 ELSE 0 END AS has_media,
         created_at
       FROM messages ORDER BY id DESC LIMIT ?`,
      MAX_WELCOME_MESSAGES,
    ).toArray();
    return rows.reverse().map(messageToJson);
  }

  getReads() {
    const rows = this.ctx.storage.sql.exec(
      "SELECT client_id, name, last_read_id FROM reads ORDER BY updated_at DESC, client_id ASC LIMIT ?",
      MAX_READS,
    ).toArray();
    return rows.reverse().map((row) => ({
      clientId: row.client_id,
      name: row.name,
      lastReadId: row.last_read_id,
    }));
  }

  cleanupReads() {
    const cutoff = Date.now() - READ_RETENTION_MS;
    this.ctx.storage.sql.exec("DELETE FROM reads WHERE updated_at < ?", cutoff);
  }

  getMembers() {
    const byClientId = new Map();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== 1) continue;
      const attachment = getAttachment(ws);
      if (!attachment || typeof attachment.clientId !== "string") continue;
      const current = byClientId.get(attachment.clientId);
      if (!current || attachment.joinedAt < current.joinedAt) {
        byClientId.set(attachment.clientId, attachment);
      }
    }
    return Array.from(byClientId.values())
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((attachment) => ({
        clientId: attachment.clientId,
        name: attachment.name,
        role: attachment.role,
      }));
  }

  broadcast(payload) {
    const data = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // 切断済みのソケットは無視する
      }
    }
  }

  broadcastPresence() {
    this.broadcast({ type: "presence", members: this.getMembers() });
  }

  setRead(clientId, name, lastReadId) {
    this.ctx.storage.sql.exec(
      `INSERT INTO reads (client_id, name, last_read_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(client_id) DO UPDATE SET
         name = excluded.name,
         last_read_id = excluded.last_read_id,
         updated_at = excluded.updated_at`,
      clientId,
      name,
      lastReadId,
      Date.now(),
    );
    // 無限成長を防ぐため、更新の古い行を 200 件までに削る
    this.ctx.storage.sql.exec(
      "DELETE FROM reads WHERE client_id NOT IN (SELECT client_id FROM reads ORDER BY updated_at DESC LIMIT ?)",
      MAX_READS,
    );
  }

  allowRates(rules) {
    const now = Date.now();
    const entries = rules.map((rule) => {
      const recent = (this.rateLimits.get(rule.key) ?? [])
        .filter((time) => now - time < rule.windowMs);
      return { ...rule, recent };
    });

    if (entries.some((entry) => entry.recent.length >= entry.limit)) {
      for (const entry of entries) this.rateLimits.set(entry.key, entry.recent);
      if (this.rateLimits.size > MAX_RATE_ENTRIES) {
        pruneRateLimits(this.rateLimits, now);
      }
      return false;
    }

    for (const entry of entries) {
      entry.recent.push(now);
      this.rateLimits.set(entry.key, entry.recent);
    }
    if (this.rateLimits.size > MAX_RATE_ENTRIES) {
      pruneRateLimits(this.rateLimits, now);
    }
    return true;
  }

  closeForClosedRoom(ws, deleted) {
    safeSend(ws, deleted ? { type: "closed", deleted: true } : { type: "closed" });
    try {
      ws.close(4000);
    } catch {
      // 既に閉じている場合は無視する
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/media/")) {
      return this.handleMedia(request, url);
    }

    switch (url.pathname) {
      case "/init":
        return this.handleInit(request);
      case "/info":
        return this.handleInfo(request, url);
      case "/ws":
        return this.handleWebSocket(request, url);
      case "/close":
        return this.handleClose(request);
      case "/delete":
        return this.handleDelete(request);
      case "/settings":
        return this.handleSettings(request);
      case "/push":
        return this.handlePush(request);
      default:
        return jsonError("内部APIが見つかりません", 404);
    }
  }

  async handleInit(request) {
    if (request.method !== "POST") {
      return jsonError("許可されていないメソッドです", 405);
    }
    if (isBodyTooLarge(request)) return jsonError("リクエストが大きすぎます", 413);

    const parsed = await readJson(request);
    if (parsed.response) return parsed.response;
    const body = parsed.value;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonError("リクエストの形式が正しくありません", 400);
    }
    if (this.getRoomRow()) {
      return jsonError("このルームコードは既に使用されています", 409);
    }
    if (typeof body.code !== "string" || !CODE_PATTERN.test(body.code)) {
      return jsonError("ルームコードの形式が正しくありません", 400);
    }
    const name = cleanName(body.roomName, 40);
    if (!name) return jsonError("ルーム名は1〜40文字で入力してください", 400);
    const hostName = cleanName(body.hostName, 20);
    if (!hostName) return jsonError("ホスト名は1〜20文字で入力してください", 400);
    if (typeof body.hostId !== "string" || !HOST_ID_PATTERN.test(body.hostId)) {
      return jsonError("hostIdの形式が正しくありません", 400);
    }
    const settings = parseSettings(body.settings);
    if (!settings) return jsonError("設定の形式が正しくありません", 400);

    this.ctx.storage.sql.exec(
      "INSERT INTO room (id, code, name, host_name, host_id, settings, closed, created_at) VALUES (1, ?, ?, ?, ?, ?, 0, ?)",
      body.code,
      name,
      hostName,
      body.hostId,
      JSON.stringify(settings),
      Date.now(),
    );

    return json({ room: roomToJson(this.getRoomRow()) }, 201);
  }

  handleInfo(request, url) {
    if (request.method !== "GET") {
      return jsonError("許可されていないメソッドです", 405);
    }
    const row = this.getRoomRow();
    if (!row) return jsonError("ルームが見つかりません", 404);
    if (row.deleted) return jsonError("ルームが見つかりません", 404);

    const hostId = url.searchParams.get("hostId");
    return json({
      room: roomToJson(row),
      isHost: typeof hostId === "string" && HOST_ID_PATTERN.test(hostId) && hostId === row.host_id,
      online: this.getMembers().length,
    });
  }

  handleWebSocket(request, url) {
    if (request.method !== "GET") {
      return jsonError("許可されていないメソッドです", 405);
    }
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
      return jsonError("WebSocket接続が必要です", 400);
    }

    const row = this.getRoomRow();
    if (!row) return jsonError("ルームが見つかりません", 404);
    if (row.deleted) return jsonError("ルームが見つかりません", 404);
    if (row.closed) return jsonError("このルームは既に終了しています", 409);

    const name = cleanName(url.searchParams.get("name") ?? "", 20);
    if (!name) return jsonError("名前は1〜20文字で入力してください", 400);

    const clientId = url.searchParams.get("clientId") ?? "";
    if (!CLIENT_ID_PATTERN.test(clientId)) {
      return jsonError("clientIdの形式が正しくありません", 400);
    }

    const hostId = url.searchParams.get("hostId");
    const role = hostId && HOST_ID_PATTERN.test(hostId) && hostId === row.host_id
      ? "host"
      : "guest";

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      clientId,
      name,
      role,
      joinedAt: Date.now(),
      ip: url.searchParams.get("ip") ?? "",
      visible: true,
    });

    this.cleanupReads();
    const settings = readSettings(row.settings);
    const welcome = {
      type: "welcome",
      room: roomToJson(row),
      messages: this.getMessages(),
      reads: settings.readReceipts === false ? [] : this.getReads(),
      members: this.getMembers(),
      self: { clientId, name, role },
    };

    if (!safeSend(server, welcome)) {
      try {
        server.close(1011);
      } catch {
        // 既に閉じている場合は無視する
      }
    }
    this.broadcastPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  async handleClose(request) {
    if (request.method !== "POST") {
      return jsonError("許可されていないメソッドです", 405);
    }
    if (isBodyTooLarge(request)) return jsonError("リクエストが大きすぎます", 413);

    const parsed = await readJson(request);
    if (parsed.response) return parsed.response;
    const body = parsed.value;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonError("リクエストの形式が正しくありません", 400);
    }
    const row = this.getRoomRow();
    if (!row) return jsonError("ルームが見つかりません", 404);
    if (row.deleted) return jsonError("ルームが見つかりません", 404);

    const hostId = body.hostId;
    if (typeof hostId !== "string" || !HOST_ID_PATTERN.test(hostId) || hostId !== row.host_id) {
      return jsonError("ホスト権限がありません", 403);
    }

    this.ctx.storage.sql.exec("UPDATE room SET closed = 1 WHERE id = 1");

    const payload = JSON.stringify({ type: "closed" });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // 切断済みのソケットは無視する
      }
    }
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(4000);
      } catch {
        // 既に閉じている場合は無視する
      }
    }

    // ソケットへの通知後に容量を解放する
    this.ctx.storage.sql.exec("DELETE FROM messages");
    this.ctx.storage.sql.exec("DELETE FROM reads");
    this.ctx.storage.sql.exec("DELETE FROM push_subs");

    return json({ ok: true });
  }

  async handleDelete(request) {
    if (request.method !== "POST") {
      return jsonError("許可されていないメソッドです", 405);
    }
    if (isBodyTooLarge(request)) return jsonError("リクエストが大きすぎます", 413);

    const parsed = await readJson(request);
    if (parsed.response) return parsed.response;
    const body = parsed.value;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonError("リクエストの形式が正しくありません", 400);
    }
    const row = this.getRoomRow();
    if (!row || row.deleted) return jsonError("ルームが見つかりません", 404);

    const hostId = body.hostId;
    if (typeof hostId !== "string" || !HOST_ID_PATTERN.test(hostId) || hostId !== row.host_id) {
      return jsonError("ホスト権限がありません", 403);
    }

    // 閉鎖済みルームも削除できる（deleted = 0 が条件）
    this.ctx.storage.sql.exec(
      "UPDATE room SET closed = 1, deleted = 1 WHERE id = 1 AND deleted = 0",
    );

    const payload = JSON.stringify({ type: "closed", deleted: true });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // 切断済みのソケットは無視する
      }
    }
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(4000, "room deleted");
      } catch {
        // 既に閉じている場合は無視する
      }
    }

    // ソケットへの通知後に容量を解放する（失敗しても削除状態は維持して 200 を返す）
    try {
      this.ctx.storage.sql.exec("DELETE FROM messages");
      this.ctx.storage.sql.exec("DELETE FROM reads");
      this.ctx.storage.sql.exec("DELETE FROM push_subs");
    } catch (error) {
      console.error("削除時のデータ消去に失敗しました:", error);
    }

    return json({ ok: true });
  }

  async handleSettings(request) {
    if (request.method !== "POST") {
      return jsonError("許可されていないメソッドです", 405);
    }
    if (isBodyTooLarge(request)) return jsonError("リクエストが大きすぎます", 413);

    const parsed = await readJson(request);
    if (parsed.response) return parsed.response;
    const body = parsed.value;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonError("リクエストの形式が正しくありません", 400);
    }
    const row = this.getRoomRow();
    if (!row) return jsonError("ルームが見つかりません", 404);
    if (row.deleted) return jsonError("ルームが見つかりません", 404);

    const hostId = body.hostId;
    if (typeof hostId !== "string" || !HOST_ID_PATTERN.test(hostId) || hostId !== row.host_id) {
      return jsonError("ホスト権限がありません", 403);
    }

    const update = parseSettingsUpdate(body.settings);
    if (!update) return jsonError("設定の形式が正しくありません", 400);

    const previous = readSettings(row.settings);
    const wasReadReceipts = previous.readReceipts !== false;
    const settings = { ...previous, ...update };
    this.ctx.storage.sql.exec(
      "UPDATE room SET settings = ? WHERE id = 1",
      JSON.stringify(settings),
    );
    this.broadcast({ type: "settings", settings });

    if (!settings.readReceipts && wasReadReceipts) {
      this.ctx.storage.sql.exec("DELETE FROM reads");
      this.broadcast({ type: "reads", reads: [] });
    } else if (settings.readReceipts && !wasReadReceipts) {
      this.cleanupReads();
      this.broadcast({ type: "reads", reads: this.getReads() });
    }

    return json({ settings });
  }

  async handlePush(request) {
    if (request.method !== "POST") {
      return jsonError("許可されていないメソッドです", 405);
    }
    const parsed = await readJson(request);
    if (parsed.response) return parsed.response;
    const body = parsed.value;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonError("リクエストの形式が正しくありません", 400);
    }
    const row = this.getRoomRow();
    if (!row || row.deleted) return jsonError("ルームが見つかりません", 404);

    if (body.action === "unsubscribe") {
      if (typeof body.endpoint !== "string" || body.endpoint.length > 1024) {
        return jsonError("購読情報が正しくありません", 400);
      }
      this.ctx.storage.sql.exec("DELETE FROM push_subs WHERE endpoint = ?", body.endpoint);
      return json({ ok: true });
    }

    if (body.action !== "subscribe") {
      return jsonError("リクエストの形式が正しくありません", 400);
    }
    if (row.closed) return jsonError("このルームは既に終了しています", 409);
    if (typeof body.clientId !== "string" || !CLIENT_ID_PATTERN.test(body.clientId)) {
      return jsonError("clientIdの形式が正しくありません", 400);
    }
    const subscription = body.subscription;
    const endpoint = subscription && subscription.endpoint;
    const keys = subscription && subscription.keys;
    if (!isAllowedPushEndpoint(endpoint)) {
      return jsonError("この通知サービスには対応していません", 400);
    }
    if (!keys || !isValidSubscriptionKeys(keys.p256dh, keys.auth)) {
      return jsonError("購読情報が正しくありません", 400);
    }

    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO push_subs (endpoint, client_id, p256dh, auth, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         client_id = excluded.client_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         updated_at = excluded.updated_at`,
      endpoint,
      body.clientId,
      keys.p256dh,
      keys.auth,
      now,
    );
    // 上限を超えたら古い購読から削除する
    this.ctx.storage.sql.exec(
      "DELETE FROM push_subs WHERE endpoint NOT IN (SELECT endpoint FROM push_subs ORDER BY updated_at DESC LIMIT ?)",
      MAX_PUSH_SUBSCRIPTIONS,
    );
    return json({ ok: true });
  }

  // 画面を見ていない参加者（送信者本人を除く）へ Web Push を送る
  async notifyPush(row, sender, message) {
    let keys;
    try {
      keys = await loadVapidKeys(this.env.VAPID_PRIVATE_JWK);
    } catch {
      keys = null;
    }
    if (!keys) return;

    const subs = this.ctx.storage.sql.exec(
      "SELECT endpoint, client_id, p256dh, auth FROM push_subs WHERE client_id <> ? ORDER BY updated_at DESC LIMIT ?",
      sender.clientId,
      MAX_PUSH_SUBSCRIPTIONS,
    ).toArray();
    if (subs.length === 0) return;

    // 画面を表示中のクライアントには WebSocket で届くので送らない
    const viewing = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = getAttachment(ws);
      if (attachment && attachment.visible !== false) viewing.add(attachment.clientId);
    }
    const targets = subs.filter((sub) => !viewing.has(sub.client_id)).slice(0, MAX_PUSH_PER_MESSAGE);
    if (targets.length === 0) return;

    const payload = JSON.stringify({
      title: row.name,
      body: pushMessageBody(message),
      tag: `kc-${row.code}`,
      url: `/r/${row.code}`,
      code: row.code,
      id: message.id,
    });
    const subject = this.env.VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT;

    const results = await Promise.allSettled(targets.map((sub) => sendWebPush({
      subscription: sub,
      payload,
      keys,
      subject,
      ttl: PUSH_TTL_SECONDS,
    })));
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        if (result.value === 404 || result.value === 410) {
          try {
            this.ctx.storage.sql.exec("DELETE FROM push_subs WHERE endpoint = ?", targets[index].endpoint);
          } catch (error) {
            console.error("push subscription cleanup failed:", error);
          }
        }
      } else {
        console.error("push send failed:", result.reason);
      }
    });
  }

  handleMedia(request, url) {
    if (request.method !== "GET") {
      return jsonError("許可されていないメソッドです", 405);
    }

    const room = this.getRoomRow();
    if (!room || room.deleted) {
      return jsonError("メッセージが見つかりません", 404);
    }

    const rawId = url.pathname.slice("/media/".length);
    if (!/^[1-9][0-9]*$/.test(rawId)) {
      return jsonError("メッセージが見つかりません", 404);
    }
    const id = Number(rawId);
    if (!Number.isSafeInteger(id)) {
      return jsonError("メッセージが見つかりません", 404);
    }

    const row = this.ctx.storage.sql.exec(
      "SELECT media FROM messages WHERE id = ? AND kind = 'image'",
      id,
    ).toArray()[0];
    if (!row || typeof row.media !== "string" || !row.media.startsWith("data:image/")) {
      return jsonError("メッセージが見つかりません", 404);
    }

    return new Response(JSON.stringify({ media: row.media }), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "private, max-age=86400",
      },
    });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string") return;

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return;

    const attachment = getAttachment(ws);
    if (!attachment || typeof attachment.clientId !== "string") return;

    const row = this.getRoomRow();
    if (!row) {
      try {
        ws.close(4004);
      } catch {
        // 既に閉じている場合は無視する
      }
      return;
    }
    if (row.closed) {
      this.closeForClosedRoom(ws, Boolean(row.deleted));
      return;
    }

    switch (data.type) {
      case "send":
        await this.handleSend(ws, attachment, row, data);
        break;
      case "visibility":
        this.handleVisibility(ws, attachment, data);
        break;
      case "read":
        this.handleRead(ws, attachment, row, data);
        break;
      case "rename":
        this.handleRename(ws, attachment, row, data);
        break;
    }
  }

  async handleSend(ws, attachment, row, data) {
    const input = data.message;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      safeSend(ws, { type: "error", message: "メッセージの形式が不正です" });
      return;
    }

    const kind = input.kind;
    let text = null;
    let media = null;

    if (kind === "text") {
      if (typeof input.text !== "string") {
        safeSend(ws, { type: "error", message: "メッセージは1〜2000文字で入力してください" });
        return;
      }
      // 巨大文字列の replace を避けるため、加工前に長さを確認する
      if (input.text.length > MAX_RAW_TEXT_LENGTH) {
        safeSend(ws, { type: "error", message: "メッセージは1〜2000文字で入力してください" });
        return;
      }
      text = cleanMessageText(input.text);
      if (!text || charLength(text) > MAX_MESSAGE_LENGTH) {
        safeSend(ws, { type: "error", message: "メッセージは1〜2000文字で入力してください" });
        return;
      }
    } else if (kind === "stamp") {
      if (typeof input.text !== "string") {
        safeSend(ws, { type: "error", message: "スタンプは1〜8文字で指定してください" });
        return;
      }
      if (input.text.length > MAX_RAW_TEXT_LENGTH) {
        safeSend(ws, { type: "error", message: "スタンプは1〜8文字で指定してください" });
        return;
      }
      text = cleanMessageText(input.text);
      const length = charLength(text);
      if (length < 1 || length > MAX_STAMP_LENGTH) {
        safeSend(ws, { type: "error", message: "スタンプは1〜8文字で指定してください" });
        return;
      }
    } else if (kind === "image") {
      media = typeof input.media === "string" ? input.media : "";
      if (media.length === 0 || media.length > MAX_IMAGE_LENGTH || !IMAGE_PATTERN.test(media)) {
        safeSend(ws, { type: "error", message: "画像データが不正です" });
        return;
      }
      if (input.text !== undefined && input.text !== null) {
        if (typeof input.text !== "string") {
          safeSend(ws, { type: "error", message: "メッセージは1〜2000文字で入力してください" });
          return;
        }
        if (input.text.length > MAX_RAW_TEXT_LENGTH) {
          safeSend(ws, { type: "error", message: "メッセージは1〜2000文字で入力してください" });
          return;
        }
        text = cleanMessageText(input.text);
        if (charLength(text) > MAX_MESSAGE_LENGTH) {
          safeSend(ws, { type: "error", message: "メッセージは1〜2000文字で入力してください" });
          return;
        }
        if (!text) text = null;
      }
    } else {
      safeSend(ws, { type: "error", message: "メッセージの種類が不正です" });
      return;
    }

    const sendRules = [{
      key: `send:client:${attachment.clientId}`,
      limit: SEND_CLIENT_LIMIT,
      windowMs: SEND_WINDOW_MS,
    }];
    if (attachment.ip) {
      sendRules.push({
        key: `send:ip:${attachment.ip}`,
        limit: SEND_IP_LIMIT,
        windowMs: SEND_WINDOW_MS,
      });
    }
    if (!this.allowRates(sendRules)) {
      safeSend(ws, { type: "error", message: "送信が速すぎます" });
      return;
    }

    const now = Date.now();
    let inserted;
    try {
      inserted = this.ctx.storage.sql.exec(
        "INSERT INTO messages (client_id, name, role, kind, text, media, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
        attachment.clientId,
        attachment.name,
        attachment.role,
        kind,
        text,
        media,
        now,
      ).one();
    } catch (error) {
      console.error("message insert failed:", error);
      safeSend(ws, {
        type: "error",
        message: "メッセージを保存できませんでした（容量不足の可能性があります）",
      });
      return;
    }

    try {
      this.ctx.storage.sql.exec(
        "DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT ?)",
        MAX_STORED_MESSAGES,
      );
    } catch (error) {
      console.error("message trim failed:", error);
    }

    this.broadcast({
      type: "message",
      message: {
        id: inserted.id,
        clientId: attachment.clientId,
        name: attachment.name,
        role: attachment.role,
        kind,
        text,
        media,
        createdAt: now,
      },
    });

    if (readSettings(row.settings).readReceipts) {
      this.setRead(attachment.clientId, attachment.name, inserted.id);
      this.broadcast({ type: "reads", reads: this.getReads() });
    }

    // 配信と既読の更新が終わってから Push を送る（失敗してもチャットには影響させない）
    try {
      await this.notifyPush(row, attachment, { id: inserted.id, name: attachment.name, kind, text });
    } catch (error) {
      console.error("push notify failed:", error);
    }
  }

  handleVisibility(ws, attachment, data) {
    if (typeof data.visible !== "boolean") return;
    if (attachment.visible === data.visible) return;
    try {
      ws.serializeAttachment({ ...attachment, visible: data.visible });
    } catch {
      // 切断済みのソケットは無視する
    }
  }

  handleRead(ws, attachment, row, data) {
    // 既読OFFでは DB 更新も通知も行わない
    if (readSettings(row.settings).readReceipts === false) return;

    const readRules = [{
      key: `read:client:${attachment.clientId}`,
      limit: READ_CLIENT_LIMIT,
      windowMs: READ_WINDOW_MS,
    }];
    if (attachment.ip) {
      readRules.push({
        key: `read:ip:${attachment.ip}`,
        limit: READ_IP_LIMIT,
        windowMs: READ_WINDOW_MS,
      });
    }
    if (!this.allowRates(readRules)) return;

    if (!Number.isInteger(data.lastReadId) || data.lastReadId < 0) {
      safeSend(ws, { type: "error", message: "既読位置が不正です" });
      return;
    }

    const maxRow = this.ctx.storage.sql.exec(
      "SELECT COALESCE(MAX(id), 0) AS max_id FROM messages",
    ).toArray()[0];
    const maxId = maxRow && Number.isFinite(Number(maxRow.max_id))
      ? Number(maxRow.max_id)
      : 0;
    const lastReadId = Math.min(data.lastReadId, maxId);

    this.setRead(attachment.clientId, attachment.name, lastReadId);
    this.broadcast({ type: "reads", reads: this.getReads() });
  }

  handleRename(ws, attachment, row, data) {
    const renameRules = [{
      key: `rename:client:${attachment.clientId}`,
      limit: RENAME_CLIENT_LIMIT,
      windowMs: RENAME_WINDOW_MS,
    }];
    if (!this.allowRates(renameRules)) {
      safeSend(ws, { type: "error", message: "名前の変更が速すぎます" });
      return;
    }

    const name = cleanName(data.name, 20);
    if (!name) {
      safeSend(ws, { type: "error", message: "名前は1〜20文字で入力してください" });
      return;
    }

    // 同じ clientId の全ソケットの添付情報を更新する
    for (const socket of this.ctx.getWebSockets()) {
      const current = getAttachment(socket);
      if (current && current.clientId === attachment.clientId) {
        try {
          socket.serializeAttachment({ ...current, name });
        } catch {
          // 切断済みのソケットは無視する
        }
      }
    }

    if (attachment.role === "host") {
      this.ctx.storage.sql.exec(
        "UPDATE room SET host_name = ? WHERE id = 1",
        name,
      );
    }

    this.ctx.storage.sql.exec(
      "UPDATE reads SET name = ? WHERE client_id = ?",
      name,
      attachment.clientId,
    );

    this.broadcastPresence();
    if (readSettings(row.settings).readReceipts) {
      this.broadcast({ type: "reads", reads: this.getReads() });
    }
  }

  webSocketClose(ws, code) {
    try {
      ws.close(code);
    } catch {
      // 閉じられないコードは無視する
    }
    this.broadcastPresence();
  }

  webSocketError(ws) {
    try {
      ws.close(1011);
    } catch {
      // 既に閉じている場合は無視する
    }
    this.broadcastPresence();
  }
}

// ---- Directory Durable Object ----

export class Directory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS codes (
          code TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          closed INTEGER NOT NULL DEFAULT 0
        )
      `);
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/register":
        return this.handleRegister(request);
      case "/exists":
        return this.handleExists(request, url);
      case "/markClosed":
        return this.handleMarkClosed(request);
      case "/unregister":
        return this.handleUnregister(request);
      default:
        return jsonError("内部APIが見つかりません", 404);
    }
  }

  async handleRegister(request) {
    if (request.method !== "POST") {
      return jsonError("許可されていないメソッドです", 405);
    }
    if (isBodyTooLarge(request)) return jsonError("リクエストが大きすぎます", 413);

    const parsed = await readJson(request);
    if (parsed.response) return parsed.response;
    const body = parsed.value;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonError("リクエストの形式が正しくありません", 400);
    }
    if (typeof body.code !== "string" || !CODE_PATTERN.test(body.code)) {
      return jsonError("ルームコードの形式が正しくありません", 400);
    }

    const existing = this.ctx.storage.sql.exec(
      "SELECT code FROM codes WHERE code = ?",
      body.code,
    ).toArray()[0];
    if (existing) return jsonError("このルームコードは既に使用されています", 409);

    const countRow = this.ctx.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM codes WHERE closed = 0",
    ).toArray()[0];
    const count = countRow ? Number(countRow.count) : 0;
    if (Number.isFinite(count) && count >= MAX_DIRECTORY_ROOMS) {
      return jsonError("ルーム数が上限に達しました", 507);
    }

    this.ctx.storage.sql.exec(
      "INSERT INTO codes (code, created_at, closed) VALUES (?, ?, 0)",
      body.code,
      Date.now(),
    );

    return json({ ok: true }, 201);
  }

  handleExists(request, url) {
    if (request.method !== "GET") {
      return jsonError("許可されていないメソッドです", 405);
    }

    const code = url.searchParams.get("code") ?? "";
    if (!CODE_PATTERN.test(code)) {
      return jsonError("ルームコードの形式が正しくありません", 400);
    }

    const row = this.ctx.storage.sql.exec(
      "SELECT code, closed FROM codes WHERE code = ?",
      code,
    ).toArray()[0];

    return json({
      exists: Boolean(row),
      closed: row ? Boolean(row.closed) : false,
    });
  }

  async handleMarkClosed(request) {
    if (request.method !== "POST") {
      return jsonError("許可されていないメソッドです", 405);
    }
    if (isBodyTooLarge(request)) return jsonError("リクエストが大きすぎます", 413);

    const parsed = await readJson(request);
    if (parsed.response) return parsed.response;
    const body = parsed.value;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonError("リクエストの形式が正しくありません", 400);
    }
    if (typeof body.code !== "string" || !CODE_PATTERN.test(body.code)) {
      return jsonError("ルームコードの形式が正しくありません", 400);
    }

    this.ctx.storage.sql.exec(
      "UPDATE codes SET closed = 1 WHERE code = ?",
      body.code,
    );

    return json({ ok: true });
  }

  async handleUnregister(request) {
    if (request.method !== "POST") {
      return jsonError("許可されていないメソッドです", 405);
    }
    if (isBodyTooLarge(request)) return jsonError("リクエストが大きすぎます", 413);

    const parsed = await readJson(request);
    if (parsed.response) return parsed.response;
    const body = parsed.value;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonError("リクエストの形式が正しくありません", 400);
    }
    if (typeof body.code !== "string" || !CODE_PATTERN.test(body.code)) {
      return jsonError("ルームコードの形式が正しくありません", 400);
    }

    // 存在しなくても成功として扱う
    this.ctx.storage.sql.exec("DELETE FROM codes WHERE code = ?", body.code);

    return json({ ok: true });
  }
}

