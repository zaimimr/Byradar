const SCRIPT_SRC = 'https://cloud.umami.is/script.js';

export function startAnalytics(): void {
  if (!__UMAMI_WEBSITE_ID__) return;
  if (document.querySelector(`script[src="${SCRIPT_SRC}"]`)) return;

  const script = document.createElement('script');
  script.src = SCRIPT_SRC;
  script.defer = true;
  script.dataset.websiteId = __UMAMI_WEBSITE_ID__;
  script.dataset.domains = __UMAMI_DOMAINS__;
  script.dataset.excludeHash = 'true';
  script.dataset.excludeSearch = 'true';
  script.dataset.doNotTrack = 'true';
  document.head.appendChild(script);
}

startAnalytics();
