const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Base de dados: PostgreSQL em produção, SQLite em local ---
let getDB, setDB;

if (process.env.DATABASE_URL) {
  // Produção: Neon PostgreSQL (Render)
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  pool.query(`CREATE TABLE IF NOT EXISTS storage (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    .then(() => console.log('✅ PostgreSQL conectado'))
    .catch(console.error);

  getDB = async () => {
    const { rows } = await pool.query('SELECT value FROM storage WHERE key = $1', ['crm']);
    return rows[0] ? JSON.parse(rows[0].value) : { deals: [], activities: [], config: {} };
  };
  setDB = async (data) => {
    await pool.query(
      'INSERT INTO storage (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      ['crm', JSON.stringify(data)]
    );
  };
} else {
  // Local: SQLite nativo Node.js
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(__dirname, 'noivos.db'));
  db.exec(`CREATE TABLE IF NOT EXISTS storage (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  console.log('✅ SQLite local conectado');

  getDB = async () => {
    const row = db.prepare('SELECT value FROM storage WHERE key = ?').get('crm');
    return row ? JSON.parse(row.value) : { deals: [], activities: [], config: {} };
  };
  setDB = async (data) => {
    db.prepare('INSERT OR REPLACE INTO storage (key, value) VALUES (?, ?)').run('crm', JSON.stringify(data));
  };
}

// Serializa leituras+escritas para que um pedido do site não se perca entre o GET e o SET de outro pedido.
let lock = Promise.resolve();
const withLock = (fn) => { const run = lock.then(fn, fn); lock = run.catch(() => {}); return run; };

// --- Rotas API ---
app.get('/api/data', async (_req, res) => {
  try {
    const data = await getDB();
    // _servedAt deixa o POST saber que leads do site chegaram depois de esta cópia ser carregada.
    res.json({ ...data, _servedAt: Date.now() });
  }
  catch (e) { console.error(e); res.status(500).json({ error: 'Erro ao carregar dados' }); }
});

app.post('/api/data', async (req, res) => {
  try {
    await withLock(async () => {
      const incoming = req.body || {};
      const servedAt = Number(incoming._servedAt) || 0;
      delete incoming._servedAt;
      // Um separador do CRM aberto há muito tempo guarda a sua cópia inteira:
      // manter as leads do site que entraram depois dessa cópia ter sido carregada.
      const current = await getDB();
      const ids = new Set((incoming.leads || []).map(l => l.id));
      const missed = (current.leads || []).filter(l => l.recebidoTs && l.recebidoTs > servedAt && !ids.has(l.id));
      if (missed.length) incoming.leads = [...(incoming.leads || []), ...missed];
      await setDB(incoming);
    });
    res.json({ ok: true });
  }
  catch (e) { console.error(e); res.status(500).json({ error: 'Erro ao guardar dados' }); }
});

// --- Formulário público "Agenda a tua visita" (página /noivos do site dos relatórios) ---
const PUBLIC_ORIGINS = ['https://crm-clientes-site-1.onrender.com', 'http://localhost:5001', 'http://127.0.0.1:5001'];
app.use('/api/public', (req, res, next) => {
  const origin = req.headers.origin;
  if (PUBLIC_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const LOJAS = { guimaraes: 'Guimarães', braga: 'Braga', porto: 'Porto' };
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const clip = (v, n) => String(v ?? '').trim().slice(0, n);

app.post('/api/public/agendamento', async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true }); // bot apanhado no campo armadilha
  const nome = clip(b.nome, 120), email = clip(b.email, 160), tel = clip(b.tel, 40);
  const localidade = clip(b.localidade, 80);
  const m = clip(b.data, 10).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (nome.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || tel.replace(/\D/g, '').length < 9
      || !m || localidade.length < 2 || b.privacidade !== true) {
    return res.status(400).json({ error: 'Dados inválidos' });
  }
  const hoje = new Date().toISOString().split('T')[0];
  const lead = {
    id: Date.now().toString(),
    nome, tel, email,
    casamento: `${m[3]}-${m[2]}-${m[1]}`,
    localidade,
    loja: LOJAS[norm(localidade)] || '',
    origem: 'Website',
    estado: 'novo',
    notas: 'Pedido de visita pelo formulário do site.',
    criado: hoje,
    atualizado: hoje,
    recebidoTs: Date.now(),
  };
  try {
    await withLock(async () => {
      const data = await getDB();
      data.leads = [...(data.leads || []), lead];
      await setDB(data);
    });
    console.log(`📥 Lead do site: ${nome}`);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erro ao guardar pedido' }); }
});

app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`🚀 NoivosCRM em http://localhost:${PORT}`));
