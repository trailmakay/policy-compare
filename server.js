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

// Optional password protection (HTTP Basic Auth). Set APP_PASSWORD in the
// environment to lock the app; leave it unset to run open (e.g. local dev).
const APP_USER = process.env.APP_USER || 'agent';
const APP_PASSWORD = process.env.APP_PASSWORD || '';

if (!API_KEY) {
  console.error('ERROR: Set ANTHROPIC_API_KEY in your environment or .env file');
  process.exit(1);
}
if (!APP_PASSWORD) {
  console.warn('WARNING: APP_PASSWORD is not set — the app is open to anyone with the URL.');
}

// Returns true if the request carries the correct Basic-Auth credentials
// (or if no password is configured at all).
function checkAuth(req) {
  if (!APP_PASSWORD) return true;
  const header = req.headers['authorization'] || '';
  const m = header.match(/^Basic (.+)$/);
  if (!m) return false;
  let decoded = '';
  try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch { return false; }
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  const user = decoded.slice(0, i);
  const pass = decoded.slice(i + 1);
  const passBuf = Buffer.from(pass);
  const wantBuf = Buffer.from(APP_PASSWORD);
  const passOk = passBuf.length === wantBuf.length && crypto.timingSafeEqual(passBuf, wantBuf);
  return user === APP_USER && passOk;
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
// Uses the stronger model (Sonnet) by default. If the per-minute rate limit is
// hit it waits and retries once; if it's still limited, it falls back to the
// faster model (Haiku, higher limits) so the app never hard-fails on a big read.
const PRIMARY_MODEL = 'claude-haiku-4-5';
const FALLBACK_MODEL = 'claude-haiku-4-5';

function askAnthropic({ system, content, max_tokens = 8192, model = PRIMARY_MODEL, attempt = 0 }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model, max_tokens, temperature: 0,
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
    const again = (opts, waitMs) => setTimeout(() => {
      askAnthropic({ system, content, max_tokens, ...opts }).then(resolve, reject);
    }, waitMs);

    let resp = '';
    const r = https.request(options, up => {
      up.on('data', c => { resp += c; });
      up.on('end', () => {
        try {
          const m = JSON.parse(resp);
          if (m.error) {
            const msg = m.error.message || 'Anthropic error';
            const rateLimited = up.statusCode === 429 || up.statusCode === 529 ||
              m.error.type === 'rate_limit_error' || /rate limit|overloaded/i.test(msg);
            if (rateLimited && attempt < 1) return again({ model, attempt: 1 }, 25000);       // wait & retry same model
            if (rateLimited && model !== FALLBACK_MODEL) return again({ model: FALLBACK_MODEL, attempt: 0 }, 1500); // fall back
            return reject(new Error(msg));
          }
          resolve(m.content?.[0]?.text ?? '');
        } catch (e) { reject(e); }
      });
    });
    r.on('error', err => { if (attempt < 1) return again({ model, attempt: 1 }, 3000); reject(err); });
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

// ── Deterministic policy comparison ─────────────────────────────────────────
// Matches coverages across two policies in code (no AI), so the result is exact,
// instant, and identical every time for the same input.
const CMP_MAKE_MAP = { toyt:'toyota', hond:'honda', intl:'international', chev:'chevrolet', chevy:'chevrolet', vw:'volkswagen', mercbenz:'mercedes', frt:'freightliner' };
const cmpNorm = s => String(s||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
const CMP_YEAR = /\b(19|20)\d{2}\b/;

function comparePolicies(oldRows, newRows) {
  const vehDescriptor = r => {
    const sec = String(r.Section||''), cov = String(r.Coverage||'');
    if (CMP_YEAR.test(sec)) return sec.replace(/^vehicle\s*\d+\s*-\s*/i,'').trim();
    if (/^vehicles?$/i.test(sec) && CMP_YEAR.test(cov)) return cov.replace(/^vehicle\s*-\s*/i,'').trim();
    return null;
  };
  const parseVeh = desc => {
    const toks = cmpNorm(desc).split(' ').filter(Boolean).map(t => CMP_MAKE_MAP[t]||t);
    let year=''; const rest=[];
    toks.forEach(t => { if(!year && /^(19|20)\d{2}$/.test(t)) year=t; else rest.push(t); });
    return { year, toks: rest, desc };
  };
  const vehScore = (a,b) => { if(a.year&&b.year&&a.year!==b.year) return -1; const sb=new Set(b.toks); let s=0; a.toks.forEach(t=>{ if(sb.has(t)) s++; }); return s; };

  const oldDescs=[...new Set(oldRows.map(vehDescriptor).filter(Boolean))];
  const newDescs=[...new Set(newRows.map(vehDescriptor).filter(Boolean))];
  const oldV=oldDescs.map(parseVeh), newV=newDescs.map(parseVeh);
  const cand=[];
  oldV.forEach((o,i)=>newV.forEach((n,j)=>{ const s=vehScore(o,n); if(s>=1) cand.push([s,i,j]); }));
  cand.sort((x,y)=>y[0]-x[0]);
  const usedOi=new Set(), usedNj=new Set(), oldDescToId={}, newDescToId={};
  cand.forEach(([s,i,j])=>{ if(usedOi.has(i)||usedNj.has(j)) return; usedOi.add(i); usedNj.add(j); oldDescToId[oldDescs[i]]='V'+j; newDescToId[newDescs[j]]='V'+j; });
  oldDescs.forEach(d=>{ if(!(d in oldDescToId)) oldDescToId[d]='Oonly:'+d; });
  newDescs.forEach(d=>{ if(!(d in newDescToId)) newDescToId[d]='Nonly:'+d; });

  const driverKey = cov => { const n=cmpNorm(cov).replace(/^driver\s*/,'').trim().split(' ').filter(Boolean); return 'DR|'+(n[0]||'')+'|'+(n[n.length-1]||''); };
  const rowKey = (r, side) => {
    const desc=vehDescriptor(r);
    if (desc) {
      const id = side==='o' ? oldDescToId[desc] : newDescToId[desc];
      if (/^vehicles?$/i.test(String(r.Section||''))) return 'VH|'+id+'|__LIST__';
      return 'VH|'+id+'|'+cmpNorm(r.Coverage);
    }
    const sec=String(r.Section||'');
    if (/drivers?/i.test(sec)) return driverKey(r.Coverage);
    if (/summary/i.test(sec))  return 'SM|'+cmpNorm(r.Coverage);
    return 'OT|'+cmpNorm(sec)+'|'+cmpNorm(r.Coverage);
  };
  const isOT = r => !vehDescriptor(r) && !/drivers?|summary/i.test(String(r.Section||''));
  const label = r => {
    const desc=vehDescriptor(r);
    if (desc && !/^vehicles?$/i.test(String(r.Section||''))) return 'Auto › '+desc+' › '+r.Coverage;
    return 'Auto › '+(r.Section||'')+' › '+r.Coverage;
  };
  const val = r => ({ Limit: r.Limit||'', Deductible: r.Deductible||'', Premium: r.Premium||'' });

  const oldMap=new Map(), newMap=new Map();
  oldRows.forEach(r=>{ const k=rowKey(r,'o'); if(!oldMap.has(k)) oldMap.set(k,r); });
  newRows.forEach(r=>{ const k=rowKey(r,'n'); if(!newMap.has(k)) newMap.set(k,r); });

  const matched=[], missing=[], added=[];
  for (const [k,r] of oldMap){ if(newMap.has(k)) matched.push([r,newMap.get(k)]); else missing.push(r); }
  for (const [k,r] of newMap){ if(!oldMap.has(k)) added.push(r); }

  // Reconcile leftover package/other coverages by unique coverage name (handles
  // the same coverage filed under a different section name in each policy).
  const mCov=new Map(), aCov=new Map();
  missing.forEach((r,i)=>{ if(!isOT(r)) return; const c=cmpNorm(r.Coverage); (mCov.get(c)||mCov.set(c,[]).get(c)).push(i); });
  added.forEach((r,j)=>{ if(!isOT(r)) return; const c=cmpNorm(r.Coverage); (aCov.get(c)||aCov.set(c,[]).get(c)).push(j); });
  const dropM=new Set(), dropA=new Set();
  for (const [c,mis] of mCov){ const adds=aCov.get(c); if(mis.length===1 && adds && adds.length===1){ matched.push([missing[mis[0]], added[adds[0]]]); dropM.add(mis[0]); dropA.add(adds[0]); } }

  const pg = r => (r && (r.Page || r.page)) || null;
  const entries=[];
  matched.forEach(([o,n])=>{ const ov=val(o), nv=val(n); const ch=ov.Limit!==nv.Limit||ov.Deductible!==nv.Deductible||ov.Premium!==nv.Premium; entries.push({ s: ch?'changed':'match', k: label(n), o: ov, n: nv, pg: pg(n)||pg(o), pgs:'new' }); });
  missing.forEach((r,i)=>{ if(!dropM.has(i)) entries.push({ s:'missing', k: label(r), o: val(r), pg: pg(r), pgs:'old' }); });
  added.forEach((r,j)=>{ if(!dropA.has(j)) entries.push({ s:'added', k: label(r), n: val(r), pg: pg(r), pgs:'new' }); });
  return entries;
}

// ── Page tracking ───────────────────────────────────────────────────────────
// Read a PDF but tag each page so we can later say which page a coverage is on.
function pageMarkedRender() {
  let counter = 0;
  return pageData => {
    const n = pageData.pageNumber || (++counter);
    return pageData.getTextContent({ normalizeWhitespace:false, disableCombineTextItems:false }).then(tc => {
      let text='', lastY;
      for (const it of tc.items) { if (lastY===it.transform[5] || !lastY) text+=it.str; else text+='\n'+it.str; lastY=it.transform[5]; }
      return '\n===PAGE '+n+'===\n'+text;
    });
  };
}
function buildPages(marked) {
  const re=/===PAGE (\d+)===/g; let m, prev=null, lastIdx=0; const parts=[];
  while ((m=re.exec(marked))) { if (prev!==null) parts.push({ page:prev, text:marked.slice(lastIdx, m.index) }); prev=+m[1]; lastIdx=re.lastIndex; }
  if (prev!==null) parts.push({ page:prev, text:marked.slice(lastIdx) });
  return parts.map(p => ({ page:p.page, norm:' '+p.text.toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim()+' ' }));
}
// Find the page whose text contains the most of the needle's distinctive words.
// Distinctive words (make/model/coverage names) are weighted far above the year,
// which appears on many pages — and we refuse to guess on a year-only match.
function pageForNeedle(pages, needle) {
  if (!needle) return null;
  const toks=[...new Set(String(needle).toUpperCase().replace(/[^A-Z0-9]+/g,' ').split(' ').filter(t => t.length>=3 || /^(19|20)\d{2}$/.test(t)))];
  if (!toks.length) return null;
  let best=null, bestScore=0;
  for (const p of pages) {
    let sc=0; for (const t of toks) if (p.norm.includes(' '+t+' ')) sc += /^(19|20)\d{2}$/.test(t) ? 1 : 10;
    if (sc>bestScore) { bestScore=sc; best=p.page; }
  }
  if (bestScore>=10) return best; // found a distinctive (non-year) word cleanly
  // Last resort for glued/abbreviated raw text (e.g. "2017MAZD 6"): the 4-char
  // prefix of the longest distinctive word as a substring.
  const distinct=toks.filter(t => !/^(19|20)\d{2}$/.test(t)).sort((a,b)=>b.length-a.length);
  for (const t of distinct) { const pre=t.slice(0,4); if (pre.length<4) continue;
    for (const p of pages) if (p.norm.includes(pre)) return p.page;
  }
  return null;
}
function rowNeedle(r) {
  const sec=String(r.Section||''), cov=String(r.Coverage||'');
  const desc = CMP_YEAR.test(sec) ? sec.replace(/^vehicle\s*\d+\s*-\s*/i,'').trim()
    : (/^vehicles?$/i.test(sec) && CMP_YEAR.test(cov)) ? cov.replace(/^vehicle\s*-\s*/i,'').trim()
    : null;
  if (desc) return desc;
  if (/drivers?/i.test(sec)) return cov.replace(/^driver\s*-?\s*/i,'').trim();
  return cov || sec;
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

  // Password gate — applies to the page and every API endpoint.
  if (!checkAuth(req)) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Policy Renewal Checker", charset="UTF-8"',
      'content-type': 'text/plain',
    });
    res.end('Authentication required.');
    return;
  }

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
      let markedText = '';
      if (payload.pdf) {
        try {
          const buf = Buffer.from(payload.pdf, 'base64');
          const data = await pdfParse(buf, { pagerender: pageMarkedRender() });
          markedText = data.text || '';
          policyText = markedText.replace(/===PAGE \d+===/g, ' '); // clean copy for the AI
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

        // Stamp each row with the PDF page it was found on (deterministic search).
        if (markedText) {
          const pages = buildPages(markedText);
          rows.forEach(r => { const p = pageForNeedle(pages, rowNeedle(r)); if (p) r.Page = p; });
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

      try {
        const entries = comparePolicies(oldRows, newRows);
        const out = { entries };
        cacheSet(compareKey, out);
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        res.end(JSON.stringify(out));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
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
