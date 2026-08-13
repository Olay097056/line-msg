// Set the control-panel password. The plaintext never leaves this machine and
// is never written to a file — only the bcrypt hash is stored in Supabase.
//
// Usage:
//   node scripts/set-password.mjs                 # prompts, input hidden
//   node scripts/set-password.mjs --random        # generates one and prints it once
//
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.

import readline from 'node:readline';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('ต้องตั้ง SUPABASE_URL และ SUPABASE_SERVICE_ROLE_KEY ก่อน');
  process.exit(1);
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onData = (char) => {
      if (['\n', '\r', ''].includes(String(char))) process.stdin.removeListener('data', onData);
      else process.stdout.write('[2K[200D' + question + '*'.repeat(rl.line.length));
    };
    process.stdin.on('data', onData);
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const random = process.argv.includes('--random');
let password;
if (random) {
  // 10 chars, matching the 8–10 the user asked for.
  password = crypto.randomBytes(16).toString('base64url').slice(0, 10);
  console.log('รหัสผ่านที่สุ่มให้ (จดไว้ จะไม่แสดงอีก):', password);
} else {
  password = await askHidden('รหัสผ่านใหม่ (8-10 ตัว): ');
  const again = await askHidden('พิมพ์ซ้ำอีกครั้ง: ');
  if (password !== again) {
    console.error('รหัสผ่านไม่ตรงกัน');
    process.exit(1);
  }
  if (password.length < 8 || password.length > 32) {
    console.error('ความยาวต้องอยู่ระหว่าง 8-32 ตัว');
    process.exit(1);
  }
}

const hash = await bcrypt.hash(password, 10);
const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/app_settings`, {
  method: 'POST',
  headers: {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=representation',
  },
  body: JSON.stringify({ key: 'admin_password_hash', value: hash, updated_at: new Date().toISOString() }),
});

if (!res.ok) {
  console.error('เขียนลง Supabase ไม่สำเร็จ:', res.status, await res.text());
  process.exit(1);
}
console.log('ตั้งรหัสผ่านเรียบร้อย — session ที่ค้างอยู่ทั้งหมดถูกตัดทิ้งอัตโนมัติ');
