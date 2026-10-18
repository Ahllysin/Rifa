// Rifa online — servidor sem dependências (Node 18+). Rode: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Carrega o arquivo .env (se existir) para process.env
try {
  for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !l.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

// ====== CONFIGURAÇÃO (edite aqui ou use variáveis de ambiente) ======
const CFG = {
  titulo: process.env.TITULO || 'Rifa Solidária',
  premio: process.env.PREMIO || 'Prêmio: R$ 500,00 no PIX',
  descricao: process.env.DESCRICAO || '',       // texto curto sobre a rifa (opcional)
  dataSorteio: process.env.DATA_SORTEIO || '',  // ex.: 30/11/2026 às 20h (opcional)
  whatsapp: (process.env.WHATSAPP || '').replace(/\D/g, ''), // ex.: 5511999998888 (opcional)
  vendaDireta: +process.env.VENDA_DIRETA || 0,  // preço de venda direta do prêmio (0 = não está à venda)
  totalNumeros: +process.env.TOTAL || 100,
  preco: +process.env.PRECO || 10.0,           // valor por número (R$)
  pixChave: process.env.PIX_CHAVE || 'seu-email-ou-cpf-ou-telefone-aqui',
  pixNome: process.env.PIX_NOME || 'SEU NOME',  // até 25 caracteres, sem acento
  pixCidade: process.env.PIX_CIDADE || 'SAO PAULO',
  adminSenha: process.env.ADMIN_SENHA || 'troque-esta-senha',
  mpToken: process.env.MP_ACCESS_TOKEN || '',   // opcional: Mercado Pago (confirmação automática)
  mpWebhookSecret: process.env.MP_WEBHOOK_SECRET || '', // "assinatura secreta" do webhook (painel do MP)
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''), // ex.: https://minharifa.com.br
  reservaMin: process.env.MP_ACCESS_TOKEN ? 30 : 15, // PIX do MP expira no mínimo em 30 min
  porta: +process.env.PORT || 3000,
};
const DB_FILE = path.join(__dirname, 'data.json');
const PUBLIC = path.join(__dirname, 'public');

// ====== Armazenamento ======
// Local: arquivo data.json. Em hospedagem sem disco (Render grátis): Supabase,
// definindo SUPABASE_URL e SUPABASE_SERVICE_KEY (tabela criada com supabase.sql).
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const usaSupabase = !!(SB_URL && SB_KEY);
// Chave antiga (JWT, começa com "eyJ") vai também em Authorization; a nova (sb_secret_...) só em apikey.
const sbH = () => ({ apikey: SB_KEY, ...(SB_KEY.startsWith('eyJ') ? { Authorization: 'Bearer ' + SB_KEY } : {}), 'Content-Type': 'application/json' });
let db = { orders: [] };

async function carregarDB() {
  if (!usaSupabase) { try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {} return; }
  const r = await fetch(`${SB_URL}/rest/v1/rifa_dados?id=eq.main&select=dados`, { headers: sbH() });
  if (!r.ok) throw new Error(`Supabase não respondeu ao carregar os dados (${r.status}): ${await r.text()}`);
  const l = await r.json();
  if (l[0]) db = l[0].dados;
}

let gravando = Promise.resolve(), naFila = false;
function save() {
  if (!usaSupabase) return fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  // Uma gravação por vez; a que está na fila sempre grava o estado mais recente.
  if (naFila) return;
  naFila = true;
  gravando = gravando.then(async () => {
    naFila = false;
    for (let t = 1; t <= 3; t++) {
      try {
        const r = await fetch(`${SB_URL}/rest/v1/rifa_dados`, {
          method: 'POST', headers: { ...sbH(), Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ id: 'main', dados: db, atualizado_em: new Date().toISOString() }),
        });
        if (r.ok) return;
        console.error('Supabase recusou a gravação:', r.status, await r.text());
      } catch (e) { console.error('Falha ao gravar no Supabase:', e.message); }
      await new Promise(x => setTimeout(x, 500 * t));
    }
  });
}
// A hospedagem manda SIGTERM ao reiniciar: termina de gravar antes de sair
process.on('SIGTERM', async () => { await gravando; process.exit(0); });

// Margem depois do prazo em que o número continua bloqueado, para cobrir pagamentos
// feitos no último segundo e a demora na confirmação do PIX.
const MARGEM_MS = 3 * 60000;
function expire() {
  const now = Date.now();
  for (const o of db.orders)
    if (o.status === 'pendente' && now > o.expiraEm + MARGEM_MS) o.status = 'expirado';
}
const taken = () => {
  expire();
  const s = new Set();
  for (const o of db.orders) if (o.status === 'pendente' || o.status === 'pago') o.numeros.forEach(n => s.add(n));
  return s;
};

// ====== PIX copia-e-cola (BR Code estático) ======
const tlv = (id, v) => id + String(v.length).padStart(2, '0') + v;
function crc16(s) {
  let c = 0xFFFF;
  for (let i = 0; i < s.length; i++) {
    c ^= s.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
  }
  return c.toString(16).toUpperCase().padStart(4, '0');
}
function pixPayload(valor, txid) {
  const clean = (s, n) => s.normalize('NFD').replace(/[^\x20-\x7E]/g, '').toUpperCase().slice(0, n);
  const p =
    tlv('00', '01') +
    tlv('26', tlv('00', 'br.gov.bcb.pix') + tlv('01', CFG.pixChave)) +
    tlv('52', '0000') + tlv('53', '986') +
    tlv('54', valor.toFixed(2)) + tlv('58', 'BR') +
    tlv('59', clean(CFG.pixNome, 25)) + tlv('60', clean(CFG.pixCidade, 15)) +
    tlv('62', tlv('05', txid)) + '6304';
  return p + crc16(p);
}

// ====== Mercado Pago (confirmação automática) ======
const MP = (process.env.MP_API || 'https://api.mercadopago.com') + '/v1/payments';
const mpHeaders = () => ({ Authorization: 'Bearer ' + CFG.mpToken });
// O MP exige data com fuso: 2026-10-14T16:00:00.000-03:00
const dataMP = ms => new Date(ms - 3 * 3600e3).toISOString().replace('Z', '-03:00');

async function mpCriarPix(order) {
  const r = await fetch(MP, {
    method: 'POST',
    headers: { ...mpHeaders(), 'Content-Type': 'application/json', 'X-Idempotency-Key': order.id },
    body: JSON.stringify({
      transaction_amount: order.valor,
      description: `${CFG.titulo} - números ${order.numeros.join(', ')}`.slice(0, 200),
      payment_method_id: 'pix',
      external_reference: order.id,
      date_of_expiration: dataMP(order.expiraEm),
      payer: { email: process.env.MP_EMAIL_PAGADOR || 'comprador@example.com', first_name: order.nome.split(' ')[0] },
      notification_url: CFG.publicUrl ? CFG.publicUrl + '/api/webhook/mp' : undefined,
    }),
  });
  const j = await r.json();
  if (!r.ok) {
    console.error('Mercado Pago recusou:', JSON.stringify(j));
    throw Object.assign(new Error('mp'), { publico: 'Não foi possível gerar o PIX agora. Tente novamente.' });
  }
  order.mpId = j.id;
  return j.point_of_interaction.transaction_data.qr_code;
}

// Consulta o pagamento direto na API do MP (nunca confia no corpo do webhook)
async function mpChecar(order) {
  if (!CFG.mpToken || !order.mpId || ['pago', 'conflito', 'reembolsado'].includes(order.status)) return;
  const r = await fetch(`${MP}/${order.mpId}`, { headers: mpHeaders() });
  if (!r.ok) return;
  const j = await r.json();
  if (j.status !== 'approved') return;
  // Confere se o pagamento é mesmo deste pedido e do valor certo
  if (j.external_reference !== order.id || Math.abs(j.transaction_amount - order.valor) > 0.001) {
    console.error('Pagamento MP divergente do pedido', order.id, j.id);
    return;
  }
  pagar(order);
}

// Devolve o valor total de um pagamento do Mercado Pago. Retorna { ok, id } ou { ok: false, erro }.
async function reembolsarMP(o) {
  const r = await fetch(`${MP}/${o.mpId}/refunds`, {
    method: 'POST', headers: { ...mpHeaders(), 'Content-Type': 'application/json', 'X-Idempotency-Key': 'reembolso-' + o.id }, body: '{}',
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('Reembolso recusado pelo MP:', r.status, JSON.stringify(j));
    return { ok: false, erro: j.message || j.error || String(r.status) };
  }
  return { ok: true, id: j.id };
}

// Valida a assinatura do webhook (header x-signature) quando MP_WEBHOOK_SECRET estiver definido
function mpAssinaturaOk(req, dataId) {
  if (!CFG.mpWebhookSecret) return true;
  const sig = String(req.headers['x-signature'] || '');
  const ts = (sig.match(/ts=([^,]+)/) || [])[1];
  const v1 = (sig.match(/v1=([^,]+)/) || [])[1];
  if (!ts || !v1) return false;
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${req.headers['x-request-id'] || ''};ts:${ts};`;
  const esperado = crypto.createHmac('sha256', CFG.mpWebhookSecret).update(manifest).digest('hex');
  const a = Buffer.from(esperado), b = Buffer.from(v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function gerarCodigo() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = () => Array.from(crypto.randomBytes(4), b => a[b % a.length]).join('');
  return `RIFA-${part()}-${part()}`;
}
function pagar(order) {
  if (order.status === 'pago') return;
  // Rifa encerrada: pagamento que chegar agora precisa ser devolvido
  if (db.encerrada) { order.status = 'conflito'; save(); return; }
  // Se o prazo expirou, só confirma se os números ainda estiverem livres
  if (order.status === 'expirado' || order.status === 'cancelado') {
    const t = taken();
    if (order.numeros.some(n => t.has(n))) {
      // Pagou depois do prazo e alguém já levou o número: precisa de reembolso manual
      order.status = 'conflito';
      save();
      return;
    }
  }
  order.status = 'pago';
  order.codigo = gerarCodigo();
  order.pagoEm = Date.now();
  save();
}

// ====== Limite de tentativas por IP (em memória) ======
const hits = new Map();
function limitado(chave, max, janelaMs) {
  const agora = Date.now();
  const l = (hits.get(chave) || []).filter(t => agora - t < janelaMs);
  l.push(agora); hits.set(chave, l);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || agora - v[v.length - 1] > janelaMs) hits.delete(k);
  return l.length > max;
}
// Atrás de proxy (Render, Railway...) defina TRUST_PROXY com o número de proxies confiáveis (normalmente 1).
// O cliente pode forjar o começo do X-Forwarded-For; só vale o que os NOSSOS proxies acrescentam no fim da lista,
// por isso contamos a partir da direita.
const ipDe = req => {
  const n = parseInt(process.env.TRUST_PROXY, 10) || (process.env.TRUST_PROXY ? 1 : 0);
  if (!n) return req.socket.remoteAddress;
  const l = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
  return l[l.length - n] || req.socket.remoteAddress;
};

// ====== Admin só nos IPs autorizados (ADMIN_IPS=ip1,ip2) ======
const normIp = s => String(s || '').replace(/^::ffff:/, '').trim();
const ADMIN_IPS = (process.env.ADMIN_IPS || '').split(',').map(normIp).filter(Boolean);
const ipAdminOk = ip => !ADMIN_IPS.length || ['127.0.0.1', '::1'].includes(normIp(ip)) || ADMIN_IPS.includes(normIp(ip));

// Dispositivos autorizados (ex.: celular): quem pareou fica liberado em qualquer IP.
// O pareamento é feito de um IP autorizado, por link de uso único. No banco só guardamos o hash do token.
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const cookieDe = (req, nome) => (String(req.headers.cookie || '').split(/;\s*/).map(c => c.split('=')).find(([k]) => k === nome) || [])[1];
const dispositivoOk = req => { const t = cookieDe(req, 'adm_dev'); return !!t && (db.dispositivos || []).some(d => d.hash === sha(t)); };
const acessoAdmin = (req, ip) => ipAdminOk(ip) || dispositivoOk(req);
const pareamentos = new Map();   // código de uso único -> expira em (ms)
const negarAdmin = (res, ip, p) => {
  console.log(`Admin negado para o IP ${ip} (${p}). Se for você, adicione esse IP em ADMIN_IPS.`);
  res.writeHead(404); res.end('Não encontrado');
};

// ====== HTTP ======
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};
const body = req => new Promise(ok => {
  let d = '';
  req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); });
  req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch { ok({}); } });
});
const isAdmin = req => (req.headers.authorization || '') === 'Bearer ' + CFG.adminSenha;
const publico = o => ({
  id: o.id, status: o.status, numeros: o.numeros, valor: o.valor, nome: o.nome,
  expiraEm: o.expiraEm, pix: o.pix, codigo: o.status === 'pago' ? o.codigo : undefined,
});

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
};

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = ipDe(req);
  try {
    // Painel e API do admin: invisíveis para qualquer IP fora da lista
    if ((p.startsWith('/api/admin/') || p === '/admin' || p === '/admin.html') && !acessoAdmin(req, ip)) return negarAdmin(res, ip, p);

    // Link de pareamento do celular (aberto no aparelho a autorizar)
    if (p === '/admin/parear' && req.method === 'GET') {
      const c = url.searchParams.get('c') || '';
      const exp = pareamentos.get(c);
      pareamentos.delete(c);   // uso único
      if (limitado('par:' + ip, 10, 10 * 60000) || !exp || Date.now() > exp) { res.writeHead(404); return res.end('Link inválido ou expirado.'); }
      const token = crypto.randomBytes(32).toString('hex');
      (db.dispositivos = db.dispositivos || []).push({
        hash: sha(token), nome: String(req.headers['user-agent'] || 'Dispositivo').slice(0, 90), criadoEm: Date.now(),
      });
      save();
      const https = process.env.TRUST_PROXY ? req.headers['x-forwarded-proto'] === 'https' : !!req.socket.encrypted;
      res.writeHead(302, {
        'Set-Cookie': `adm_dev=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${365 * 86400}${https ? '; Secure' : ''}`,
        Location: '/admin',
      });
      return res.end();
    }
    // Reservas: evita que alguém bloqueie todos os números repetindo pedidos
    if (p === '/api/reservar' && req.method === 'POST' && limitado('res:' + ip, 8, 10 * 60000))
      return json(res, 429, { erro: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.' });
    // Consulta de código: evita adivinhar códigos
    if (p === '/api/consulta' && limitado('con:' + ip, 20, 10 * 60000))
      return json(res, 429, { erro: 'Muitas consultas. Aguarde alguns minutos.' });
    // Admin: bloqueia quem erra a senha várias vezes
    if (p.startsWith('/api/admin/')) {
      const f = (hits.get('adm:' + ip) || []).filter(t => Date.now() - t < 15 * 60000).length;
      // IP bloqueado: recusa até com a senha certa, senão o limite não frearia tentativas em massa
      if (f >= 8) return json(res, 429, { erro: 'Muitas tentativas. Aguarde 15 minutos.' });
      if (!isAdmin(req)) { limitado('adm:' + ip, 8, 15 * 60000); return json(res, 401, { erro: 'Senha incorreta' }); }
    }
    if (p === '/api/rifa' && req.method === 'GET') {
      const ocupados = [...taken()];
      const vendidos = new Set(db.orders.filter(o => o.status === 'pago').flatMap(o => o.numeros)).size;
      return json(res, 200, {
        titulo: CFG.titulo, premio: CFG.premio, descricao: CFG.descricao, dataSorteio: CFG.dataSorteio,
        whatsapp: CFG.whatsapp, vendaDireta: CFG.vendaDireta, total: CFG.totalNumeros, preco: CFG.preco, reservaMin: CFG.reservaMin,
        ocupados, vendidos, encerrada: db.encerrada || null,
      });
    }
    if (p === '/api/reservar' && req.method === 'POST' && db.encerrada)
      return json(res, 403, { erro: 'Esta rifa foi encerrada e não aceita novas compras.' });
    if (p === '/api/reservar' && req.method === 'POST') {
      const b = await body(req);
      const nome = String(b.nome || '').trim().slice(0, 80);
      const telefone = String(b.telefone || '').replace(/\D/g, '').slice(0, 13);
      const numeros = [...new Set((b.numeros || []).map(Number))]
        .filter(n => Number.isInteger(n) && n >= 1 && n <= CFG.totalNumeros);
      if (!nome || telefone.length < 10) return json(res, 400, { erro: 'Informe nome e WhatsApp válidos.' });
      if (!numeros.length || numeros.length > 20) return json(res, 400, { erro: 'Escolha de 1 a 20 números.' });
      const t = taken();
      const ocup = numeros.filter(n => t.has(n));
      if (ocup.length) return json(res, 409, { erro: `Número(s) já ocupado(s): ${ocup.join(', ')}`, ocupados: ocup });
      const order = {
        id: crypto.randomBytes(8).toString('hex'), nome, telefone, numeros: numeros.sort((a, b) => a - b),
        valor: +(numeros.length * CFG.preco).toFixed(2), status: 'pendente',
        criadoEm: Date.now(), expiraEm: Date.now() + CFG.reservaMin * 60000,
      };
      order.pix = CFG.mpToken ? await mpCriarPix(order) : pixPayload(order.valor, order.id.slice(0, 16));
      db.orders.push(order); save();
      return json(res, 200, publico(order));
    }
    let m;
    if ((m = p.match(/^\/api\/pedido\/(\w+)$/)) && req.method === 'GET') {
      expire();
      const o = db.orders.find(x => x.id === m[1]);
      if (!o) return json(res, 404, { erro: 'Pedido não encontrado' });
      await mpChecar(o);
      return json(res, 200, publico(o));
    }
    if (p === '/api/consulta' && req.method === 'GET') {
      const c = (url.searchParams.get('codigo') || '').toUpperCase().trim();
      const o = db.orders.find(x => x.codigo === c && x.status === 'pago');
      return o ? json(res, 200, { codigo: o.codigo, nome: o.nome, numeros: o.numeros }) : json(res, 404, { erro: 'Código não encontrado' });
    }
    if (p === '/api/webhook/mp' && req.method === 'POST') {
      const b = await body(req);
      const id = url.searchParams.get('data.id') || b?.data?.id;
      if (!id || !mpAssinaturaOk(req, id)) { res.writeHead(401); return res.end('assinatura inválida'); }
      const o = db.orders.find(x => String(x.mpId) === String(id));
      if (o) await mpChecar(o);   // confere direto na API do MP, não confia no corpo
      res.writeHead(200); return res.end('ok');
    }
    // ---- Admin ----
    if (p === '/api/admin/pedidos' && req.method === 'GET') {
      if (!isAdmin(req)) return json(res, 401, { erro: 'Senha incorreta' });
      expire();
      return json(res, 200, db.orders.slice().reverse());
    }
    if ((m = p.match(/^\/api\/admin\/confirmar\/(\w+)$/)) && req.method === 'POST') {
      if (!isAdmin(req)) return json(res, 401, { erro: 'Senha incorreta' });
      const o = db.orders.find(x => x.id === m[1]);
      if (!o) return json(res, 404, { erro: 'Pedido não encontrado' });
      pagar(o);
      return json(res, 200, o);
    }
    if (p === '/api/admin/venda' && req.method === 'POST') {   // venda manual (dinheiro, PIX direto etc.)
      if (db.encerrada) return json(res, 400, { erro: 'A rifa está encerrada. Reabra para registrar vendas.' });
      if (!isAdmin(req)) return json(res, 401, { erro: 'Senha incorreta' });
      const b = await body(req);
      const nome = String(b.nome || '').trim().slice(0, 80);
      const telefone = String(b.telefone || '').replace(/\D/g, '').slice(0, 13);
      const numeros = [...new Set((b.numeros || []).map(Number))]
        .filter(n => Number.isInteger(n) && n >= 1 && n <= CFG.totalNumeros).sort((a, c) => a - c);
      if (!nome || !numeros.length) return json(res, 400, { erro: 'Informe o nome e ao menos um número válido.' });
      const t = taken();
      const ocup = numeros.filter(n => t.has(n));
      if (ocup.length) return json(res, 409, { erro: `Número(s) já ocupado(s): ${ocup.join(', ')}` });
      const agora = Date.now();
      const order = {
        id: crypto.randomBytes(8).toString('hex'), nome, telefone, numeros,
        valor: +(numeros.length * CFG.preco).toFixed(2), status: 'pago', origem: 'manual',
        criadoEm: agora, expiraEm: agora, pagoEm: agora, codigo: gerarCodigo(),
      };
      db.orders.push(order); save();
      return json(res, 200, order);
    }
    if ((m = p.match(/^\/api\/admin\/cancelar\/(\w+)$/)) && req.method === 'POST') {   // libera os números
      if (!isAdmin(req)) return json(res, 401, { erro: 'Senha incorreta' });
      const o = db.orders.find(x => x.id === m[1]);
      if (!o) return json(res, 404, { erro: 'Pedido não encontrado' });
      if (o.status === 'pago') return json(res, 400, { erro: 'Pedido já pago não pode ser cancelado aqui.' });
      o.status = 'cancelado'; save();
      return json(res, 200, o);
    }
    if ((m = p.match(/^\/api\/admin\/reembolsar\/(\w+)$/)) && req.method === 'POST') {   // devolve o valor e libera os números
      const o = db.orders.find(x => x.id === m[1]);
      if (!o) return json(res, 404, { erro: 'Pedido não encontrado' });
      if (o.status !== 'pago' && o.status !== 'conflito') return json(res, 400, { erro: 'Só dá para reembolsar compras já pagas.' });
      const b = await body(req);
      if (o.mpId && CFG.mpToken) {
        const r = await reembolsarMP(o);
        if (!r.ok) return json(res, 502, { erro: 'O Mercado Pago não aceitou o reembolso: ' + r.erro });
        o.reembolsoMpId = r.id;
      } else if (!b.manual) {
        return json(res, 400, { erro: 'Esta compra não foi paga pelo Mercado Pago (venda manual). Devolva o valor por fora e confirme a opção manual.' });
      }
      o.status = 'reembolsado'; o.reembolsoEm = Date.now(); save();
      return json(res, 200, o);
    }
    if (p === '/api/admin/reembolsar-todos' && req.method === 'POST') {   // encerra a rifa e devolve tudo
      const b = await body(req);
      if (String(b.confirmacao || '').trim().toUpperCase() !== 'REEMBOLSAR TODOS') return json(res, 400, { erro: 'Confirmação incorreta.' });
      db.encerrada = {
        motivo: String(b.motivo || '').trim().slice(0, 200) || 'A conta foi vendida. Todos os valores foram devolvidos.',
        em: (db.encerrada && db.encerrada.em) || Date.now(),
      };
      for (const o of db.orders) if (o.status === 'pendente') o.status = 'cancelado';   // libera reservas em aberto
      save();
      const alvo = db.orders.filter(o => o.status === 'pago' || (o.status === 'conflito' && o.mpId));
      const out = { total: alvo.length, reembolsados: 0, valor: 0, manuais: [], falhas: [] };
      for (let i = 0; i < alvo.length; i += 5) {
        await Promise.all(alvo.slice(i, i + 5).map(async o => {
          if (!(o.mpId && CFG.mpToken)) { out.manuais.push({ nome: o.nome, telefone: o.telefone, valor: o.valor }); return; }
          try {
            const r = await reembolsarMP(o);
            if (!r.ok) return out.falhas.push({ nome: o.nome, telefone: o.telefone, valor: o.valor, erro: r.erro });
            o.status = 'reembolsado'; o.reembolsoEm = Date.now(); o.reembolsoMpId = r.id;
            out.reembolsados++; out.valor += o.valor;
          } catch (e) { out.falhas.push({ nome: o.nome, telefone: o.telefone, valor: o.valor, erro: e.message }); }
        }));
      }
      save();
      return json(res, 200, out);
    }
    if (p === '/api/admin/reabrir' && req.method === 'POST') {
      db.encerrada = null; save();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/admin/sortear' && req.method === 'POST') {   // sorteia entre os números pagos
      if (!isAdmin(req)) return json(res, 401, { erro: 'Senha incorreta' });
      const todos = db.orders.filter(o => o.status === 'pago').flatMap(o => o.numeros.map(n => ({ n, o })));
      if (!todos.length) return json(res, 400, { erro: 'Ainda não há números pagos.' });
      const { n, o } = todos[crypto.randomInt(todos.length)];
      const r = { numero: n, pedidoId: o.id, nome: o.nome, telefone: o.telefone, codigo: o.codigo, entre: todos.length, em: Date.now() };
      (db.sorteios = db.sorteios || []).push(r); save();
      return json(res, 200, r);
    }
    if (p === '/api/admin/parear' && req.method === 'POST') {   // gera link de uso único (10 min) para autorizar o celular
      const codigo = crypto.randomBytes(16).toString('hex');
      pareamentos.set(codigo, Date.now() + 10 * 60000);
      const https = process.env.TRUST_PROXY ? req.headers['x-forwarded-proto'] === 'https' : !!req.socket.encrypted;
      return json(res, 200, { url: `${https ? 'https' : 'http'}://${req.headers.host}/admin/parear?c=${codigo}`, expiraEm: Date.now() + 10 * 60000 });
    }
    if (p === '/api/admin/dispositivos' && req.method === 'GET') {
      const meu = sha(cookieDe(req, 'adm_dev') || '');
      return json(res, 200, (db.dispositivos || []).map(d => ({ id: d.hash.slice(0, 12), nome: d.nome, criadoEm: d.criadoEm, atual: d.hash === meu })));
    }
    if ((m = p.match(/^\/api\/admin\/dispositivos\/revogar\/(\w+)$/)) && req.method === 'POST') {
      db.dispositivos = (db.dispositivos || []).filter(d => d.hash.slice(0, 12) !== m[1]); save();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/admin/sorteios' && req.method === 'GET') {
      if (!isAdmin(req)) return json(res, 401, { erro: 'Senha incorreta' });
      return json(res, 200, (db.sorteios || []).slice().reverse());
    }
    // ---- Arquivos estáticos ----
    let f = p === '/' ? '/index.html' : p === '/admin' ? '/admin.html' : p;
    const full = path.normalize(path.join(PUBLIC, f));
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404); return res.end('Não encontrado');
    }
    const ext = path.extname(full).toLowerCase(), tam = fs.statSync(full).size;
    const head = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
    if (ext !== '.html') head['Cache-Control'] = 'public, max-age=3600';
    // Pedaços do arquivo (Range): necessário para o vídeo avançar/voltar e tocar no iPhone
    const rg = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (rg && (rg[1] || rg[2])) {
      let ini = rg[1] ? +rg[1] : tam - +rg[2], fim = rg[1] && rg[2] ? +rg[2] : tam - 1;
      fim = Math.min(fim, tam - 1);
      if (ini < 0 || ini > fim) { res.writeHead(416, { 'Content-Range': `bytes */${tam}` }); return res.end(); }
      res.writeHead(206, { ...head, 'Content-Range': `bytes ${ini}-${fim}/${tam}`, 'Content-Length': fim - ini + 1 });
      return fs.createReadStream(full, { start: ini, end: fim }).pipe(res);
    }
    res.writeHead(200, { ...head, 'Content-Length': tam });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    if (!e.publico) console.error(e);
    json(res, 500, { erro: e.publico || 'Erro interno' });
  }
});

// Confere com o Mercado Pago os pedidos ainda sem confirmação (cobre webhook perdido ou site dormindo)
async function conferirPendentes() {
  const lim = Date.now() - 36 * 3600e3;
  for (const o of db.orders.filter(x => x.mpId && (x.status === 'pendente' || x.status === 'expirado') && x.criadoEm > lim)) {
    try { await mpChecar(o); } catch (e) { console.error('Conferência do pedido', o.id, e.message); }
  }
}

carregarDB().then(() => servidor.listen(CFG.porta, () => {
  console.log(`Rifa no ar: http://localhost:${CFG.porta}  |  Admin: http://localhost:${CFG.porta}/admin`);
  console.log(usaSupabase ? 'Dados no Supabase.' : 'Dados no arquivo data.json (local).');
  if (CFG.mpToken) { setInterval(conferirPendentes, 60000); conferirPendentes(); }
  if (CFG.adminSenha === 'troque-esta-senha') console.log('⚠ Troque ADMIN_SENHA antes de publicar!');
  if (CFG.mpToken) {
    console.log('Mercado Pago ligado (confirmação automática).');
    if (!CFG.publicUrl) console.log('⚠ Defina PUBLIC_URL para o webhook funcionar; sem ele só confirma enquanto o comprador está na página.');
    if (!CFG.mpWebhookSecret) console.log('⚠ Defina MP_WEBHOOK_SECRET para validar a assinatura do webhook.');
  } else console.log('Modo manual: você confirma os pagamentos em /admin (defina MP_ACCESS_TOKEN para automatizar).');
})).catch(e => { console.error('Não foi possível iniciar:', e.message); process.exit(1); });
