const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

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
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch {
        res.writeHead(400); res.end('Bad JSON'); return;
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

Return ONLY the JSON — no explanation, no markdown, no code blocks.`;

      const userContent = payload.pdf ? [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: payload.pdf },
        },
        { type: 'text', text: 'Extract all insurance coverage data from this PDF per the instructions.' },
      ] : String(payload.text || '').slice(0, 120000);

      const data = JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
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
            // Pull out the JSON object even if Claude wrapped it in anything
            const match = text.match(/\{[\s\S]*\}/);
            if (!match) throw new Error('No JSON found in AI response');
            res.writeHead(200, {
              'content-type': 'application/json',
              'access-control-allow-origin': '*',
            });
            res.end(match[0]);
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
