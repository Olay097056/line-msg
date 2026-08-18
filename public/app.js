// line-msg-v2 control panel — vanilla JS, no build step.
// All API calls are same-origin relative paths (frontend and backend share
// the one Vercel deployment), so there is no API_BASE_URL to configure.

const $ = (sel) => document.querySelector(sel);

// ---- theme bridge (HyperUI light/dark) ----
// localStorage 'linemsg_theme' (priority) -> cookie 'theme' -> light default.
// The no-FOUC inline head script already set data-theme before first paint;
// this wires the toggle + persists on change.
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

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtTime(t) {
  return String(t).slice(0, 5);
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'medium' });
}

// ------------------------------------------------------------------- state
let state = null; // last /api/state payload
let logKind = 'send';

// -------------------------------------------------------------------- boot
async function boot() {
  try {
    await refresh();
    showApp();
  } catch {
    showLogin();
  }
}

function showLogin() {
  $('#login-view').classList.remove('hidden');
  $('#app-view').classList.add('hidden');
}

function showApp() {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
}

// ------------------------------------------------------------------- login
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('#password').value;
  const msg = $('#login-msg');
  msg.textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
    $('#password').value = '';
    await refresh();
    showApp();
  } catch (err) {
    msg.textContent = err.message;
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/api/login', { method: 'DELETE' }).catch(() => {});
  showLogin();
});

// -------------------------------------------------------------------- data
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
  $('#clock').textContent = `${state.now.date} ${state.now.hhmm} น. (ไทย)`;
}

// --------------------------------------------------------- hero / next departure
// The signature element: the next enabled schedule, rendered as a physical
// split-flap board row (time / route / status). Computed client-side from the
// same `now` the server used for /api/state, so weekday-skip logic matches
// exactly what the tick endpoint will actually do.
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
    const dayOffset = target > nowMinutes
      ? daysUntilValid(s.weekdays_only, 0)
      : daysUntilValid(s.weekdays_only, 1);
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
  if (!state.quota) {
    el.innerHTML = `<div class="msg error">อ่านโควต้าไม่ได้: ${escapeHtml(state.quotaError ?? 'ไม่ทราบสาเหตุ')}</div>`;
    return;
  }
  const q = state.quota;
  if (q.limit == null) {
    el.innerHTML = `<div>ไม่จำกัดโควต้า (ใช้ไปแล้ว ${q.totalUsage} ข้อความ)</div>`;
    return;
  }
  const pct = Math.min(100, Math.round((q.totalUsage / q.limit) * 100));
  const level = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '';
  const proj = q.projection;
  el.innerHTML = `
    <div class="quota-numbers">
      <span>ใช้ไป ${q.totalUsage} / ${q.limit}</span>
      <span>เหลือ ${q.limit - q.totalUsage}</span>
    </div>
    <div class="quota-bar"><div class="quota-bar-fill ${level}" style="width:${pct}%"></div></div>
    ${proj ? `<div class="quota-projection">อัตราการใช้ ${q.perSendingDay} ข้อความ/วันทำงาน — เหลือพอส่งได้อีกประมาณ ${proj.sendingDaysLeft} วันทำงาน</div>` : ''}
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
  const opts = state.templates
    .map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`)
    .join('');
  $('#sched-message').innerHTML = opts || '<option value="">— ยังไม่มีข้อความ —</option>';
}

function renderGroups() {
  const el = $('#groups-body');
  if (state.groups.length === 0) {
    el.innerHTML = '<div class="empty">ยังไม่มีกลุ่ม</div>';
    return;
  }
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
  msg.textContent = '';
  try {
    await api('/api/groups', { method: 'POST', body: JSON.stringify({ lineGroupId: input.value.trim() }) });
    input.value = '';
    msg.className = 'msg ok';
    msg.textContent = 'เพิ่มกลุ่มแล้ว (สถานะ pending — กด "ยืนยันใช้งาน" เพื่อเริ่มส่ง)';
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
    if (action === 'activate-group') {
      await api('/api/groups', { method: 'PATCH', body: JSON.stringify({ id, status: 'active' }) });
    } else if (action === 'deactivate-group') {
      await api('/api/groups', { method: 'PATCH', body: JSON.stringify({ id, status: 'inactive' }) });
    } else if (action === 'toggle-schedule') {
      await api('/api/schedules', { method: 'PATCH', body: JSON.stringify({ id, enabled: btn.dataset.next === 'true' }) });
    } else if (action === 'delete-schedule') {
      if (!confirm('ลบเวลานี้?')) return;
      await api(`/api/schedules?id=${id}`, { method: 'DELETE' });
    } else {
      return;
    }
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

// --------------------------------------------------------------- schedules
function renderSchedules() {
  const el = $('#schedules-body');
  const groupById = new Map(state.groups.map((g) => [g.id, g]));
  const messageOpts = state.templates
    .map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`)
    .join('');
  if (state.schedules.length === 0) {
    el.innerHTML = '<div class="empty">ยังไม่มีตารางเวลา</div>';
    return;
  }
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
            <td>
              <select data-action="change-schedule-message" data-id="${s.id}">${messageOpts}</select>
            </td>
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
  // Set each select's current value after inserting the HTML — <select> value
  // cannot be baked into the option string reliably across browsers.
  state.schedules.forEach((s) => {
    const sel = el.querySelector(`select[data-id="${s.id}"]`);
    if (sel) sel.value = s.message_id;
  });
}

document.body.addEventListener('change', async (e) => {
  const sel = e.target.closest('select[data-action="change-schedule-message"]');
  if (!sel) return;
  try {
    await api('/api/schedules', {
      method: 'PATCH',
      body: JSON.stringify({ id: sel.dataset.id, messageId: sel.value }),
    });
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
  if (!groupId || !messageId || !sendAtLocal) {
    msg.className = 'msg error';
    msg.textContent = 'ต้องเลือกกลุ่มและเวลา';
    return;
  }
  try {
    await api('/api/schedules', {
      method: 'POST',
      body: JSON.stringify({ groupId, messageId, sendAtLocal, weekdaysOnly }),
    });
    msg.className = 'msg ok';
    msg.textContent = 'เพิ่มเวลาแล้ว มีผลตั้งแต่รอบถัดไปทันที';
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
  if (!groupId) {
    msg.className = 'msg error';
    msg.textContent = 'ต้องเลือกกลุ่ม';
    return;
  }
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const res = await api('/api/send', {
      method: 'POST',
      body: JSON.stringify({ groupId, body: body || undefined }),
    });
    const outcome = res.results[0];
    msg.className = outcome?.status === 'sent' ? 'msg ok' : 'msg error';
    msg.textContent = `ผล: ${outcome?.status ?? 'ไม่ทราบ'}${outcome?.detail ? ' — ' + outcome.detail : ''}`;
    await refresh();
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// -------------------------------------------------------------------- msg
// Each schedule can point at its own message_templates row (ticket 10), so
// this section lists every template — not just one — with its own save
// button and a count of how many schedules currently use it.
function renderMessage() {
  const el = $('#message-body');
  if (state.templates.length === 0) {
    el.innerHTML = '<div class="empty">ยังไม่มีข้อความ</div>';
    return;
  }
  const usageCount = (templateId) =>
    state.schedules.filter((s) => s.message_id === templateId).length;

  el.innerHTML = state.templates.map((t) => `
    <div class="field" style="border-bottom:1px solid var(--border-default);padding-bottom:12px;margin-bottom:12px">
      <label>${escapeHtml(t.name)} <span>(ใช้อยู่ ${usageCount(t.id)} ตาราง)</span></label>
      <textarea data-template-id="${t.id}">${escapeHtml(t.body)}</textarea>
      <div class="row">
        <button data-action="save-message" data-id="${t.id}">บันทึก</button>
        ${usageCount(t.id) === 0 ? `<button class="danger" data-action="delete-message" data-id="${t.id}">ลบข้อความนี้</button>` : ''}
      </div>
      <div class="msg" data-status-for="${t.id}"></div>
    </div>
  `).join('');
}

document.body.addEventListener('click', async (e) => {
  const saveBtn = e.target.closest('button[data-action="save-message"]');
  const delBtn = e.target.closest('button[data-action="delete-message"]');
  if (!saveBtn && !delBtn) return;

  const id = (saveBtn ?? delBtn).dataset.id;
  const status = document.querySelector(`[data-status-for="${id}"]`);

  try {
    if (saveBtn) {
      const textarea = document.querySelector(`textarea[data-template-id="${id}"]`);
      await api('/api/message', { method: 'PATCH', body: JSON.stringify({ id, body: textarea.value }) });
      if (status) { status.className = 'msg ok'; status.textContent = 'บันทึกแล้ว'; }
    } else if (delBtn) {
      if (!confirm('ลบข้อความนี้?')) return;
      await api(`/api/message?id=${id}`, { method: 'DELETE' });
    }
    await refresh();
  } catch (err) {
    if (status) { status.className = 'msg error'; status.textContent = err.message; }
    else alert(err.message);
  }
});

$('#message-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#new-message-name');
  const msg = $('#message-form-msg');
  msg.className = 'msg';
  try {
    await api('/api/message', {
      method: 'POST',
      body: JSON.stringify({ name: input.value.trim(), body: 'Send TIME' }),
    });
    input.value = '';
    msg.className = 'msg ok';
    msg.textContent = 'เพิ่มข้อความใหม่แล้ว แก้เนื้อหาได้ด้านบน';
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
  if (rows.length === 0) {
    el.innerHTML = '<div class="empty">ยังไม่มีรายการ</div>';
    return;
  }
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
      </table>
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
      </table>
    `;
  }
}

boot();

// Keep the board honest while it's left open on a wall-mounted screen or a
// second monitor — refresh quietly every minute so the "next departure" and
// quota stay current without anyone touching the page.
setInterval(() => {
  if (!$('#app-view').classList.contains('hidden')) refresh().catch(() => {});
}, 60_000);
