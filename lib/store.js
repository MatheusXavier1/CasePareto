'use strict';
/**
 * Armazenamento da Mesa (substitui a planilha do Apps Script).
 * Backend: Upstash Redis via REST (integração "Upstash for Redis" do Marketplace da Vercel).
 * Sem variáveis de ambiente, cai para memória do processo (serve só para teste local; na Vercel não persiste).
 */
const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const TOKEN_ = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const REMOTO = !!(URL_ && TOKEN_);
const P = 'cp:';

// ---------- fallback em memória (só para desenvolvimento local) ----------
const mem = { h: new Map(), l: new Map(), s: new Map() };
const memHash = (k) => { if (!mem.h.has(k)) mem.h.set(k, new Map()); return mem.h.get(k); };
const memList = (k) => { if (!mem.l.has(k)) mem.l.set(k, []); return mem.l.get(k); };
function memCmd(a) {
  const [c, k, ...r] = a;
  switch (String(c).toUpperCase()) {
    case 'HGETALL': { const o = []; memHash(k).forEach((v, f) => o.push(f, v)); return o; }
    case 'HGET': return memHash(k).get(r[0]) ?? null;
    case 'HSET': memHash(k).set(r[0], String(r[1])); return 1;
    case 'SETNX': if (mem.s.has(k)) return 0; mem.s.set(k, String(r[0])); return 1;
    case 'INCR': { const n = Number(mem.s.get(k) || 0) + 1; mem.s.set(k, String(n)); return n; }
    case 'RPUSH': memList(k).push(String(r[0])); return memList(k).length;
    case 'LRANGE': { const l = memList(k); const ini = Number(r[0]) < 0 ? Math.max(0, l.length + Number(r[0])) : Number(r[0]); const fim = Number(r[1]) < 0 ? l.length + Number(r[1]) : Number(r[1]); return l.slice(ini, fim + 1); }
    case 'LTRIM': { const l = memList(k); const ini = Number(r[0]) < 0 ? Math.max(0, l.length + Number(r[0])) : Number(r[0]); mem.l.set(k, l.slice(ini)); return 'OK'; }
    case 'SET': {
      const nx = r.map(String).includes('NX');
      if (nx && mem.s.has(k)) return null;
      mem.s.set(k, String(r[0]));
      const px = r.indexOf('PX'); if (px >= 0) setTimeout(() => { if (mem.s.get(k) === String(r[0])) mem.s.delete(k); }, Number(r[px + 1])).unref?.();
      return 'OK';
    }
    case 'GET': return mem.s.get(k) ?? null;
    case 'DEL': mem.h.delete(k); mem.l.delete(k); mem.s.delete(k); return 1;
    default: throw new Error('comando não suportado no modo memória: ' + c);
  }
}

async function cmd(...args) {
  if (!REMOTO) return memCmd(args);
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error('Redis: ' + (j.error || r.status));
  return j.result;
}

const pares = (flat) => { const o = {}; for (let i = 0; i < (flat || []).length; i += 2) o[flat[i]] = flat[i + 1]; return o; };
const asJson = (s) => (typeof s === 'string' ? JSON.parse(s) : s);

// ---------- casos ----------
async function lerCasos() {
  return Object.values(pares(await cmd('HGETALL', P + 'casos'))).map(asJson);
}
async function lerCaso(id) {
  const v = await cmd('HGET', P + 'casos', id);
  return v ? asJson(v) : null;
}
async function gravarCaso(c) {
  const aud = c._aud || []; delete c._aud;
  await cmd('HSET', P + 'casos', c.id, JSON.stringify(c));
  for (const a of aud) await cmd('RPUSH', P + 'auditoria', JSON.stringify(a));
  if (aud.length) await cmd('LTRIM', P + 'auditoria', -5000, -1);
}
async function proximoId() {
  await cmd('SETNX', P + 'contador', 1037);
  return 'C-' + (await cmd('INCR', P + 'contador'));
}

// ---------- ERP simulado ----------
async function erpLogUltimos(n) {
  return ((await cmd('LRANGE', P + 'erp_log', -n, -1)) || []).map(asJson);
}
async function erpLogAdd(entrada) {
  await cmd('RPUSH', P + 'erp_log', JSON.stringify(entrada));
  await cmd('LTRIM', P + 'erp_log', -500, -1);
}
async function erpNovasLer() {
  return ((await cmd('LRANGE', P + 'erp_novas', 0, -1)) || []).map(asJson);
}
async function erpNovaAdd(c) { await cmd('RPUSH', P + 'erp_novas', JSON.stringify(c)); }
async function erpAjustesLer() {
  const o = pares(await cmd('HGETALL', P + 'erp_ajustes')); const r = {};
  Object.keys(o).forEach((k) => { r[k] = asJson(o[k]); });
  return r;
}
async function erpAjusteSet(cod, data_fim, status) {
  await cmd('HSET', P + 'erp_ajustes', cod, JSON.stringify({ data_fim, status }));
}

// ---------- lock (substitui o LockService) ----------
async function comLock(fn) {
  const chave = P + 'lock'; const dono = Math.random().toString(36).slice(2);
  const fim = Date.now() + 25000;
  while ((await cmd('SET', chave, dono, 'NX', 'PX', 30000)) !== 'OK') {
    if (Date.now() > fim) throw new Error('sistema ocupado, tente de novo');
    await new Promise((r) => setTimeout(r, 150));
  }
  try { return await fn(); } finally {
    try { if ((await cmd('GET', chave)) === dono) await cmd('DEL', chave); } catch (e) { /* o lock expira sozinho */ }
  }
}

// Zera os dados da demonstração (rota protegida pelo TOKEN).
async function limparTudo() {
  for (const k of ['casos', 'auditoria', 'erp_log', 'erp_novas', 'erp_ajustes', 'contador', 'lock']) await cmd('DEL', P + k);
}

module.exports = {
  REMOTO, lerCasos, lerCaso, gravarCaso, proximoId,
  erpLogUltimos, erpLogAdd, erpNovasLer, erpNovaAdd, erpAjustesLer, erpAjusteSet, comLock, limparTudo,
};
