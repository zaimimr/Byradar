import {
  MODE_LABEL,
  MODE_RAIL_ORDER,
  MODE_SWATCH,
  PUNCTUALITY,
  formatDelay,
  formatServiceTime,
  punctuality,
} from './palette.js';
import type { AppState } from './state.js';
import type { DataMeta, Mode, Vehicle, VehicleDetail } from './types.js';

const OSLO_CLOCK = new Intl.DateTimeFormat('nb-NO', {
  timeZone: 'Europe/Oslo',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const PULSE_SAMPLES = 56;

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
}

export class Ui {
  private readonly modeButtons = new Map<Mode, HTMLButtonElement>();
  private readonly pulse: Array<{ count: number; delay: number }> = [];
  private tooltip: HTMLDivElement | null = null;
  private toggles: Record<'stops' | 'network' | 'labels' | 'buildings', HTMLButtonElement> | null = null;

  constructor(private readonly callbacks: UiCallbacks) {
    this.buildRail();
    this.buildLegendScale();
    this.buildPulse();
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
