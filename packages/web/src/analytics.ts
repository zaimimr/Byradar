const SCRIPT_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';

export function startAnalytics(): void {
  if (!__CF_BEACON_TOKEN__) return;
  if (document.querySelector(`script[src="${SCRIPT_SRC}"]`)) return;

  const script = document.createElement('script');
  script.src = SCRIPT_SRC;
  script.defer = true;
  script.dataset.cfBeacon = JSON.stringify({ token: __CF_BEACON_TOKEN__, spa: false });
  document.head.appendChild(script);
}

startAnalytics();
