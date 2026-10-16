'use strict';
/**
 * Mesmo contrato do Web App do Apps Script, agora em /api:
 *   POST /api?token=T                       validador (Make). Grava o caso na Mesa se for proposta.
 *   GET  /api?token=T&rota=casos            lista de casos + cadastro de fornecedores (a Mesa lê daqui)
 *   POST /api?token=T&rota=acao             ações da Mesa: val1 | approve | reject | sendrec | retry
 *   GET  /api?token=T&rota=fornecedores|lojas|condicoes[&status=]   ERP simulado (consultas)
 *   POST /api?token=T&rota=limpar           zera os dados da demonstração (só TOKEN)
 *   GET  /api?rota=ping                     saúde (sem token)
 */
const crypto = require('crypto');
const mesa = require('../lib/mesa');

const igual = (a, b) => {
  if (!a || !b) return false;
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
function autorizado(token, escopoMesa) {
  const t = process.env.TOKEN, tm = process.env.TOKEN_MESA;
  return igual(token, t) || (escopoMesa && igual(token, tm));
}
function lerCorpo(req) {
  let b = req.body;
  if (Buffer.isBuffer(b)) b = b.toString('utf8');
  if (typeof b === 'string') { if (!b.trim()) return {}; return JSON.parse(b); } // Mesa envia text/plain; Make envia JSON
  return b || {};
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  const token = q.token || req.headers['x-token'] || '';
  try {
    if (q.rota === 'ping') return res.status(200).json({ ok: true, armazenamento: mesa.store.REMOTO ? 'redis' : 'memoria (nao persiste na Vercel)' });

    if (req.method === 'POST') {
      let corpo;
      try { corpo = lerCorpo(req); } catch (e) { return res.status(200).json({ error: 'JSON inválido' }); }
      const rota = q.rota || corpo.rota || 'validar';
      if (!autorizado(token, rota === 'acao')) return res.status(401).json({ error: 'nao autorizado' });
      if (rota === 'acao') return res.status(200).json(await mesa.executarAcao(corpo));
      if (rota === 'limpar') { await mesa.store.limparTudo(); return res.status(200).json({ ok: true }); }
      return res.status(200).json(await mesa.processarValidacao(corpo));
    }

    if (req.method === 'GET') {
      const mesaScope = q.rota === 'casos';
      if (!autorizado(token, mesaScope)) return res.status(401).json({ error: 'nao autorizado' });
      if (q.rota === 'fornecedores') return res.status(200).json(mesa.ERP_FORNECEDORES);
      if (q.rota === 'lojas') return res.status(200).json(mesa.ERP_LOJAS);
      if (q.rota === 'condicoes') {
        const status = q.status || 'VIGENTE';
        const itens = await mesa.erpCondicoes(status);
        return res.status(200).json({ consultado_em: new Date().toISOString(), filtro: { status }, total: itens.length, itens });
      }
      if (mesaScope) {
        const casos = (await mesa.lerCasos()).map(mesa.paraMesa).sort((a, b) => (a.recebido < b.recebido ? 1 : -1));
        const fornecedores = {};
        mesa.ERP_FORNECEDORES.itens.forEach((f) => { fornecedores[f.cod_fornecedor] = { nome: f.razao_social, cnpj: f.cnpj, status: f.status }; });
        return res.status(200).json({ ok: true, agora: new Date().toISOString(), sups: fornecedores, casos });
      }
      return res.status(200).json({ error: 'rota desconhecida', rotas: ['fornecedores', 'lojas', 'condicoes', 'casos'] });
    }
    return res.status(405).json({ error: 'método não permitido' });
  } catch (err) {
    return res.status(200).json({ error: String(err.message || err) });
  }
};
