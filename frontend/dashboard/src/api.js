import { getIdToken } from './auth';

const BASE = import.meta.env.VITE_API_BASE_URL;

async function request(path, options = {}) {
  const token = await getIdToken();
  const res = await fetch(BASE + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `request failed (${res.status})`);
  }
  return res.json();
}

export const api = {
  listSites: () => request('/sites'),
  createSite: (name, domain) =>
    request('/sites', {
      method: 'POST',
      body: JSON.stringify({ name, domain }),
    }),
  overview: (siteId, range) =>
    request(`/sites/${siteId}/overview?range=${range}`),
  visitors: (siteId, range) =>
    request(`/sites/${siteId}/visitors?range=${range}`),
};
