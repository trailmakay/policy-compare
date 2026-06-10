const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
const crypto = require('crypto');

// Simple in-memory cache so identical inputs always return the identical answer
// (makes results repeatable, instant, and free on re-runs).
const cache = new Map();
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
function cacheGet(k) { return cache.get(k); }
function cacheSet(k, v) {
  cache.set(k, v);
  if (cache.size > 80) cache.delete(cache.keys().next().value); // cap memory
}

// Load .env if present
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8')
    .split('\n').forEach(line => {
      const [key, ...val] = line.split('=');
      if (key && val.length) process.env[key.trim()] = val.join('=').trim();
    });
} catch {}

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const PORT = process.env.PORT || 3000;

if (!API_KEY) {
  console.error('ERROR: Set ANTHROPIC_API_KEY in your environment or .env file');
  process.exit(1);
}

// Pull a named array out of the AI's JSON reply. Handles the normal case, and
// also repairs a response that got cut off mid-list (keeps all complete items).
function extractArray(text, key) {
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      if (Array.isArray(obj[key])) return obj[key];
    } catch {}
  }
  // Repair case: response truncated — close the array after the last full item
  const start = text.indexOf('[');
  if (start >= 0) {
    let arr = text.slice(start);
    const lastObj = arr.lastIndexOf('}');
    if (lastObj >= 0) {
      arr = arr.slice(0, lastObj + 1) + ']';
      try {
        const items = JSON.parse(arr);
        if (Array.isArray(items)) return items;
      } catch {}
    }
  }
  return null;
}

// One promise-based call to Claude; returns the assistant's text.
function askAnthropic({ system, content, max_tokens = 8192 }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: 'claude-haiku-4-5', max_tokens, temperature: 0,
      system, messages: [{ role: 'user', content }],
    });
    const options = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
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
          if (m.error) return reject(new Error(m.error.message || 'Anthropic error'));
          resolve(m.content?.[0]?.text ?? '');
        } catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    r.write(data); r.end();
  });
}

function parseMoneyServer(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}

// Use the policy's own printed total premium as an answer key: do the line-item
// premiums add up to it? Returns { total, diff } or null if no total found.
function reconcileScore(rows) {
  let sum = 0, total = null;
  (rows || []).forEach(r => {
    const p = parseMoneyServer(r.Premium);
    if (p == null) return;
    if (/total[^a-z]*premium/i.test(r.Coverage || '') || /summary/i.test(r.Section || '')) {
      if (total == null) total = p;
    } else sum += p;
  });
  if (total == null) return null;
  return { total, diff: Math.abs(sum - total) };
}

function parseMeta(text) {
  let meta = {};
  const f = text.match(/\{[\s\S]*\}/);
  if (f) { try { const o = JSON.parse(f[0]); if (o.meta) meta = o.meta; } catch {} }
  if (!meta.insured) {
    const mm = text.match(/"meta"\s*:\s*(\{[^}]*\})/);
    if (mm) { try { meta = JSON.parse(mm[1]); } catch {} }
  }
  return meta;
}

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.csv':  'text/csv',
  '.pdf':  'application/pdf',
};

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);

  // ── Proxy endpoint ──────────────────────────────────────────────────────────
  if (req.method === 'POST' && parsed.pathname === '/api/ask') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch {
        res.writeHead(400); res.end('Bad JSON'); return;
      }

      const data = JSON.stringify({
        model:      payload.model      || 'claude-opus-4-8',
        max_tokens: payload.max_tokens || 1024,
        system:     payload.system,
        messages:   payload.messages,
        stream:     true,
      });

      const options = {
        hostname: 'api.anthropic.com',
        path:     '/v1/messages',
        method:   'POST',
        headers: {
          'content-type':    'application/json',
          'content-length':  Buffer.byteLength(data),
          'x-api-key':       API_KEY,
          'anthropic-version': '2023-06-01',
        },
      };

      const proxy = https.request(options, upstream => {
        res.writeHead(upstream.statusCode, {
          'content-type':  'text/event-stream',
          'cache-control': 'no-cache',
          'access-control-allow-origin': '*',
        });
        upstream.pipe(res);
      });

      proxy.on('error', err => {
        if (!res.headersSent) res.writeHead(502);
        res.end(`Upstream error: ${err.message}`);
      });

      proxy.write(data);
      proxy.end();
    });
    return;
  }

  // ── Extract endpoint (AI policy parsing, non-streaming) ────────────────────
  if (req.method === 'POST' && parsed.pathname === '/api/extract') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(body); } catch {
        res.writeHead(400); res.end('Bad JSON'); return;
      }

      // Return a cached result if we've seen this exact file/text before.
      const extractKey = 'extract:' + hash(payload.pdf || ('text:' + String(payload.text || '')));
      const cachedExtract = cacheGet(extractKey);
      if (cachedExtract) {
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        res.end(JSON.stringify(cachedExtract));
        return;
      }

      // Get the policy text — either provided directly, or extracted from an
      // uploaded PDF (base64) right here on the server (works regardless of
      // which browser the client uses, and keeps token usage low).
      let policyText = String(payload.text || '');
      if (payload.pdf) {
        try {
          const buf = Buffer.from(payload.pdf, 'base64');
          const data = await pdfParse(buf);
          policyText = data.text || '';
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Could not read PDF: ' + err.message }));
          return;
        }
      }

      if (!policyText.trim()) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'No text found in the file. It may be a scanned image.' }));
        return;
      }

      const systemPrompt = `You are an insurance document parser. Your job is to extract the policy identity AND every coverage, limit, premium, driver, and vehicle from the insurance policy text provided.

Return ONLY a valid JSON object in this exact format:
{"meta":{"insured":"JOHN A SMITH","policyNumber":"43-0127-00","effectiveDate":"11-20-2025","expirationDate":"11-20-2026","carrier":"Auto-Owners Insurance"},
"rows": [
  {
    "Type": "Auto",
    "Section": "Vehicle 1 - 2019 Ford F-150",
    "Coverage": "Bodily Injury Liability",
    "Limit": "$100,000/$300,000",
    "Deductible": "N/A",
    "Premium": "$145.00"
  }
]}

META rules:
- "insured" = the primary named insured's full name exactly as printed
- "policyNumber" = the policy number
- "effectiveDate" / "expirationDate" = the policy term start/end dates, exactly as printed
- "carrier" = the insurance company name
- If any meta field is not found, use "".

ROW rules:
- "Type" = policy type: Auto, Homeowners, Renters, Umbrella, Life, Farm, Commercial, or Other
- "Section" = logical grouping within the policy. For auto: use vehicle description (e.g. "Vehicle 1 - 2020 Toyota Camry VIN:1HGBH41"). For home: use section name (Dwelling, Personal Property, Liability). For drivers: use "Drivers".
- "Coverage" = the specific coverage or item name
- "Limit" = coverage limit, insured amount, or "Included" if bundled
- "Deductible" = deductible amount, or "N/A" if not applicable
- "Premium" = premium amount shown, or "" if not listed separately

ALSO include:
- One row per named driver: Type=same as policy type, Section="Drivers", Coverage="Driver - [Full Name]", Limit="", Deductible="", Premium=""
- One row per vehicle: Type="Auto", Section="Vehicles", Coverage="Vehicle - [Year Make Model]", Limit="VIN: [VIN if available]", Deductible="", Premium=""
- One row for total premium per policy type: Type=[type], Section="Summary", Coverage="Total [Type] Premium", Limit="", Deductible="", Premium="[amount]"

BUNDLED PACKAGES — IMPORTANT for consistency:
- If the policy includes a bundled package of extra coverages (e.g. a name containing "Package", "Plus", "Advantage", "Enhancement", or a grouping called "Additional Coverage"/"Additional Coverages"), output exactly ONE row for the WHOLE package: Section="[package name]", Coverage="[package name]", Limit="Included", Deductible="N/A", Premium="[the package's premium if shown, else '']".
- Do NOT itemize the individual sub-coverages inside such a package. Treat the package as a single line item.

Skip: page numbers, addresses, phone numbers, agent contact info, privacy notices, legal boilerplate, accident instruction cards, ID card text.
Focus on: declarations pages, coverage schedules, premium breakdowns.

Return ONLY the JSON — no explanation, no markdown, no code blocks. Output compact minified JSON (no extra spaces or line breaks) so the full list fits.`;

      const content = policyText.slice(0, 120000);
      try {
        // First read.
        const text1 = await askAnthropic({ system: systemPrompt, content });
        let rows = extractArray(text1, 'rows');
        if (!rows) throw new Error('Could not read AI response');
        let meta = parseMeta(text1);

        // Self-check: do the line-item premiums add up to the printed total?
        // If not, the read missed something — read it again, more carefully,
        // and keep whichever version reconciles better with the printed total.
        const score1 = reconcileScore(rows);
        if (score1 && score1.total > 0 && score1.diff > Math.max(25, score1.total * 0.03)) {
          try {
            const carefulPrompt = systemPrompt +
              `\n\nCAREFUL RE-READ: A first pass did not fully reconcile. Be exhaustive: include EVERY premium-bearing line (each vehicle's coverages and every per-vehicle premium) so the individual premiums add up to the printed total premium. Do not skip any line that carries a premium.`;
            const text2 = await askAnthropic({ system: carefulPrompt, content });
            const rows2 = extractArray(text2, 'rows');
            const score2 = reconcileScore(rows2);
            if (rows2 && rows2.length && score2 && score2.diff < score1.diff) {
              rows = rows2;
              meta = parseMeta(text2) || meta;
            }
          } catch { /* keep first read if the re-read fails (e.g. rate limit) */ }
        }

        const out = { rows, meta };
        cacheSet(extractKey, out);
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        res.end(JSON.stringify(out));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── Compare endpoint (AI matches coverages across two policies) ────────────
  if (req.method === 'POST' && parsed.pathname === '/api/compare') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch {
        res.writeHead(400); res.end('Bad JSON'); return;
      }
      const oldRows = Array.isArray(payload.oldRows) ? payload.oldRows : [];
      const newRows = Array.isArray(payload.newRows) ? payload.newRows : [];

      // Same two policies in → same comparison out.
      const compareKey = 'compare:' + hash(JSON.stringify({ o: oldRows, n: newRows }));
      const cachedCompare = cacheGet(compareKey);
      if (cachedCompare) {
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        res.end(JSON.stringify(cachedCompare));
        return;
      }

      const systemPrompt = `You are an expert insurance policy analyst. You are given two NUMBERED lists of coverage lines: the client's CURRENT policy (OLD items o0, o1, …) and their RENEWAL policy (NEW items n0, n1, …). Each item shows: Type | Section | Coverage | Limit | Deductible | Premium.

Your ONLY job is to PAIR each old item with the new item that represents the SAME coverage on the SAME vehicle/section. Match INTELLIGENTLY:
- Two vehicles are the SAME vehicle if they share year + make + model, EVEN IF the "Vehicle N" position number differs and EVEN IF spelling/abbreviation differs ("International"="Intl", "RAM"="Ram", "16FT"="16ft", "Dr"="DR"). Position numbers often shift between policies — ignore them.
- Two coverages match if they mean the same thing, ignoring minor wording ("Property Damage"="Property Damage Liability") or how each document grouped them.

Output ONLY compact minified JSON, no markdown:
{"pairs":[{"o":<old index number or null>,"n":<new index number or null>,"k":"label"}]}
Rules:
- If an old item matches a new item: one pair with BOTH "o" and "n".
- If an old item has NO match in the new policy: {"o":<i>,"n":null,"k":…} (it was dropped).
- If a new item has NO match in the old policy: {"o":null,"n":<j>,"k":…} (it was added).
- Use each old index AT MOST once and each new index AT MOST once.
- "k" = a clear "Type › Section › Coverage" label. For vehicles use the real "YEAR MAKE MODEL" (never a bare position number), e.g. "Auto › 2021 Ram 2500 › Collision". Prefer the renewal policy's wording.
- CRITICAL: account for EVERY old index and EVERY new index. Do not skip any.
Return ONLY the JSON.`;

      const list = (rows, p) => rows.map((r, i) =>
        `${p}${i}: ${r.Type} | ${r.Section} | ${r.Coverage} | ${r.Limit} | ${r.Deductible} | ${r.Premium}`).join('\n');
      const userMsg = 'OLD POLICY (current):\n' + list(oldRows, 'o') +
                      '\n\nNEW POLICY (renewal):\n' + list(newRows, 'n');

      const data = JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 8192,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMsg.slice(0, 150000) }],
      });

      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'content-type':      'application/json',
          'content-length':    Buffer.byteLength(data),
          'x-api-key':         API_KEY,
          'anthropic-version': '2023-06-01',
        },
      };

      let responseData = '';
      const proxy = https.request(options, upstream => {
        upstream.on('data', chunk => { responseData += chunk; });
        upstream.on('end', () => {
          try {
            const msg = JSON.parse(responseData);
            if (msg.error) throw new Error(msg.error.message || 'Anthropic error');
            const text = msg.content?.[0]?.text ?? '';
            const pairs = extractArray(text, 'pairs') || [];

            // Reconcile the AI's pairings against the real rows — this GUARANTEES
            // every line is accounted for and computes the actual changes.
            const valOf   = r => ({ Limit: r.Limit || '', Deductible: r.Deductible || '', Premium: r.Premium || '' });
            const labelOf = r => [r.Type, r.Section, r.Coverage].filter(Boolean).join(' › ');
            const usedOld = new Set(), usedNew = new Set();
            const entries = [];

            for (const p of pairs) {
              let oi = Number.isInteger(p.o) ? p.o : null;
              let ni = Number.isInteger(p.n) ? p.n : null;
              if (oi !== null && (oi < 0 || oi >= oldRows.length || usedOld.has(oi))) oi = null;
              if (ni !== null && (ni < 0 || ni >= newRows.length || usedNew.has(ni))) ni = null;
              if (oi === null && ni === null) continue;
              if (oi !== null) usedOld.add(oi);
              if (ni !== null) usedNew.add(ni);
              const oRow = oi !== null ? oldRows[oi] : null;
              const nRow = ni !== null ? newRows[ni] : null;
              const k = (typeof p.k === 'string' && p.k.trim()) ? p.k.trim() : labelOf(nRow || oRow);
              if (oRow && nRow) {
                const o = valOf(oRow), n = valOf(nRow);
                const changed = o.Limit !== n.Limit || o.Deductible !== n.Deductible || o.Premium !== n.Premium;
                entries.push({ s: changed ? 'changed' : 'match', k, o, n });
              } else if (oRow) {
                entries.push({ s: 'missing', k, o: valOf(oRow) });
              } else {
                entries.push({ s: 'added', k, n: valOf(nRow) });
              }
            }

            // Auto-pair any leftovers with an IDENTICAL Type|Section|Coverage
            // identity (e.g. "Total Auto Premium") that the AI left unmatched.
            const idOf = r => (r.Type + '|' + r.Section + '|' + r.Coverage).toLowerCase().replace(/\s+/g, ' ').trim();
            const newById = new Map();
            newRows.forEach((r, j) => { if (!usedNew.has(j)) { const id = idOf(r); (newById.get(id) || newById.set(id, []).get(id)).push(j); } });
            oldRows.forEach((r, i) => {
              if (usedOld.has(i)) return;
              const bucket = newById.get(idOf(r));
              if (bucket && bucket.length) {
                const j = bucket.shift();
                usedOld.add(i); usedNew.add(j);
                const o = valOf(r), n = valOf(newRows[j]);
                const changed = o.Limit !== n.Limit || o.Deductible !== n.Deductible || o.Premium !== n.Premium;
                entries.push({ s: changed ? 'changed' : 'match', k: labelOf(newRows[j]), o, n });
              }
            });

            // Safety net: anything still unmatched is shown, so nothing is ever
            // lost. These were NOT confidently matched by the AI, so flag them
            // "rv" (review) — the agent should double-check these by eye.
            oldRows.forEach((r, i) => { if (!usedOld.has(i)) entries.push({ s: 'missing', k: labelOf(r), o: valOf(r), rv: true }); });
            newRows.forEach((r, i) => { if (!usedNew.has(i)) entries.push({ s: 'added',   k: labelOf(r), n: valOf(r), rv: true }); });

            const out = { entries };
            cacheSet(compareKey, out);
            res.writeHead(200, {
              'content-type': 'application/json',
              'access-control-allow-origin': '*',
            });
            res.end(JSON.stringify(out));
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
      });

      proxy.on('error', err => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });

      proxy.write(data);
      proxy.end();
    });
    return;
  }

  // ── CORS preflight ──────────────────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' });
    res.end(); return;
  }

  // ── Static files ────────────────────────────────────────────────────────────
  let filePath = path.join(__dirname, parsed.pathname === '/' ? 'policy-compare.html' : parsed.pathname);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
