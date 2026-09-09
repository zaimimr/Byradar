import './analytics.js';

import { API_URL } from './endpoints.js';

const MESSAGE_MAX = 2000;
const MESSAGE_MIN = 4;
const VIEW_MAX = 240;
const VIEW_SHAPE = /^[A-Za-z0-9=&,.:_%+-]*$/;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

const form = el<HTMLFormElement>('form');
const message = el<HTMLTextAreaElement>('message');
const place = el<HTMLInputElement>('place');
const contact = el<HTMLInputElement>('contact');
const trap = el<HTMLInputElement>('nettsted');
const send = el<HTMLButtonElement>('send');
const status = el<HTMLParagraphElement>('status');
const count = el<HTMLSpanElement>('count');
const note = el<HTMLParagraphElement>('note');
const ctx = el<HTMLDivElement>('ctx');
const ctxLink = el<HTMLAnchorElement>('ctx-link');
const ctxDrop = el<HTMLButtonElement>('ctx-drop');

function readView(): string {
  const raw = new URLSearchParams(location.search).get('kart') ?? '';
  const view = raw.replace(/^#/, '').slice(0, VIEW_MAX);
  if (!view || !VIEW_SHAPE.test(view) || !view.includes('lat=')) return '';
  return view;
}

let view = readView();

if (view) {
  ctxLink.href = `/#${view}`;
  ctx.hidden = false;
}

ctxDrop.addEventListener('click', () => {
  view = '';
  ctx.hidden = true;
  message.focus();
});

function renderCount(): void {
  count.textContent = `${message.value.length} / ${MESSAGE_MAX}`;
}

message.addEventListener('input', () => {
  renderCount();
  if (status.dataset.state === 'error') {
    status.dataset.state = '';
    status.textContent = '';
  }
});

renderCount();

function kindValue(): string {
  const picked = form.querySelector<HTMLInputElement>('input[name="kind"]:checked');
  return picked?.value ?? 'annet';
}

function fail(text: string): void {
  status.dataset.state = 'error';
  status.textContent = text;
}

function done(): void {
  form.hidden = true;
  note.hidden = true;
  ctx.hidden = true;
  const panel = document.createElement('div');
  panel.className = 'sent';
  panel.innerHTML = `
    <p class="sent__lede">Takk. Det ligger nå hos meg.</p>
    <p>Jeg leser alt som kommer inn, men rekker ikke å svare på alt. Ga du e-post, hører du fra meg om jeg trenger mer.</p>
    <div class="sent__row">
      <a class="sent__link" href="/">Tilbake til kartet</a>
      <button class="sent__again" type="button">Send en til</button>
    </div>
  `;
  form.insertAdjacentElement('afterend', panel);
  panel.querySelector('.sent__again')?.addEventListener('click', () => {
    panel.remove();
    form.reset();
    form.hidden = false;
    note.hidden = false;
    status.dataset.state = '';
    status.textContent = '';
    renderCount();
    message.focus();
  });
}

async function submit(): Promise<void> {
  const text = message.value.trim();
  if (text.length < MESSAGE_MIN) {
    fail('Skriv noen ord om hva som skjedde.');
    message.focus();
    return;
  }
  if (contact.value.trim() && !contact.checkValidity()) {
    fail('E-postadressen ser ikke riktig ut. Du kan også la den stå tom.');
    contact.focus();
    return;
  }

  send.disabled = true;
  status.dataset.state = 'busy';
  status.textContent = 'Sender …';

  const body = {
    kind: kindValue(),
    message: text,
    place: place.value.trim(),
    contact: contact.value.trim(),
    view,
    nettsted: trap.value,
  };

  try {
    const res = await fetch(`${API_URL}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      status.dataset.state = '';
      status.textContent = '';
      done();
      return;
    }
    if (res.status === 429) {
      fail('Du har sendt inn flere nå nettopp. Prøv igjen om noen minutter.');
    } else if (res.status === 400) {
      fail('Serveren tok ikke imot skjemaet. Prøv å korte ned teksten.');
    } else {
      fail('Fikk det ikke sendt. Prøv igjen senere, eller send meg en e-post via zaim.no.');
    }
  } catch {
    fail('Ingen forbindelse. Sjekk nettet og prøv igjen.');
  } finally {
    send.disabled = false;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void submit();
});
