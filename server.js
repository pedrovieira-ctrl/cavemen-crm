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

// Cópia em memória: a base de dados (Neon, plano gratuito, com limite de transferência) só é lida
// ao arrancar; os pedidos são servidos da memória e cada gravação atualiza a memória e a base de dados.
const lerBase = getDB, gravarBase = setDB;
let CACHE = null;
let REV = Date.now();
getDB = async () => {
  if (!CACHE) CACHE = await lerBase();
  return structuredClone(CACHE);
};
setDB = async (data) => {
  await gravarBase(data);
  CACHE = structuredClone(data);
  REV = Date.now();
};

// Serializa leituras+escritas para que um pedido do site não se perca entre o GET e o SET de outro pedido.
let lock = Promise.resolve();
const withLock = (fn) => { const run = lock.then(fn, fn); lock = run.catch(() => {}); return run; };

// Pedidos do formulário de agendamento (têm recebidoTs) contam como origem "Landing Page".
// Corrige os que entraram como "Website", incluindo cópias antigas enviadas por separadores abertos.
const ORIGEM_FORMULARIO = 'Landing Page';
const corrigirOrigemFormulario = (data) => {
  (data.leads || []).forEach(l => { if (l.recebidoTs && l.origem === 'Website') l.origem = ORIGEM_FORMULARIO; });
  return data;
};

// --- Rotas API ---
app.get('/api/data', async (_req, res) => {
  try {
    const { _removidos, ...data } = corrigirOrigemFormulario(await getDB());
    res.set('Cache-Control', 'no-store');
    res.json({ ...data, _servedAt: Date.now(), _rev: REV });
  }
  catch (e) { console.error(e); res.status(500).json({ error: 'Erro ao carregar dados', detalhe: String(e && e.message || e).slice(0, 300) }); }
});

// Versão da página: cada separador compara com a que carregou e avisa quando há uma nova
const fs = require('fs');
const VERSAO = require('crypto').createHash('md5').update(fs.readFileSync(path.join(__dirname, 'public', 'index.html'))).digest('hex').slice(0, 10);
app.get('/api/versao', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json({ versao: VERSAO, rev: REV }); });

// _ts = quando o servidor gravou o item; _removidos = ids apagados (para não ressuscitarem)
const marcarRemovidos = (data, ids) => {
  if (!ids.length) return;
  const agora = Date.now(), limite = agora - 90 * 86400000;
  const r = Object.fromEntries(Object.entries(data._removidos || {}).filter(([, t]) => t > limite));
  ids.forEach(id => { r[id] = agora; });
  data._removidos = r;
};

// Cada separador envia só o que mudou (por id), para não apagar o que os colegas criaram entretanto.
const COLECOES = ['deals', 'activities', 'leads'];
app.post('/api/patch', async (req, res) => {
  try {
    const p = req.body || {};
    const muitos = COLECOES.some(c => ((p[c] && p[c].upsert) || []).length > 25);
    if (muitos && req.get('x-crm-restauro') !== 'sim') {
      return res.status(409).json({ error: 'Gravação demasiado grande: recarrega a página.' });
    }
    await withLock(async () => {
      const data = await getDB();
      for (const c of COLECOES) {
        if (!p[c]) continue;
        const remover = new Set(p[c].remove || []);
        const lista = (data[c] || []).filter(x => !remover.has(x.id));
        marcarRemovidos(data, [...remover]);
        for (const item of p[c].upsert || []) {
          const novo = { ...item, _ts: Date.now() };
          const i = lista.findIndex(x => x.id === item.id);
          if (i > -1) lista[i] = novo; else lista.push(novo);
        }
        data[c] = lista;
      }
      if (p.config) data.config = p.config;
      await setDB(corrigirOrigemFormulario(data));
    });
    res.json({ ok: true });
  }
  catch (e) { console.error(e); res.status(500).json({ error: 'Erro ao guardar dados' }); }
});

// Versão antiga da página (separadores abertos antes da atualização) enviava a cópia inteira e
// apagava o trabalho dos colegas: recusar e pedir para recarregar.
// Separadores com a versão antiga da página (anterior a 03/11) enviam a cópia inteira dos dados.
// Em vez de a gravar por cima de tudo, junta-se só o que esse separador mudou desde que carregou.
const semTs = (x) => { const { _ts, ...r } = x; return JSON.stringify(r); };
app.post('/api/data', async (req, res) => {
  const incoming = req.body || {};
  const servedAt = Number(incoming._servedAt) || 0;
  if (!servedAt || !Array.isArray(incoming.deals)) return res.status(409).json({ error: 'Versão antiga do CRM: recarrega a página.' });
  const diaCarregado = new Date(servedAt).toISOString().split('T')[0];
  try {
    const resumo = {};
    await withLock(async () => {
      const data = await getDB();
      const removidos = data._removidos || {};
      for (const c of COLECOES) {
        const recebidos = new Map((incoming[c] || []).map(x => [x.id, x]));
        const resultado = [], apagados = [];
        let alterados = 0, novos = 0;
        for (const atual of data[c] || []) {
          const dele = recebidos.get(atual.id);
          recebidos.delete(atual.id);
          // mudou no servidor depois de o separador antigo ter carregado?
          const mudouDepois = (atual._ts || 0) > servedAt || (atual.recebidoTs || 0) > servedAt
            || (atual.criado || '') >= diaCarregado || (atual.atualizado || '') > diaCarregado;
          if (!dele) {
            if (mudouDepois) resultado.push(atual); else apagados.push(atual.id);
          } else if (semTs(dele) !== semTs(atual) && !((atual._ts || 0) > servedAt) && !((atual.atualizado || '') > (dele.atualizado || ''))) {
            resultado.push(atual._ts ? { ...dele, _ts: atual._ts } : dele); alterados++;
          } else resultado.push(atual);
        }
        for (const dele of recebidos.values()) {
          if (removidos[dele.id]) continue;
          resultado.push(dele); novos++;
        }
        marcarRemovidos(data, apagados);
        data[c] = resultado;
        resumo[c] = { alterados, novos, apagados: apagados.length };
      }
      await setDB(corrigirOrigemFormulario(data));
    });
    console.log('🔀 Gravação de separador antigo juntada:', JSON.stringify(resumo));
    res.json({ ok: true });
  }
  catch (e) { console.error(e); res.status(500).json({ error: 'Erro ao guardar dados' }); }
});

// --- Formulário público "Agenda a tua visita" (página /noivos do site dos relatórios) ---
const PUBLIC_ORIGINS = ['https://encomendascavemen-cmd.github.io', 'https://crm-clientes-site-1.onrender.com', 'http://localhost:5001', 'http://127.0.0.1:5001'];
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
    origem: ORIGEM_FORMULARIO,
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

// --- Leads dos formulários do Meta (Facebook/Instagram), enviadas pelo Pabbly Connect ---
// A chave fica na variável de ambiente META_LEADS_KEY do Render (o repositório é público).
const primeiro = (b, ...nomes) => { for (const n of nomes) if (b[n] != null && String(b[n]).trim()) return String(b[n]).trim(); return ''; };
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const dataISO = (v) => {
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = v.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4}|\d{2})$/);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  // "11 de dez", "11 dezembro 2027": sem ano, assume a próxima vez que essa data acontece
  m = norm(v).match(/^(\d{1,2})\s*(?:de\s+)?([a-z]{3})[a-z]*\.?(?:\s*(?:de\s+)?(\d{4}))?$/);
  const mes = m ? MESES.indexOf(m[2]) : -1;
  if (mes < 0 || +m[1] < 1 || +m[1] > 31) return '';
  const hoje = new Date();
  let ano = m[3] ? +m[3] : hoje.getFullYear();
  if (!m[3] && new Date(ano, mes, +m[1]) < new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate())) ano++;
  return `${ano}-${String(mes + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
};

app.post('/api/public/meta-lead', express.urlencoded({ extended: false }), async (req, res) => {
  const chave = process.env.META_LEADS_KEY;
  if (!chave) return res.status(503).json({ error: 'META_LEADS_KEY não configurada no servidor' });
  if ((req.get('x-crm-key') || req.query.key) !== chave) return res.status(401).json({ error: 'Chave inválida' });

  const original = req.body || {};
  const chaveNorm = (k) => norm(String(k)).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const b = {};
  Object.entries(original).forEach(([k, v]) => { const n = chaveNorm(k); if (!(n in b)) b[n] = v; });
  const nome = clip(primeiro(b, 'nome', 'full_name', 'name'), 120);
  const tel = clip(primeiro(b, 'tel', 'telefone', 'phone_number', 'phone'), 40);
  const email = clip(primeiro(b, 'email'), 160);
  if (nome.length < 2 || (!tel && !email)) return res.status(400).json({ error: 'Falta o nome ou um contacto (telefone/email)' });

  const metaLeadId = clip(primeiro(b, 'meta_lead_id', 'leadgen_id', 'lead_id'), 60);
  const dataTexto = clip(primeiro(b, 'data_casamento', 'data_do_casamento', 'casamento', 'wedding_date'), 40);
  const localidade = clip(primeiro(b, 'localidade', 'city', 'cidade'), 80);
  const plataforma = primeiro(b, 'plataforma', 'platform').toLowerCase();
  // a resposta pode vir com texto a mais (ex.: "loja_de_guimarães"): basta conter o nome da loja
  const lojaTexto = primeiro(b, 'loja');
  const lojaPedida = Object.entries(LOJAS).find(([k]) => norm(lojaTexto).includes(k))?.[1];
  const detalhes = [
    ['Formulário', primeiro(b, 'formulario', 'form_name')],
    ['Campanha', primeiro(b, 'campanha', 'campaign_name')],
    ['Anúncio', primeiro(b, 'anuncio', 'ad_name')],
    ['Loja indicada', lojaTexto && !lojaPedida ? lojaTexto : ''],
    ['Data do casamento indicada', dataTexto && (!dataISO(dataTexto) || !/\d{4}/.test(dataTexto)) ? dataTexto : ''],
  ].filter(([, v]) => v).map(([k, v]) => `${k}: ${clip(v, 120)}`);
  // Perguntas do formulário sem campo próprio no CRM ficam nas notas, como "pergunta: resposta"
  const conhecidos = new Set(['nome', 'full_name', 'name', 'tel', 'telefone', 'phone_number', 'phone', 'email',
    'meta_lead_id', 'leadgen_id', 'lead_id', 'data_casamento', 'data_do_casamento', 'casamento', 'wedding_date', 'localidade', 'city', 'cidade',
    'plataforma', 'platform', 'loja', 'formulario', 'form_name', 'campanha', 'campaign_name', 'anuncio', 'ad_name', 'origem', 'notas', 'key']);
  Object.entries(original).filter(([k, v]) => !conhecidos.has(chaveNorm(k)) && v != null && typeof v !== 'object' && String(v).trim())
    .slice(0, 30).forEach(([k, v]) => detalhes.push(`${clip(k.replace(/_/g, ' '), 80)}: ${clip(v, 300)}`));
  const hoje = new Date().toISOString().split('T')[0];
  const lead = {
    id: Date.now().toString(),
    nome, tel, email,
    casamento: dataISO(dataTexto),
    localidade,
    loja: lojaPedida || LOJAS[norm(localidade)] || '',
    origem: clip(primeiro(b, 'origem'), 40) || (/^(ig|instagram)/.test(plataforma) ? 'Instagram' : 'Facebook'),
    estado: 'novo',
    notas: [`Lead do formulário do Meta.`, detalhes.join(' · '), clip(primeiro(b, 'notas'), 1000)].filter(Boolean).join(' '),
    criado: hoje,
    atualizado: hoje,
    recebidoTs: Date.now(),
    ...(metaLeadId && { metaLeadId }),
  };
  try {
    let duplicado = false;
    await withLock(async () => {
      const data = await getDB();
      // o Pabbly pode reenviar a mesma lead: não duplicar
      duplicado = !!metaLeadId && [...(data.leads || []), ...(data.deals || [])].some(x => x.metaLeadId === metaLeadId);
      if (duplicado) return;
      data.leads = [...(data.leads || []), lead];
      await setDB(data);
    });
    console.log(`📥 Lead do Meta${duplicado ? ' (repetida, ignorada)' : ''}: ${nome}`);
    res.json({ ok: true, duplicado });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erro ao guardar lead' }); }
});

app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`🚀 NoivosCRM em http://localhost:${PORT}`));
