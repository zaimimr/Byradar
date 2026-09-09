import { escapeHtml, textOn } from './html.js';
import { formatDistance } from './nearby.js';
import { MODE_LABEL, MODE_SHORT, MODE_SWATCH, formatServiceTime } from './palette.js';
import type { Commute, CommuteTarget, PlacePin, PlaceProfile, PlaceStop } from './place.js';
import type { Mode } from './types.js';

const GRADE_COLOR: Record<string, string> = {
  A: '#3FC796',
  B: '#3FC796',
  C: '#58B6DD',
  D: '#E9A63F',
  E: '#E0533C',
  F: '#E0533C',
};

const WEEKDAY_NAME = ['søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag'];
const PULSE_HOURS = 24;
const MAX_STOP_LINES = 5;
const MAX_LEGS = 4;

export type ProfileState =
  | { phase: 'loading' }
  | { phase: 'failed' }
  | { phase: 'ready'; profile: PlaceProfile };

export type CommuteState =
  | { phase: 'loading' }
  | { phase: 'failed' }
  | { phase: 'ready'; commute: Commute };

export interface PlaceView {
  pin: PlacePin;
  profile: ProfileState;
  targets: CommuteTarget[];
  commutes: Map<string, CommuteState>;
}

function gradeColor(grade: string): string {
  return GRADE_COLOR[grade] ?? '#8892A6';
}

function dateWords(serviceDate: string, weekday: number): string {
  const day = Number(serviceDate.slice(6, 8));
  const month = Number(serviceDate.slice(4, 6));
  return `${WEEKDAY_NAME[weekday] ?? ''} ${day}.${month}.`.trim();
}

function scoreBars(profile: PlaceProfile): string {
  const rows = profile.score.parts
    .map((part) => {
      const share = Math.max(0, Math.min(1, part.score / part.max));
      return `<li class="place__bar-row">
        <span class="place__bar-label">${escapeHtml(part.label)}</span>
        <span class="place__bar"><i style="--p:${(share * 100).toFixed(0)}%"></i></span>
        <span class="place__bar-val">${Math.round(part.score)}<s>/${part.max}</s></span>
      </li>`;
    })
    .join('');
  return `<ul class="place__bars">${rows}</ul>`;
}

function scoreNotes(profile: PlaceProfile): string {
  const items = profile.score.parts
    .map(
      (part) =>
        `<li><b>${escapeHtml(part.label)}</b> ${escapeHtml(part.note)}</li>`,
    )
    .join('');
  return `<details class="place__why">
    <summary>hva ligger bak tallet</summary>
    <ul class="place__why-list">${items}</ul>
  </details>`;
}

function legBadges(commute: Commute): string {
  const rides = commute.legs.filter((leg) => leg.mode !== 'foot').slice(0, MAX_LEGS);
  if (!rides.length) return '<span class="place__trip-walk">hele veien til fots</span>';
  return rides
    .map(
      (leg) =>
        `<span class="badge badge--slim" style="--c:${leg.color};--tc:${textOn(leg.color)}">${escapeHtml(
          leg.line || MODE_SHORT[leg.mode as Mode] || '·',
        )}</span>`,
    )
    .join('<span class="place__trip-arrow">→</span>');
}

function tripRow(target: CommuteTarget, state: CommuteState | undefined): string {
  const name = escapeHtml(target.name);
  if (!state || state.phase === 'loading') {
    return `<li class="place__trip place__trip--waiting">
      <span class="place__trip-to">${name}</span>
      <span class="place__trip-note">regner ut&hellip;</span>
    </li>`;
  }
  if (state.phase === 'failed') {
    return `<li class="place__trip place__trip--waiting">
      <span class="place__trip-to">${name}</span>
      <span class="place__trip-note">ingen reise funnet</span>
    </li>`;
  }
  const trip = state.commute;
  const shifts = trip.transfers === 0 ? 'uten bytte' : trip.transfers === 1 ? '1 bytte' : `${trip.transfers} bytter`;
  return `<li class="place__trip">
    <span class="place__trip-to">${name}</span>
    <span class="place__trip-time">${trip.minutes} min</span>
    <span class="place__trip-meta">${shifts} · ${trip.walkMin} min gange</span>
    <span class="place__trip-legs">${legBadges(trip)}</span>
  </li>`;
}

function stopRow(stop: PlaceStop, at: number): string {
  const badges = stop.lines
    .slice(0, MAX_STOP_LINES)
    .map(
      (line) =>
        `<span class="badge badge--slim" style="--c:${line.color};--tc:${textOn(line.color)}">${escapeHtml(
          line.line || '·',
        )}</span>`,
    )
    .join('');
  const rest = stop.lines.length > MAX_STOP_LINES ? `<span class="place__stop-more">+${stop.lines.length - MAX_STOP_LINES}</span>` : '';
  const rate =
    stop.timetable === 'none'
      ? '<span class="place__stop-rate place__stop-rate--missing">mangler rutetider</span>'
      : `<span class="place__stop-rate">${stop.perHour.toFixed(0)} avg/t</span>`;
  const modes = stop.modes.map((mode) => MODE_SHORT[mode]).join('·');
  return `<li>
    <button class="near place__stop" type="button" data-stop="${escapeHtml(stop.id)}" data-at="${at}">
      <span class="near__head">
        <span class="near__name">${escapeHtml(stop.name)}</span>
        <span class="near__walk">${stop.walkMin} min · ${formatDistance(stop.metres)}</span>
      </span>
      <span class="place__stop-meta">
        <span class="near__modes">${escapeHtml(modes)}</span>
        ${rate}
      </span>
      <span class="place__stop-lines">${badges}${rest}</span>
    </button>
  </li>`;
}

function dayPulse(hourly: number[]): string {
  const max = Math.max(1, ...hourly);
  const bars = Array.from({ length: PULSE_HOURS }, (_, hour) => {
    const value = hourly[hour] ?? 0;
    const height = Math.max(2, Math.round((value / max) * 26));
    const dim = hour < 6 || hour >= 23 ? ' place__hour--night' : '';
    return `<i class="place__hour${dim}" style="--h:${height}px" title="kl. ${String(hour).padStart(2, '0')}: ${value} avganger"></i>`;
  }).join('');
  return `<div class="place__day">
    <div class="place__day-track">${bars}</div>
    <div class="place__day-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
  </div>`;
}

function coverageNote(profile: PlaceProfile): string {
  if (profile.coverage.level === 'full') return '';
  const named = profile.coverage.missing.map((mode) => MODE_LABEL[mode].toLowerCase()).join(' og ');
  return `<div class="veh__prov">
    <span class="prov prov--missing">MANGLER</span>
    <span>Rutetidene her dekker Ruter. ${
      named ? `Avganger for ${named} er ikke tellet med i tallene` : 'Noen avganger er ikke tellet med'
    }, så tilbudet er i praksis bedre enn poengsummen viser.</span>
  </div>`;
}

function summaryLine(profile: PlaceProfile): string {
  const modes = profile.summary.modes.map((mode) => MODE_LABEL[mode].toLowerCase()).join(', ');
  const rail =
    profile.summary.railMode && profile.summary.railWalkMin !== null
      ? `${MODE_LABEL[profile.summary.railMode].toLowerCase()} ${profile.summary.railWalkMin} min unna`
      : 'ingen skinnegang i gangavstand';
  const last = profile.summary.lastDep === null ? null : formatServiceTime(profile.summary.lastDep);
  return `<p class="place__facts">
    ${profile.summary.lines} linjer${modes ? ` (${escapeHtml(modes)})` : ''} · ${rail}${
      last ? ` · siste avgang ${last}` : ''
    }
  </p>`;
}

export function placeBody(view: PlaceView): string {
  const head = `
    <div class="veh__mode">Boligsjekk</div>
    <p class="veh__head">${escapeHtml(view.pin.label)}</p>
    ${view.pin.detail ? `<p class="place__where">${escapeHtml(view.pin.detail)}</p>` : ''}
  `;

  if (view.profile.phase === 'loading') {
    return `${head}<p class="inspector__note">regner ut kollektivtilbudet&hellip;</p>`;
  }
  if (view.profile.phase === 'failed') {
    return `${head}<p class="inspector__note">Fikk ikke hentet kollektivtilbudet for dette punktet. Ligger det innenfor kartutsnittet for Oslo?</p>`;
  }

  const profile = view.profile.profile;
  const colour = gradeColor(profile.score.grade);
  const trips = view.targets.map((target) => tripRow(target, view.commutes.get(target.id))).join('');
  const stops = profile.stops.map((stop, at) => stopRow(stop, at)).join('');

  return `${head}
    <div class="place__score" style="--c:${colour}">
      <span class="place__grade">${escapeHtml(profile.score.grade)}</span>
      <span class="place__total"><b>${profile.score.total}</b><s>/100</s></span>
      <span class="place__verdict">${escapeHtml(profile.score.label)}<em>i nabolaget</em></span>
    </div>
    ${summaryLine(profile)}
    ${scoreBars(profile)}
    ${scoreNotes(profile)}
    <p class="calls__title">Reisetid kl. 08 på hverdag</p>
    <ul class="place__trips">${trips}</ul>
    <div class="place__dest">
      <input
        class="place__dest-input"
        id="place-dest"
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder="legg til jobb, skole, stopp"
        aria-label="Legg til et stopp du vil se reisetid til"
      />
      <div class="place__dest-results" id="place-dest-results" hidden></div>
    </div>
    <p class="calls__title">Stopp i nærheten</p>
    ${stops ? `<ul class="nears">${stops}</ul>` : '<p class="inspector__note">Ingen stopp innen 1,2 km.</p>'}
    <p class="calls__title">Avganger gjennom døgnet</p>
    ${dayPulse(profile.hourly)}
    <p class="inspector__note">
      Tallene er tellet fra rutetabellen for ${escapeHtml(dateWords(profile.serviceDate, profile.weekday))} og gjelder
      per linje og retning innen ti minutters gange. Reisetidene kommer fra Enturs reiseplanlegger.
    </p>
    ${coverageNote(profile)}
  `;
}
