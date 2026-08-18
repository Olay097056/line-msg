// line-msg-v2 — DEMO mode.
//
// A self-contained copy of app.js wired to an in-memory mock instead of the
// real /api/* endpoints. Nothing here ever touches LINE or Supabase — every
// interaction mutates a local JS object that resets on page reload. Kept as
// its own file (not a flag inside app.js) so the real app can never
// accidentally ship with mock data wired in.

const $ = (sel) => document.querySelector(sel);

// ---- theme bridge (HyperUI light/dark) ----
(function themeBridge() {
  const KEY = 'linemsg_theme';
  const COOKIE = 'theme';
  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem(KEY, t); } catch (e) {}
    document.cookie = `${COOKIE}=${t}; path=/; max-age=31536000; SameSite=Lax`;
  }
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.addEventListener('click', () => {
      const cur = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
      setTheme(cur === 'dark' ? 'light' : 'dark');
    });
  }
})();

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function fmtTime(t) { return String(t).slice(0, 5); }
function fmtDate(iso) { return new Date(iso).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'medium' }); }
function uid(prefix) { return `${prefix}-${Math.random().toString(36).slice(2, 9)}`; }

// ----------------------------------------------------------------- mock db
const now = new Date();
const bangkokNow = new Date(now.getTime() + 7 * 60 * 60_000);

const db = {
  groups: [
    {
      id: 'demo-g1',
      line_group_id: 'Cdemo00000000000000000000000001',
      name: 'ทีมหน้าร้าน',
      status: 'active',
      member_count: 9,
    },
    {
      id: 'demo-g2',
      line_group_id: 'Cdemo00000000000000000000000002',
      name: 'ทีมคลังสินค้า',
      status: 'pending',
      member_count: 4,
    },
  ],
  templates: [
    { id: 'demo-m1', name: 'default', body: 'อย่าลืมเช็คสต็อกก่อนปิดร้านนะครับ 🙏' },
    { id: 'demo-m2', name: 'เช้า', body: 'เปิดร้านแล้ว เช็คของหน้าร้านให้ครบก่อนลูกค้าเข้า' },
  ],
  schedules: [
    { id: 'demo-s1', group_id: 'demo-g1', message_id: 'demo-m2', send_at_local: '09:00:00', weekdays_only: true, enabled: true },
    { id: 'demo-s2', group_id: 'demo-g1', message_id: 'demo-m1', send_at_local: '20:00:00', weekdays_only: true, enabled: true },
  ],
  send_logs: [
    { id: 3, schedule_id: 'demo-s2', group_id: 'demo-g1', trigger_source: 'cron', message_body: 'อย่าลืมเช็คสต็อกก่อนปิดร้านนะครับ 🙏', status: 'sent', created_at: new Date(now - 15 * 3600_000).toISOString(), error_detail: null },
    { id: 2, schedule_id: 'demo-s1', group_id: 'demo-g1', trigger_source: 'cron', message_body: 'เปิดร้านแล้ว เช็คของหน้าร้านให้ครบก่อนลูกค้าเข้า', status: 'sent', created_at: new Date(now - 26 * 3600_000).toISOString(), error_detail: null },
    { id: 1, schedule_id: null, group_id: 'demo-g1', trigger_source: 'manual', message_body: 'ทดสอบระบบก่อนเริ่มใช้งานจริง', status: 'sent', created_at: new Date(now - 48 * 3600_000).toISOString(), error_detail: null },
  ],
  system_logs: [
    { id: 4, level: 'info', event: 'schedule_created', detail: { send_at_local: '09:00:00' }, created_at: new Date(now - 26 * 3600_000).toISOString() },
    { id: 3, level: 'warn', event: 'member_count_changed', detail: { group: 'Cdemo...0001', from: 8, to: 9 }, created_at: new Date(now - 20 * 3600_000).toISOString() },
    { id: 2, level: 'info', event: 'webhook_group_joined', detail: { line_group_id: 'Cdemo...0002', status: 'pending' }, created_at: new Date(now - 5 * 3600_000).toISOString() },
    { id: 1, level: 'info', event: 'login_ok', detail: null, created_at: new Date(now - 1 * 3600_000).toISOString() },
  ],
  quotaUsed: 812,
  nextId: 100,
};

const nowClock = {
  weekday: bangkokNow.getUTCDay(),
  minutes: bangkokNow.getUTCHours() * 60 + bangkokNow.getUTCMinutes(),
  date: bangkokNow.toISOString().slice(0, 10),
  hhmm: `${String(bangkokNow.getUTCHours()).padStart(2, '0')}:${String(bangkokNow.getUTCMinutes()).padStart(2, '0')}`,
};

// ------------------------------------------------------------ mock api()
// Signature matches the real fetch-based `api()` in app.js: (path, opts) ->
// Promise<parsedJsonBody>, throwing Error(message) on a simulated failure.
function delay(ms = 220) { return new Promise((r) => setTimeout(r, ms)); }

async function api(path, opts = {}) {
  await delay();
  const method = opts.method ?? 'GET';
  const body = opts.body ? JSON.parse(opts.body) : {};
  const [route, qs] = path.split('?');
  const params = new URLSearchParams(qs ?? '');

  if (route === '/api/state') {
    const limit = 1000;
    const remaining = limit - db.quotaUsed;
    const perDay = db.groups
      .filter((g) => g.status === 'active')
      .reduce((sum, g) => sum + g.member_count * db.schedules.filter((s) => s.group_id === g.id && s.enabled).length, 0);
    return {
      now: nowClock,
      quota: {
        type: 'limited',
        limit,
        totalUsage: db.quotaUsed,
        perSendingDay: perDay,
        projection: { remaining, sendingDaysLeft: Math.floor(remaining / Math.max(perDay, 1)) },
      },
      quotaError: null,
      groups: db.groups,
      schedules: db.schedules,
      templates: db.templates,
    };
  }

  if (route === '/api/logs') {
    const kind = params.get('kind') ?? 'send';
    return kind === 'system' ? db.system_logs : db.send_logs;
  }

  if (route === '/api/send' && method === 'POST') {
    const group = db.groups.find((g) => g.id === body.groupId);
    if (!group) throw new Error('ไม่พบกลุ่มที่ใช้ส่งได้');
    const text = body.body || db.templates[0]?.body || '';
    const row = {
      id: db.nextId++,
      schedule_id: null,
      group_id: group.id,
      trigger_source: 'manual',
      message_body: text,
      status: 'sent',
      created_at: new Date().toISOString(),
      error_detail: null,
    };
    db.send_logs.unshift(row);
    db.quotaUsed += group.member_count;
    return { body: text, results: [{ group: group.line_group_id, status: 'sent', logId: row.id }] };
  }

  if (route === '/api/schedules') {
    if (method === 'GET') return db.schedules;
    if (method === 'POST') {
      const clash = db.schedules.some((s) => s.group_id === body.groupId && s.send_at_local.startsWith(body.sendAtLocal));
      if (clash) throw new Error('กลุ่มนี้มีเวลานี้อยู่แล้ว');
      const row = {
        id: uid('demo-s'),
        group_id: body.groupId,
        message_id: body.messageId,
        send_at_local: `${body.sendAtLocal}:00`,
        weekdays_only: !!body.weekdaysOnly,
        enabled: true,
      };
      db.schedules.push(row);
      return row;
    }
    if (method === 'PATCH') {
      const row = db.schedules.find((s) => s.id === body.id);
      if (!row) throw new Error('ไม่พบตารางเวลานี้');
      if (body.sendAtLocal !== undefined) row.send_at_local = `${body.sendAtLocal}:00`;
      if (body.enabled !== undefined) row.enabled = body.enabled;
      if (body.messageId !== undefined) row.message_id = body.messageId;
      if (body.weekdaysOnly !== undefined) row.weekdays_only = body.weekdaysOnly;
      return row;
    }
    if (method === 'DELETE') {
      const id = params.get('id');
      db.schedules = db.schedules.filter((s) => s.id !== id);
      return { ok: true };
    }
  }

  if (route === '/api/groups') {
    if (method === 'GET') return db.groups;
    if (method === 'POST') {
      const row = { id: uid('demo-g'), line_group_id: body.lineGroupId, name: 'กลุ่มตัวอย่างใหม่', status: 'pending', member_count: 3 };
      db.groups.push(row);
      return row;
    }
    if (method === 'PATCH') {
      const row = db.groups.find((g) => g.id === body.id);
      if (!row) throw new Error('ไม่พบกลุ่มนี้');
      if (body.status !== undefined) row.status = body.status;
      if (body.name !== undefined) row.name = body.name;
      return row;
    }
    if (method === 'DELETE') {
      const id = params.get('id');
      db.groups = db.groups.filter((g) => g.id !== id);
      return { ok: true };
    }
  }

  if (route === '/api/message') {
    if (method === 'GET') return db.templates;
    if (method === 'POST') {
      const row = { id: uid('demo-m'), name: body.name, body: body.body ?? 'Send TIME' };
      db.templates.push(row);
      return row;
    }
    if (method === 'PATCH') {
      const row = db.templates.find((t) => t.id === body.id);
      if (!row) throw new Error('ไม่พบข้อความนี้');
      if (body.body !== undefined) row.body = body.body;
      if (body.name !== undefined) row.name = body.name;
      return row;
    }
    if (method === 'DELETE') {
      const id = params.get('id');
      if (db.schedules.some((s) => s.message_id === id)) {
        throw new Error('ลบไม่ได้ — มีตารางเวลากำลังใช้ข้อความนี้อยู่');
      }
      db.templates = db.templates.filter((t) => t.id !== id);
      return { ok: true };
    }
  }

  throw new Error(`demo: unhandled ${method} ${route}`);
}

// ------------------------------------------------------------------- state
let state = null;
let logKind = 'send';

async function refresh() {
  state = await api('/api/state');
  renderClock();
  renderHero();
  renderQuota();
  renderGroupSelects();
  renderMessageSelects();
  renderSchedules();
  renderGroups();
  renderMessage();
  await renderLogs();
}

function renderClock() {
  $('#clock').textContent = `${state.now.date} ${state.now.hhmm} น. (ไทย, จำลอง)`;
}

// --------------------------------------------------------- hero / next departure
function minutesOfTime(hhmmss) {
  const [h, m] = String(hhmmss).split(':').map(Number);
  return h * 60 + m;
}

function computeNextDeparture() {
  const activeGroupIds = new Set(state.groups.filter((g) => g.status === 'active').map((g) => g.id));
  const candidates = state.schedules.filter((s) => s.enabled && activeGroupIds.has(s.group_id));
  if (candidates.length === 0) return null;

  const nowMinutes = state.now.minutes;
  const nowWeekday = state.now.weekday;

  const daysUntilValid = (weekdaysOnly, startOffset) => {
    for (let d = startOffset; d < startOffset + 8; d++) {
      const wd = (nowWeekday + d) % 7;
      if (!weekdaysOnly || (wd >= 1 && wd <= 5)) return d;
    }
    return startOffset;
  };

  let best = null;
  for (const s of candidates) {
    const target = minutesOfTime(s.send_at_local);
    const dayOffset = target > nowMinutes ? daysUntilValid(s.weekdays_only, 0) : daysUntilValid(s.weekdays_only, 1);
    const away = dayOffset * 1440 + (target - nowMinutes);
    if (!best || away < best.away) best = { schedule: s, dayOffset, away };
  }
  return best;
}

function renderHero() {
  const el = $('#hero-body');
  const next = computeNextDeparture();
  if (!next) {
    el.innerHTML = '<div class="empty">ยังไม่มีตารางเวลาที่ใช้งานอยู่ — เพิ่มได้ที่ด้านล่าง</div>';
    return;
  }
  const { schedule, dayOffset, away } = next;
  const group = state.groups.find((g) => g.id === schedule.group_id);
  const dueSoon = dayOffset === 0 && away <= 2;
  const statusText = dueSoon ? 'กำลังส่ง' : dayOffset === 0 ? 'วันนี้' : dayOffset === 1 ? 'พรุ่งนี้' : `อีก ${dayOffset} วัน`;
  const statusClass = dueSoon ? 'danger' : 'ok';

  el.innerHTML = `
    <div class="hero-cell">
      <span class="hero-cell-label">เวลา · TIME</span>
      <div class="hero-value">${escapeHtml(fmtTime(schedule.send_at_local))}</div>
    </div>
    <div class="hero-cell">
      <span class="hero-cell-label">กลุ่ม · ROUTE</span>
      <div class="hero-value small">${escapeHtml(group?.name ?? '—')}</div>
    </div>
    <div class="hero-cell">
      <span class="hero-cell-label">สถานะ · STATUS</span>
      <div class="hero-value small ${statusClass}">${statusText}</div>
    </div>
  `;
}

// -------------------------------------------------------------------- quota
function renderQuota() {
  const el = $('#quota-body');
  const q = state.quota;
  const pct = Math.min(100, Math.round((q.totalUsage / q.limit) * 100));
  const level = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '';
  const proj = q.projection;
  el.innerHTML = `
    <div class="quota-numbers">
      <span>ใช้ไป ${q.totalUsage} / ${q.limit}</span>
      <span>เหลือ ${q.limit - q.totalUsage}</span>
    </div>
    <div class="quota-bar"><div class="quota-bar-fill ${level}" style="width:${pct}%"></div></div>
    <div class="quota-projection">อัตราการใช้ ${q.perSendingDay} ข้อความ/วันทำงาน — เหลือพอส่งได้อีกประมาณ ${proj.sendingDaysLeft} วันทำงาน</div>
  `;
}

// ------------------------------------------------------------------ groups
function renderGroupSelects() {
  const opts = state.groups
    .filter((g) => g.status === 'active')
    .map((g) => `<option value="${g.id}">${escapeHtml(g.name ?? g.line_group_id)} (${g.member_count ?? '?'} คน)</option>`)
    .join('');
  $('#send-group').innerHTML = opts || '<option value="">— ไม่มีกลุ่มที่ใช้งานอยู่ —</option>';
  $('#sched-group').innerHTML = opts || '<option value="">— ไม่มีกลุ่มที่ใช้งานอยู่ —</option>';
}

function renderMessageSelects() {
  const opts = state.templates.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  $('#sched-message').innerHTML = opts || '<option value="">— ยังไม่มีข้อความ —</option>';
}

function renderGroups() {
  const el = $('#groups-body');
  if (state.groups.length === 0) { el.innerHTML = '<div class="empty">ยังไม่มีกลุ่ม</div>'; return; }
  el.innerHTML = `
    <div class="table-scroll"><table>
      <thead><tr><th>ชื่อ</th><th>สถานะ</th><th>สมาชิก</th><th>LINE group ID</th><th></th></tr></thead>
      <tbody>
        ${state.groups.map((g) => `
          <tr>
            <td>${escapeHtml(g.name ?? '(ไม่มีชื่อ)')}</td>
            <td><span class="badge ${g.status}">${g.status}</span></td>
            <td>${g.member_count ?? '?'}</td>
            <td style="font-family:monospace;font-size:11px">${escapeHtml(g.line_group_id)}</td>
            <td>
              ${g.status !== 'active' ? `<button data-action="activate-group" data-id="${g.id}">ยืนยันใช้งาน</button>` : ''}
              ${g.status === 'active' ? `<button class="secondary" data-action="deactivate-group" data-id="${g.id}">ปิดใช้งาน</button>` : ''}
            </td>
          </tr>`).join('')}
      </tbody>
    </table></div>
  `;
}

$('#group-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#group-line-id');
  const msg = $('#group-msg');
  msg.className = 'msg';
  try {
    await api('/api/groups', { method: 'POST', body: JSON.stringify({ lineGroupId: input.value.trim() || uid('Cdemo') }) });
    input.value = '';
    msg.className = 'msg ok';
    msg.textContent = 'เพิ่มกลุ่มแล้ว (จำลอง) — สถานะ pending ให้กดยืนยันใช้งาน';
    await refresh();
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.message;
  }
});

document.body.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;
  try {
    if (action === 'activate-group') await api('/api/groups', { method: 'PATCH', body: JSON.stringify({ id, status: 'active' }) });
    else if (action === 'deactivate-group') await api('/api/groups', { method: 'PATCH', body: JSON.stringify({ id, status: 'inactive' }) });
    else if (action === 'toggle-schedule') await api('/api/schedules', { method: 'PATCH', body: JSON.stringify({ id, enabled: btn.dataset.next === 'true' }) });
    else if (action === 'delete-schedule') { if (!confirm('ลบเวลานี้? (จำลอง)')) return; await api(`/api/schedules?id=${id}`, { method: 'DELETE' }); }
    else if (action === 'save-message') {
      const textarea = document.querySelector(`textarea[data-template-id="${id}"]`);
      await api('/api/message', { method: 'PATCH', body: JSON.stringify({ id, body: textarea.value }) });
    } else if (action === 'delete-message') { if (!confirm('ลบข้อความนี้? (จำลอง)')) return; await api(`/api/message?id=${id}`, { method: 'DELETE' }); }
    else return;
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

// --------------------------------------------------------------- schedules
function renderSchedules() {
  const el = $('#schedules-body');
  const groupById = new Map(state.groups.map((g) => [g.id, g]));
  const messageOpts = state.templates.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  if (state.schedules.length === 0) { el.innerHTML = '<div class="empty">ยังไม่มีตารางเวลา</div>'; return; }
  el.innerHTML = `
    <div class="table-scroll"><table>
      <thead><tr><th>เวลา</th><th>กลุ่ม</th><th>ข้อความ</th><th>เฉพาะวันทำงาน</th><th>สถานะ</th><th></th></tr></thead>
      <tbody>
        ${state.schedules.map((s) => {
          const g = groupById.get(s.group_id);
          return `
          <tr>
            <td>${fmtTime(s.send_at_local)}</td>
            <td>${escapeHtml(g?.name ?? s.group_id)}</td>
            <td><select data-action="change-schedule-message" data-id="${s.id}">${messageOpts}</select></td>
            <td>${s.weekdays_only ? 'ใช่' : 'ทุกวัน'}</td>
            <td><span class="badge ${s.enabled ? 'active' : 'inactive'}">${s.enabled ? 'เปิด' : 'ปิด'}</span></td>
            <td class="row">
              <button class="secondary" data-action="toggle-schedule" data-id="${s.id}" data-next="${!s.enabled}">${s.enabled ? 'ปิด' : 'เปิด'}</button>
              <button class="danger" data-action="delete-schedule" data-id="${s.id}">ลบ</button>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table></div>
  `;
  state.schedules.forEach((s) => {
    const sel = el.querySelector(`select[data-id="${s.id}"]`);
    if (sel) sel.value = s.message_id;
  });
}

document.body.addEventListener('change', async (e) => {
  const sel = e.target.closest('select[data-action="change-schedule-message"]');
  if (!sel) return;
  try {
    await api('/api/schedules', { method: 'PATCH', body: JSON.stringify({ id: sel.dataset.id, messageId: sel.value }) });
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

$('#schedule-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#schedule-msg');
  msg.className = 'msg';
  const groupId = $('#sched-group').value;
  const messageId = $('#sched-message').value;
  const sendAtLocal = $('#sched-time').value;
  const weekdaysOnly = $('#sched-weekdays').checked;
  if (!groupId || !messageId || !sendAtLocal) { msg.className = 'msg error'; msg.textContent = 'ต้องเลือกกลุ่มและเวลา'; return; }
  try {
    await api('/api/schedules', { method: 'POST', body: JSON.stringify({ groupId, messageId, sendAtLocal, weekdaysOnly }) });
    msg.className = 'msg ok';
    msg.textContent = 'เพิ่มเวลาแล้ว (จำลอง)';
    await refresh();
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.message;
  }
});

// --------------------------------------------------------------- send form
$('#send-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#send-msg');
  msg.className = 'msg';
  const groupId = $('#send-group').value;
  const body = $('#send-body').value.trim();
  if (!groupId) { msg.className = 'msg error'; msg.textContent = 'ต้องเลือกกลุ่ม'; return; }
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const res = await api('/api/send', { method: 'POST', body: JSON.stringify({ groupId, body: body || undefined }) });
    const outcome = res.results[0];
    msg.className = 'msg ok';
    msg.textContent = `ผล (จำลอง): ${outcome?.status ?? 'ไม่ทราบ'} — ไม่มีข้อความจริงถูกส่งออกไปไหน`;
    await refresh();
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// -------------------------------------------------------------------- msg
function renderMessage() {
  const el = $('#message-body');
  if (state.templates.length === 0) { el.innerHTML = '<div class="empty">ยังไม่มีข้อความ</div>'; return; }
  const usageCount = (id) => state.schedules.filter((s) => s.message_id === id).length;
  el.innerHTML = state.templates.map((t) => `
    <div class="field" style="border-bottom:1px solid var(--border-default);padding-bottom:12px;margin-bottom:12px">
      <label>${escapeHtml(t.name)} <span>(ใช้อยู่ ${usageCount(t.id)} ตาราง)</span></label>
      <textarea data-template-id="${t.id}">${escapeHtml(t.body)}</textarea>
      <div class="row">
        <button data-action="save-message" data-id="${t.id}">บันทึก</button>
        ${usageCount(t.id) === 0 ? `<button class="danger" data-action="delete-message" data-id="${t.id}">ลบข้อความนี้</button>` : ''}
      </div>
    </div>
  `).join('');
}

$('#message-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#new-message-name');
  const msg = $('#message-form-msg');
  msg.className = 'msg';
  try {
    await api('/api/message', { method: 'POST', body: JSON.stringify({ name: input.value.trim(), body: 'ข้อความตัวอย่าง แก้ไขได้ด้านบน' }) });
    input.value = '';
    msg.className = 'msg ok';
    msg.textContent = 'เพิ่มข้อความใหม่แล้ว (จำลอง)';
    await refresh();
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.message;
  }
});

// -------------------------------------------------------------------- logs
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    logKind = btn.dataset.kind;
    await renderLogs();
  });
});

async function renderLogs() {
  const el = $('#logs-body');
  const rows = await api(`/api/logs?kind=${logKind}&limit=30`);
  if (rows.length === 0) { el.innerHTML = '<div class="empty">ยังไม่มีรายการ</div>'; return; }
  const groupById = new Map((state.groups ?? []).map((g) => [g.id, g]));
  if (logKind === 'send') {
    el.innerHTML = `
      <div class="table-scroll"><table>
        <thead><tr><th>เวลา</th><th>กลุ่ม</th><th>ที่มา</th><th>สถานะ</th><th class="wrap">รายละเอียด</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${fmtDate(r.created_at)}</td>
              <td>${escapeHtml(groupById.get(r.group_id)?.name ?? r.group_id)}</td>
              <td>${r.trigger_source}</td>
              <td><span class="badge ${r.status}">${r.status}</span></td>
              <td class="wrap">${escapeHtml(r.error_detail ?? '')}</td>
            </tr>`).join('')}
        </tbody>
      </table></div>
    `;
  } else {
    el.innerHTML = `
      <div class="table-scroll"><table>
        <thead><tr><th>เวลา</th><th>ระดับ</th><th>เหตุการณ์</th><th class="wrap">รายละเอียด</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${fmtDate(r.created_at)}</td>
              <td><span class="badge ${r.level}">${r.level}</span></td>
              <td>${escapeHtml(r.event)}</td>
              <td class="wrap" style="font-family:monospace;font-size:11px">${escapeHtml(JSON.stringify(r.detail ?? {}))}</td>
            </tr>`).join('')}
        </tbody>
      </table></div>
    `;
  }
}

refresh();
