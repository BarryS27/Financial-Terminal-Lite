'use strict';
// pages/webtime.js — Web Time report page

import { $, send, esc, formatDuration } from './shared.js';

let _summary = null;
let _range   = 'today';

function domainColor(host) {
  let hash = 0;
  for (let i = 0; i < host.length; i++) hash = (hash * 31 + host.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return `oklch(62% 0.13 ${hue})`;
}

function weekdayLabel(day) {
  const d = new Date(day + 'T00:00:00');
  return d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 2);
}

async function load() {
  const res = await send('webtime:get-summary');
  if (!res?.ok) return;
  _summary = res;
  render();
}

function listForRange() {
  if (!_summary) return { list: [], total: 0, label: '' };
  if (_range === 'today')   return { list: _summary.today,      total: _summary.totals.todaySeconds,   label: 'Active time today' };
  if (_range === 'week')    return { list: _summary.week,       total: _summary.totals.weekSeconds,    label: 'Active time this week' };
  return                           { list: _summary.topAlltime, total: _summary.totals.alltimeSeconds, label: 'Active time all time' };
}

function render() {
  if (!_summary) return;
  const { list, total, label } = listForRange();

  $('wt-hero-value').textContent = total > 0 ? formatDuration(total) : '0m';
  $('wt-hero-label').textContent = label;

  renderChart();

  const listEl  = $('wt-list');
  const emptyEl = $('wt-empty');
  if (!list.length) {
    listEl.style.display = 'none';
    emptyEl.style.display = '';
  } else {
    listEl.style.display = '';
    emptyEl.style.display = 'none';
    const max = list[0]?.seconds || 1;
    listEl.innerHTML = list.map((d, i) => `
      <div class="wt-row">
        <div class="wt-row-rank">${i + 1}</div>
        <div class="wt-row-dot" style="background:${domainColor(d.domain)}">${esc((d.domain[0] || '?').toUpperCase())}</div>
        <div class="wt-row-domain">${esc(d.domain)}</div>
        <div class="wt-row-bar-track"><div class="wt-row-bar-fill" style="width:${Math.max(3, d.seconds / max * 100)}%"></div></div>
        <div class="wt-row-time">${formatDuration(d.seconds)}</div>
      </div>`).join('');
  }

  $('wt-since').textContent = _summary.dateStart ? `Tracking since ${_summary.dateStart}` : '';
}

function renderChart() {
  const chart = _summary.chart || [];
  const max = Math.max(1, ...chart.map(c => c.seconds));
  const today = chart[chart.length - 1]?.day;
  $('wt-chart').innerHTML = chart.map(c => {
    const pct = Math.max(2, Math.round(c.seconds / max * 100));
    const isToday = c.day === today;
    return `
      <div class="wt-chart-col" title="${esc(c.day)}: ${esc(formatDuration(c.seconds))}">
        <div class="wt-chart-bar-wrap"><div class="wt-chart-bar${isToday ? ' today' : ''}" style="height:${pct}%"></div></div>
        <div class="wt-chart-label">${esc(weekdayLabel(c.day))}</div>
      </div>`;
  }).join('');
}

document.querySelectorAll('.range-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.range-btn').forEach(b => b.classList.toggle('active', b === btn));
    _range = btn.dataset.range;
    render();
  });
});

$('clear-btn').addEventListener('click', async () => {
  const scope = _range === 'today' ? 'today' : 'all';
  const label = scope === 'today' ? "today's" : 'all';
  if (!confirm(`Clear ${label} Web Time data? This can't be undone.`)) return;
  await send('webtime:clear-data', { scope });
  load();
});

load();
