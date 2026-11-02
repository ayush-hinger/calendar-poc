const api = async (path, options = {}) => {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
};

const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let selectedId = null;
let poll = null;
let boot = null;

// ---------------------------------------------------------------- setup

function pad(n) { return String(n).padStart(2, '0'); }
function localInput(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function init() {
  boot = await api('/bootstrap');
  el('tz').value = Intl.DateTimeFormat().resolvedOptions().timeZone;
  el('students-link').href = `/student/${boot.students[0]?.id ?? 'none'}`;

  const start = new Date(Date.now() + 36e5);
  start.setMinutes(0, 0, 0);
  const form = el('create-form');
  form.starts_at.value = localInput(start);
  form.ends_at.value = localInput(new Date(start.getTime() + 36e5));

  await refreshEvents();
  setInterval(refreshPending, 1500);
}

async function refreshPending() {
  try {
    const { pending } = await api('/pending');
    el('pending').textContent = pending === 0 ? 'all synced' : `${pending} syncing…`;
    el('pending').style.color = pending === 0 ? 'var(--ok)' : 'var(--warn)';
  } catch { /* transient */ }
}

// --------------------------------------------------------------- events

async function refreshEvents() {
  const { events } = await api('/events');
  const list = el('event-list');

  if (events.length === 0) {
    list.innerHTML = '<li class="empty" style="cursor:default">No classes yet</li>';
    return;
  }

  list.innerHTML = events
    .map((e) => `
      <li data-id="${e.id}" class="${e.id === selectedId ? 'active' : ''}">
        <div class="title">${esc(e.title)} ${e.status === 'cancelled' ? '<span class="badge removed">cancelled</span>' : ''}</div>
        <div class="meta">
          ${esc(e.starts_at.replace('T', ' '))} · v${e.version} ·
          ${e.synced_count}/${e.target_count} calendars
        </div>
      </li>`)
    .join('');

  for (const li of list.querySelectorAll('li[data-id]')) {
    li.onclick = () => select(li.dataset.id);
  }

  if (!selectedId && events.length > 0) select(events[0].id);
}

el('create-form').onsubmit = async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const created = await api('/events', {
    method: 'POST',
    body: {
      title: f.get('title'),
      description: f.get('description'),
      location: f.get('location'),
      starts_at: `${f.get('starts_at')}:00`,
      ends_at: `${f.get('ends_at')}:00`,
      timezone: f.get('timezone'),
    },
  });
  selectedId = created.event.id;
  await refreshEvents();
  select(selectedId);
};

function select(id) {
  selectedId = id;
  for (const li of document.querySelectorAll('li[data-id]')) {
    li.classList.toggle('active', li.dataset.id === id);
  }
  if (poll) clearInterval(poll);
  renderDetail();
  poll = setInterval(renderDetail, 1500);
}

// --------------------------------------------------------------- detail

function badge(t, version) {
  const behind = t.synced_version < version;
  let state = t.state;
  if (state === 'synced' && behind) state = 'pending';
  const text = {
    synced: 'synced',
    pending: 'syncing…',
    failed: 'retrying',
    dead: 'gave up',
    removed: 'removed',
  }[state] ?? state;
  return `<span class="badge ${state}">${text}</span>`;
}

async function renderDetail() {
  if (!selectedId) return;

  let data;
  let logs;
  try {
    [data, logs] = await Promise.all([
      api(`/events/${selectedId}/targets`),
      api(`/events/${selectedId}/log`),
    ]);
  } catch {
    return;
  }

  const { event } = await api(`/events/${selectedId}`);
  const rows = data.targets.map((t) => `
    <tr>
      <td>${esc(t.student_name)}</td>
      <td><span class="pill">${esc(boot.providerLabels[t.provider] ?? t.provider)}</span></td>
      <td class="muted mono">${esc(t.account_email ?? '—')}</td>
      <td>${badge(t, data.version)}</td>
      <td class="mono muted">v${t.synced_version}/${data.version}</td>
      <td class="err">${esc(t.last_error ?? '')}</td>
    </tr>`).join('');

  el('detail').innerHTML = `
    <h2>${esc(event.title)} <span class="pill">v${event.version}</span>
      ${data.converged ? '<span class="badge synced">all calendars in sync</span>' : '<span class="badge pending">converging…</span>'}
    </h2>

    <form id="edit-form">
      <div class="grid2">
        <label>Title<input name="title" value="${esc(event.title)}" /></label>
        <label>Location<input name="location" value="${esc(event.location ?? '')}" /></label>
      </div>
      <div class="grid2">
        <label>Starts<input name="starts_at" type="datetime-local" value="${esc((event.starts_at || '').slice(0, 16))}" /></label>
        <label>Ends<input name="ends_at" type="datetime-local" value="${esc((event.ends_at || '').slice(0, 16))}" /></label>
      </div>
      <label>Description<textarea name="description">${esc(event.description ?? '')}</textarea></label>
      <div class="row">
        <button type="submit" ${event.status === 'cancelled' ? 'disabled' : ''}>Save &amp; propagate</button>
        <button type="button" class="ghost" id="btn-reconcile">Re-push all</button>
        <button type="button" class="ghost" id="btn-retry">Retry failed</button>
        <button type="button" class="danger" id="btn-cancel" ${event.status === 'cancelled' ? 'disabled' : ''}>Cancel class</button>
      </div>
      <p class="hint">Saving bumps the version; the worker pushes the change to every calendar that has fallen behind.</p>
    </form>

    <h2 style="margin-top:24px">Per-calendar status</h2>
    <table>
      <thead><tr><th>Student</th><th>Provider</th><th>Account</th><th>State</th><th>Version</th><th>Last error</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="empty">No calendars connected yet</td></tr>'}</tbody>
    </table>

    <h2 style="margin-top:24px">Sync activity</h2>
    <div class="log">
      ${logs.entries.map((l) => `
        <div>
          <span class="${l.ok ? 'yes' : 'no'}">${l.ok ? '✓' : '✗'}</span>
          <span class="muted mono">${esc(l.at)}</span>
          ${esc(l.action)} · ${esc(l.student_name)} (${esc(l.provider)})
          ${l.detail ? `<span class="muted">— ${esc(l.detail)}</span>` : ''}
        </div>`).join('') || '<div class="muted">Nothing yet</div>'}
    </div>`;

  el('edit-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    await api(`/events/${selectedId}`, {
      method: 'PATCH',
      body: {
        title: f.get('title'),
        location: f.get('location'),
        description: f.get('description'),
        starts_at: `${f.get('starts_at')}:00`,
        ends_at: `${f.get('ends_at')}:00`,
      },
    });
    await refreshEvents();
    renderDetail();
  };

  el('btn-cancel').onclick = async () => {
    await api(`/events/${selectedId}/cancel`, { method: 'POST' });
    await refreshEvents();
    renderDetail();
  };
  el('btn-retry').onclick = async () => {
    await api(`/events/${selectedId}/retry`, { method: 'POST' });
  };
  el('btn-reconcile').onclick = async () => {
    await api(`/events/${selectedId}/reconcile`, { method: 'POST' });
  };
}

init().catch((err) => {
  document.body.innerHTML = `<main class="single"><div class="panel"><h2>Failed to start</h2><pre>${esc(err.message)}</pre></div></main>`;
});
