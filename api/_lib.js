import { Redis } from "@upstash/redis";
import { neon } from "@neondatabase/serverless";
import { SCHEMA } from "./_schema.js";
import { createHash, timingSafeEqual } from "node:crypto";

/* ===== Redis: ใช้เฉพาะ rate limit กับล็อกรหัสผิด (ข้อมูลชั่วคราว) ===== */
const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "";
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "";
export const redisReady = Boolean(url && token);
export const redis = redisReady ? new Redis({ url, token }) : null;

/* ===== Postgres: ใบสมัคร + รอบทดสอบ ===== */
const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
export const dbReady = Boolean(DB_URL);
const client = dbReady ? neon(DB_URL) : null;

/** sql`...` ใช้แบบ template เท่านั้น (ค่าที่ใส่ถูกส่งเป็นพารามิเตอร์ ไม่ต่อสตริง จึงกัน SQL injection) */
export const sql = (...args) => client(...args);
export const sqlTx = (queries) => client.transaction(queries);

/** สร้างตารางครั้งแรก (รันครั้งเดียวต่อ cold start; ใช้ IF NOT EXISTS จึงรันซ้ำได้ปลอดภัย) */
let schemaPromise = null;
export function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = client.transaction(SCHEMA.map((q) => client.query(q)))
      .catch((e) => { schemaPromise = null; throw e; });
  }
  return schemaPromise;
}

/** พร้อมใช้งานเมื่อมีทั้ง Postgres และ Redis */
export const systemReady = () => dbReady && redisReady;

export const RETENTION_DAYS = 90; // ลบใบสมัครอัตโนมัติหลังครบ 90 วัน (PDPA: ไม่เก็บข้อมูลเกินจำเป็น)

/* ===== ระบบนัดวันทดสอบ ===== */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SLOT_MAX_CAPACITY = 10;
export const SLOT_MAX_AHEAD_DAYS = 120;
export const SLOT_MAX_TOTAL = 300;

/** แถวจาก DB -> รูปแบบที่หน้าเว็บใช้ (camelCase, เวลาเป็น ISO) */
export function appFromRow(r) {
  const iso = (v) => (v ? new Date(v).toISOString() : "");
  return {
    id: r.id, ref: r.ref, ign: r.ign, uid: r.uid, level: r.level,
    rankBR: r.rank_br, rankCS: r.rank_cs, track: r.track, tier: r.tier,
    testers: r.testers || [], instagram: r.instagram, messenger: r.messenger,
    availability: r.availability, note: r.note, status: r.status,
    slotId: r.slot_id || "", slotStart: iso(r.slot_start), slotCancelled: Boolean(r.slot_cancelled),
    createdAt: iso(r.created_at),
  };
}

/* ===== ข้อมูล (ต้องตรงกับ index.html) ===== */
export const TIER_TABLE = {
  LEAGUE: { God: ["ฟลุ๊ค"], SSS: ["กัน"], SS: ["ปาย", "น้อต"], S: ["ปั้น", "โต้", "เกล้า"] },
  HIGHLIGHTS: { God: ["เกล้า"], SSS: ["กัน", "น้อต"], SS: ["ฟลุ๊ค", "ปั้น"], S: ["โต้", "ปาย"] },
};
export const TIERS = ["God", "SSS", "SS", "S"];
export const RANKS = ["Diamond 1", "Diamond 2", "Diamond 3", "Diamond 4", "Heroic", "Master", "Grandmaster"];
export const AVAIL = { weekday_evening: "วันธรรมดา ช่วงเย็น", weekday_night: "วันธรรมดา ช่วงดึก", weekend: "เสาร์–อาทิตย์", anytime: "ได้ทุกช่วงเวลา" };
export const STATUSES = ["pending", "testing", "approved", "rejected"];
const TRACK_LABEL = { LEAGUE: "TIER LEAGUE", HIGHLIGHTS: "TIER HIGHLIGHTS" };

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const str = (v) => (typeof v === "string" ? v : "");

/* ===== HTTP helpers ===== */
export function send(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(status).send(JSON.stringify(body));
}

export function getIp(req) {
  const h = req.headers;
  return String(h["x-real-ip"] || String(h["x-forwarded-for"] || "").split(",")[0].trim() || "unknown");
}

/** ไม่เก็บ IP ดิบ ใช้ hash ใส่ salt แทน */
export function ipKey(req) {
  return createHash("sha256").update(`${process.env.IP_HASH_SALT || "rz-default-salt"}:${getIp(req)}`).digest("hex").slice(0, 32);
}

/** กัน CSRF: Origin ต้องตรงกับ Host */
export function sameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (!origin || !host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}

/** อ่าน JSON body พร้อมจำกัดขนาด */
export function readJson(req, max = 4000) {
  if (!String(req.headers["content-type"] || "").includes("application/json")) return { error: [415, "รูปแบบข้อมูลไม่รองรับ"] };
  let body;
  try { body = req.body; } catch { return { error: [400, "รูปแบบข้อมูลไม่ถูกต้อง"] }; }
  if (typeof body === "string") {
    if (body.length > max) return { error: [413, "ข้อมูลยาวเกินไป"] };
    try { body = JSON.parse(body); } catch { return { error: [400, "รูปแบบข้อมูลไม่ถูกต้อง"] }; }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: [400, "รูปแบบข้อมูลไม่ถูกต้อง"] };
  if (JSON.stringify(body).length > max) return { error: [413, "ข้อมูลยาวเกินไป"] };
  return { body };
}

/** Rate limit แบบ fixed window ด้วย Redis INCR */
export async function rateLimit(name, id, limit, windowSec) {
  const bucket = Math.floor(Date.now() / (windowSec * 1000));
  const key = `rz:rl:${name}:${id}:${bucket}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, windowSec);
  return n <= limit;
}

/* ===== Admin auth ===== */
function safeEqual(a, b) {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function isAdmin(req) {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw || pw.length < 16) return false; // บังคับรหัสยาวอย่างน้อย 16 ตัว
  const auth = String(req.headers.authorization || "");
  const t = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return t.length > 0 && t.length <= 256 && safeEqual(t, pw);
}

/* ===== Cloudflare Turnstile ===== */
export async function verifyTurnstile(tokenValue, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true;
  if (typeof tokenValue !== "string" || !tokenValue || tokenValue.length > 2048) return false;
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({ secret, response: tokenValue, remoteip: ip }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await r.json();
    return data.success === true;
  } catch {
    return false;
  }
}

/* ===== ตรวจใบสมัคร (ตัวตัดสินจริง) ===== */
const CTRL = /[\u0000-\u001F\u007F]/;
const CTRL_NL = /[\u0000-\u0009\u000B-\u001F\u007F]/;
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/;

// ต้องตรงกับ index.html
const IG_RE = /^(?:@?[A-Za-z0-9._]{1,30}|(?:https?:\/\/)?(?:www\.)?(?:instagram\.com|instagr\.am)\/[A-Za-z0-9._\/?=&%-]{1,100})$/;
const MSG_RE = /^(?:(?:https?:\/\/)?(?:www\.|m\.|web\.)?(?:facebook\.com|fb\.com|fb\.me|m\.me|messenger\.com)\/[A-Za-z0-9._\/?=&%-]{1,120}|[^\s<>\/\\]{2,60}(?: [^\s<>\/\\]{1,30}){0,3})$/;

export function validateApplication(b) {
  const d = {
    ign: str(b.ign).trim(),
    uid: str(b.uid).trim(),
    level: str(b.level).trim(),
    rankBR: str(b.rankBR),
    rankCS: str(b.rankCS),
    track: str(b.track),
    tier: str(b.tier),
    instagram: str(b.instagram).trim(),
    messenger: str(b.messenger).trim(),
    availability: str(b.availability),
    slotId: str(b.slotId).trim(),
    note: str(b.note).replace(/\r\n?/g, "\n").trim(),
  };
  const e = {};

  if (d.ign.length < 2 || d.ign.length > 20) e.ign = "ชื่อในเกมต้องยาว 2–20 ตัวอักษร";
  else if (CTRL.test(d.ign) || INVISIBLE.test(d.ign) || /[<>]/.test(d.ign)) e.ign = "ชื่อมีอักขระที่ไม่อนุญาต";

  if (!/^\d{8,12}$/.test(d.uid)) e.uid = "UID ต้องเป็นตัวเลข 8–12 หลัก";

  const level = /^\d{1,3}$/.test(d.level) ? Number(d.level) : NaN;
  if (!(level >= 30 && level <= 100)) e.level = "เลเวลต้อง 30 ขึ้นไป";

  if (!RANKS.includes(d.rankBR)) e.rankBR = "แรงค์ BR ต้อง Diamond 1 ขึ้นไป";
  if (!RANKS.includes(d.rankCS)) e.rankCS = "แรงค์ CS ต้อง Diamond 1 ขึ้นไป";
  if (!has(TIER_TABLE, d.track)) e.track = "เลือกสายที่ต้องการสมัคร";
  if (!TIERS.includes(d.tier)) e.tier = "เลือกระดับความยาก";

  if (d.instagram && !IG_RE.test(d.instagram)) e.instagram = "Instagram ไม่ถูกต้อง";
  else if (d.instagram && (CTRL.test(d.instagram) || INVISIBLE.test(d.instagram))) e.instagram = "Instagram มีอักขระที่ไม่อนุญาต";
  if (d.messenger && !MSG_RE.test(d.messenger)) e.messenger = "Messenger ไม่ถูกต้อง";
  else if (d.messenger && (CTRL.test(d.messenger) || INVISIBLE.test(d.messenger))) e.messenger = "Messenger มีอักขระที่ไม่อนุญาต";
  if (!d.instagram && !d.messenger && !e.instagram) e.instagram = "กรอกช่องทางติดต่ออย่างน้อย 1 ช่องทาง (Instagram หรือ Messenger)";

  if (d.slotId) {
    if (!UUID_RE.test(d.slotId)) e.slotId = "รอบทดสอบไม่ถูกต้อง";
    d.availability = "";
  } else if (!has(AVAIL, d.availability)) e.availability = "เลือกรอบทดสอบหรือช่วงเวลาที่สะดวก";
  if (d.note.length > 300) e.note = "หมายเหตุไม่เกิน 300 ตัวอักษร";
  else if (CTRL_NL.test(d.note) || INVISIBLE.test(d.note)) e.note = "มีอักขระที่ไม่อนุญาต";

  if (b.consent !== true) e.consent = "กรุณาติ๊กยืนยันก่อนส่ง";

  return { ok: Object.keys(e).length === 0, errors: e, data: { ...d, level } };
}

/* ===== จัดรูปแบบเวลารอบทดสอบ ===== */
export function fmtSlot(iso) {
  try {
    return new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "full", timeStyle: "short" }).format(new Date(iso)) + " น.";
  } catch { return iso; }
}
