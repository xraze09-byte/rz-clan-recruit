import { randomUUID } from "node:crypto";
import {
  sql, sqlTx, ensureSchema, redis, systemReady, send, readJson, sameOrigin, rateLimit, ipKey, isAdmin,
  UUID_RE, SLOT_MAX_CAPACITY, SLOT_MAX_AHEAD_DAYS, SLOT_MAX_TOTAL,
} from "./_lib.js";

const MAX_FAILS = 10;
const WINDOW = 600;
const MIN_LEAD_MS = 5 * 60 * 1000;

const slotOut = (r) => ({
  id: r.id, start: new Date(r.starts_at).toISOString(), capacity: r.capacity, label: r.label, booked: r.booked,
});

/** รอบที่ยังไม่ผ่านไป (เก็บย้อนหลัง 1 วันให้แอดมินเห็น) พร้อมจำนวนที่จองแล้ว */
async function loadSlots() {
  const rows = await sql`
    SELECT s.id, s.starts_at, s.capacity, s.label,
           (SELECT count(*) FROM applications a WHERE a.slot_id = s.id)::int AS booked
    FROM slots s
    WHERE s.starts_at > now() - interval '1 day'
    ORDER BY s.starts_at
    LIMIT ${SLOT_MAX_TOTAL}`;
  return rows.map(slotOut);
}

export default async function handler(req, res) {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  const method = req.method;
  if (!["GET", "POST", "DELETE"].includes(method)) {
    res.setHeader("Allow", "GET, POST, DELETE");
    return send(res, 405, { error: "Method not allowed" });
  }

  try {
    if (!systemReady()) return send(res, 503, { error: "ระบบยังไม่พร้อม" });
    const ip = ipKey(req);

    /* ===== สาธารณะ: ดูรอบที่ยังว่าง ===== */
    if (method === "GET" && !req.headers.authorization) {
      if (!(await rateLimit("slots", ip, 60, WINDOW))) return send(res, 429, { error: "เรียกใช้บ่อยเกินไป กรุณารอสักครู่" });
      await ensureSchema();
      const now = Date.now();
      const open = (await loadSlots())
        .filter((s) => Date.parse(s.start) > now + MIN_LEAD_MS && s.booked < s.capacity)
        .map((s) => ({ id: s.id, start: s.start, label: s.label || "", left: s.capacity - s.booked }));
      return send(res, 200, { slots: open });
    }

    /* ===== แอดมิน ===== */
    if (method !== "GET" && !sameOrigin(req)) return send(res, 403, { error: "คำขอไม่ถูกต้อง" });
    if (!(await rateLimit("admin", ip, 120, WINDOW))) return send(res, 429, { error: "เรียกใช้บ่อยเกินไป กรุณารอสักครู่" });
    const failKey = `rz:adminfail:${ip}`;
    if (Number(await redis.get(failKey)) >= MAX_FAILS) return send(res, 429, { error: "ใส่รหัสผิดหลายครั้ง กรุณารอ 10 นาที" });
    if (!isAdmin(req)) {
      const n = await redis.incr(failKey);
      if (n === 1) await redis.expire(failKey, WINDOW);
      return send(res, 401, { error: "รหัสผ่านไม่ถูกต้อง" });
    }

    await ensureSchema();

    if (method === "GET") return send(res, 200, { slots: await loadSlots() });

    const { body, error } = readJson(req, 8000);
    if (error) return send(res, error[0], { error: error[1] });

    if (method === "POST") {
      const raw = Array.isArray(body.slots) ? body.slots : [];
      if (!raw.length || raw.length > 60) return send(res, 400, { error: "เพิ่มได้ครั้งละ 1–60 รอบ" });

      const [{ n }] = await sql`SELECT count(*)::int AS n FROM slots WHERE starts_at > now() - interval '1 day'`;
      if (n + raw.length > SLOT_MAX_TOTAL) return send(res, 400, { error: `มีรอบทดสอบได้สูงสุด ${SLOT_MAX_TOTAL} รอบ` });

      const now = Date.now();
      const seen = new Set();
      const valid = [];
      const skipped = [];
      for (const r of raw) {
        const t = typeof r?.start === "string" ? Date.parse(r.start) : NaN;
        const cap = Number.isInteger(r?.capacity) ? r.capacity : 1;
        const label = typeof r?.label === "string" ? r.label.trim().slice(0, 60) : "";
        if (!Number.isFinite(t) || t < now + MIN_LEAD_MS || t > now + SLOT_MAX_AHEAD_DAYS * 86400000) { skipped.push("เวลาไม่ถูกต้องหรือไกลเกินไป"); continue; }
        if (cap < 1 || cap > SLOT_MAX_CAPACITY) { skipped.push("จำนวนที่นั่งต้อง 1–" + SLOT_MAX_CAPACITY); continue; }
        if (/[\u0000-\u001F\u007F<>\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/.test(label)) { skipped.push("ป้ายชื่อมีอักขระที่ไม่อนุญาต"); continue; }
        const start = new Date(t).toISOString();
        if (seen.has(start)) { skipped.push("มีรอบเวลานี้อยู่แล้ว"); continue; }
        seen.add(start);
        valid.push({ id: randomUUID(), start, cap, label });
      }

      // ON CONFLICT: รอบเวลาเดียวกันที่มีอยู่แล้วจะถูกข้าม (ไม่ error)
      let created = 0;
      if (valid.length) {
        const out = await sqlTx(valid.map((v) => sql`
          INSERT INTO slots (id, starts_at, capacity, label)
          VALUES (${v.id}::uuid, ${v.start}::timestamptz, ${v.cap}, ${v.label})
          ON CONFLICT (starts_at) DO NOTHING
          RETURNING id`));
        for (const rows of out) { if (rows.length) created++; else skipped.push("มีรอบเวลานี้อยู่แล้ว"); }
      }
      return send(res, 200, { ok: true, created, skipped });
    }

    // DELETE: ลบรอบ ใบสมัครที่จองไว้จะถูกทำเครื่องหมาย "รอนัดใหม่" (ไม่หาย)
    const id = typeof body.id === "string" && UUID_RE.test(body.id) ? body.id : "";
    if (!id) return send(res, 400, { error: "ข้อมูลไม่ถูกต้อง" });
    const [mark, del] = await sqlTx([
      sql`UPDATE applications SET slot_cancelled = true, updated_at = now() WHERE slot_id = ${id}::uuid RETURNING id`,
      sql`DELETE FROM slots WHERE id = ${id}::uuid RETURNING id`,
    ]);
    if (!del.length) return send(res, 404, { error: "ไม่พบรอบทดสอบ" });
    return send(res, 200, { ok: true, affected: mark.length });
  } catch (e) {
    console.error("slots:", e?.message);
    return send(res, 500, { error: "ระบบขัดข้อง" });
  }
}
