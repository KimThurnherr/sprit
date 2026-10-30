'use strict';
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = (n, d = 2) => n == null ? '–' : Number(n).toLocaleString('de-CH', { minimumFractionDigits: d, maximumFractionDigits: d });
  const km = (n) => n == null ? '–' : Number(n).toLocaleString('de-CH', { maximumFractionDigits: 1 });
  const dt = (s) => s ? s.split('-').reverse().join('.') : '';
  const parseNum = (s) => { s = String(s ?? '').trim().replace(/['\s]/g, '').replace(',', '.'); return s === '' ? null : Number(s); };

  let me = null, vehicles = [], current = null, view = null, tab = 'fillups', statRange = 'all';
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

  async function api(path, opts = {}) {
    const r = await fetch('/api/' + path, { ...opts, headers: opts.body ? { 'Content-Type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
    if (r.status === 401) { showLogin(); throw new Error('Nicht angemeldet'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Fehler ' + r.status);
    return j;
  }
  function toast(msg, ms = 3500) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms); }
  function showLogin() {
    $('#app').hidden = true; $('#login').hidden = false;
    const p = new URLSearchParams(location.search).get('login');
    $('#loginMsg').textContent = p === 'nicht-erlaubt' ? 'Dieses Google-Konto ist nicht freigeschaltet.' : p === 'fehler' ? 'Anmeldung fehlgeschlagen. Bitte nochmals versuchen.' : '';
  }

  async function init() {
    try { me = await api('me'); } catch { return; }
    if (location.search) history.replaceState(null, '', '/');
    $('#login').hidden = true; $('#app').hidden = false;
    $('#fillupForm [name=currency]').innerHTML = me.currencies.map(c => `<option>${c}</option>`).join('');
    $('#vehicleForm [name=fuel]').innerHTML = Object.entries(me.fuels).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
    await loadVehicles();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  async function loadVehicles() {
    vehicles = await api('vehicles');
    const active = vehicles.filter(v => !v.archived);
    const saved = +store.get('vehicle');
    current = (active.find(v => v.id === saved) || active[0] || null)?.id ?? null;
    $('#vehicleSel').innerHTML = active.length ? active.map(v => `<option value="${v.id}">${esc(v.name)}${v.plate ? ' · ' + esc(v.plate) : ''}</option>`).join('') : '<option>Kein Fahrzeug</option>';
    if (current) $('#vehicleSel').value = current;
    $('#addBtn').disabled = !current;
    await loadView();
  }
  async function loadView() {
    view = current ? await api('vehicles/' + current) : null;
    render();
  }

  function render() {
    for (const s of ['fillups', 'stats', 'vehicles']) $('#tab-' + s).hidden = s !== tab;
    document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'fillups') renderFillups();
    if (tab === 'stats') renderStats();
    if (tab === 'vehicles') renderVehicles();
  }

  function renderFillups() {
    const el = $('#tab-fillups');
    if (!view) { el.innerHTML = `<div class="card empty">Noch kein Fahrzeug erfasst.<br><br><button class="btn primary" id="firstVehicle">Fahrzeug anlegen</button></div>`; $('#firstVehicle').onclick = () => openVehicle(); return; }
    const s = view.stats;
    const head = `<div class="kpis">
      <div class="kpi"><span>Durchschnitt</span><b>${nf(s.avg_l_100km)}</b><small>l/100km</small></div>
      <div class="kpi"><span>Kilometerstand</span><b>${km(s.last_odometer)}</b><small>km</small></div>
    </div>`;
    if (!view.fillups.length) { el.innerHTML = head + '<div class="card empty">Noch keine Betankung. Mit + erfassen.</div>'; return; }
    const avg = s.avg_l_100km;
    el.innerHTML = head + '<div class="list">' + view.fillups.map(f => {
      let right;
      if (f.l_100km != null) { const cls = avg == null ? '' : f.l_100km > avg ? 'up' : 'down'; right = `<b class="${cls}">${nf(f.l_100km)}</b><span>l/100km</span>`; }
      else right = `<span>${f.status === 'teil' ? 'Teilbetankt' : f.status === 'start' || f.status === 'neu_gemessen' ? (f.full ? 'Startpunkt' : 'Teilbetankt') : '–'}</span>`;
      const chf = f.currency !== 'CHF' ? (f.total_chf != null ? `<span>≈ ${nf(f.total_chf)} CHF</span>` : '<span>CHF offen</span>') : '';
      return `<div class="row" data-id="${f.id}">
        <div class="a"><b>${dt(f.date)}${f.missed ? '<span class="tag">Lücke</span>' : ''}</b><span class="num">${km(f.odometer)} km</span><span class="num">${nf(f.price_per_l, 3)} ${esc(f.currency)}/l</span></div>
        <div class="b num">${f.km_since_prev != null ? km(f.km_since_prev) + ' km' : '–'}<span>${nf(f.liters)} l</span><span>${nf(f.total)} ${esc(f.currency)}</span>${chf}</div>
        <div class="c num">${right}</div></div>`;
    }).join('') + '</div>';
    el.querySelectorAll('.row').forEach(r => r.onclick = () => openFillup(view.fillups.find(f => f.id === +r.dataset.id)));
  }

  function rangeOf(r) {
    const t = me.today;
    if (r === '12m') { const d = new Date(t + 'T00:00:00Z'); d.setUTCFullYear(d.getUTCFullYear() - 1); return { from: d.toISOString().slice(0, 10) }; }
    if (r === 'year') return { from: t.slice(0, 4) + '-01-01' };
    return {};
  }
  async function renderStats() {
    const el = $('#tab-stats');
    if (!view) { el.innerHTML = '<div class="card empty">Noch kein Fahrzeug erfasst.</div>'; return; }
    const rg = rangeOf(statRange);
    const data = rg.from ? await api(`vehicles/${current}?from=${rg.from}`) : view;
    const s = data.stats;
    const seg = `<div class="seg">${[['all', 'Gesamt'], ['12m', '12 Monate'], ['year', 'Dieses Jahr']].map(([k, l]) => `<button data-r="${k}" class="${statRange === k ? 'active' : ''}">${l}</button>`).join('')}</div>`;
    const k = (label, val, unit) => `<div class="kpi"><span>${label}</span><b>${val}</b>${unit ? `<small>${unit}</small>` : ''}</div>`;
    el.innerHTML = seg + `<div class="kpis">
      ${k('Ø Verbrauch', nf(s.avg_l_100km), 'l/100km')}
      ${k('Letzter', nf(s.last_l_100km), 'l/100km')}
      ${k('Bester / schlechtester', `${nf(s.best_l_100km, 1)} / ${nf(s.worst_l_100km, 1)}`, '')}
      ${k('Kosten pro 100 km', nf(s.chf_per_100km), 'CHF')}
      ${k('Ø Preis', nf(s.avg_price_per_l_chf, 3), 'CHF/l')}
      ${k('Gefahren', km(s.km_driven), 'km')}
      ${k('Getankt', nf(s.total_liters, 1), 'l')}
      ${k('Ausgaben', nf(s.total_chf), 'CHF' + (s.chf_incomplete ? '*' : ''))}
    </div>
    <div class="card chart"><h3 style="margin-top:0">Verbrauch je Volltankung</h3>${chart(s.series, s.avg_l_100km)}</div>
    <div class="card"><h3 style="margin-top:0">Pro Monat</h3><div class="scroll">${table(s.by_month)}</div></div>
    <div class="card"><h3 style="margin-top:0">Pro Jahr</h3><div class="scroll">${table(s.by_year)}</div></div>
    <p class="muted small">Verbrauch wird nur zwischen zwei Volltankungen gemessen (Teilbetankungen dazwischen zählen mit). Fremdwährungen sind zum EZB-Tageskurs umgerechnet.${s.chf_incomplete ? ' * Für einzelne Betankungen fehlt noch der Kurs.' : ''}</p>`;
    el.querySelectorAll('.seg button').forEach(b => b.onclick = () => { statRange = b.dataset.r; renderStats(); });
  }
  function table(rows) {
    if (!rows.length) return '<p class="muted">Keine Daten.</p>';
    return `<table><thead><tr><th>Periode</th><th>km</th><th>Liter</th><th>CHF</th><th>l/100km</th></tr></thead><tbody>${rows.slice().reverse().map(r => `<tr><td>${r.period.length === 7 ? r.period.slice(5) + '.' + r.period.slice(0, 4) : r.period}</td><td>${km(r.km)}</td><td>${nf(r.liters, 1)}</td><td>${nf(r.chf)}${r.chf_incomplete ? '*' : ''}</td><td>${nf(r.l_100km)}</td></tr>`).join('')}</tbody></table>`;
  }
  function chart(series, avg) {
    if (series.length < 2) return '<p class="muted">Für eine Grafik braucht es mindestens drei Volltankungen.</p>';
    const W = 640, H = 260, L = 46, R = 12, T = 14, B = 34;
    const ys = series.map(p => p.l_100km);
    let lo = Math.floor(Math.min(...ys) - 0.5), hi = Math.ceil(Math.max(...ys) + 0.5);
    if (hi - lo < 2) { lo -= 1; hi += 1; }
    const t0 = Date.parse(series[0].date), t1 = Date.parse(series[series.length - 1].date) || t0 + 1;
    const x = d => L + (t1 === t0 ? 0.5 : (Date.parse(d) - t0) / (t1 - t0)) * (W - L - R);
    const y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const step = Math.max(1, Math.ceil((hi - lo) / 5));
    let grid = '';
    for (let v = lo; v <= hi; v += step) grid += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 7}" text-anchor="end">${v}</text>`;
    const first = series[0].date, last = series[series.length - 1].date;
    const pts = series.map(p => `${x(p.date).toFixed(1)},${y(p.l_100km).toFixed(1)}`).join(' ');
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Verbrauch über die Zeit">
      <g class="grid axis">${grid}<text x="${L}" y="${H - 6}">${dt(first)}</text><text x="${W - R}" y="${H - 6}" text-anchor="end">${dt(last)}</text></g>
      ${avg != null ? `<line class="avg" x1="${L}" x2="${W - R}" y1="${y(avg)}" y2="${y(avg)}"/>` : ''}
      <polyline class="line" points="${pts}"/>
      ${series.map(p => `<circle class="dot" cx="${x(p.date).toFixed(1)}" cy="${y(p.l_100km).toFixed(1)}" r="5"><title>${dt(p.date)}: ${nf(p.l_100km)} l/100km</title></circle>`).join('')}
    </svg>`;
  }

  function renderVehicles() {
    const el = $('#tab-vehicles');
    el.innerHTML = '<div class="list">' + (vehicles.length ? vehicles.map(v => `<div class="row" data-id="${v.id}">
      <div class="a"><b>${esc(v.name)}${v.archived ? '<span class="tag">archiviert</span>' : ''}</b><span>${esc(v.plate)} · ${esc(v.fuel_label)}</span><span>${v.fillups} Betankungen</span></div>
      <div class="b num">${km(v.odometer)} km<span>${nf(v.total_liters, 1)} l</span></div>
      <div class="c num"><b>${nf(v.avg_l_100km)}</b><span>l/100km</span></div></div>`).join('') : '<div class="empty">Noch kein Fahrzeug.</div>') + '</div>'
      + '<p><button class="btn primary" id="newVehicle">Fahrzeug hinzufügen</button></p>'
      + `<div class="card"><h3 style="margin-top:0">Claude / MCP</h3>${me.mcp ? `<p class="small">Adresse: <code>${esc(me.mcp)}</code><br>Authentifizierung mit Bearer-Token (in der Server-Konfiguration hinterlegt).</p>` : '<p class="small muted">Für dieses Konto ist kein MCP-Token eingerichtet.</p>'}</div>`
      + '<p><button class="btn small" id="logout">Abmelden</button></p>';
    el.querySelectorAll('.row').forEach(r => r.onclick = () => openVehicle(vehicles.find(v => v.id === +r.dataset.id)));
    $('#newVehicle').onclick = () => openVehicle();
    $('#logout').onclick = async () => { await fetch('/auth/logout', { method: 'POST' }); location.reload(); };
  }

  // ---------- Betankung erfassen/ändern ----------
  let editing = null, priceSrc = 'ppl';
  function openFillup(f = null) {
    editing = f; const form = $('#fillupForm'); form.reset();
    $('#fillupTitle').textContent = f ? 'Betankung ändern' : 'Betankung erfassen';
    $('#fillupDelete').hidden = !f; $('#fillupErr').textContent = '';
    const last = view?.fillups[0];
    const lastCur = store.get('currency') || 'CHF';
    const v = f || { date: me.today, currency: lastCur, full: true, missed: false };
    form.date.value = v.date; form.date.max = me.today;
    form.odometer.value = v.odometer ?? ''; form.liters.value = v.liters ?? '';
    form.price_per_l.value = v.price_per_l ?? ''; form.total.value = v.total ?? '';
    form.currency.value = v.currency; form.full.checked = !!v.full; form.missed.checked = !!v.missed;
    form.station.value = v.station || ''; form.country.value = v.country || ''; form.note.value = v.note || '';
    form.total_chf.value = f && f.fx_source === 'manual' ? f.total_chf : '';
    $('#odoHint').textContent = !f && last ? `Letzter Stand: ${km(last.odometer)} km am ${dt(last.date)}` : '';
    priceSrc = 'ppl';
    updateFx();
    $('#fillupDlg').showModal();
  }
  function recalc() {
    const f = $('#fillupForm'), l = parseNum(f.liters.value), p = parseNum(f.price_per_l.value), t = parseNum(f.total.value);
    if (!l) return;
    if (priceSrc === 'ppl' && p) f.total.value = (Math.round(p * l * 100) / 100).toFixed(2);
    if (priceSrc === 'total' && t) f.price_per_l.value = (Math.round(t / l * 1000) / 1000).toFixed(3);
  }
  let fxReq = 0;
  async function updateFx() {
    const f = $('#fillupForm'), cur = f.currency.value;
    $('#fxBox').hidden = cur === 'CHF';
    if (cur === 'CHF') return;
    const id = ++fxReq;
    $('#fxInfo').textContent = 'Kurs wird geladen …';
    try {
      const r = await api(`fx?currency=${cur}&date=${f.date.value || me.today}`);
      if (id !== fxReq) return;
      const t = parseNum(f.total.value);
      $('#fxInfo').textContent = r.rate ? `EZB-Kurs ${dt(r.rate_date)}: 1 ${cur} = ${nf(r.rate, 4)} CHF${t ? ` · ≈ ${nf(t * r.rate)} CHF` : ''}` : 'Kein Kurs verfügbar, wird später nachgetragen.';
    } catch { if (id === fxReq) $('#fxInfo').textContent = 'Kurs nicht abrufbar.'; }
  }
  $('#fillupForm').liters.addEventListener('input', () => { recalc(); });
  $('#fillupForm').price_per_l.addEventListener('input', () => { priceSrc = 'ppl'; recalc(); });
  $('#fillupForm').total.addEventListener('input', () => { priceSrc = 'total'; recalc(); });
  $('#fillupForm').total.addEventListener('change', updateFx);
  $('#fillupForm').currency.addEventListener('change', updateFx);
  $('#fillupForm').date.addEventListener('change', updateFx);
  $('#fillupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { vehicle_id: current, date: f.date.value, odometer: parseNum(f.odometer.value), liters: parseNum(f.liters.value), currency: f.currency.value,
      full: f.full.checked, missed: f.missed.checked, station: f.station.value, country: f.country.value, note: f.note.value };
    if (priceSrc === 'total' && f.total.value) body.total = parseNum(f.total.value); else if (f.price_per_l.value) body.price_per_l = parseNum(f.price_per_l.value); else body.total = parseNum(f.total.value);
    body.total_chf = f.currency.value !== 'CHF' && f.total_chf.value ? parseNum(f.total_chf.value) : null;
    try {
      const r = await api(editing ? 'fillups/' + editing.id : 'fillups', { method: editing ? 'PUT' : 'POST', body });
      store.set('currency', body.currency);
      $('#fillupDlg').close();
      await loadVehicles();
      const msg = r.l_100km != null ? `Gespeichert: ${nf(r.l_100km)} l/100km` : 'Gespeichert';
      toast(r.warnings?.length ? msg + '. ' + r.warnings.join(' ') : msg, r.warnings?.length ? 7000 : 3000);
    } catch (err) { $('#fillupErr').textContent = err.message; }
  });
  $('#fillupDelete').onclick = async () => {
    if (!editing || !confirm('Betankung vom ' + dt(editing.date) + ' löschen?')) return;
    try { await api('fillups/' + editing.id, { method: 'DELETE' }); $('#fillupDlg').close(); await loadVehicles(); toast('Gelöscht'); }
    catch (err) { $('#fillupErr').textContent = err.message; }
  };

  // ---------- Fahrzeug ----------
  let editingV = null;
  function openVehicle(v = null) {
    editingV = v; const f = $('#vehicleForm'); f.reset();
    $('#vehicleTitle').textContent = v ? 'Fahrzeug ändern' : 'Neues Fahrzeug';
    $('#vehicleDelete').hidden = !v; $('#vehicleErr').textContent = '';
    f.name.value = v?.name || ''; f.plate.value = v?.plate || ''; f.fuel.value = v?.fuel || 'diesel';
    f.tank_l.value = v?.tank_l ?? ''; f.note.value = v?.note || ''; f.archived.checked = !!v?.archived;
    $('#vehicleDlg').showModal();
  }
  $('#vehicleForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target;
    const body = { name: f.name.value, plate: f.plate.value, fuel: f.fuel.value, tank_l: f.tank_l.value ? parseNum(f.tank_l.value) : null, note: f.note.value, archived: f.archived.checked };
    try {
      const r = await api(editingV ? 'vehicles/' + editingV.id : 'vehicles', { method: editingV ? 'PUT' : 'POST', body });
      if (!editingV) store.set('vehicle', r.id);
      $('#vehicleDlg').close(); await loadVehicles(); toast('Gespeichert');
    } catch (err) { $('#vehicleErr').textContent = err.message; }
  });
  $('#vehicleDelete').onclick = async () => {
    if (!editingV) return;
    if (!confirm(`Fahrzeug «${editingV.name}» mit allen ${editingV.fillups} Betankungen endgültig löschen? (Zum Ausblenden besser archivieren.)`)) return;
    try { await api('vehicles/' + editingV.id, { method: 'DELETE' }); $('#vehicleDlg').close(); await loadVehicles(); toast('Gelöscht'); }
    catch (err) { $('#vehicleErr').textContent = err.message; }
  };

  document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());
  document.querySelectorAll('.tabbar button').forEach(b => b.onclick = () => { tab = b.dataset.tab; render(); });
  $('#vehicleSel').onchange = async (e) => { current = +e.target.value; store.set('vehicle', current); await loadView(); };
  $('#addBtn').onclick = () => openFillup();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && me && !document.querySelector('dialog[open]')) loadVehicles().catch(() => {}); });

  init();
})();
