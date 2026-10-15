// สร้างอัตโนมัติจาก db/schema.sql — ฝังเป็นโค้ดเพื่อไม่ต้องพึ่งการอ่านไฟล์ตอนรันบน Vercel
// ถ้าแก้ schema.sql ให้แก้ไฟล์นี้ให้ตรงกัน
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS slots (
    id          uuid PRIMARY KEY,
    starts_at   timestamptz NOT NULL UNIQUE,          
    capacity    smallint    NOT NULL CHECK (capacity BETWEEN 1 AND 10),
    label       text        NOT NULL DEFAULT '' CHECK (char_length(label) <= 60),
    created_at  timestamptz NOT NULL DEFAULT now()
    )`,
  `CREATE TABLE IF NOT EXISTS applications (
    id            uuid PRIMARY KEY,
    ref           text        NOT NULL UNIQUE,
    ign           text        NOT NULL,
    uid           text        NOT NULL UNIQUE,         
    level         smallint    NOT NULL CHECK (level BETWEEN 30 AND 100),
    rank_br       text        NOT NULL,
    rank_cs       text        NOT NULL,
    track         text        NOT NULL CHECK (track IN ('LEAGUE', 'HIGHLIGHTS')),
    tier          text        NOT NULL CHECK (tier IN ('God', 'SSS', 'SS', 'S')),
    tier_admin    text        CHECK (tier_admin IN ('God', 'SSS', 'SS', 'S')),
    instagram     text        NOT NULL DEFAULT '',
    messenger     text        NOT NULL DEFAULT '',
    availability  text        NOT NULL DEFAULT '',
    preferred_at  timestamptz,
    note          text        NOT NULL DEFAULT '',
    status        text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'testing', 'approved', 'rejected')),
    slot_id       uuid        REFERENCES slots(id) ON DELETE SET NULL,
    slot_cancelled boolean    NOT NULL DEFAULT false,  
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
    )`,
  `DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='applications' AND column_name='discord') THEN
      ALTER TABLE applications RENAME COLUMN discord TO instagram;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='applications' AND column_name='line') THEN
      ALTER TABLE applications RENAME COLUMN line TO messenger;
    END IF;
  END $$`,
  `ALTER TABLE applications ADD COLUMN IF NOT EXISTS preferred_at timestamptz`,
  `DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='applications' AND column_name='testers') THEN
      ALTER TABLE applications ALTER COLUMN testers DROP NOT NULL;
    END IF;
  END $$`,
  `ALTER TABLE applications ADD COLUMN IF NOT EXISTS tier_admin text CHECK (tier_admin IN ('God', 'SSS', 'SS', 'S'))`,
  `ALTER TABLE applications ADD COLUMN IF NOT EXISTS testers_admin text[]`,
  `CREATE TABLE IF NOT EXISTS tier_testers (
    track      text        NOT NULL CHECK (track IN ('LEAGUE', 'HIGHLIGHTS')),
    tier       text        NOT NULL CHECK (tier IN ('God', 'SSS', 'SS', 'S')),
    names      text[]      NOT NULL DEFAULT '{}',
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (track, tier)
    )`,
  `CREATE INDEX IF NOT EXISTS applications_created_idx ON applications (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS applications_status_idx  ON applications (status)`,
  `CREATE INDEX IF NOT EXISTS applications_slot_idx    ON applications (slot_id) WHERE slot_id IS NOT NULL`,
];
