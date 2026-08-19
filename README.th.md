# line-msg

*[English version](README.md)*

ระบบแจ้งเตือน**งาน routine ที่ทำซ้ำๆ ทุกวันจนคนลืม** — งานประจำรายวันรายสัปดาห์
ที่ไม่มีใครคิดจะตั้งเตือน เพราะ "ก็ทำอยู่ทุกวันอยู่แล้ว" จนถึงวันที่ไม่มีใครทำ
ระบบจะยิงข้อความเตือนเข้ากลุ่ม LINE ที่ทีมใช้งานกันอยู่แล้ว ตรงเวลาที่งานนั้นต้องทำจริง

สร้างเป็นหน้าเว็บควบคุม + ตัวจับเวลาที่ผูกกับฐานข้อมูล + เชื่อมต่อ LINE
Messaging API เต็มรูปแบบ รันอยู่บน Cloudflare free tier ทั้งหมด

**[ลองใช้ demo ได้เลย](https://line-msg.pages.dev/demo)** — ไม่ต้อง
login เล่นได้ทุกฟีเจอร์ ข้อมูลจำลองทั้งหมด ไม่มีอะไรไปแตะ LINE หรือฐานข้อมูล
จริงเลย ส่วน production instance ใช้หน้าตาเดียวกันแต่ต่อกับกลุ่ม LINE จริง
เลยไม่เปิดสาธารณะด้วยเหตุผลนั้น

## ทำไมถึงสร้างระบบนี้

งาน routine มีรูปแบบการล้มเหลวเฉพาะตัว: มันเล็กเกินกว่าจะเปิด ticket, ถี่เกินกว่า
จะจำได้ว่าทำไปหรือยัง และเป็นงานของทุกคนซึ่งแปลว่าไม่เป็นของใครเลย การตั้งเตือน
ในปฏิทินจะเด้งเข้ามือถือคนเดียว ซึ่งเขาปัดทิ้งตอนขับรถ แต่ข้อความในกลุ่ม LINE
ที่ทุกคนเฝ้าอยู่แล้ว ทั้งทีมเห็นพร้อมกัน และการเงียบใส่มันกลายเป็นการเลือกที่คนอื่นเห็น

ความพยายามครั้งแรกเป็นฟังก์ชัน Google Apps Script ตัวเดียวผูกกับ time-driven
trigger เช็คนาฬิกาทุกครั้งที่รัน แล้วยิงข้อความคงที่ที่ 2 เวลาตายตัว ใช้งานได้จริง
แต่มีปัญหา:

- แก้ข้อความหรือเวลาส่งได้แค่ทางเดียวคือแก้โค้ด
- ไม่มีทางรู้เลยว่าการส่งแต่ละครั้งสำเร็จจริงไหม
- ไม่มีอะไรติดตามโควต้าข้อความรายเดือนของ LINE เลย — การ push เข้ากลุ่มหนึ่งครั้ง
  จะกินโควต้า **ตามจำนวนคนในกลุ่ม** ไม่ใช่ตามจำนวนครั้งที่เรียก API แปลว่ากลุ่ม
  เล็ก ๆ ก็ใช้โควต้า free tier หมดเร็วกว่าที่คิดได้ง่าย ๆ

โปรเจกต์นี้ทำงานเดิม (ส่งข้อความตามเวลา) แต่ทำให้ทุกส่วนมองเห็นได้และแก้ไขได้
โดยไม่ต้องแตะโค้ดเลย (เวอร์ชันแรกรันบน Vercel + Supabase — ออกแบบเหมือนกัน
แค่คนละ host ดูหัวข้อ "ประวัติ" ด้านล่าง)

## สถาปัตยกรรม

```
Cloudflare Worker Cron Trigger (00:15 & 10:15 UTC = 07:15 & 17:15 ไทย)
        │  ยิง scheduled() ซึ่งเรียก runTick() ตัวเดียวกับที่ HTTP tick ใช้
        ▼
Worker fetch() handler  /api/*
        │  อ่าน D1 ทำงานเฉพาะตอนตารางเวลาถึงจริงเท่านั้น
        ▼
LINE Messaging API  (push, เช็คโควต้า, เช็คจำนวนสมาชิกกลุ่ม)
        │
Cloudflare D1  (schedules, groups, message templates, send/system logs)
        ▲
Static frontend (vanilla JS) เสิร์ฟจาก Worker เดียวกันผ่าน [assets] binding
        ▲
LINE webhook  →  /api/webhook  (event กลุ่ม join/leave/สมาชิกเปลี่ยน,
                  ตรวจลายเซ็น HMAC จาก raw request body)
```

ไม่มี framework ไม่มี build step ไม่มี ORM:

- **Backend**: Cloudflare Worker ตัวเดียว (`src/worker.ts`) — route handler
  ทุกตัวอยู่ใน `api/*.ts` เขียนครั้งเดียวใช้ซ้ำได้ทั้งจาก Worker's `fetch()`
  และ (สำหรับ local dev / deployment สำรอง) Cloudflare Pages Functions
  (`functions/`) ต่างกันแค่ตัวแปลง transport เท่านั้น ตัว logic จริงเหมือนกัน
- **Frontend**: static HTML + vanilla JS ในโฟลเดอร์ `public/` เสิร์ฟจาก
  Worker เดียวกันผ่าน `[assets]` binding — ไม่ต้องมี CORS หรือ `API_BASE_URL`
- **Database**: Cloudflare D1 (SQLite) migration อยู่ที่ `d1/migrations/`
  ยิงด้วย `wrangler d1 execute --remote`
- **Scheduler**: Worker Cron Trigger ประกาศไว้ใน `wrangler.worker.toml`
  ใช้งานได้ทันทีตอน `wrangler deploy` — ไม่ต้องเข้า dashboard เลย (นี่คือ
  เหตุผลที่เลือกทำเป็น Worker ไม่ใช่ Pages: Cloudflare Pages Cron Triggers
  ไม่มี API หรือ CLI เลย ต้องตั้งในหน้าเว็บ dashboard เท่านั้น ส่วน Worker
  cron trigger เป็นแค่ config ธรรมดา)

## ความสามารถ

- **ส่งด้วยตัวเอง** — เลือกกลุ่ม ใส่ข้อความเอง (หรือไม่ใส่ก็ใช้ข้อความมาตรฐาน)
  แล้วส่งได้ทันที
- **ส่งตามตารางเวลา** — ตั้งเวลาส่งได้หลายกลุ่ม หลายรอบเวลา แต่ละรอบผูกข้อความ
  ของตัวเองได้ เลือกได้ว่าเฉพาะวันทำงานหรือทุกวัน
- **ติดตามโควต้า** — อ่านค่าจริงจาก LINE API ทั้งจำนวนที่ใช้ไปและลิมิต โชว์
  จำนวนที่เหลือ พร้อมคำนวณอัตราการใช้ว่าจะพอส่งได้อีกกี่วันทำการ และปฏิเสธการ
  ส่งถ้าจะทำให้โควต้าเกิน
- **จัดการกลุ่ม** — เพิ่มกลุ่มด้วย group ID เอง หรือให้ webhook ของ LINE เพิ่มให้
  อัตโนมัติ (สถานะ pending) ตอนบอทถูกเชิญเข้ากลุ่ม แล้วมายืนยันจากหน้าเว็บ
- **log แยก 2 แบบ** — ประวัติการส่ง (ส่งจริงหรือข้ามเพราะอะไร) กับ log ระบบ/
  error (เหตุการณ์เบื้องหลัง, auth ล้มเหลว, webhook ทำงาน) แยกกันตั้งใจ
- **ล็อกอินด้วยรหัสผ่าน** — รหัสผ่านเดียว hash แบบ bcrypt คุมการเข้าหน้าเว็บ
  ส่วน endpoint ที่ scheduler เรียก (`/api/tick`) ใช้กลไกแยกต่างหาก (shared
  secret) เพราะ Cloudflare cron trigger เรียกเข้ามาแบบเดียวกับ client
  ทั่วไป ไม่มี network ส่วนตัวให้ซ่อนไว้หลัง login เดียวกันได้

## จุดออกแบบที่น่าอ่าน

- **เขียนก่อนส่ง (claim-then-send)**: บันทึกแถวสถานะ `sent` ลงฐานข้อมูล
  **ก่อน** เรียก LINE API เสมอ ทำให้ database constraint (ส่งได้ 1 ครั้งต่อ
  ตารางเวลาต่อวัน) เป็นตัวกันการส่งซ้ำจริง ๆ ไม่ใช่การล็อกในระดับแอป ถ้า LINE
  เรียกไม่สำเร็จ แถวนั้นจะถูกลดสถานะเป็น `failed` ซึ่งปลดล็อกให้ลองใหม่รอบหน้าได้
- **โควต้านับตามจำนวนคน ไม่ใช่จำนวนครั้งที่ส่ง**: ข้อความที่ส่งเข้ากลุ่ม 7 คน
  กินโควต้า 7 ข้อความ ตัวกันโควต้าคูณด้วยจำนวนสมาชิกกลุ่มจริงที่อ่านสด ไม่ใช่
  ค่าคงที่ที่ cache ไว้
- **นาทีที่เงียบไม่เสียอะไรเลย**: tick จะเรียก LINE API ก็ต่อเมื่อถึงเวลาที่
  ตั้งไว้จริงเท่านั้น — แบบ poll ทุกนาที (ดีไซน์ตั้งต้น) ถ้าไม่มีตัวกันนี้จะ
  กลายเป็นการเช็คโควต้าทุกนาทีที่ว่างโดยไม่จำเป็น
- **ตรวจลายเซ็น webhook ด้วย raw body**: ข้าม auto JSON parsing ของ platform
  สำหรับ route นี้ เพราะถ้าเอา body ที่ parse แล้วมา stringify กลับ ไบต์จะ
  ไม่ตรงกับที่ LINE เซ็นมา ทำให้การตรวจ HMAC พังแบบเงียบ ๆ
- **ธีมเป็นชุด token แบบ HyperUI (light-first + dark mode)**: หน้าเว็บใช้
  สัญญา `data-theme` (ค่าเริ่มเป็น light, `[data-theme='dark']` เป็นตัวแทน
  ธีมมืด, เก็บค่าที่ `localStorage['linemsg_theme']` พร้อม script no-FOUC
  ใน `<head>` และปุ่มสลับธีมที่ header) สีทั้งหมดมาจาก semantic token ใน
  `public/app.css` เท่านั้น — พื้นผิวใช้ `--bg-*`, สีสถานะใช้คู่ soft+text
  ของ `--success/--warning/--danger` — แปลว่าเปลี่ยนธีมคือแค่เปลี่ยน
  attribute `data-theme` ตัวเดียว ไม่ใช่แก้ class ทีละตัว

## รันในเครื่องตัวเอง

```bash
npm install
npm test            # tsc typecheck + ชุดเทสต์ node:test (LINE กับ D1 ถูก
                     # stub ทั้งหมด ไม่มีอะไรแตะเน็ตจริง)
```

ถ้าจะ deploy เป็นของตัวเอง: สร้าง LINE Messaging API channel และบัญชี
Cloudflare แล้วกรอกค่าใน `.env.example` → `.dev.vars` จากนั้น:

```bash
npx wrangler d1 create line-msg                         # จด database_id ที่ได้
npx wrangler d1 execute line-msg --remote --file=./d1/migrations/0001_init.sql
for k in LINE_CHANNEL_ACCESS_TOKEN LINE_CHANNEL_SECRET CRON_SECRET SESSION_SECRET; do
  npx wrangler secret put "$k" --config wrangler.worker.toml
done
npx wrangler deploy --config wrangler.worker.toml         # deploy จริง + ตั้ง cron trigger ให้เลย
```

## ประวัติ

เริ่มจาก Google Apps Script trigger ตัวเดียว แล้วเขียนใหม่ลง Vercel +
Supabase Postgres (ดีไซน์เดียวกัน ใช้งานได้จริงครบ — serverless function,
`pg_cron`, PostgREST) จากนั้นย้ายอีกรอบมา Cloudflare Workers + D1 เพื่อให้
เหลือ vendor เดียวและ deploy ผ่าน CLI ได้ล้วน ๆ เวอร์ชัน Vercel/Supabase
เลิกใช้แล้วแต่โค้ด (`lib/db.ts` ตัว PostgREST client) ยังอยู่ในโปรเจกต์คู่กับ
D1 client (`lib/d1.ts`) — `lib/http.ts` เลือกใช้ตัวไหนตาม runtime ที่ได้รับมา

## Stack

Node.js · TypeScript · Cloudflare Workers · D1 (SQLite) · LINE Messaging API
· vanilla HTML/CSS/JS
