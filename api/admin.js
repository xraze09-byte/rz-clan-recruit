import {
  sql, ensureSchema, redis, systemReady, STATUSES, TIERS, TRACKS, cleanNames, send, readJson,
  sameOrigin, rateLimit, ipKey, isAdmin, UUID_RE, appFromRow, RETENTION_DAYS,
} from "./_lib.js";

const MAX_FAILS = 10;
const WINDOW = 600; // 10 นาที

export default async function handler(req, res) {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  const method = req.method;
  if (!["GET", "PATCH", "PUT", "DELETE"].includes(method)) {
    res.setHeader("Allow", "GET, PATCH, PUT, DELETE");
    return send(res, 405, { error: "Method not allowed" });
  }

  try {
    if (!systemReady()) return send(res, 503, { error: "ระบบยังไม่พร้อม" });
    if (method !== "GET" && !sameOrigin(req)) return send(res, 403, { error: "คำขอไม่ถูกต้อง" });

    const ip = ipKey(req);
    if (!(await rateLimit("admin", ip, 120, WINDOW))) return send(res, 429, { error: "เรียกใช้บ่อยเกินไป กรุณารอสักครู่" });

    // ล็อกเมื่อใส่รหัสผิดเกิน 10 ครั้งใน 10 นาที
    const failKey = `rz:adminfail:${ip}`;
    if (Number(await redis.get(failKey)) >= MAX_FAILS) {
      return send(res, 429, { error: "ใส่รหัสผิดหลายครั้ง กรุณารอ 10 นาที" });
    }
    if (!isAdmin(req)) {
      const n = await redis.incr(failKey);
      if (n === 1) await redis.expire(failKey, WINDOW);
      return send(res, 401, { error: "รหัสผ่านไม่ถูกต้อง" });
    }

    await ensureSchema();

    const isTesters = String(req.url || "").includes("what=testers");

    if (method === "GET" && isTesters) {
      const rows = await sql`SELECT track, tier, names FROM tier_testers`;
      return send(res, 200, { testers: rows.map((r) => ({ track: r.track, tier: r.tier, names: r.names || [] })) });
    }

    if (method === "PUT" && isTesters) {
      // บันทึกรายชื่อผู้เทสของ (สาย, tier) หนึ่งช่อง แทนที่ทั้งรายการ; names ว่าง = ล้าง
      const { body, error } = readJson(req, 2000);
      if (error) return send(res, error[0], { error: error[1] });
      if (!TRACKS.includes(body.track) || !TIERS.includes(body.tier)) return send(res, 400, { error: "ข้อมูลไม่ถูกต้อง" });
      const names = cleanNames(body.names);
      if (!names) return send(res, 422, { error: "รายชื่อไม่ถูกต้อง (สูงสุด 10 ชื่อ ชื่อละไม่เกิน 40 ตัวอักษร)" });
      await sql`
        INSERT INTO tier_testers (track, tier, names) VALUES (${body.track}, ${body.tier}, ${names}::text[])
        ON CONFLICT (track, tier) DO UPDATE SET names = EXCLUDED.names, updated_at = now()`;
      return send(res, 200, { ok: true, names });
    }
    if (method === "PUT") return send(res, 404, { error: "ไม่พบ" });

    if (method === "GET") {
      // ลบใบสมัครที่เก็บเกินกำหนด (แทน TTL ของ Redis เดิม)
      await sql`DELETE FROM applications WHERE created_at < now() - make_interval(days => ${RETENTION_DAYS})`;
      const rows = await sql`
        SELECT a.*, s.starts_at AS slot_start
        FROM applications a LEFT JOIN slots s ON s.id = a.slot_id
        ORDER BY a.created_at DESC LIMIT 500`;
      return send(res, 200, { items: rows.map(appFromRow) });
    }

    const { body, error } = readJson(req, 500);
    if (error) return send(res, error[0], { error: error[1] });
    const id = typeof body.id === "string" && UUID_RE.test(body.id) ? body.id : "";
    if (!id) return send(res, 400, { error: "ข้อมูลไม่ถูกต้อง" });

    if (method === "PATCH") {
      const hasStatus = body.status !== undefined;
      const hasTier = body.tierAdmin !== undefined;
      const hasTesters = body.testers !== undefined;
      if (!hasStatus && !hasTier && !hasTesters) return send(res, 400, { error: "ไม่มีข้อมูลที่จะแก้" });

      if (hasTier) {
        // tierAdmin: "" = ล้างค่า (กลับไปใช้ tier ที่ผู้สมัครเลือก) หรือ God/SSS/SS/S
        if (body.tierAdmin !== "" && !TIERS.includes(body.tierAdmin)) return send(res, 400, { error: "tier ไม่ถูกต้อง" });
        const t = body.tierAdmin === "" ? null : body.tierAdmin;
        const out = await sql`UPDATE applications SET tier_admin = ${t}, updated_at = now() WHERE id = ${id}::uuid RETURNING id`;
        if (!out.length) return send(res, 404, { error: "ไม่พบใบสมัคร" });
      }
      if (hasTesters) {
        // testers: null = ล้างค่า (กลับไปใช้รายชื่อกลางของ tier) | array/string = ตั้งรายชื่อของใบสมัครนี้ ([] = ไม่มีผู้เทส)
        let names = null;
        if (body.testers !== null) {
          names = cleanNames(body.testers);
          if (!names) return send(res, 422, { error: "รายชื่อไม่ถูกต้อง (สูงสุด 10 ชื่อ ชื่อละไม่เกิน 40 ตัวอักษร)" });
        }
        const out = await sql`UPDATE applications SET testers_admin = ${names}::text[], updated_at = now() WHERE id = ${id}::uuid RETURNING id`;
        if (!out.length) return send(res, 404, { error: "ไม่พบใบสมัคร" });
      }
      if (hasStatus) {
        if (!STATUSES.includes(body.status)) return send(res, 400, { error: "สถานะไม่ถูกต้อง" });
        // ไม่ผ่าน → คืนที่นั่งในรอบทดสอบ (slot_id = NULL) ในคำสั่งเดียว
        const out = await sql`
          UPDATE applications
          SET status = ${body.status},
              slot_id = CASE WHEN ${body.status} = 'rejected' THEN NULL ELSE slot_id END,
              updated_at = now()
          WHERE id = ${id}::uuid
          RETURNING id`;
        if (!out.length) return send(res, 404, { error: "ไม่พบใบสมัคร" });
      }
      return send(res, 200, { ok: true });
    }

    // DELETE: ลบใบสมัคร (UID ปลดล็อกให้สมัครใหม่ได้ และที่นั่งว่างอัตโนมัติ)
    await sql`DELETE FROM applications WHERE id = ${id}::uuid`;
    return send(res, 200, { ok: true });
  } catch (e) {
    console.error("admin:", e?.message);
    return send(res, 500, { error: "ระบบขัดข้อง" });
  }
}
