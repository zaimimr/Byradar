import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB = resolve(HERE, '..');
const DATA = resolve(HERE, '../../../data/server');

const HUBS_PER_CITY = 6;

const CITIES = [
  {
    slug: 'oslo',
    name: 'Oslo',
    title: 'Sanntidskart for T-bane, trikk og buss i Oslo',
    description:
      'Se T-banen, trikken, bussene, båtene og togene i Oslo bevege seg i sanntid. Avganger fra stoppet nærmest deg, og boligsjekk av kollektivtilbudet på en adresse.',
    view: { lon: 10.7522, lat: 59.9139, zoom: 12.4 },
    radiusKm: 12,
    operator: 'Ruter',
    lede:
      'Byradar tegner hele Ruter-nettet mens det kjører: T-bane, trikk, buss og båt, med togene fra Vy, Flytoget og Go-Ahead oppå. Klikk et kjøretøy for å se hvor det er på ruta, eller et stopp for avgangene de neste minuttene.',
    live:
      'Ruter deler ingen posisjoner offentlig. Kjøretøyene i Oslo er derfor beregnet: Byradar tar rutetabellen, legger på forsinkelsen sanntidsfeeden melder, og plasserer vognen der den da burde være langs traseen. Togene har ekte GPS, så de flytter seg slik de faktisk kjører.',
    extra:
      'Nettet i Oslo er tettest rundt Jernbanetorget, Nationaltheatret og Majorstuen. Zoomer du inn forbi gatenivå, tegnes kjøretøyene i virkelig lengde, så en leddbuss er lengre enn en vanlig.',
  },
  {
    slug: 'bergen',
    name: 'Bergen',
    title: 'Sanntidskart for Bybanen og bussene i Bergen',
    description:
      'Følg Bybanen, bussene og båtene i Bergen i sanntid, med ekte GPS fra Skyss. Avganger fra stoppene rundt deg, og boligsjekk av kollektivtilbudet på en adresse.',
    view: { lon: 5.3255, lat: 60.3913, zoom: 12.4 },
    radiusKm: 10,
    operator: 'Skyss',
    lede:
      'Byradar viser Skyss sitt nett i Bergen mens det kjører: Bybanen linje 1 og 2, bybussene, regionbussene og hurtigbåtene, pluss togene på Bergensbanen og Vossebanen.',
    live:
      'Skyss deler faktiske posisjoner, så de fleste bussene og bybanevognene i Bergen står der de virkelig er, ikke der ruta sier de burde være. Kjøretøy merket GPS er målt; de få som mangler signal blir beregnet fra rutetabellen og merket EST.',
    extra:
      'Bybanen dominerer kartet fra Byparken sørover mot Flesland og østover mot Fyllingsdalen. Rundt Bergen busstasjon og Åsane terminal ligger bussene så tett at det lønner seg å zoome inn før du klikker.',
  },
  {
    slug: 'trondheim',
    name: 'Trondheim',
    title: 'Sanntidskart for bussene og trikken i Trondheim',
    description:
      'Følg AtB sine busser, Gråkallbanen og båtene i Trondheim i sanntid, med ekte GPS. Avganger fra stoppene rundt deg, og boligsjekk av kollektivtilbudet på en adresse.',
    view: { lon: 10.3951, lat: 63.4305, zoom: 12.4 },
    radiusKm: 10,
    operator: 'AtB',
    lede:
      'Byradar viser AtB sitt nett i Trondheim mens det kjører: metrobussene, de vanlige bybussene, Gråkallbanen opp til Lian, hurtigbåtene ut i fjorden og togene på Dovrebanen og Nordlandsbanen.',
    live:
      'AtB deler faktiske posisjoner, så bussene på kartet er målt og ikke gjettet. Kjøretøy merket GPS kommer rett fra vognen; de som mangler signal beregnes fra rutetabellen og merket EST.',
    extra:
      'Metrobusslinjene 1, 2 og 3 er ryggraden gjennom Midtbyen, og rundt Prinsens gate og Kongens gate krysser nesten alt hverandre. Gråkallbanen er den ene trikkelinjen, og den eneste i verden så langt nord.',
  },
  {
    slug: 'stavanger',
    name: 'Stavanger',
    title: 'Sanntidskart for bussene og toget i Stavanger',
    description:
      'Følg Kolumbus sine busser, hurtigbåtene og Jærbanen i Stavanger og på Nord-Jæren i sanntid. Avganger fra stoppene rundt deg, og boligsjekk på adressenivå.',
    view: { lon: 5.7331, lat: 58.97, zoom: 12.4 },
    radiusKm: 12,
    operator: 'Kolumbus',
    lede:
      'Byradar viser Kolumbus sitt nett i Stavanger, Sandnes og resten av Nord-Jæren mens det kjører: bussveien, bybussene, hurtigbåtene til øyene, og lokaltogene på Jærbanen.',
    live:
      'Kolumbus deler faktiske posisjoner, så bussene på kartet er målt. Kjøretøy merket GPS kommer rett fra vognen; de som mangler signal beregnes fra rutetabellen og merkes EST.',
    extra:
      'Jærbanen går tett nok til å fungere som bybane mellom Stavanger og Sandnes, og hurtigbåtene til Vassøy og Byøyene ligger som egne linjer ut i fjorden.',
  },
  {
    slug: 'kristiansand',
    name: 'Kristiansand',
    title: 'Sanntidskart for bussene i Kristiansand',
    description:
      'Følg AKT sine busser i Kristiansand og på Agder i sanntid, med ekte GPS. Se avganger fra stoppene rundt deg, og sjekk kollektivtilbudet på en adresse.',
    view: { lon: 7.9956, lat: 58.1467, zoom: 12.6 },
    radiusKm: 8,
    operator: 'AKT',
    lede:
      'Byradar viser Agder kollektivtrafikk sitt nett i Kristiansand mens det kjører: bybussene gjennom Kvadraturen, regionbussene langs Sørlandet og togene på Sørlandsbanen.',
    live:
      'AKT deler faktiske posisjoner, så bussene på kartet er målt og ikke gjettet. De få som mangler signal beregnes fra rutetabellen og merkes EST.',
    extra:
      'Kvadraturen er navet: nesten alle bylinjene innom Rådhuset og rutebilstasjonen, og derfra går det utover mot Vågsbygd, Lund og Universitetet.',
  },
  {
    slug: 'tromso',
    name: 'Tromsø',
    title: 'Sanntidskart for bussene i Tromsø',
    description:
      'Følg bussene og hurtigbåtene i Tromsø i sanntid, med ekte GPS fra Troms fylkestrafikk. Avganger fra stoppene rundt deg, og boligsjekk på adressenivå.',
    view: { lon: 18.9553, lat: 69.6492, zoom: 12.6 },
    radiusKm: 8,
    operator: 'Troms fylkestrafikk',
    lede:
      'Byradar viser Troms fylkestrafikk sitt nett i Tromsø mens det kjører: bybussene over broa og gjennom tunnelene, regionbussene, og hurtigbåtene nordover og sørover langs kysten.',
    live:
      'Troms fylkestrafikk deler faktiske posisjoner, så bussene på kartet er målt. Kjøretøy merket GPS kommer rett fra vognen; de som mangler signal beregnes fra rutetabellen og merkes EST.',
    extra:
      'Tromsø har ingen jernbane, så buss og båt er hele kollektivtilbudet. Det gjør kartet enkelt å lese: alt som beveger seg er enten en buss eller en båt.',
  },
  {
    slug: 'drammen',
    name: 'Drammen',
    title: 'Sanntidskart for bussene og toget i Drammen',
    description:
      'Følg Brakar sine busser og togene gjennom Drammen i sanntid. Se avganger fra stoppene rundt deg, og sjekk kollektivtilbudet på en adresse før du legger inn bud.',
    view: { lon: 10.2045, lat: 59.7439, zoom: 12.8 },
    radiusKm: 8,
    operator: 'Brakar',
    lede:
      'Byradar viser Brakar sitt nett i Drammen mens det kjører, sammen med togene som går gjennom byen: lokaltogene mot Oslo og Kongsberg, og fjerntogene videre sør- og vestover.',
    live:
      'Brakar deler faktiske posisjoner for mye av nettet, og togene har ekte GPS. Det som mangler signal, beregnes fra rutetabellen og merkes EST.',
    extra:
      'Drammen stasjon er navet for alt som går på skinner her, og med fire tog i timen mot Oslo er reisetiden til hovedstaden ofte kortere enn fra ytterkantene av Oslo selv. Det slår ut på boligsjekken.',
  },
  {
    slug: 'alesund',
    name: 'Ålesund',
    title: 'Sanntidskart for bussene og hurtigbåtene i Ålesund',
    description:
      'Følg Fram sine busser og hurtigbåtene i Ålesund og Møre og Romsdal i sanntid. Avganger fra stoppene rundt deg, og boligsjekk av kollektivtilbudet på en adresse.',
    view: { lon: 6.1549, lat: 62.4722, zoom: 12.8 },
    radiusKm: 8,
    operator: 'Fram',
    lede:
      'Byradar viser Fram sitt nett i Ålesund mens det kjører: bybussene gjennom sentrum og ut til Moa, regionbussene, og hurtigbåtene og fergene mellom øyene.',
    live:
      'Fram deler faktiske posisjoner, så bussene på kartet er målt. Det som mangler signal, beregnes fra rutetabellen og merkes EST.',
    extra:
      'Uten jernbane er båtene en del av hverdagsnettet her, ikke bare turistruter. På kartet ser du dem krysse fjorden i samme rytme som bussene kjører.',
  },
];

const MODE_PROSE_ORDER = ['bus', 'tram', 'metro', 'rail', 'ferry', 'other'];

const MODE_WORD = {
  metro: 'T-bane',
  tram: 'trikk',
  rail: 'tog',
  bus: 'buss',
  ferry: 'båt',
  other: 'annet',
};

function readJson(name) {
  return JSON.parse(readFileSync(resolve(DATA, name), 'utf8'));
}

function callsPerStopPlace() {
  const stops = readJson('stops.json');
  const quays = readJson('quays.json');
  const trips = readJson('trips-index.json');
  const buf = readFileSync(resolve(DATA, 'trips.bin'));
  const calls = new Int32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);

  const indexById = new Map(stops.map((stop, i) => [stop.id, i]));
  const counts = new Int32Array(stops.length);
  for (const trip of trips) {
    for (let k = 0; k < trip.n; k++) {
      const at = indexById.get(quays.parents[calls[(trip.o + k) * 5 + 4]]);
      if (at !== undefined) counts[at]++;
    }
  }
  return { stops, counts };
}

function hubsFor(city, stops, counts) {
  const cos = Math.cos((city.view.lat * Math.PI) / 180);
  const near = [];
  for (let i = 0; i < stops.length; i++) {
    if (counts[i] === 0) continue;
    const stop = stops[i];
    const dLat = (stop.lat - city.view.lat) * 111;
    const dLon = (stop.lon - city.view.lon) * 111 * cos;
    if (Math.hypot(dLat, dLon) > city.radiusKm) continue;
    near.push({ stop, calls: counts[i] });
  }
  near.sort((a, b) => b.calls - a.calls);

  const seen = new Set();
  const hubs = [];
  for (const entry of near) {
    const key = entry.stop.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hubs.push(entry.stop);
    if (hubs.length === HUBS_PER_CITY) break;
  }
  return { hubs, served: near.length };
}

function modesIn(stops, city) {
  const cos = Math.cos((city.view.lat * Math.PI) / 180);
  const modes = new Set();
  for (const stop of stops) {
    const dLat = (stop.lat - city.view.lat) * 111;
    const dLon = (stop.lon - city.view.lon) * 111 * cos;
    if (Math.hypot(dLat, dLon) > city.radiusKm) continue;
    for (const mode of stop.modes) modes.add(mode);
  }
  return MODE_PROSE_ORDER.filter((mode) => modes.has(mode));
}

function listWords(words) {
  if (words.length < 2) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} og ${words[words.length - 1]}`;
}

function escape(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function mapLink(city, extra = '') {
  const { lon, lat, zoom } = city.view;
  return `/#lon=${lon}&amp;lat=${lat}&amp;z=${zoom}${extra}`;
}

function render(city, facts, others) {
  const url = `https://byradar.no/${city.slug}`;
  const modeWords = facts.modes.map((mode) => MODE_WORD[mode] ?? mode);
  const hubList = facts.hubs
    .map(
      (hub) =>
        `          <li>\n            <a href="/#stop=${encodeURIComponent(hub.id)}">${escape(hub.name)}</a>\n            <span class="doc__muted">${escape(listWords(hub.modes.map((m) => MODE_WORD[m] ?? m)))}</span>\n          </li>`,
    )
    .join('\n');
  const otherList = others
    .map((other) => `<a href="/${other.slug}">${escape(other.name)}</a>`)
    .join(', ');

  return `<!doctype html>
<html lang="nb" class="doc-page">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escape(city.title)} · Byradar</title>
    <meta name="description" content="${escape(city.description)}" />
    <link rel="canonical" href="${url}" />
    <meta name="theme-color" content="#07090c" />
    <link rel="icon" href="/favicon.ico" sizes="48x48" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="icon" href="/icon-192.png" sizes="192x192" type="image/png" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />

    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="Byradar" />
    <meta property="og:locale" content="nb_NO" />
    <meta property="og:url" content="${url}" />
    <meta property="og:title" content="${escape(city.title)} · Byradar" />
    <meta property="og:description" content="${escape(city.description)}" />
    <meta property="og:image" content="https://byradar.no/og.jpg" />
    <meta property="og:image:width" content="2400" />
    <meta property="og:image:height" content="1260" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escape(city.title)} · Byradar" />
    <meta name="twitter:description" content="${escape(city.description)}" />
    <meta name="twitter:image" content="https://byradar.no/og.jpg" />

    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "WebPage",
        "name": "${escape(city.title)}",
        "url": "${url}",
        "inLanguage": "nb-NO",
        "description": "${escape(city.description)}",
        "about": { "@type": "City", "name": "${escape(city.name)}" },
        "isPartOf": { "@type": "WebSite", "name": "Byradar", "url": "https://byradar.no/" }
      }
    </script>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:ital,wght@0,400..700;1,400..700&family=Martian+Mono:wght@300;400;500;700&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="/src/styles.css" />
  </head>
  <body>
    <svg class="grain" aria-hidden="true">
      <filter id="grain-filter">
        <feTurbulence type="fractalNoise" baseFrequency="0.86" numOctaves="3" stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#grain-filter)" />
    </svg>

    <main class="doc">
      <header class="doc__head">
        <a class="doc__back" href="/">tilbake til kartet</a>
        <div class="doc__mark" aria-hidden="true">
          <span class="masthead__bar" style="--c: #ec700c"></span>
          <span class="masthead__bar" style="--c: #0b91ef"></span>
          <span class="masthead__bar" style="--c: #e60000"></span>
          <span class="masthead__bar" style="--c: #354f7f"></span>
        </div>
        <h1 class="doc__title">${escape(city.title)}</h1>
        <p class="doc__lede">${escape(city.lede)}</p>
        <p><a class="doc__strong" href="${mapLink(city)}">Åpne kartet over ${escape(city.name)} →</a></p>
      </header>

      <section class="doc__section">
        <h2 class="doc__h">Hva kartet viser</h2>
        <p>
          Innenfor ${city.radiusKm} kilometer fra sentrum ligger det rundt ${Math.round(facts.served / 10) * 10}
          stoppesteder med avganger i rutetabellen, med ${escape(listWords(modeWords))}. Hvert kjøretøy tegnes med
          transportmiddel, retning og hvor presist det ligger an: blå ring betyr før tiden, grønn innenfor tre
          minutter, gul tre til sju, rød over sju minutter sen.
        </p>
        <p>${escape(city.extra)}</p>
      </section>

      <section class="doc__section">
        <h2 class="doc__h">Målt eller beregnet</h2>
        <p>${escape(city.live)}</p>
        <p>
          Rutetabellen er ${escape(city.operator)} sin egen, hentet fra
          <a href="https://developer.entur.org" rel="noreferrer noopener">Enturs</a> nasjonale eksport og bygget om
          hver natt. <a href="/om">Mer om datakildene og nøyaktigheten</a>.
        </p>
      </section>

      <section class="doc__section">
        <h2 class="doc__h">Travle stopp i ${escape(city.name)}</h2>
        <p>Stoppestedene med flest avganger i rutetabellen. Klikk for å åpne avgangstavla på kartet.</p>
        <ul class="doc__list">
${hubList}
        </ul>
      </section>

      <section class="doc__section">
        <h2 class="doc__h">Boligsjekk i ${escape(city.name)}</h2>
        <p>
          Skriv en adresse i ${escape(city.name)} i søkefeltet, eller hold fingeren på kartet, så regner Byradar ut
          hvor godt kollektivtilbudet er akkurat der: stoppene i gangavstand, hvor ofte det faktisk går i rushet,
          hvor mange linjer og transportmidler du når, og reisetiden til et sted du velger selv.
        </p>
        <p><a class="doc__strong" href="${mapLink(city)}">Prøv boligsjekken i ${escape(city.name)} →</a></p>
      </section>

      <section class="doc__section">
        <h2 class="doc__h">Andre byer</h2>
        <p>${otherList}</p>
      </section>

      <footer class="doc__foot">
        <a href="/">← kartet</a>
      </footer>
    </main>

    <script type="module" src="/src/analytics.ts"></script>
  </body>
</html>
`;
}

const { stops, counts } = callsPerStopPlace();

for (const city of CITIES) {
  const { hubs, served } = hubsFor(city, stops, counts);
  const facts = { hubs, served, modes: modesIn(stops, city) };
  const others = CITIES.filter((other) => other.slug !== city.slug);
  writeFileSync(resolve(WEB, `${city.slug}.html`), render(city, facts, others));
  console.log(`${city.slug}.html  ${served} stoppesteder, ${hubs.length} knutepunkt`);
}

console.log(`\nvite input: ${CITIES.map((c) => `${c.slug}: resolve(__dirname, '${c.slug}.html')`).join(', ')}`);
console.log(`sitemap: ${CITIES.map((c) => `https://byradar.no/${c.slug}`).join(' ')}`);
