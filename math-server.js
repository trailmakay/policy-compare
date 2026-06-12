// Math Photo Tutor — tiny Node server.
// Takes a photo of a math problem (up to pre-calc), reads it, solves it, and
// teaches the student how to do it themselves. Mirrors the pattern used by
// server.js: plain Node, loads .env, calls Claude over https, passcode-gated.
//
// Run:  node math-server.js   (or: npm run math)
// Needs ANTHROPIC_API_KEY in .env (the same key the policy app uses).
// Set MATH_PASSCODE to control who can use it — share it only with people you pick.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Load .env (same loader style as server.js) ──────────────────────────────
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8')
    .split('\n').forEach(line => {
      const [key, ...val] = line.split('=');
      if (key && val.length) process.env[key.trim()] = val.join('=').trim();
    });
} catch {}

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const PORT = process.env.MATH_PORT || process.env.PORT || 3100;

// The passcode you hand out to the people you choose. If unset, the app runs
// open (fine for trying it on your own phone; set it before you share).
const PASSCODE = process.env.MATH_PASSCODE || '';

// Opus 4.8 = best math accuracy + reads photos. Switch to 'claude-haiku-4-5'
// for faster/cheaper answers if you ever want to trade a little accuracy.
const MODEL = process.env.MATH_MODEL || 'claude-opus-4-8';

if (!API_KEY) {
  console.error('ERROR: Set ANTHROPIC_API_KEY in your environment or .env file');
  process.exit(1);
}
if (!PASSCODE) {
  console.warn('WARNING: MATH_PASSCODE is not set — anyone with the link can use it. Set it before sharing.');
}

// Constant-time passcode check (no early-exit timing leak).
function passcodeOk(given) {
  if (!PASSCODE) return true;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(PASSCODE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const SYSTEM = `You are a warm, patient math tutor for a student working on problems from basic arithmetic up through calculus (arithmetic, fractions, percentages, ratios, algebra, geometry, trigonometry, functions, sequences, and calculus: limits, derivatives, integrals, and their applications). You do not need to handle proof-heavy math beyond first-year calculus. You handle plain equations AND word problems (story problems) equally well.

You are shown a PHOTO of a math problem — usually cropped by the student to a single problem. Read it from the image and produce a step-by-step lesson the student clicks through one step at a time. If a neighboring problem is partly visible at an edge, ignore it and solve the problem that is fully shown and centered.

WORD PROBLEMS: when the photo is a word problem, the student's hardest part is turning the words into math — so spend your first one or two steps on exactly that: (1) state in plain words what the problem is asking for, (2) name the unknown (e.g. "let x = number of apples"), and (3) translate the sentences into an equation, pointing to which words become which math. Then solve it step by step. State the final answer as a real-world sentence with units (e.g. "**12 apples**", "**$45**", "**7.5 hours**"), not just a bare number.

Return your answer as JSON matching the given schema. Field meanings:
- readable: true if you can clearly read a math problem in the photo; false if it is blurry, cut off, or not a math problem.
- message: only when readable is false — a kind one-sentence note asking for a clearer, well-lit photo. Empty string otherwise.
- problem: restate the problem you read so the student can confirm you read it right. (If several problems appear, handle the first clearly and mention the others here.)
- steps: the solution broken into small steps the student clicks through in order. Each step has:
    - title: a short action, e.g. "Subtract 5 from both sides".
    - detail: 1-3 short sentences showing exactly what happens in this step AND the reason why, so the student learns the method, not just the moves.
  Keep each step small enough to follow on its own. Do NOT reveal the final answer inside the steps — let the student arrive at it.
- answer: the final answer, stated simply, with the key result in **double asterisks**.
- check: a quick way to confirm the answer is right (e.g. plug it back in).
- practice: one similar practice problem (no solution) so they can test themselves.

Use plain-text math only: no LaTeX, no $ signs, no \\frac. Use ^ for powers, / for division, * for multiply, sqrt( ) for roots. For calculus, write derivatives as d/dx[ ... ] or f'(x), integrals as "integral of ... dx", and limits as "lim as x -> a of ...". Add "+ C" to indefinite integrals. Work carefully and verify your arithmetic — accuracy matters more than speed. Keep the tone encouraging and the language simple.
When readable is false, set steps to an empty array and answer/check/practice to empty strings.`;

// Schema the model must fill — lets the phone page paginate the steps cleanly.
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['readable', 'message', 'problem', 'steps', 'answer', 'check', 'practice'],
  properties: {
    readable: { type: 'boolean' },
    message: { type: 'string' },
    problem: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'detail'],
        properties: { title: { type: 'string' }, detail: { type: 'string' } },
      },
    },
    answer: { type: 'string' },
    check: { type: 'string' },
    practice: { type: 'string' },
  },
};

// One non-streaming call to Claude with the photo. Opus 4.8: adaptive thinking,
// no temperature/top_p (those 400 on 4.8). One retry on rate-limit/overload.
function solveImage({ image, mediaType, attempt = 0 }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
          { type: 'text', text: 'Please read this math problem, solve it, and teach me how to do it myself.' },
        ],
      }],
    });
    const options = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
    };
    let resp = '';
    const r = https.request(options, up => {
      up.on('data', c => { resp += c; });
      up.on('end', () => {
        try {
          const m = JSON.parse(resp);
          if (m.error) {
            const msg = m.error.message || 'Anthropic error';
            const limited = up.statusCode === 429 || up.statusCode === 529 ||
              m.error.type === 'rate_limit_error' || /rate limit|overloaded/i.test(msg);
            if (limited && attempt < 1) {
              return setTimeout(() => solveImage({ image, mediaType, attempt: 1 }).then(resolve, reject), 8000);
            }
            return reject(new Error(msg));
          }
          // With adaptive thinking the content array can hold thinking blocks
          // (empty text by default) plus the answer — collect all text blocks.
          // Structured output means that text is JSON matching SCHEMA.
          const text = (m.content || [])
            .filter(b => b.type === 'text')
            .map(b => b.text).join('').trim();
          let obj;
          try { obj = JSON.parse(text); }
          catch {
            const mm = text.match(/\{[\s\S]*\}/);   // defensive: pull out the JSON object
            try { obj = JSON.parse(mm[0]); } catch {}
          }
          if (!obj || typeof obj !== 'object') {
            obj = { readable: false, message: 'I had trouble reading that — please try a clearer, well-lit photo.',
                    problem: '', steps: [], answer: '', check: '', practice: '' };
          }
          resolve(obj);
        } catch (e) { reject(e); }
      });
    });
    r.on('error', err => {
      if (attempt < 1) return setTimeout(() => solveImage({ image, mediaType, attempt: 1 }).then(resolve, reject), 3000);
      reject(err);
    });
    r.write(body); r.end();
  });
}

const PAGE = fs.readFileSync(path.join(__dirname, 'math.html'), 'utf8');

const MANIFEST = JSON.stringify({
  name: 'Math Photo Tutor',
  short_name: 'Math Tutor',
  start_url: '/',
  display: 'standalone',
  background_color: '#0f172a',
  theme_color: '#0f172a',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
});

// Simple square icon (a teal "√x" mark) so the home-screen shortcut looks intentional.
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" rx="96" fill="#0f172a"/>
<text x="50%" y="54%" font-family="Georgia, serif" font-size="240" fill="#5eead4"
 text-anchor="middle" dominant-baseline="middle">&#8730;x</text></svg>`;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }
  if (req.method === 'GET' && req.url === '/manifest.webmanifest') {
    res.writeHead(200, { 'content-type': 'application/manifest+json' });
    return res.end(MANIFEST);
  }
  if (req.method === 'GET' && req.url === '/icon.svg') {
    res.writeHead(200, { 'content-type': 'image/svg+xml' });
    return res.end(ICON);
  }

  if (req.method === 'POST' && req.url === '/solve') {
    let data = '';
    let tooBig = false;
    req.on('data', c => {
      data += c;
      if (data.length > 16 * 1024 * 1024) { tooBig = true; req.destroy(); } // 16 MB cap
    });
    req.on('end', async () => {
      if (tooBig) {
        res.writeHead(413, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Image too large. Try again — it will be shrunk automatically.' }));
      }
      let payload;
      try { payload = JSON.parse(data); } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Bad request.' }));
      }
      if (!passcodeOk(payload.passcode)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Wrong passcode.' }));
      }
      if (!payload.image || !payload.mediaType) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'No image received.' }));
      }
      try {
        const result = await solveImage({ image: payload.image, mediaType: payload.mediaType });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ result }));
      } catch (e) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e.message || 'Something went wrong reading the problem.' }));
      }
    });
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Math Photo Tutor running on http://localhost:${PORT}`);
  if (!PASSCODE) console.log('(no passcode set — open to anyone with the link)');
});
