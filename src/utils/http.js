const USER_AGENT =
  "OpenClawOutreachBot/0.1 (+https://openclaw.local; lead discovery and website audit)";

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(options.timeoutMs || 15000),
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/json,text/plain;q=0.8,*/*;q=0.5",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Request failed ${response.status}: ${body.slice(0, 300)}`);
  }

  return response.json();
}

export async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(options.timeoutMs || 15000),
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,text/plain;q=0.9,*/*;q=0.5",
      ...(options.headers || {}),
    },
  });

  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  return {
    ok: response.ok,
    status: response.status,
    url: response.url || url,
    contentType,
    text,
  };
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
