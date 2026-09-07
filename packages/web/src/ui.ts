import {
  MODE_LABEL,
  MODE_RAIL_ORDER,
  MODE_SHORT,
  MODE_SWATCH,
  PUNCTUALITY,
  formatDelay,
  formatServiceTime,
  punctuality,
} from './palette.js';
import { flatten, search } from './search.js';
import type { LineHit, SearchHit, SearchIndex, StopGroup, StopHit } from './search.js';
import type { AppState, LineFilter } from './state.js';
import type { DataMeta, Departure, Mode, TimetableCoverage, Vehicle, VehicleDetail } from './types.js';

const OSLO_CLOCK = new Intl.DateTimeFormat('nb-NO', {
  timeZone: 'Europe/Oslo',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const PULSE_SAMPLES = 56;
const FLASH_MS = 6000;
const CROSSHAIR = `<svg class="rail__glyph" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.4" stroke="none" /><circle cx="8" cy="8" r="5.6" fill="none" /><path d="M8 0.4v2.2M8 13.4v2.2M0.4 8h2.2M13.4 8h2.2" fill="none" /></svg>`;

export type LocateState = 'idle' | 'busy' | 'active';

export interface Coverage {
  level: TimetableCoverage;
  missing: Mode[];
}

export type DeparturesState =
  | { phase: 'loading' }
  | { phase: 'failed' }
  | { phase: 'ready'; departures: Departure[]; coverage: Coverage };

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

export interface UiCallbacks {
  onToggleMode: (mode: Mode) => void;
  onToggleStops: () => void;
  onToggleNetwork: () => void;
  onToggleLabels: () => void;
  onToggleBuildings: () => void;
  onCloseInspector: () => void;
  onLocate: () => void;
  onPickLine: (hit: LineHit) => void;
  onPickStop: (hit: StopHit) => void;
  onClearLine: () => void;
}

export class Ui {
  private readonly modeButtons = new Map<Mode, HTMLButtonElement>();
  private readonly pulse: Array<{ count: number; delay: number }> = [];
  private tooltip: HTMLDivElement | null = null;
  private toggles: Record<'stops' | 'network' | 'labels' | 'buildings', HTMLButtonElement> | null = null;
  private locateButton: HTMLButtonElement | null = null;
  private flash: HTMLParagraphElement | null = null;
  private flashTimer: number | undefined;
  private searchIndex: SearchIndex | null = null;
  private hits: SearchHit[] = [];
  private activeHit = -1;

  constructor(private readonly callbacks: UiCallbacks) {
    this.buildRail();
    this.buildLegendScale();
    this.buildPulse();
    this.buildSearch();
    el<HTMLButtonElement>('inspector-close').addEventListener('click', () => this.callbacks.onCloseInspector());
    this.startClock();
  }

  private buildRail(): void {
    const rail = el<HTMLElement>('mode-rail');
    for (const mode of MODE_RAIL_ORDER) {
      if (mode === 'other') continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mode';
      button.setAttribute('aria-pressed', 'true');
      button.style.setProperty('--c', MODE_SWATCH[mode]);
      button.innerHTML = `<span class="mode__swatch"></span><span>${MODE_LABEL[mode]}</span><span class="mode__count">–</span>`;
      button.addEventListener('click', () => this.callbacks.onToggleMode(mode));
      rail.appendChild(button);
      this.modeButtons.set(mode, button);
    }

    const divider = document.createElement('div');
    divider.className = 'rail__divider';
    rail.appendChild(divider);

    const makeToggle = (label: string, onClick: () => void): HTMLButtonElement => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'rail__toggle';
      button.setAttribute('aria-pressed', 'true');
      button.innerHTML = `<span>${label}</span><span class="tick"></span>`;
      button.addEventListener('click', onClick);
      rail.appendChild(button);
      return button;
    };

    this.toggles = {
      network: makeToggle('linjer', () => this.callbacks.onToggleNetwork()),
      stops: makeToggle('stopp', () => this.callbacks.onToggleStops()),
      labels: makeToggle('navn', () => this.callbacks.onToggleLabels()),
      buildings: makeToggle('bygg', () => this.callbacks.onToggleBuildings()),
    };

    const actionDivider = document.createElement('div');
    actionDivider.className = 'rail__divider';
    rail.appendChild(actionDivider);

    const locate = document.createElement('button');
    locate.type = 'button';
    locate.className = 'rail__action';
    locate.dataset.state = 'idle';
    locate.innerHTML = `${CROSSHAIR}<span>min posisjon</span>`;
    locate.addEventListener('click', () => this.callbacks.onLocate());
    rail.appendChild(locate);
    this.locateButton = locate;

    const flash = document.createElement('p');
    flash.className = 'rail__flash';
    flash.setAttribute('role', 'status');
    flash.hidden = true;
    rail.appendChild(flash);
    this.flash = flash;
  }

  private buildLegendScale(): void {
    const list = el<HTMLElement>('legend-scale');
    for (const step of PUNCTUALITY) {
      const item = document.createElement('li');
      item.innerHTML = `<span class="legend__ring" style="--c:${step.hex}"></span>${step.label}`;
      list.appendChild(item);
    }
  }

  private buildPulse(): void {
    const track = el<HTMLElement>('pulse-track');
    for (let i = 0; i < PULSE_SAMPLES; i++) {
      const bar = document.createElement('div');
      bar.className = 'pulse__bar';
      bar.style.setProperty('--h', '2px');
      bar.style.setProperty('--c', '#2a3240');
      track.appendChild(bar);
    }
  }

  private buildSearch(): void {
    const input = el<HTMLInputElement>('search-input');

    input.addEventListener('input', () => this.runSearch());
    input.addEventListener('focus', () => this.runSearch());
    input.addEventListener('blur', () =>
      window.setTimeout(() => {
        if (document.activeElement !== input) this.closeResults();
      }, 120),
    );

    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.moveHit(1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        this.moveHit(-1);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        this.chooseHit(this.activeHit < 0 ? 0 : this.activeHit);
        return;
      }
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (input.value) {
        input.value = '';
        this.runSearch();
        return;
      }
      this.closeResults();
      input.blur();
    });

    window.addEventListener('keydown', (event) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      event.preventDefault();
      input.focus();
      input.select();
    });
  }

  setSearchIndex(index: SearchIndex): void {
    this.searchIndex = index;
  }

  private runSearch(): void {
    const input = el<HTMLInputElement>('search-input');
    const panel = el<HTMLElement>('search-results');
    if (!this.searchIndex || !input.value.trim()) {
      this.hits = [];
      this.activeHit = -1;
      this.closeResults();
      return;
    }

    const results = search(this.searchIndex, input.value);
    this.hits = flatten(results);
    this.activeHit = this.hits.length ? 0 : -1;

    if (!this.hits.length) {
      panel.innerHTML = '<p class="search__empty">ingen treff</p>';
    } else {
      const sections: string[] = [];
      if (results.lines.length) {
        sections.push('<p class="search__group">Linjer</p>');
        sections.push(results.lines.map((hit) => this.lineRow(hit)).join(''));
      }
      if (results.stops.length) {
        sections.push('<p class="search__group">Stopp</p>');
        sections.push(results.stops.map((hit) => this.stopRow(hit)).join(''));
      }
      panel.innerHTML = sections.join('');
      for (const node of panel.querySelectorAll<HTMLButtonElement>('.search__hit')) {
        const at = Number(node.dataset.at);
        node.addEventListener('mousedown', (event) => event.preventDefault());
        node.addEventListener('click', () => this.chooseHit(at));
        node.addEventListener('mouseenter', () => this.highlightHit(at));
      }
    }

    panel.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    this.paintActiveHit();
  }

  private lineRow(hit: LineHit): string {
    const at = this.hits.indexOf(hit);
    return `<button class="search__hit" type="button" role="option" aria-selected="false" data-at="${at}">
      <span class="badge" style="--c:${hit.route.color};--tc:${textOn(hit.route.color)}">${escapeHtml(hit.route.line)}</span>
      <span class="search__hit-name">${escapeHtml(hit.route.name)}</span>
      <span class="search__hit-modes"></span>
    </button>`;
  }

  private stopRow(hit: StopHit): string {
    const at = this.hits.indexOf(hit);
    const primary = hit.group.modes[0] ?? 'other';
    const modes = hit.group.modes.map((m) => MODE_SHORT[m]).join('·');
    return `<button class="search__hit" type="button" role="option" aria-selected="false" data-at="${at}">
      <span class="search__node" style="--c:${MODE_SWATCH[primary]}"></span>
      <span class="search__hit-name">${escapeHtml(hit.group.name)}</span>
      <span class="search__hit-modes">${escapeHtml(modes)}</span>
    </button>`;
  }

  private moveHit(delta: number): void {
    if (!this.hits.length) return;
    const count = this.hits.length;
    this.activeHit = (((this.activeHit < 0 ? 0 : this.activeHit + delta) % count) + count) % count;
    this.paintActiveHit();
  }

  private highlightHit(at: number): void {
    this.activeHit = at;
    this.paintActiveHit();
  }

  private paintActiveHit(): void {
    const nodes = el<HTMLElement>('search-results').querySelectorAll<HTMLElement>('.search__hit');
    nodes.forEach((node, i) => {
      const on = i === this.activeHit;
      node.setAttribute('aria-selected', String(on));
      if (on) node.scrollIntoView({ block: 'nearest' });
    });
  }

  private chooseHit(at: number): void {
    const hit = this.hits[at];
    if (!hit) return;
    const input = el<HTMLInputElement>('search-input');
    input.value = hit.kind === 'line' ? `${hit.route.line} ${hit.route.name}` : hit.group.name;
    input.blur();
    this.closeResults();
    if (hit.kind === 'line') this.callbacks.onPickLine(hit);
    else this.callbacks.onPickStop(hit);
  }

  private closeResults(): void {
    const panel = el<HTMLElement>('search-results');
    panel.hidden = true;
    panel.innerHTML = '';
    el<HTMLInputElement>('search-input').setAttribute('aria-expanded', 'false');
  }

  setLineFilter(filter: LineFilter | null): void {
    const node = el<HTMLElement>('search-filter');
    if (!filter) {
      node.hidden = true;
      node.innerHTML = '';
      return;
    }
    node.style.setProperty('--c', filter.route.color);
    node.innerHTML = `<span>viser <b>linje ${escapeHtml(filter.route.line)}</b></span>
      <button class="search__filter-clear" type="button">vis alle</button>`;
    node.querySelector('button')?.addEventListener('click', () => this.callbacks.onClearLine());
    node.hidden = false;
  }

  clearSearchQuery(): void {
    el<HTMLInputElement>('search-input').value = '';
  }

  setLocateState(state: LocateState): void {
    if (this.locateButton) this.locateButton.dataset.state = state;
  }

  setFlash(message: string | null): void {
    if (!this.flash) return;
    if (this.flashTimer !== undefined) clearTimeout(this.flashTimer);
    if (!message) {
      this.flash.hidden = true;
      this.flash.textContent = '';
      return;
    }
    this.flash.textContent = message;
    this.flash.hidden = false;
    this.flashTimer = window.setTimeout(() => this.setFlash(null), FLASH_MS);
  }

  private startClock(): void {
    const clock = el<HTMLElement>('clock');
    const paint = () => {
      clock.textContent = OSLO_CLOCK.format(new Date());
    };
    paint();
    setInterval(paint, 1000);
  }

  setMeta(meta: DataMeta): void {
    el<HTMLElement>('masthead-sub').textContent = `sanntid · ${meta.counts.routes} linjer · ${meta.serviceDate.slice(6, 8)}.${meta.serviceDate.slice(4, 6)}.${meta.serviceDate.slice(0, 4)}`;
    el<HTMLElement>('legend-note').textContent =
      'Ikonet viser transportmiddel, kanten viser presisjon og pilen viser retning. Zoom inn for kjøretøy i virkelig størrelse.';
  }

  setConnection(state: 'connecting' | 'live' | 'lost'): void {
    const node = el<HTMLElement>('conn');
    const label = el<HTMLElement>('conn-label');
    node.dataset.state = state;
    label.textContent = state === 'live' ? 'sanntid aktiv' : state === 'connecting' ? 'kobler til' : 'mistet signal';
  }

  syncState(state: AppState): void {
    for (const [mode, button] of this.modeButtons) {
      button.setAttribute('aria-pressed', String(state.modes.has(mode)));
    }
    if (this.toggles) {
      this.toggles.network.setAttribute('aria-pressed', String(state.showNetwork));
      this.toggles.stops.setAttribute('aria-pressed', String(state.showStops));
      this.toggles.labels.setAttribute('aria-pressed', String(state.showLabels));
      this.toggles.buildings.setAttribute('aria-pressed', String(state.showBuildings));
    }
  }

  setStats(vehicles: Vehicle[]): void {
    const byMode = new Map<Mode, number>();
    let gps = 0;
    let rt = 0;
    let delaySum = 0;
    let delayCount = 0;

    for (const v of vehicles) {
      byMode.set(v.mode, (byMode.get(v.mode) ?? 0) + 1);
      if (v.source === 'gps') gps++;
      if (v.source === 'rt') rt++;
      if (v.source !== 'sched') {
        delaySum += v.delay;
        delayCount++;
      }
    }

    for (const [mode, button] of this.modeButtons) {
      const count = byMode.get(mode) ?? 0;
      const node = button.querySelector('.mode__count');
      if (node) node.textContent = String(count);
    }

    const avgDelay = delayCount ? delaySum / delayCount : 0;
    el<HTMLElement>('stat-active').textContent = String(vehicles.length);
    el<HTMLElement>('stat-gps').textContent = String(gps);
    el<HTMLElement>('stat-rt').textContent = String(rt);
    const delayNode = el<HTMLElement>('stat-delay');
    delayNode.textContent = delayCount ? formatDelay(avgDelay) : '–';
    delayNode.style.color = punctuality(avgDelay).hex;

    this.pushPulse(vehicles.length, avgDelay);
  }

  private pushPulse(count: number, delay: number): void {
    this.pulse.push({ count, delay });
    while (this.pulse.length > PULSE_SAMPLES) this.pulse.shift();

    const track = el<HTMLElement>('pulse-track');
    const bars = track.children;
    const max = Math.max(60, ...this.pulse.map((p) => p.count));
    const offset = PULSE_SAMPLES - this.pulse.length;

    for (let i = 0; i < PULSE_SAMPLES; i++) {
      const bar = bars[i] as HTMLElement | undefined;
      if (!bar) continue;
      const sample = i >= offset ? this.pulse[i - offset] : undefined;
      if (!sample) {
        bar.style.setProperty('--h', '2px');
        bar.style.setProperty('--c', '#222933');
        continue;
      }
      const height = Math.max(2, Math.round((sample.count / max) * 30));
      bar.style.setProperty('--h', `${height}px`);
      bar.style.setProperty('--c', punctuality(sample.delay).hex);
    }

    el<HTMLElement>('pulse-total').textContent = `${count} kjøretøy`;
  }

  showTooltip(vehicle: Vehicle, x: number, y: number): void {
    if (!this.tooltip) {
      this.tooltip = document.createElement('div');
      this.tooltip.className = 'tooltip';
      document.body.appendChild(this.tooltip);
    }
    const p = punctuality(vehicle.delay);
    this.tooltip.style.setProperty('--c', vehicle.color);
    this.tooltip.style.left = `${x}px`;
    this.tooltip.style.top = `${y}px`;
    this.tooltip.innerHTML = `<b>${escapeHtml(vehicle.line)}</b> ${escapeHtml(vehicle.headsign)} <span style="color:${p.hex}">${formatDelay(vehicle.delay)}</span>`;
    this.tooltip.hidden = false;
  }

  hideTooltip(): void {
    if (this.tooltip) this.tooltip.hidden = true;
  }

  renderInspector(detail: VehicleDetail, nowSec: number): void {
    const panel = el<HTMLElement>('inspector');
    const body = el<HTMLElement>('inspector-body');
    const v = detail.vehicle;
    const p = punctuality(v.delay);
    const isGps = v.source === 'gps';

    const nextIdx = detail.calls.findIndex((c) => c.arrival + v.delay >= nowSec);
    const window = detail.calls.slice(Math.max(0, nextIdx - 2), nextIdx < 0 ? 0 : nextIdx + 7);

    body.innerHTML = `
      <div class="veh">
        <span class="veh__badge" style="--c:${v.color};--tc:${textOn(v.color)}">${escapeHtml(v.line || '·')}</span>
        <div>
          <div class="veh__mode">${MODE_LABEL[v.mode] ?? v.mode}${v.atStop ? ' · på stopp' : ''}</div>
          <p class="veh__head">${escapeHtml(v.headsign || 'ukjent destinasjon')}</p>
        </div>
      </div>
      <div class="veh__meta">
        <span class="veh__delay" style="--c:${p.hex}">${formatDelay(v.delay)}</span>
        <span class="veh__delay-label">${p.label}<br />mot rutetabell</span>
      </div>
      <div class="veh__progress"><i style="--p:${(v.progress * 100).toFixed(1)}%;--c:${v.color}"></i></div>
      ${window.length ? `<p class="calls__title">Neste stopp</p><ul class="calls">${window
        .map((call, i) => {
          const absolute = detail.calls.indexOf(call);
          const cls = absolute < nextIdx ? 'call--passed' : absolute === nextIdx ? 'call--next' : '';
          const aimed = formatServiceTime(call.arrival);
          const expected = formatServiceTime(call.arrival + v.delay);
          const shifted = Math.abs(v.delay) >= 60;
          return `<li class="call ${cls}" style="--c:${v.color}">
              <span class="call__node"></span>
              <span>${escapeHtml(call.name)}</span>
              <span class="call__time">${shifted ? `<s>${aimed}</s>` : ''}${expected}</span>
            </li>`;
        })
        .join('')}</ul>` : ''}
      <div class="veh__prov">
        <span class="prov ${isGps ? 'prov--gps' : 'prov--est'}">${isGps ? 'GPS' : 'EST'}</span>
        <span>${
          isGps
            ? 'Faktisk posisjon rapportert fra kjøretøyet via Entur.'
            : 'Beregnet posisjon: rutetabell langs traseen justert for sanntidsavvik. Ruter deler ikke GPS offentlig.'
        }</span>
      </div>
    `;
    panel.hidden = false;
  }

  renderStop(group: StopGroup, state: DeparturesState): void {
    const panel = el<HTMLElement>('inspector');
    const body = el<HTMLElement>('inspector-body');
    const chips = group.modes
      .map((m) => `<span class="stop__mode" style="--c:${MODE_SWATCH[m]}">${MODE_LABEL[m]}</span>`)
      .join('');

    body.innerHTML = `
      <div class="veh__mode">Stoppested</div>
      <p class="veh__head">${escapeHtml(group.name)}</p>
      <div class="stop__modes">${chips}</div>
      <div class="stop__body">${departuresBody(group, state)}</div>
    `;
    panel.hidden = false;
  }

  hideInspector(): void {
    el<HTMLElement>('inspector').hidden = true;
  }

  setBuildingsSupported(supported: boolean): void {
    if (!this.toggles) return;
    this.toggles.buildings.hidden = !supported;
  }

  setBoot(label: string | null): void {
    const boot = el<HTMLElement>('boot');
    if (label === null) {
      boot.hidden = true;
      return;
    }
    el<HTMLElement>('boot-label').textContent = label;
  }
}

function listModes(modes: Mode[]): string {
  const names = modes.map((mode) => MODE_LABEL[mode].toLowerCase());
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} og ${names[names.length - 1]}`;
}

function missingNote(missing: Mode[]): string {
  const named = listModes(missing);
  const lead = named ? `Vi mangler rutetider for ${named} her.` : 'Vi mangler rutetider her.';
  return `<div class="veh__prov">
      <span class="prov prov--missing">MANGLER</span>
      <span>${lead} Datagrunnlaget har bare holdeplasstider fra Ruter, så avganger fra Vy, Flytoget og Brakar mangler.</span>
    </div>`;
}

function departuresBody(group: StopGroup, state: DeparturesState): string {
  if (state.phase === 'loading') return '<p class="inspector__note">henter avganger&hellip;</p>';
  if (state.phase === 'failed') return '<p class="inspector__note">kunne ikke hente avganger akkurat nå.</p>';

  const note = state.coverage.level === 'full' ? '' : missingNote(state.coverage.missing);
  if (state.coverage.level === 'none') return note;
  if (!state.departures.length) {
    return `<p class="inspector__note">Ingen flere avganger herfra i dag.</p>${note}`;
  }

  const rows = state.departures
    .map((dep) => {
      const p = punctuality(dep.delay);
      const aimed = formatServiceTime(dep.aimed);
      const expected = formatServiceTime(dep.expected);
      const shifted = aimed !== expected;
      const quay = dep.quay && dep.quay !== group.name ? `<p class="dep__quay">${escapeHtml(dep.quay)}</p>` : '';
      return `<li class="dep ${dep.realtime ? '' : 'dep--sched'}">
        <span class="badge" style="--c:${dep.color};--tc:${textOn(dep.color)}">${escapeHtml(dep.line || '·')}</span>
        <span>
          <p class="dep__head">${escapeHtml(dep.headsign || 'ukjent destinasjon')}</p>
          ${quay}
        </span>
        <span class="dep__when">
          <span class="dep__time">${shifted ? `<s>${aimed}</s>` : ''}${expected}</span>
          <span class="dep__delay" style="--c:${p.hex}">${dep.realtime ? formatDelay(dep.delay) : 'rutetid'}</span>
        </span>
      </li>`;
    })
    .join('');

  return `<p class="calls__title">Neste avganger</p><ul class="deps">${rows}</ul>${note}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function textOn(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? '#0b0e13' : '#ffffff';
}
