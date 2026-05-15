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

// --- Rotas API ---
app.get('/api/data', async (_req, res) => {
  try { res.json(await getDB()); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Erro ao carregar dados' }); }
});

app.post('/api/data', async (req, res) => {
  try { await setDB(req.body); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Erro ao guardar dados' }); }
});

app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`🚀 NoivosCRM em http://localhost:${PORT}`));
