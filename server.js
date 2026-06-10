const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

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

      const systemPrompt = `You are an insurance document parser. Your job is to extract every coverage, limit, premium, driver, and vehicle from the insurance policy text provided.

Return ONLY a valid JSON object in this exact format:
{"rows": [
  {
    "Type": "Auto",
    "Section": "Vehicle 1 - 2019 Ford F-150",
    "Coverage": "Bodily Injury Liability",
    "Limit": "$100,000/$300,000",
    "Deductible": "N/A",
    "Premium": "$145.00"
  }
]}

Rules:
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

Skip: page numbers, addresses, phone numbers, agent contact info, privacy notices, legal boilerplate, accident instruction cards, ID card text.
Focus on: declarations pages, coverage schedules, premium breakdowns.

Return ONLY the JSON — no explanation, no markdown, no code blocks. Output compact minified JSON (no extra spaces or line breaks) so the full list fits.`;

      const data = JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 8192,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: policyText.slice(0, 120000) }],
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
            const rows = extractArray(text, 'rows');
            if (!rows) throw new Error('Could not read AI response');
            res.writeHead(200, {
              'content-type': 'application/json',
              'access-control-allow-origin': '*',
            });
            res.end(JSON.stringify({ rows }));
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

            // Safety net: anything the AI forgot is added here, so nothing is ever lost.
            oldRows.forEach((r, i) => { if (!usedOld.has(i)) entries.push({ s: 'missing', k: labelOf(r), o: valOf(r) }); });
            newRows.forEach((r, i) => { if (!usedNew.has(i)) entries.push({ s: 'added',   k: labelOf(r), n: valOf(r) }); });

            res.writeHead(200, {
              'content-type': 'application/json',
              'access-control-allow-origin': '*',
            });
            res.end(JSON.stringify({ entries }));
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
