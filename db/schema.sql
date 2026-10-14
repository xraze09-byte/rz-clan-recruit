-- RZ CLAN Recruit: ฐานข้อมูล Postgres
-- ใช้ได้กับ Neon / Supabase / Postgres ทั่วไป  (ระบบรันไฟล์นี้ให้เองอัตโนมัติครั้งแรก ไม่ต้องรันเอง
-- แต่รันซ้ำได้ปลอดภัย เพราะใช้ IF NOT EXISTS ทั้งหมด)

CREATE TABLE IF NOT EXISTS slots (
  id          uuid PRIMARY KEY,
  starts_at   timestamptz NOT NULL UNIQUE,          -- ห้ามมี 2 รอบเวลาเดียวกัน
  capacity    smallint    NOT NULL CHECK (capacity BETWEEN 1 AND 10),
  label       text        NOT NULL DEFAULT '' CHECK (char_length(label) <= 60),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS applications (
  id            uuid PRIMARY KEY,
  ref           text        NOT NULL UNIQUE,
  ign           text        NOT NULL,
  uid           text        NOT NULL UNIQUE,         -- กันสมัครซ้ำที่ระดับฐานข้อมูล
  level         smallint    NOT NULL CHECK (level BETWEEN 30 AND 100),
  rank_br       text        NOT NULL,
  rank_cs       text        NOT NULL,
  track         text        NOT NULL CHECK (track IN ('LEAGUE', 'HIGHLIGHTS')),
  tier          text        NOT NULL CHECK (tier IN ('God', 'SSS', 'SS', 'S')),
  testers       text[]      NOT NULL DEFAULT '{}',
  instagram     text        NOT NULL DEFAULT '',   -- ชื่อหรือลิงก์ Instagram
  messenger     text        NOT NULL DEFAULT '',   -- ชื่อหรือลิงก์ Facebook Messenger
  availability  text        NOT NULL DEFAULT '',
  preferred_at  timestamptz,                        -- วัน+เวลาที่ผู้สมัครเลือกเอง (เวลาจริง เก็บเป็น UTC แสดงเป็นเวลาไทย)
  note          text        NOT NULL DEFAULT '',
  status        text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'testing', 'approved', 'rejected')),
  -- รอบที่จอง: ON DELETE SET NULL = ลบรอบแล้วใบสมัครไม่หาย
  slot_id       uuid        REFERENCES slots(id) ON DELETE SET NULL,
  slot_cancelled boolean    NOT NULL DEFAULT false,  -- true = รอบที่จองไว้ถูกแอดมินลบ (รอนัดใหม่)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS applications_created_idx ON applications (created_at DESC);
CREATE INDEX IF NOT EXISTS applications_status_idx  ON applications (status);
CREATE INDEX IF NOT EXISTS applications_slot_idx    ON applications (slot_id) WHERE slot_id IS NOT NULL;

-- ย้ายฐานข้อมูลเดิม: discord/line -> instagram/messenger (รันซ้ำได้ปลอดภัย)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='applications' AND column_name='discord') THEN
    ALTER TABLE applications RENAME COLUMN discord TO instagram;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='applications' AND column_name='line') THEN
    ALTER TABLE applications RENAME COLUMN line TO messenger;
  END IF;
END $$;

-- ฐานข้อมูลเดิม: เพิ่มคอลัมน์วัน+เวลาที่สะดวก
ALTER TABLE applications ADD COLUMN IF NOT EXISTS preferred_at timestamptz;
