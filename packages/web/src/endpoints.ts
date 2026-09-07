const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/;

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function usable(configured: string): boolean {
  if (!configured) return false;
  const host = hostnameOf(configured);
  if (host === null) return true;
  return !LOCAL_HOSTS.test(host) || LOCAL_HOSTS.test(location.hostname);
}

function sameOrigin(path: string): string {
  return new URL(path, location.origin).toString().replace(/\/$/, '');
}

function sameOriginSocket(path: string): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}${path}`;
}

export const DATA_URL = usable(__DATA_URL__) ? __DATA_URL__ : sameOrigin('/data');
export const API_URL = usable(__API_URL__) ? __API_URL__ : sameOrigin('/');
export const WS_URL = usable(__WS_URL__) ? __WS_URL__ : sameOriginSocket('/live');
