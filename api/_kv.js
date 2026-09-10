// Shared helper for talking to Vercel KV (an Upstash Redis database) via its
// REST API. This file is NOT a route — Vercel ignores files that start with
// an underscore when building serverless functions from the api/ folder —
// but it can still be imported by the other files in this folder.
//
// Commands are sent as a JSON array in the POST body (Upstash's "body"
// command form) rather than built into the URL path, so long values (like a
// booking comment) never risk hitting a URL length limit.

export async function kv(...args) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null; // not connected — callers should fail open

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.result;
  } catch (err) {
    console.error('KV request failed:', err);
    return null;
  }
}

// Runs several commands in one HTTP round-trip. `commands` is an array of
// arrays, e.g. [['HKEYS', 'bookings:2026-09-16'], ['HKEYS', 'bookings:2026-09-17']].
// Returns an array of { result } / { error }, one per command, in order —
// or null if KV isn't connected or the request failed outright.
export async function kvPipeline(commands) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;

  try {
    const res = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error('KV pipeline request failed:', err);
    return null;
  }
}

// Upstash returns HGETALL as a flat array: ["field1","value1","field2","value2"].
// This turns that into a plain { field1: value1, field2: value2 } object.
// A missing/empty hash comes back as null or [], both handled here.
export function pairsToObject(pairs) {
  if (!Array.isArray(pairs)) return {};
  const out = {};
  for (let i = 0; i < pairs.length - 1; i += 2) {
    out[pairs[i]] = pairs[i + 1];
  }
  return out;
}
