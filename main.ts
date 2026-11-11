// photo-geolocator-01 entry: two-pass vision geolocator.
//
// Pass 1 asks claude-sonnet-5-5 for every photo, with a structured GeoGuessr-style
// prompt: read the signs, language, driving side, road markings, plates, vegetation,
// architecture and vehicles, then give one JSON line with lat, lon, a confidence
// (0-1) and the country. Pass 2 asks claude-opus-5-5 to confirm or correct only the
// photos pass 1 was unsure about (confidence < 0.65, at most 8), showing it pass 1's
// guess so it refines rather than starts over. Every photo gets an answer: a photo
// with no usable guess falls back to the median of the trial's other guesses, which
// still beats leaving it unanswered (20,015 km). Answers are posted once, at the end,
// in photo order, so a spent budget or a refused call mid-run still leaves pass 1's
// guesses to post.
//
// Deterministic given the model's answers: temperature 0, fixed prompts that are a
// function of the photo bytes only, fixed concurrency, no wall clock and no unseeded
// randomness anywhere in a request. A gateway refusal (4xx) is final and costs
// nothing; transient 5xx/429/408/529 answers are retried with fixed backoff.

const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const MAX_TOKENS = 768;
const CONCURRENCY = 4;
const LOW_CONFIDENCE = 0.65;
const MAX_REFINEMENTS = 8;
const RETRY_STATUSES = [408, 429, 500, 502, 503, 504, 529];
const RETRIES = 3;

const PASS1_PROMPT =
  'You are a GeoGuessr expert. Look at this street-level photo carefully and work out where on Earth it was taken. ' +
  'Use every clue: language and script on signs, driving side, road markings and signs, license plates, vegetation and climate, ' +
  'architecture and building materials, vehicles, street furniture, and the sun and shadows. ' +
  'Reason briefly, then give your best estimate as one line of JSON only: ' +
  '{"lat": <degrees north>, "lon": <degrees east>, "confidence": <0 to 1>, "country": "<country name>"}. ' +
  'confidence is how sure you are: 0.9+ only if a sign, landmark or plate pins the place down, 0.5-0.7 for a good regional guess, below 0.5 for a continent-level guess.';

function pass2Prompt(first: Guess): string {
  return (
    'You are a GeoGuessr expert. A first look at this street-level photo guessed ' +
    `${first.lat.toFixed(4)}, ${first.lon.toFixed(4)} (${first.country ?? 'unknown country'}, confidence ${first.confidence ?? '?'}). ` +
    'Check that guess against the photo: language and script on signs, driving side, road markings and signs, license plates, ' +
    'vegetation and climate, architecture, vehicles, street furniture, sun and shadows. ' +
    'Confirm it if it looks right, or correct it if the clues point elsewhere. ' +
    'Give your final estimate as one line of JSON only: ' +
    '{"lat": <degrees north>, "lon": <degrees east>, "confidence": <0 to 1>, "country": "<country name>"}.'
  );
}

interface Photo {
  id: string;
  url: string;
  answered: boolean;
}

interface Guess {
  id: string;
  lat: number;
  lon: number;
  confidence?: number;
  country?: string;
}

function need(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`${name} is not set`);
  return v;
}

const envUrl = need('MAKEFUN_ENV_URL').replace(/\/+$/, '');
const anthropicUrl = need('ANTHROPIC_BASE_URL').replace(/\/+$/, '');
const apiKey = need('ANTHROPIC_API_KEY');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The model's answer text for one photo, or null when the gateway refused the call (final). */
async function ask(model: string, jpeg: Buffer, prompt: string): Promise<string | null> {
  const body = JSON.stringify({
    model,
    max_tokens: MAX_TOKENS,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
          { type: 'text', text: prompt },
        ],
      },
    ],
  });
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(`${anthropicUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body,
    });
    if (res.ok) {
      const msg = (await res.json()) as { content?: { type: string; text?: string }[] };
      return (msg.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('\n');
    }
    const text = await res.text();
    if (RETRY_STATUSES.includes(res.status) && res.headers.get('x-should-retry') !== 'false' && attempt < RETRIES) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    process.stderr.write(`geolocator: model call refused (${model}, HTTP ${res.status}): ${text.slice(0, 200)}\n`);
    return null;
  }
}

const isLat = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90;
const isLon = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180;

/** The guess an answer gives: its first JSON object with lat and lon, else its first two numbers in range. */
function coordinates(id: string, text: string): Guess | null {
  for (const m of text.matchAll(/\{[^{}]*\}/g)) {
    try {
      const o = JSON.parse(m[0]) as Record<string, unknown>;
      const lat = o.lat ?? o.latitude;
      const lon = o.lon ?? o.lng ?? o.longitude;
      if (isLat(lat) && isLon(lon)) {
        const conf = typeof o.confidence === 'number' && Number.isFinite(o.confidence) ? Math.max(0, Math.min(1, o.confidence)) : undefined;
        const country = typeof o.country === 'string' ? o.country : undefined;
        return { id, lat, lon, confidence: conf, country };
      }
    } catch {
      // Not JSON: try the next object, or the numbers below.
    }
  }
  const nums = [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  for (let i = 0; i + 1 < nums.length; i += 1) {
    if (isLat(nums[i]) && isLon(nums[i + 1])) return { id, lat: nums[i]!, lon: nums[i + 1]! };
  }
  return null;
}

async function main(): Promise<number> {
  const listed = (await (await fetch(`${envUrl}/photos`)).json()) as { photos: Photo[] };
  const photos = listed.photos.filter((p) => !p.answered);
  const jpegs = new Map<string, Buffer>();
  const guesses: (Guess | null)[] = new Array(photos.length).fill(null);

  // Pass 1: every photo, sonnet, four at a time.
  let next = 0;
  const pass1 = async (): Promise<void> => {
    while (next < photos.length) {
      const i = next;
      next += 1;
      const p = photos[i]!;
      const jpeg = Buffer.from(await (await fetch(`${envUrl}${p.url}`)).arrayBuffer());
      jpegs.set(p.id, jpeg);
      const text = await ask(SONNET, jpeg, PASS1_PROMPT);
      if (text === null) continue;
      const c = coordinates(p.id, text);
      if (c === null) process.stderr.write(`geolocator: no coordinates in the pass-1 answer for ${p.id}: ${text.slice(0, 200)}\n`);
      else guesses[i] = c;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => pass1()));

  // Pass 2: opus refines only the unsure ones, fewest-confidence first.
  const unsure = photos
    .map((p, i) => ({ p, i, g: guesses[i] }))
    .filter((x) => x.g === null || (x.g.confidence ?? 0) < LOW_CONFIDENCE)
    .sort((a, b) => (a.g?.confidence ?? 0) - (b.g?.confidence ?? 0))
    .slice(0, MAX_REFINEMENTS);
  let rnext = 0;
  const pass2 = async (): Promise<void> => {
    while (rnext < unsure.length) {
      const x = unsure[rnext]!;
      rnext += 1;
      const jpeg = jpegs.get(x.p.id);
      if (jpeg === undefined) continue;
      const prompt = x.g !== null ? pass2Prompt(x.g) : PASS1_PROMPT;
      const text = await ask(OPUS, jpeg, prompt);
      if (text === null) continue;
      const c = coordinates(x.p.id, text);
      if (c !== null) guesses[x.i] = c;
      else process.stderr.write(`geolocator: no coordinates in the pass-2 answer for ${x.p.id}\n`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => pass2()));

  // Fallback: never leave a photo unanswered (20,015 km). The median of the
  // trial's other guesses is a far better blind guess than nothing.
  const known = guesses.filter((g): g is Guess => g !== null);
  if (known.length > 0) {
    const median = (vs: number[]): number => {
      const s = [...vs].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)]!;
    };
    const flat = { lat: median(known.map((g) => g.lat)), lon: median(known.map((g) => g.lon)) };
    for (let i = 0; i < photos.length; i += 1) {
      if (guesses[i] === null) guesses[i] = { id: photos[i]!.id, lat: flat.lat, lon: flat.lon };
    }
  }

  const answers = guesses.filter((g): g is Guess => g !== null);
  if (answers.length === 0) {
    process.stderr.write('geolocator: no answers at all (every model call was refused)\n');
    return 1;
  }
  const res = await fetch(`${envUrl}/answers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answers: answers.map(({ id, lat, lon }) => ({ id, lat, lon })) }),
  });
  const body = await res.text();
  process.stdout.write(`geolocator: ${answers.length} of ${photos.length} photos answered: HTTP ${res.status} ${body}`);
  return res.ok ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (err) {
  process.stderr.write(`geolocator: ${(err as Error).stack ?? String(err)}\n`);
  process.exitCode = 1;
}
