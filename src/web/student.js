const api = async (path, options = {}) => {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
};

const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let boot = null;

const notice = new URLSearchParams(location.search).get('notice');
if (notice) el('notice').innerHTML = `<div class="notice">${esc(notice)}</div>`;

async function render() {
  boot = await api('/bootstrap');

  /**
   * Only wrap the button in a live link when the provider is actually
   * configured -- a disabled button inside an <a> still lets the click reach the
   * anchor in some browsers, which would navigate to an error page.
   */
  const connectButton = (provider, label, studentId) => {
    if (!boot.configured[provider]) {
      const hint = `Set ${provider.toUpperCase()}_CLIENT_ID and ${provider.toUpperCase()}_CLIENT_SECRET in .env`;
      return `<button type="button" class="ghost" disabled title="${hint}">${label}</button>`;
    }
    return `<a href="/connect/${provider}?student=${studentId}">` +
      `<button type="button" class="ghost">${label}</button></a>`;
  };

  el('students').innerHTML = boot.students.length === 0
    ? '<div class="empty">No students yet — add one below.</div>'
    : boot.students.map((s) => `
      <div style="padding:14px 0;border-bottom:1px solid var(--border)">
        <div class="row">
          <strong>${esc(s.name)}</strong>
          <span class="muted mono">${esc(s.id)}</span>
        </div>
        <div class="row" style="margin-top:8px">
          ${s.connections.map((c) => `
            <span class="badge ${c.status === 'active' ? 'synced' : 'failed'}"
                  ${c.last_error ? `title="${esc(c.last_error)}"` : ''}>
              ${esc(boot.providerLabels[c.provider] ?? c.provider)}${c.account_email ? `: ${esc(c.account_email)}` : ''}
              ${c.status === 'active' ? '' : ' — reconnect'}
            </span>`).join('') || '<span class="muted">No calendars connected</span>'}
        </div>
        <div class="row" style="margin-top:10px">
          ${connectButton('google', 'Connect Google', s.id)}
          ${connectButton('microsoft', 'Connect Outlook', s.id)}
          <button type="button" class="ghost" data-sim="${s.id}">Add simulated calendar</button>
          <button type="button" class="ghost" data-simfail="${s.id}" title="Always fails — use it to see the retry path">Add failing calendar</button>
        </div>
      </div>`).join('');

  for (const b of document.querySelectorAll('[data-sim]')) {
    b.onclick = async () => {
      await api(`/students/${b.dataset.sim}/simulate`, { method: 'POST', body: { label: `simulated-${Date.now() % 1000}` } });
      render();
    };
  }
  for (const b of document.querySelectorAll('[data-simfail]')) {
    b.onclick = async () => {
      await api(`/students/${b.dataset.simfail}/simulate`, { method: 'POST', body: { label: 'fail-demo' } });
      render();
    };
  }

  el('apple-student').innerHTML = boot.students
    .map((s) => `<option value="${s.id}">${esc(s.name)}</option>`)
    .join('');

  const current = location.pathname.split('/')[2];
  const me = boot.students.find((s) => s.id === current);
  el('who').textContent = me ? `viewing as ${me.name}` : '';
  if (me) el('apple-student').value = me.id;
}

el('add-student').onsubmit = async (ev) => {
  ev.preventDefault();
  const name = new FormData(ev.target).get('name');
  await api('/students', { method: 'POST', body: { name } });
  ev.target.reset();
  render();
};

el('apple-form').onsubmit = async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  el('apple-result').innerHTML = '<p class="muted">Contacting iCloud…</p>';
  try {
    const out = await api('/connect/apple', {
      method: 'POST',
      body: {
        student: f.get('student'),
        appleId: f.get('appleId'),
        appPassword: f.get('appPassword'),
      },
    });
    el('apple-result').innerHTML =
      `<div class="notice">Connected to iCloud calendar “${esc(out.calendar.displayName)}”.</div>`;
    ev.target.reset();
    render();
  } catch (err) {
    el('apple-result').innerHTML =
      `<p style="color:var(--bad)">${esc(err.message)}</p>`;
  }
};

render().catch((err) => {
  el('students').innerHTML = `<pre style="color:var(--bad)">${esc(err.message)}</pre>`;
});
