'use strict';
// Verbrauchsberechnung nach der Volltank-Methode:
// Der Verbrauch wird nur zwischen zwei Volltankungen gemessen. Alle Liter, die nach der ersten
// Volltankung bis und mit der nächsten getankt wurden (Teilbetankungen eingeschlossen), geteilt durch
// die Kilometer dazwischen. Die erste Betankung bzw. alles vor der ersten Volltankung ist nur Startpunkt.
// "missed" (eine Betankung fehlt davor) bricht die Messung ab; ab einer Volltankung wird neu gemessen.

const r2 = (n) => n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;
const r3 = (n) => n == null || !Number.isFinite(n) ? null : Math.round(n * 1000) / 1000;

// rows: Betankungen eines Fahrzeugs, sortiert nach Kilometerstand
function analyze(rows) {
  let base = null, accL = 0, accChf = 0, accChfOk = true, prevOdo = null;
  return rows.map((f) => {
    const out = {
      id: f.id, date: f.date, odometer: f.odometer, liters: f.liters, price_per_l: f.price_per_l, total: f.total, currency: f.currency,
      fx_rate: f.fx_rate, fx_date: f.fx_date, fx_source: f.fx_source, total_chf: f.total_chf,
      price_per_l_chf: f.total_chf != null ? r3(f.total_chf / f.liters) : null,
      full: !!f.full, missed: !!f.missed, station: f.station || '', country: f.country || '', note: f.note || '',
      km_since_prev: prevOdo == null ? null : r2(f.odometer - prevOdo),
      l_100km: null, segment_km: null, segment_liters: null, segment_chf: null, chf_per_100km: null, status: null,
    };
    prevOdo = f.odometer;
    if (f.missed) { base = null; accL = 0; accChf = 0; accChfOk = true; }
    if (base === null) {
      out.status = f.missed ? 'neu_gemessen' : 'start';
      if (f.full) { base = f.odometer; accL = 0; accChf = 0; accChfOk = true; }
      return out;
    }
    accL += f.liters;
    if (f.total_chf != null) accChf += f.total_chf; else accChfOk = false;
    if (!f.full) { out.status = 'teil'; return out; }
    const km = f.odometer - base;
    if (km > 0) {
      out.segment_km = r2(km); out.segment_liters = r2(accL);
      out.l_100km = r2(accL / km * 100);
      if (accChfOk) { out.segment_chf = r2(accChf); out.chf_per_100km = r2(accChf / km * 100); }
      out.status = 'gemessen';
    } else out.status = 'ungueltig';
    base = f.odometer; accL = 0; accChf = 0; accChfOk = true;
    return out;
  });
}

const inRange = (d, from, to) => (!from || d >= from) && (!to || d <= to);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

// Kennzahlen; from/to beschränken auf Betankungen in diesem Zeitraum (Messstrecken nach ihrem Enddatum)
function summary(res, { from, to } = {}) {
  from = isDate(from) ? from : null; to = isDate(to) ? to : null;
  const list = res.filter(f => inRange(f.date, from, to));
  const seg = list.filter(f => f.l_100km != null);
  const segKm = seg.reduce((a, f) => a + f.segment_km, 0), segL = seg.reduce((a, f) => a + f.segment_liters, 0);
  const segC = seg.filter(f => f.segment_chf != null), segCKm = segC.reduce((a, f) => a + f.segment_km, 0), segCChf = segC.reduce((a, f) => a + f.segment_chf, 0);
  const liters = list.reduce((a, f) => a + f.liters, 0);
  const chfKnown = list.filter(f => f.total_chf != null);
  const chf = chfKnown.reduce((a, f) => a + f.total_chf, 0);
  const odos = list.map(f => f.odometer);
  const driven = odos.length > 1 ? Math.max(...odos) - Math.min(...odos) : 0;
  const values = seg.map(f => f.l_100km);
  const last = res.length ? res[res.length - 1] : null;
  const lastSeg = [...res].reverse().find(f => f.l_100km != null);

  const group = (keyFn) => {
    const m = new Map();
    for (const f of list) {
      const k = keyFn(f.date);
      const g = m.get(k) || { period: k, fillups: 0, liters: 0, chf: 0, chf_missing: 0, seg_km: 0, seg_l: 0 };
      g.fillups++; g.liters += f.liters;
      if (f.total_chf != null) g.chf += f.total_chf; else g.chf_missing++;
      if (f.l_100km != null) { g.seg_km += f.segment_km; g.seg_l += f.segment_liters; }
      m.set(k, g);
    }
    // gefahrene km pro Periode aus der Differenz der Kilometerstände zur letzten Betankung davor
    const sorted = [...res].sort((a, b) => a.date.localeCompare(b.date) || a.odometer - b.odometer);
    for (const g of m.values()) {
      const inP = sorted.filter(f => keyFn(f.date) === g.period);
      const prev = sorted.filter(f => keyFn(f.date) < g.period).pop();
      const start = prev ? prev.odometer : (inP[0]?.odometer ?? 0);
      g.km = r2(Math.max(0, Math.max(...inP.map(f => f.odometer)) - start));
    }
    return [...m.values()].sort((a, b) => a.period.localeCompare(b.period)).map(g => ({
      period: g.period, fillups: g.fillups, liters: r2(g.liters), chf: r2(g.chf), chf_incomplete: g.chf_missing > 0, km: g.km,
      l_100km: g.seg_km > 0 ? r2(g.seg_l / g.seg_km * 100) : null,
    }));
  };

  return {
    from, to,
    fillups: list.length,
    first_date: list[0]?.date || null, last_date: list.length ? list[list.length - 1].date : null,
    last_odometer: last ? last.odometer : null,
    km_driven: r2(driven),
    total_liters: r2(liters),
    total_chf: r2(chf), chf_incomplete: chfKnown.length < list.length,
    avg_price_per_l_chf: chfKnown.length ? r3(chf / chfKnown.reduce((a, f) => a + f.liters, 0)) : null,
    avg_l_100km: segKm > 0 ? r2(segL / segKm * 100) : null,
    measured_km: r2(segKm),
    last_l_100km: lastSeg ? lastSeg.l_100km : null,
    best_l_100km: values.length ? Math.min(...values) : null,
    worst_l_100km: values.length ? Math.max(...values) : null,
    chf_per_100km: segCKm > 0 ? r2(segCChf / segCKm * 100) : null,
    chf_per_km: segCKm > 0 ? r3(segCChf / segCKm) : null,
    by_month: group(d => d.slice(0, 7)),
    by_year: group(d => d.slice(0, 4)),
    series: seg.map(f => ({ date: f.date, l_100km: f.l_100km })),
  };
}

module.exports = { analyze, summary };
