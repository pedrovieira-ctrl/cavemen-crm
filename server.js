const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'noivos.db');

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const db = new DatabaseSync(DB_PATH);
db.exec(`CREATE TABLE IF NOT EXISTS storage (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

app.get('/api/data', (req, res) => {
  try {
    const row = db.prepare('SELECT value FROM storage WHERE key = ?').get('crm');
    res.json(row ? JSON.parse(row.value) : { deals: [], activities: [], config: {} });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao carregar dados' });
  }
});

app.post('/api/data', (req, res) => {
  try {
    db.prepare('INSERT OR REPLACE INTO storage (key, value) VALUES (?, ?)').run('crm', JSON.stringify(req.body));
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao guardar dados' });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`✅ NoivosCRM em http://localhost:${PORT}`));
