import { randomUUID } from "node:crypto";
import {
  sql, sqlTx, ensureSchema, systemReady, send, readJson, sameOrigin,
  rateLimit, ipKey, getIp, verifyTurnstile, validateApplication,
} from "./_lib.js";

const MIN_FILL_MS = 3000;
const MIN_LEAD_MS = 5 * 60 * 1000;
const makeRef = () => `RZ-${randomUUID().slice(0, 8).toUpperCase()}`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: "Method not allowed" });
  }
  try {
    if (!systemReady()) return send(res, 503, { error: "ระบบยังไม่พร้อม กรุณาแจ้งแอดมิน" });
    if (!sameOrigin(req)) return send(res, 403, { error: "คำขอไม่ถูกต้อง" });

    const { body, error } = readJson(req);
    if (error) return send(res, error[0], { error: error[1] });

    if (!(await rateLimit("apply", ipKey(req), 8, 600))) {
      return send(res, 429, { error: "ส่งบ่อยเกินไป กรุณารอ 10 นาทีแล้วลองใหม่" });
    }

    // Honeypot: บอทกรอกช่องที่มองไม่เห็น → ตอบสำเร็จแบบหลอก แต่ไม่บันทึก
    if (typeof body.website === "string" && body.website.trim() !== "") {
      return send(res, 200, { ok: true, ref: makeRef() });
    }

    // ใช้เวลาที่วัดฝั่งผู้ใช้ (elapsed) ไม่ใช่นาฬิกาเครื่อง จึงไม่มีปัญหาเวลาเครื่องไม่ตรง
    const elapsed = Number(body.elapsedMs);
    if (!Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) {
      return send(res, 400, { error: "ส่งเร็วเกินไป กรุณาตรวจสอบข้อมูลแล้วกดส่งอีกครั้ง" });
    }

    if (process.env.TURNSTILE_SECRET_KEY && !(await verifyTurnstile(body.turnstileToken, getIp(req)))) {
      return send(res, 400, { error: "ยืนยันว่าไม่ใช่บอทไม่ผ่าน กรุณาลองใหม่" });
    }

    const { ok, data, errors } = validateApplication(body);
    if (!ok) return send(res, 422, { error: "ข้อมูลบางช่องไม่ถูกต้อง", fieldErrors: errors });

    await ensureSchema();

    const id = randomUUID();
    const ref = `RZ-${id.slice(0, 8).toUpperCase()}`;
    const minStart = new Date(Date.now() + MIN_LEAD_MS).toISOString();
    const slotId = data.slotId || null;

    /*
     * จองที่นั่งแบบกันจองเกิน: ธุรกรรมเดียว 2 คำสั่ง
     *   1) ล็อกแถวของรอบนั้น (FOR UPDATE) → คนที่มาพร้อมกันต้องต่อคิวรอ
     *   2) นับที่นั่ง + บันทึก ใน statement ถัดมา → นับหลังได้ล็อกแล้ว จึงเห็นคนที่เพิ่งจองไป
     * ห้ามรวมเป็น statement เดียว: snapshot ของการนับจะเก่ากว่าล็อก ทำให้จองเกินได้
     * (ทดสอบกับ Postgres จริงแล้ว พบว่าจองเกินได้ 3-15 คนต่อ 1 ที่นั่ง)
     * ถ้าไม่เลือกรอบ ล็อกจะไม่เจอแถวใด ๆ และ INSERT ก็บันทึกตามปกติ
     */
    let row;
    try {
      const [, out] = await sqlTx([
        sql`SELECT id FROM slots WHERE id = ${slotId}::uuid FOR UPDATE`,
        sql`
          INSERT INTO applications
            (id, ref, ign, uid, level, rank_br, rank_cs, track, tier, instagram, messenger, availability, preferred_at, note, slot_id)
          SELECT ${id}::uuid, ${ref}, ${data.ign}, ${data.uid}, ${data.level}, ${data.rankBR}, ${data.rankCS},
                 ${data.track}, ${data.tier}, ${data.instagram}, ${data.messenger}, ${data.availability},
                 ${data.preferredAt || null}::timestamptz, ${data.note}, ${slotId}::uuid
          WHERE ${slotId}::uuid IS NULL
             OR EXISTS (
               SELECT 1 FROM slots s
               WHERE s.id = ${slotId}::uuid AND s.starts_at > ${minStart}::timestamptz
                 AND (SELECT count(*) FROM applications a WHERE a.slot_id = s.id) < s.capacity)
          RETURNING id, created_at, (SELECT starts_at FROM slots WHERE id = ${slotId}::uuid) AS slot_start`,
      ]);
      row = out[0];
    } catch (e) {
      if (e?.code === "23505") {
        // unique_violation: UID ซ้ำ (หรือ ref ชนกัน ซึ่งแทบเป็นไปไม่ได้)
        return send(res, 409, { error: "UID นี้ส่งใบสมัครแล้ว หากต้องการแก้ไขโปรดติดต่อแอดมิน" });
      }
      throw e;
    }

    if (!row) {
      // ไม่ได้ที่นั่ง: ถ้า UID นี้สมัครไว้แล้ว ให้บอกตรง ๆ ก่อน (ไม่ใช่ "รอบเต็ม")
      const [dup] = await sql`SELECT 1 AS x FROM applications WHERE uid = ${data.uid}`;
      if (dup) return send(res, 409, { error: "UID นี้ส่งใบสมัครแล้ว หากต้องการแก้ไขโปรดติดต่อแอดมิน" });
      // แยกสาเหตุให้ผู้สมัครเห็นข้อความที่ถูกต้อง
      const [s] = await sql`
        SELECT starts_at, capacity,
               (SELECT count(*) FROM applications a WHERE a.slot_id = slots.id)::int AS booked
        FROM slots WHERE id = ${slotId}::uuid`;
      const msg = !s ? "ไม่พบรอบทดสอบนี้ กรุณารีเฟรชแล้วเลือกใหม่"
        : new Date(s.starts_at).getTime() <= Date.now() + MIN_LEAD_MS ? "รอบทดสอบนี้ปิดรับแล้ว กรุณาเลือกรอบอื่น"
        : "รอบทดสอบนี้เต็มแล้ว กรุณาเลือกรอบอื่น";
      return send(res, 409, { error: msg, fieldErrors: { slotId: msg }, slotsChanged: true });
    }

    return send(res, 200, { ok: true, ref });
  } catch (e) {
    console.error("apply:", e?.message);
    return send(res, 500, { error: "ระบบขัดข้อง กรุณาลองใหม่ภายหลัง" });
  }
}
