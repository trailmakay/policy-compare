// ── Policy Renewal Checker server ──────────────────────────────────────────
// Express API + static frontend. Real per-agency accounts (hashed passwords,
// JWT cookie sessions, one-time invite codes, self-serve reset) wrapped around
// the AI-assisted policy comparison engine.
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
const db = require('./db');

// ── Load .env if present (local dev) ────────────────────────────────────────
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8')
    .split('\n').forEach(line => {
      const [key, ...val] = line.split('=');
      if (key && val.length) process.env[key.trim()] = val.join('=').trim();
    });
} catch {}

// ── Settings (secrets from env in production, config.json for local) ────────
const CONFIG_PATH = path.join(__dirname, 'config.json');
let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { config = {}; }
if (!config.jwtSecret) {
  config.jwtSecret = crypto.randomBytes(32).toString('hex');
  if (!config.adminPassword) config.adminPassword = 'trailadmin';
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch (e) {}
}

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || config.jwtSecret;
const ADMIN_SECRET = process.env.ADMIN_SECRET || config.adminPassword || 'trailadmin';
const PROD = process.env.NODE_ENV === 'production';
const COOKIE_OPTS = { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 30 * 864e5 };

if (!API_KEY) { console.error('ERROR: Set ANTHROPIC_API_KEY in your environment or .env file'); process.exit(1); }

// ── In-memory cache (identical inputs → identical answer, instant/free) ─────
const cache = new Map();
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
function cacheGet(k) { return cache.get(k); }
function cacheSet(k, v) { cache.set(k, v); if (cache.size > 80) cache.delete(cache.keys().next().value); }

// ════════════════════════════════════════════════════════════════════════════
// COMPARISON ENGINE (unchanged business logic)
// ════════════════════════════════════════════════════════════════════════════
function extractArray(text, key) {
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { const obj = JSON.parse(m[0]); if (Array.isArray(obj[key])) return obj[key]; } catch {} }
  const start = text.indexOf('[');
  if (start >= 0) {
    let arr = text.slice(start);
    const lastObj = arr.lastIndexOf('}');
    if (lastObj >= 0) { arr = arr.slice(0, lastObj + 1) + ']'; try { const items = JSON.parse(arr); if (Array.isArray(items)) return items; } catch {} }
  }
  return null;
}

const PRIMARY_MODEL = 'claude-haiku-4-5';
const FALLBACK_MODEL = 'claude-haiku-4-5';
function askAnthropic({ system, content, max_tokens = 8192, model = PRIMARY_MODEL, attempt = 0 }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ model, max_tokens, temperature: 0, system, messages: [{ role: 'user', content }] });
    const options = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    };
    const again = (opts, waitMs) => setTimeout(() => { askAnthropic({ system, content, max_tokens, ...opts }).then(resolve, reject); }, waitMs);
    let resp = '';
    const r = https.request(options, up => {
      up.on('data', c => { resp += c; });
      up.on('end', () => {
        try {
          const m = JSON.parse(resp);
          if (m.error) {
            const msg = m.error.message || 'Anthropic error';
            const rateLimited = up.statusCode === 429 || up.statusCode === 529 || m.error.type === 'rate_limit_error' || /rate limit|overloaded/i.test(msg);
            if (rateLimited && attempt < 1) return again({ model, attempt: 1 }, 25000);
            if (rateLimited && model !== FALLBACK_MODEL) return again({ model: FALLBACK_MODEL, attempt: 0 }, 1500);
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

function parseMoneyServer(v) { if (v == null) return null; const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; }
function reconcileScore(rows) {
  let sum = 0, total = null;
  (rows || []).forEach(r => { const p = parseMoneyServer(r.Premium); if (p == null) return;
    if (/total[^a-z]*premium/i.test(r.Coverage || '') || /summary/i.test(r.Section || '')) { if (total == null) total = p; } else sum += p; });
  if (total == null) return null;
  return { total, diff: Math.abs(sum - total) };
}
function redactPII(text) {
  return String(text)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[id]')
    .replace(/\(\d{3}\)\s*\d{3}[-.\s]?\d{4}/g, '[phone]')
    .replace(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, '[phone]')
    .replace(/\b1[-.\s]?\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[phone]');
}
function parseMeta(text) {
  let meta = {};
  const f = text.match(/\{[\s\S]*\}/);
  if (f) { try { const o = JSON.parse(f[0]); if (o.meta) meta = o.meta; } catch {} }
  if (!meta.insured) { const mm = text.match(/"meta"\s*:\s*(\{[^}]*\})/); if (mm) { try { meta = JSON.parse(mm[1]); } catch {} } }
  return meta;
}

const CMP_MAKE_MAP = { toyt:'toyota', hond:'honda', intl:'international', chev:'chevrolet', chevy:'chevrolet', vw:'volkswagen', mercbenz:'mercedes', frt:'freightliner' };
const cmpNorm = s => String(s||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
const CMP_YEAR = /\b(19|20)\d{2}\b/;
function comparePolicies(oldRows, newRows) {
  const isVehSubtotal = r => CMP_YEAR.test(String(r.Section||'')) && (/total[^a-z]*premium/i.test(String(r.Coverage||'')) || /^\s*premium\s*$/i.test(String(r.Coverage||'')));
  oldRows = oldRows.filter(r => !isVehSubtotal(r));
  newRows = newRows.filter(r => !isVehSubtotal(r));
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
  const driverKey = cov => { const n=cmpNorm(cov).replace(/^driver\s*/,'').trim().split(' ').filter(Boolean); return 'DR|'+((n[0]||'').slice(0,3))+'|'+(n[n.length-1]||''); };
  const covKey = cov => {
    const raw = String(cov||'').toLowerCase();
    if (/\btow|road\s?side/.test(raw)) return 'roadside';
    if (/rental|loss of use|transportation expense/.test(raw)) return 'rental';
    return raw.replace(/\([^)]*\)/g,' ').replace(/[^a-z0-9 ]/g,' ').replace(/\b(liability|coverage|cov|premium|limits?)\b/g,' ').replace(/\s+/g,' ').trim();
  };
  const rowKey = (r, side) => {
    const desc=vehDescriptor(r);
    if (desc) {
      const id = side==='o' ? oldDescToId[desc] : newDescToId[desc];
      if (/^vehicles?$/i.test(String(r.Section||''))) return 'VH|'+id+'|__LIST__';
      return 'VH|'+id+'|'+covKey(r.Coverage);
    }
    const sec=String(r.Section||'');
    if (/drivers?/i.test(sec)) return driverKey(r.Coverage);
    if (/summary/i.test(sec))  return 'SM|'+covKey(r.Coverage);
    return 'OT|'+cmpNorm(sec)+'|'+covKey(r.Coverage);
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
  const mCov=new Map(), aCov=new Map();
  missing.forEach((r,i)=>{ if(!isOT(r)) return; const c=covKey(r.Coverage); (mCov.get(c)||mCov.set(c,[]).get(c)).push(i); });
  added.forEach((r,j)=>{ if(!isOT(r)) return; const c=covKey(r.Coverage); (aCov.get(c)||aCov.set(c,[]).get(c)).push(j); });
  const dropM=new Set(), dropA=new Set();
  for (const [c,mis] of mCov){ const adds=aCov.get(c); if(mis.length===1 && adds && adds.length===1){ matched.push([missing[mis[0]], added[adds[0]]]); dropM.add(mis[0]); dropA.add(adds[0]); } }
  const pg = r => (r && (r.Page || r.page)) || null;
  const entries=[];
  matched.forEach(([o,n])=>{ const ov=val(o), nv=val(n); const ch=ov.Limit!==nv.Limit||ov.Deductible!==nv.Deductible||ov.Premium!==nv.Premium; entries.push({ s: ch?'changed':'match', k: label(n), o: ov, n: nv, pg: pg(n)||pg(o), pgs:'new' }); });
  missing.forEach((r,i)=>{ if(!dropM.has(i)) entries.push({ s:'missing', k: label(r), o: val(r), pg: pg(r), pgs:'old' }); });
  added.forEach((r,j)=>{ if(!dropA.has(j)) entries.push({ s:'added', k: label(r), n: val(r), pg: pg(r), pgs:'new' }); });
  return entries;
}

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
function pageForNeedle(pages, needle) {
  if (!needle) return null;
  const toks=[...new Set(String(needle).toUpperCase().replace(/[^A-Z0-9]+/g,' ').split(' ').filter(t => t.length>=3 || /^(19|20)\d{2}$/.test(t)))];
  if (!toks.length) return null;
  let best=null, bestScore=0;
  for (const p of pages) { let sc=0; for (const t of toks) if (p.norm.includes(' '+t+' ')) sc += /^(19|20)\d{2}$/.test(t) ? 1 : 10; if (sc>bestScore) { bestScore=sc; best=p.page; } }
  if (bestScore>=10) return best;
  const distinct=toks.filter(t => !/^(19|20)\d{2}$/.test(t)).sort((a,b)=>b.length-a.length);
  for (const t of distinct) { const pre=t.slice(0,4); if (pre.length<4) continue; for (const p of pages) if (p.norm.includes(pre)) return p.page; }
  return null;
}
function rowNeedle(r) {
  const sec=String(r.Section||''), cov=String(r.Coverage||'');
  const desc = CMP_YEAR.test(sec) ? sec.replace(/^vehicle\s*\d+\s*-\s*/i,'').trim()
    : (/^vehicles?$/i.test(sec) && CMP_YEAR.test(cov)) ? cov.replace(/^vehicle\s*-\s*/i,'').trim() : null;
  if (desc) return desc;
  if (/drivers?/i.test(sec)) return cov.replace(/^driver\s*-?\s*/i,'').trim();
  return cov || sec;
}

const EXTRACT_PROMPT = `You are an insurance document parser. Your job is to extract the policy identity AND every coverage, limit, premium, driver, and vehicle from the insurance policy text provided.

Return ONLY a valid JSON object in this exact format:
{"meta":{"insured":"JOHN A SMITH","policyNumber":"43-0127-00","effectiveDate":"11-20-2025","expirationDate":"11-20-2026","carrier":"Auto-Owners Insurance"},
"rows": [
  {"Type":"Auto","Section":"Vehicle 1 - 2019 Ford F-150","Coverage":"Bodily Injury Liability","Limit":"$100,000/$300,000","Deductible":"N/A","Premium":"$145.00"}
]}

META rules:
- "insured" = the primary named insured's full name exactly as printed
- "policyNumber" = the policy number
- "effectiveDate" / "expirationDate" = the policy term start/end dates, exactly as printed
- "carrier" = the insurance company name
- If any meta field is not found, use "".

ROW rules:
- "Type" = policy type: Auto, Homeowners, Renters, Umbrella, Life, Farm, Commercial, or Other
- "Section" = logical grouping. For auto: vehicle description (e.g. "Vehicle 1 - 2020 Toyota Camry VIN:1HGBH41"). For home: section name (Dwelling, Personal Property, Liability). For drivers: "Drivers".
- "Coverage" = the specific coverage or item name
- "Limit" = coverage limit, insured amount, or "Included" if bundled
- "Deductible" = deductible amount, or "N/A" if not applicable
- "Premium" = premium amount shown, or "" if not listed separately

ALSO include:
- One row per named driver: Section="Drivers", Coverage="Driver - [Full Name]", others "".
- One row per vehicle: Type="Auto", Section="Vehicles", Coverage="Vehicle - [Year Make Model]", Limit="VIN: [VIN if available]", others "".
- One row for total premium per policy type: Section="Summary", Coverage="Total [Type] Premium", Premium="[amount]".
- Do NOT create a per-vehicle premium subtotal row. The only total-premium row is the single policy-wide one in the Summary section.

BUNDLED PACKAGES: If the policy includes a bundled package of extra coverages (a name containing "Package", "Plus", "Advantage", "Enhancement", or an "Additional Coverage(s)" grouping), output exactly ONE row for the WHOLE package: Section="[package name]", Coverage="[package name]", Limit="Included", Deductible="N/A", Premium="[the package premium if shown, else '']". Do NOT itemize its sub-coverages.

Skip: page numbers, addresses, phone numbers, agent contact info, privacy notices, legal boilerplate, accident cards, ID cards.
Focus on: declarations pages, coverage schedules, premium breakdowns.

Return ONLY the JSON — no explanation, no markdown. Output compact minified JSON so the full list fits.`;

async function runExtraction(payload) {
  const extractKey = 'extract:' + hash(payload.pdf || ('text:' + String(payload.text || '')));
  const cached = cacheGet(extractKey);
  if (cached) return cached;

  let policyText = String(payload.text || '');
  let markedText = '';
  if (payload.pdf) {
    const buf = Buffer.from(payload.pdf, 'base64');
    const data = await pdfParse(buf, { pagerender: pageMarkedRender() });
    markedText = data.text || '';
    policyText = markedText.replace(/===PAGE \d+===/g, ' ');
  }
  if (!policyText.trim()) { const e = new Error('No text found in the file. It may be a scanned image.'); e.status = 400; throw e; }

  const content = redactPII(policyText).slice(0, 120000);
  const text1 = await askAnthropic({ system: EXTRACT_PROMPT, content });
  let rows = extractArray(text1, 'rows');
  if (!rows) throw new Error('Could not read AI response');
  let meta = parseMeta(text1);

  const score1 = reconcileScore(rows);
  if (score1 && score1.total > 0 && score1.diff > Math.max(25, score1.total * 0.03)) {
    try {
      const carefulPrompt = EXTRACT_PROMPT + `\n\nCAREFUL RE-READ: A first pass did not fully reconcile. Be exhaustive: include EVERY premium-bearing line so the individual premiums add up to the printed total premium. Do not skip any line that carries a premium.`;
      const text2 = await askAnthropic({ system: carefulPrompt, content });
      const rows2 = extractArray(text2, 'rows');
      const score2 = reconcileScore(rows2);
      if (rows2 && rows2.length && score2 && score2.diff < score1.diff) { rows = rows2; meta = parseMeta(text2) || meta; }
    } catch {}
  }

  if (markedText) { const pages = buildPages(markedText); rows.forEach(r => { const p = pageForNeedle(pages, rowNeedle(r)); if (p) r.Page = p; }); }
  const out = { rows, meta };
  cacheSet(extractKey, out);
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════════════════════════════
const newSess = () => crypto.randomBytes(16).toString('hex');
function signToken(user) { return jwt.sign({ uid: user.id, aid: user.agency_id, sess: user.sess }, JWT_SECRET, { expiresIn: '30d' }); }
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s || '');
function makeCode() { const a='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const g=()=>Array.from({length:4},()=>a[Math.floor(Math.random()*a.length)]).join(''); return `${g()}-${g()}-${g()}`; }
function makeRecoveryCode() { const a='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const g=()=>Array.from({length:4},()=>a[Math.floor(Math.random()*a.length)]).join(''); return `${g()}-${g()}-${g()}-${g()}`; }

async function authRequired(req, res, next) {
  try {
    const token = req.cookies.token || (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Not signed in' });
    let payload;
    try { payload = jwt.verify(token, JWT_SECRET); } catch (e) { return res.status(401).json({ error: 'Session expired — please sign in again' }); }
    const user = await db.get('SELECT id, agency_id, sess FROM users WHERE id = ?', [payload.uid]);
    if (!user || !user.sess || user.sess !== payload.sess) { res.clearCookie('token'); return res.status(401).json({ error: 'Your session is no longer valid — please sign in again.' }); }
    req.userId = user.id; req.agencyId = user.agency_id; next();
  } catch (e) { res.status(500).json({ error: 'Auth error' }); }
}
function adminRequired(req, res, next) {
  const provided = req.headers['x-admin-secret'] || (req.body && req.body.adminSecret);
  if (!provided || provided !== ADMIN_SECRET) return res.status(401).json({ error: 'Wrong admin password.' });
  next();
}

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(cookieParser());
if (PROD) app.set('trust proxy', 1);

// ── Auth routes ─────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { agencyName, name, email, password, code } = req.body || {};
    if (!agencyName || !name || !isEmail(email) || !password) return res.status(400).json({ error: 'All fields are required and email must be valid.' });
    if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const invite = await db.get('SELECT * FROM invite_codes WHERE code = ?', [String(code || '').trim().toUpperCase()]);
    if (!invite) return res.status(403).json({ error: 'Invalid access code. Ask your administrator for a valid one-time code.' });
    if (invite.used) return res.status(403).json({ error: 'This access code has already been used. Each code works only once.' });
    const existing = await db.get('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'An account with that email already exists.' });

    const recovery = makeRecoveryCode();
    const sess = newSess();
    const agency = await db.run('INSERT INTO agencies (name) VALUES (?)', [agencyName.trim()]);
    const hashPw = bcrypt.hashSync(password, 10);
    const recHash = bcrypt.hashSync(recovery, 10);
    const user = await db.run('INSERT INTO users (agency_id, email, name, password_hash, role, recovery_hash, sess) VALUES (?,?,?,?,?,?,?)',
      [agency.lastInsertRowid, email.toLowerCase(), name.trim(), hashPw, 'owner', recHash, sess]);
    await db.run("UPDATE invite_codes SET used = 1, used_by = ?, used_at = datetime('now') WHERE id = ?", [email.toLowerCase(), invite.id]);
    const token = signToken({ id: user.lastInsertRowid, agency_id: agency.lastInsertRowid, sess });
    res.cookie('token', token, COOKIE_OPTS);
    res.json({ ok: true, recoveryCode: recovery });
  } catch (e) { res.status(500).json({ error: 'Could not create account. ' + e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const user = await db.get('SELECT * FROM users WHERE email = ?', [String(email || '').toLowerCase()]);
    if (!user || !bcrypt.compareSync(password || '', user.password_hash)) return res.status(401).json({ error: 'Incorrect email or password.' });
    let sess = user.sess;
    if (!sess) { sess = newSess(); await db.run('UPDATE users SET sess = ? WHERE id = ?', [sess, user.id]); }
    const token = signToken({ id: user.id, agency_id: user.agency_id, sess });
    res.cookie('token', token, COOKIE_OPTS);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Login error.' }); }
});

app.post('/api/auth/logout', (req, res) => { res.clearCookie('token'); res.json({ ok: true }); });

app.post('/api/auth/reset', async (req, res) => {
  try {
    const { email, recoveryCode, newPassword } = req.body || {};
    if (!isEmail(email) || !recoveryCode || !newPassword) return res.status(400).json({ error: 'Email, recovery code, and a new password are all required.' });
    if (String(newPassword).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    const user = await db.get('SELECT * FROM users WHERE email = ?', [String(email).toLowerCase()]);
    const codeNorm = String(recoveryCode).trim().toUpperCase();
    if (!user || !user.recovery_hash || !bcrypt.compareSync(codeNorm, user.recovery_hash)) return res.status(401).json({ error: "That email and recovery code don't match." });
    const newRecovery = makeRecoveryCode();
    await db.run('UPDATE users SET password_hash = ?, recovery_hash = ?, sess = ? WHERE id = ?', [bcrypt.hashSync(newPassword, 10), bcrypt.hashSync(newRecovery, 10), newSess(), user.id]);
    res.json({ ok: true, recoveryCode: newRecovery });
  } catch (e) { res.status(500).json({ error: 'Reset error.' }); }
});

app.get('/api/auth/me', authRequired, async (req, res) => {
  const user = await db.get('SELECT id, email, name, role, agency_id FROM users WHERE id = ?', [req.userId]);
  const agency = user ? await db.get('SELECT id, name FROM agencies WHERE id = ?', [req.agencyId]) : null;
  if (!user || !agency) { res.clearCookie('token'); return res.status(401).json({ error: 'Your session is no longer valid — please sign in again.' }); }
  res.json({ user, agency });
});

// ── Admin: one-time invite codes ────────────────────────────────────────────
app.post('/api/admin/codes', adminRequired, async (req, res) => {
  const count = Math.min(Math.max(parseInt((req.body && req.body.count) || 1, 10) || 1, 1), 50);
  const note = String((req.body && req.body.note) || '').slice(0, 120);
  const created = [];
  for (let i = 0; i < count; i++) {
    let code, tries = 0;
    do { code = makeCode(); tries++; } while ((await db.get('SELECT 1 AS x FROM invite_codes WHERE code = ?', [code])) && tries < 10);
    await db.run('INSERT INTO invite_codes (code, note) VALUES (?, ?)', [code, note]);
    created.push(code);
  }
  res.json({ created });
});
app.get('/api/admin/codes', adminRequired, async (req, res) => {
  res.json(await db.all('SELECT code, note, used, used_by, used_at, created_at FROM invite_codes ORDER BY id DESC'));
});
app.post('/api/admin/recovery', adminRequired, async (req, res) => {
  const email = String((req.body && req.body.email) || '').toLowerCase();
  const user = await db.get('SELECT id FROM users WHERE email = ?', [email]);
  if (!user) return res.status(404).json({ error: 'No account with that email.' });
  const recovery = makeRecoveryCode();
  await db.run('UPDATE users SET recovery_hash = ? WHERE id = ?', [bcrypt.hashSync(recovery, 10), user.id]);
  res.json({ email, recoveryCode: recovery });
});

// ── App API (require a signed-in account) ───────────────────────────────────
app.post('/api/extract', authRequired, async (req, res) => {
  try { res.json(await runExtraction(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

app.post('/api/compare', authRequired, (req, res) => {
  try {
    const oldRows = Array.isArray(req.body && req.body.oldRows) ? req.body.oldRows : [];
    const newRows = Array.isArray(req.body && req.body.newRows) ? req.body.newRows : [];
    const compareKey = 'compare:' + hash(JSON.stringify({ o: oldRows, n: newRows }));
    const cached = cacheGet(compareKey);
    if (cached) return res.json(cached);
    const out = { entries: comparePolicies(oldRows, newRows) };
    cacheSet(compareKey, out);
    res.json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ask', authRequired, (req, res) => {
  const payload = req.body || {};
  const data = JSON.stringify({
    model: payload.model || 'claude-haiku-4-5',
    max_tokens: payload.max_tokens || 1024,
    system: payload.system, messages: payload.messages, stream: true,
  });
  const options = { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' } };
  const proxy = https.request(options, upstream => {
    res.writeHead(upstream.statusCode, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    upstream.pipe(res);
  });
  proxy.on('error', err => { if (!res.headersSent) res.status(502); res.end('Upstream error: ' + err.message); });
  proxy.write(data); proxy.end();
});

// ── Static frontend (login at /, app at /app.html) ──────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

db.init()
  .then(() => app.listen(PORT, () => {
    console.log(`Policy Renewal Checker running on http://localhost:${PORT}`);
    if (!process.env.TURSO_DATABASE_URL) console.warn('NOTE: Using a LOCAL database file. Set TURSO_DATABASE_URL for cloud persistence.');
  }))
  .catch(err => { console.error('DB init failed:', err.message); process.exit(1); });
