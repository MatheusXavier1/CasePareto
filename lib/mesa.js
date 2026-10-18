'use strict';
/**
 * Mesa de Condições: lógica do caso, ações das alçadas e ERP simulado (portado do Apps Script).
 * Armazenamento em lib/store.js (Redis). Tudo que toca o armazenamento é assíncrono.
 */
const crypto = require('crypto');
const store = require('./store');
const { validar, POLITICA, num, dataOk, diaAntes, tokensForn } = require('./validador');
const { ERP_FORNECEDORES, ERP_LOJAS, ERP_CONDICOES } = require('./erp-dados');
const { lerCasos, lerCaso, gravarCaso, proximoId, comLock } = store;

const getProp = (k) => process.env[k] || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const agoraIso = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date()).replace(' ', 'T') + '-03:00';
// Normaliza o horário de recebimento vindo do Make: sem fuso assume Brasília; inválido ou futuro vira "agora".
function normalizaRecebido(v) {
  if (!v) return new Date().toISOString();
  let s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s = s.replace(' ', 'T') + '-03:00';
  const d = new Date(s);
  if (isNaN(d) || d.getTime() > Date.now() + 60000) return new Date().toISOString();
  return d.toISOString();
}
function logar(c, quem, tipo, txt) {
  const t = agoraIso();
  c.log.push({ t, quem, tipo, txt });
  (c._aud = c._aud || []).push({ t, caso: c.id, quem, tipo, txt }); // gravado junto com o caso (auditoria)
}

const PERSONAS_SRV = {
  rev: { nome: 'Ana Souza', papel: 'Revisor comercial', level: null, matricula: '004501' },
  coord: { nome: 'Bruno Lima', papel: 'Coordenação', level: 'coord', matricula: '004502' },
  ger: { nome: 'Carla Mendes', papel: 'Gerência', level: 'ger', matricula: '004503' },
  dir: { nome: 'Diego Rocha', papel: 'Diretoria', level: 'dir', matricula: '004504' },
  com: { nome: 'Comitê de verba', papel: 'Comitê', level: 'com', matricula: '004505' },
};
const NIVEL_NOME = { coord: 'Coordenação', ger: 'Gerência', dir: 'Diretoria', com: 'Comitê' };
const ALCADA_MAP = { COORDENACAO_COMERCIAL: 'coord', GERENCIA_COMERCIAL: 'ger', DIRETORIA_COMERCIAL: 'dir', COMITE_COMERCIAL: 'com' };
const CATEGORIAS_NOME = { MEDICAMENTOS_REFERENCIA: 'Medicamentos de referência', GENERICOS: 'Genéricos', MIP: 'MIP (isentos de prescrição)',
  HIGIENE_BELEZA: 'Higiene e beleza', DERMOCOSMETICOS: 'Dermocosméticos', SUPLEMENTOS: 'Suplementos' };
// Pendências que um humano resolve na Validação 1. As demais DECISAO seguem para a alçada como alerta.
const TOLERADOS = new Set(['SOBREPOSICAO', 'TETO_EXCEDIDO_EXCECAO_SAZONAL', 'CONTRAPARTIDA_AUSENTE', 'CONTRAPARTIDA_LONGA', 'ORIGEM_AUSENTE']);
const CAMPO_MESA = { categoria: 'cat', valor: 'valor', vigencia_inicio: 'ini', vigencia_fim: 'fim', loja: 'loja' };
const MESA_CAMPO = { cat: 'categoria', valor: 'valor', ini: 'vigencia_inicio', fim: 'vigencia_fim', loja: 'loja' };
const escH = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtData = (s) => { if (!s) return '-'; const [a, b, c] = String(s).split('-'); return `${c}/${b}/${a}`; };
const brlTxt = (v) => 'R$ ' + Number(v).toLocaleString('pt-BR');
const clonar = (o) => JSON.parse(JSON.stringify(o));
const objeto = (x) => (typeof x === 'string' ? JSON.parse(x) : x);

// ---------- ERP simulado: consultas ----------
async function erpExtras() {
  return { novas: await store.erpNovasLer(), ajustes: await store.erpAjustesLer() };
}
async function erpCondicoes(status) {
  const ex = await erpExtras();
  const todas = [...clonar(ERP_CONDICOES.itens), ...ex.novas].map((c) => {
    const a = ex.ajustes[c.cod_condicao];
    return a ? { ...c, data_fim: a.data_fim, status: a.status, ultima_alteracao: agoraIso(), alterado_por: 'MESA' } : c;
  });
  return status ? todas.filter((c) => c.status === status) : todas;
}

// ---------- ERP simulado: POST /condicoes (contrato do README) ----------
function erpValidarCorpo(b) {
  const erros = []; const e = (campo, erro) => erros.push({ campo, erro });
  const obrig = ['cod_fornecedor', 'cod_categoria', 'tipo', 'lojas', 'data_inicio', 'data_fim', 'aprovador', 'origem'];
  const permitidos = new Set([...obrig, 'percentual', 'valor', 'contrapartida', 'cod_condicao_substituida']);
  if (!b || typeof b !== 'object' || Array.isArray(b)) return [{ campo: '(corpo)', erro: 'deve ser um objeto' }];
  obrig.forEach((k) => { if (b[k] == null) e(k, 'obrigatório'); });
  Object.keys(b).forEach((k) => { if (!permitidos.has(k)) e(k, 'campo não permitido'); });
  if (b.cod_fornecedor != null && !/^FORN-\d{3}$/.test(b.cod_fornecedor)) e('cod_fornecedor', 'formato inválido');
  if (b.cod_categoria != null && !CATEGORIAS_NOME[b.cod_categoria]) e('cod_categoria', 'categoria inválida');
  if (b.tipo != null && !['DESCONTO_PERCENTUAL', 'VERBA_EXPOSICAO'].includes(b.tipo)) e('tipo', 'tipo inválido');
  if (b.lojas != null) {
    if (!Array.isArray(b.lojas) || !b.lojas.length) e('lojas', 'deve ter ao menos 1 item');
    else b.lojas.forEach((l, i) => {
      if (!/^(LOJA-\d{3}|REDE)$/.test(l)) e(`lojas[${i}]`, 'formato inválido');
      else if (l !== 'REDE' && !ERP_LOJAS.itens.some((x) => x.cod_loja === l)) e(`lojas[${i}]`, `loja inexistente: ${l}`);
    });
  }
  const dec = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
  if (b.tipo === 'DESCONTO_PERCENTUAL') {
    if (b.percentual == null) e('percentual', 'obrigatório'); else if (!dec(b.percentual) || b.percentual > 100) e('percentual', 'deve ser > 0, <= 100, com até 2 casas');
    if (b.valor != null) e('valor', 'proibido em DESCONTO_PERCENTUAL');
  } else if (b.tipo === 'VERBA_EXPOSICAO') {
    if (b.valor == null) e('valor', 'obrigatório'); else if (!dec(b.valor)) e('valor', 'deve ser > 0, com até 2 casas');
    if (b.percentual != null) e('percentual', 'proibido em VERBA_EXPOSICAO');
  }
  ['data_inicio', 'data_fim'].forEach((k) => { if (b[k] != null && !dataOk(b[k])) e(k, 'data inválida (AAAA-MM-DD)'); });
  if (b.contrapartida != null && (typeof b.contrapartida !== 'string' || b.contrapartida.length > 500)) e('contrapartida', 'texto de até 500 caracteres');
  if (b.cod_condicao_substituida != null && !/^COND-\d{3}$/.test(b.cod_condicao_substituida)) e('cod_condicao_substituida', 'formato inválido');
  if (b.aprovador != null) {
    if (typeof b.aprovador !== 'object' || !b.aprovador.matricula) e('aprovador.matricula', 'obrigatório');
    if (typeof b.aprovador !== 'object' || !b.aprovador.nome) e('aprovador.nome', 'obrigatório');
  }
  if (b.origem != null) {
    if (typeof b.origem !== 'object' || b.origem.tipo !== 'EMAIL') e('origem.tipo', 'deve ser EMAIL');
    if (typeof b.origem !== 'object' || !b.origem.referencia) e('origem.referencia', 'obrigatório');
  }
  return erros;
}

// Retorna { status, body, headers?, replay? }. Ordem: idempotência, limite, manutenção, schema, regra de negócio.
async function erpPost(body, idem) {
  if (!idem) return { status: 400, body: { error: 'MISSING_IDEMPOTENCY_KEY', message: 'Header Idempotency-Key é obrigatório' } };
  const agora = Date.now();
  const rec = await store.erpLogUltimos(200);
  const igual = rec.find((r) => r[1] === idem && Number(r[2]) === 201);
  if (igual) return { status: 201, body: JSON.parse(igual[3]), replay: true };
  const regis = (status, resp) => store.erpLogAdd([agora, idem, status, JSON.stringify(resp)]);
  if (rec.filter((r) => agora - Number(r[0]) < 60000).length >= 10) {
    const resp = { error: 'RATE_LIMIT_EXCEEDED', message: 'Limite de requisições excedido' };
    await regis(429, resp); return { status: 429, body: resp, headers: { 'Retry-After': '60' } };
  }
  const sim = getProp('ERP_SIM') || 'normal';
  if (sim === 'falha' || (sim === 'normal' && Math.random() < 0.2)) {
    const resp = { error: 'SERVICE_UNAVAILABLE', message: 'Sistema em manutenção' };
    await regis(503, resp); return { status: 503, body: resp };
  }
  const campos = erpValidarCorpo(body);
  if (campos.length) { const resp = { error: 'VALIDATION_ERROR', message: 'Payload inválido', campos }; await regis(422, resp); return { status: 422, body: resp }; }
  const forn = ERP_FORNECEDORES.itens.find((f) => f.cod_fornecedor === body.cod_fornecedor);
  if (!forn || forn.status !== 'ATIVO') {
    const resp = { error: 'SUPPLIER_NOT_ACTIVE', message: 'Fornecedor não possui cadastro ativo' };
    await regis(422, resp); return { status: 422, body: resp };
  }
  const todas = await erpCondicoes(null);
  let subst = null;
  if (body.cod_condicao_substituida) {
    subst = todas.find((c) => c.cod_condicao === body.cod_condicao_substituida);
    if (!subst) {
      const resp = { error: 'VALIDATION_ERROR', message: 'Payload inválido', campos: [{ campo: 'cod_condicao_substituida', erro: 'condição inexistente' }] };
      await regis(422, resp); return { status: 422, body: resp };
    }
  }
  const maior = todas.reduce((m, c) => Math.max(m, Number(String(c.cod_condicao).slice(5))), 0);
  const cod = 'COND-' + String(maior + 1).padStart(3, '0');
  const criado = agoraIso();
  const nova = { cod_condicao: cod, cod_fornecedor: body.cod_fornecedor, cod_categoria: body.cod_categoria, tipo: body.tipo, lojas: body.lojas,
    data_inicio: body.data_inicio, data_fim: body.data_fim, status: 'VIGENTE', criado_em: criado, ultima_alteracao: criado,
    ...(body.tipo === 'DESCONTO_PERCENTUAL' ? { percentual: body.percentual } : { valor: body.valor }),
    ...(body.contrapartida ? { contrapartida: body.contrapartida } : {}), alterado_por: body.aprovador.matricula, origem: body.origem };
  await store.erpNovaAdd(nova);
  if (subst) {
    const fimNovo = diaAntes(body.data_inicio);
    const encerra = fimNovo < subst.data_inicio;
    await store.erpAjusteSet(subst.cod_condicao, encerra ? subst.data_fim : fimNovo, encerra ? 'ENCERRADA' : 'VIGENTE');
  }
  const resp = { cod_condicao: cod, status: 'VIGENTE', criado_em: criado };
  await regis(201, resp);
  return { status: 201, body: resp };
}

// ---------- montagem do caso no formato da Mesa ----------
function herdarLoja(ext) {
  const e = clonar(ext); let anterior = null;
  e.condicoes = (e.condicoes || []).map((c) => {
    const l = c.loja || { valor: null, confianca: 0, evidencia: null };
    if (l.valor != null && /mesmas lojas|nessas lojas|essas lojas|mesmas unidades/i.test(l.valor) && anterior)
      return { ...c, loja: { ...anterior, confianca: Math.min(l.confianca ?? 100, anterior.confianca ?? 100), evidencia: l.evidencia } };
    if (l.valor != null) anterior = l;
    return c;
  });
  return e;
}
function nomeRemetente(rem) {
  const s = String(rem || '').trim();
  const m = s.match(/^"?([^"<]+?)"?\s*</);
  if (m) return m[1].trim();
  return s.split('@')[0] || 'Fornecedor';
}
function candidatos(nomeCitado, resolvidoCod) {
  const cit = new Set(tokensForn(nomeCitado));
  const lista = ERP_FORNECEDORES.itens.map((f) => {
    const t = new Set(tokensForn(f.razao_social)); let inter = 0; cit.forEach((x) => { if (t.has(x)) inter++; });
    let sim = cit.size && t.size ? Math.round((200 * inter) / (cit.size + t.size)) : 0;
    if (f.cod_fornecedor === resolvidoCod) sim = Math.max(sim, 98);
    return { id: f.cod_fornecedor, sim };
  }).filter((x) => x.sim >= 30).sort((a, b) => b.sim - a.sim).slice(0, 3);
  return lista;
}
function supsParaMesa() {
  const o = {}; ERP_FORNECEDORES.itens.forEach((f) => { o[f.cod_fornecedor] = { nome: f.razao_social, cnpj: f.cnpj, status: f.status }; });
  return o;
}
// Marca no corpo do e-mail os trechos de evidência (a Mesa destaca ao passar o mouse no campo).
function corpoHtml(corpo, ext, resumoVazio) {
  const txt = String(corpo || '');
  if (!txt.trim()) return resumoVazio;
  const alvos = [];
  if (ext.fornecedor && ext.fornecedor.evidencia) alvos.push(['forn', ext.fornecedor.evidencia]);
  (ext.condicoes || []).forEach((c, i) => Object.keys(CAMPO_MESA).forEach((k) => {
    if (c[k] && c[k].evidencia) alvos.push([`i${i}_${CAMPO_MESA[k]}`, c[k].evidencia]);
  }));
  const faixas = [];
  alvos.forEach(([ev, trecho]) => {
    let ini = txt.indexOf(trecho), len = String(trecho).length;
    if (ini < 0) {
      const re = new RegExp(String(trecho).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
      const m = re.exec(txt); if (m) { ini = m.index; len = m[0].length; }
    }
    if (ini < 0 || len < 2) return;
    if (faixas.some((f) => ini < f.fim && f.ini < ini + len)) return;
    faixas.push({ ini, fim: ini + len, ev });
  });
  faixas.sort((a, b) => a.ini - b.ini);
  let h = '', pos = 0;
  faixas.forEach((f) => { h += escH(txt.slice(pos, f.ini)) + `<mark data-ev="${f.ev}">${escH(txt.slice(f.ini, f.fim))}</mark>`; pos = f.fim; });
  h += escH(txt.slice(pos));
  return '<p>' + h.replace(/\r?\n[ \t]*\r?\n/g, '</p><p>').replace(/\r?\n/g, '<br>') + '</p>';
}
const assinaturaConflitos = (vc) => (vc.conflitos || []).map((x) => `${x.cod_condicao}|${x.vigencia.join('-')}|${x.percentual ?? x.valor}`).sort().join(';');

async function validarCaso(c, ext) {
  return validar({ extracao: ext, fornecedores: ERP_FORNECEDORES, lojas: ERP_LOJAS, condicoes: { itens: await erpCondicoes('VIGENTE') },
    anexo_lojas: c.anexo || '', origem_referencia: c.origem, hoje: c.hoje });
}
function itemDeExtracao(ce, vc, anexoOk) {
  const campo = (k) => ce[k] || { valor: null, confianca: 0, evidencia: null };
  const tx = campo('loja').valor;
  const lojaIsenta = tx != null && (/^\s*rede\s*$/i.test(tx) || (anexoOk && /anex|planilha|arquivo|csv|tabela/i.test(tx)));
  const conf = {
    cat: campo('categoria').valor != null ? campo('categoria').confianca ?? 0 : 0,
    valor: campo('valor').valor != null ? campo('valor').confianca ?? 0 : 0,
    ini: campo('vigencia_inicio').valor != null ? campo('vigencia_inicio').confianca ?? 0 : 0,
    fim: campo('vigencia_fim').valor != null ? campo('vigencia_fim').confianca ?? 0 : 0,
    loja: lojaIsenta ? 100 : (tx != null ? campo('loja').confianca ?? 0 : 0),
  };
  // pendências que pedem conferência humana derrubam a confiança do campo para abaixo do corte
  (vc.issues || []).forEach((i) => {
    if (i.severidade === 'DECISAO' && !TOLERADOS.has(i.codigo) && CAMPO_MESA[i.campo]) conf[CAMPO_MESA[i.campo]] = Math.min(conf[CAMPO_MESA[i.campo]], 79);
  });
  const num_ = num(campo('valor').valor);
  return {
    tipo: campo('tipo').valor === 'VERBA' ? 'VERBA' : 'DESC',
    cat: campo('categoria').valor || '', valor: num_ == null ? '' : num_,
    ini: campo('vigencia_inicio').valor || '', fim: campo('vigencia_fim').valor || '', loja: tx || '',
    conf, status: 'novo', contrapartida: campo('contrapartida').valor || null,
  };
}

function montarChecks(it, vc, val) {
  const cods = new Set(vc.issues.map((i) => i.codigo));
  const tem = (...l) => l.some((x) => cods.has(x));
  const f = val.caso.fornecedor || {};
  const ok = f.cod_fornecedor && f.status === 'ATIVO';
  const checks = [
    { id: 'cadastro', nome: 'Fornecedor com cadastro ativo', ok: !!ok, det: f.razao_social ? (ok ? f.razao_social : `${f.razao_social} (${f.status})`) : 'Sem cadastro na base' },
    { id: 'vigencia', nome: 'Vigência de até 12 meses', ok: !tem('VIGENCIA_MAIOR_QUE_12_MESES', 'FIM_ANTES_DO_INICIO', 'DATA_INVALIDA'), det: `${fmtData(it.ini)} a ${fmtData(it.fim)}` },
    { id: 'retro', nome: 'Vigência não retroativa', ok: !tem('INICIO_ANTERIOR_AO_CADASTRO'), det: `Início em ${fmtData(it.ini)} (cadastro em ${fmtData(val.hoje)})` },
    { id: 'lojas', nome: 'Lojas identificadas no cadastro', ok: !tem('LOJAS_NAO_RESOLVIDAS', 'LOJA_INVALIDA', 'ANEXO_NAO_FORNECIDO'),
      det: vc.resumo.lojas ? (vc.resumo.lojas.length > 4 ? `${vc.resumo.lojas.length} lojas` : vc.resumo.lojas.join(', ')) : 'Não foi possível identificar' },
    { id: 'sobre', nome: 'Sem sobrepor condição vigente', ok: !tem('SOBREPOSICAO'), warn: tem('SOBREPOSICAO'),
      det: vc.conflitos.length ? `Conflita com ${vc.conflitos.map((x) => `${x.cod_condicao} (${fmtData(x.vigencia[0])} a ${fmtData(x.vigencia[1])})`).join(', ')}. A alçada decide.` : 'Nenhuma vigência conflitante no ERP' },
  ];
  if (it.tipo === 'DESC') {
    const t = POLITICA.tetos[it.cat];
    checks.push({ id: 'teto', nome: `Desconto dentro do teto da categoria${t ? ` (${t}%)` : ''}`, ok: !tem('TETO_EXCEDIDO', 'TETO_EXCEDIDO_EXCECAO_SAZONAL', 'DESCONTO_VEDADO'),
      warn: tem('TETO_EXCEDIDO_EXCECAO_SAZONAL'), det: tem('TETO_EXCEDIDO_EXCECAO_SAZONAL') ? `${it.valor}% só vale como campanha sazonal aprovada pelo Trade Marketing` : `${it.valor}% proposto` });
  } else {
    checks.push({ id: 'contrapartida', nome: 'Contrapartida descrita', ok: !tem('CONTRAPARTIDA_AUSENTE'), warn: tem('CONTRAPARTIDA_AUSENTE'), det: it.contrapartida ? String(it.contrapartida).slice(0, 120) : 'Não informada' });
  }
  return checks;
}

const TEXTO_RECUSA = {
  FORNECEDOR_NAO_ENCONTRADO: (c) => `Não localizamos cadastro ativo de "${c.fornTxt}" em nossa base. Para seguir com a proposta, pedimos o envio dos dados cadastrais (CNPJ, razão social e contato). Assim que o cadastro for concluído, retomamos a análise.`,
  FORNECEDOR_INATIVO: (c, it, i, val) => `O cadastro de ${val.caso.fornecedor.razao_social || c.fornTxt} está inativo em nossa base${i.detalhe && i.detalhe.motivo ? ` (${String(i.detalhe.motivo).toLowerCase()})` : ''}. Pedimos a regularização junto ao nosso Cadastro antes de seguirmos com a negociação.`,
  TETO_EXCEDIDO: (c, it) => `O desconto de ${it.valor}% proposto para ${CATEGORIAS_NOME[it.cat] || it.cat} excede o teto de ${POLITICA.tetos[it.cat]}% definido para a categoria. Podemos avaliar uma nova proposta com percentual de até ${POLITICA.tetos[it.cat]}%.`,
  DESCONTO_VEDADO: () => 'Descontos acima de 25% não são aceitos pela política comercial.',
  VIGENCIA_MAIOR_QUE_12_MESES: (c, it) => `A vigência proposta (${fmtData(it.ini)} a ${fmtData(it.fim)}) ultrapassa o limite de 12 meses. Podemos avaliar uma nova proposta com vigência de até 12 meses.`,
  INICIO_ANTERIOR_AO_CADASTRO: (c, it) => `A vigência proposta começa em ${fmtData(it.ini)}, antes da data do cadastro. A condição não pode ser retroativa. Pedimos uma nova data de início.`,
  FIM_ANTES_DO_INICIO: () => 'A data de fim informada é anterior à data de início. Pedimos o reenvio com as datas corrigidas.',
  DATA_INVALIDA: () => 'Não conseguimos interpretar as datas de vigência da proposta. Pedimos o reenvio com as datas no formato dia/mês/ano.',
  VALOR_INVALIDO: () => 'O valor informado na proposta não é válido (percentual entre 0 e 100, ou verba maior que zero, com até 2 casas decimais). Pedimos o reenvio.',
  LOJA_INVALIDA: (c, it, i) => `Há lojas citadas que não existem ou estão inativas em nosso cadastro${i.detalhe ? ` (${[].concat(i.detalhe).join(', ')})` : ''}. Pedimos o reenvio com as lojas corretas.`,
};
function redigirRecusa(c, it, vc, val) {
  const ts = [];
  const bloq = vc.issues.filter((i) => i.severidade === 'BLOQUEIO');
  bloq.forEach((i) => { const f = TEXTO_RECUSA[i.codigo]; const t = f ? f(c, it, i, val) : i.mensagem; if (!ts.includes(t)) ts.push(t); });
  if (!ts.length) ts.push('Não conseguimos identificar com segurança todos os dados da condição proposta (' + vc.issues.filter((i) => i.severidade === 'DECISAO').map((i) => i.mensagem).join('; ') + '). Pedimos o reenvio com as informações completas.');
  return { texto: ts.join('\n\n'), motivos: bloq.length ? bloq.map((i) => i.codigo) : ['DADOS_INSUFICIENTES'] };
}

// Aplica o resultado do validador: cada condição vai para recusa (a confirmar) ou para a alçada.
async function aplicarResultado(c, val) {
  c.stage = 'andamento';
  c.itens.forEach((it, i) => {
    const vc = val.condicoes[i];
    it.checks = montarChecks(it, vc, val);
    it.alertas = vc.issues.filter((x) => x.severidade !== 'BLOQUEIO').map((x) => ({ codigo: x.codigo, mensagem: x.mensagem }));
    it.conflitos = vc.conflitos; it.sugestao = vc.sugestao_substituicao; it.sig = assinaturaConflitos(vc); it.substituir = null;
    const rotulo = it.tipo === 'DESC' ? 'Desconto' : 'Verba';
    if (vc.status === 'BLOQUEADA' || !vc.payload_erp) {
      const r = redigirRecusa(c, it, vc, val);
      it.status = 'recusa_pendente'; it.motivos = r.motivos; it.draft = r.texto; it.alcada = null;
      logar(c, 'Regras', 'auto', `${rotulo} ${i + 1}: ${vc.issues.filter((x) => x.severidade === 'BLOQUEIO').length || 1} regra(s) não atendida(s) (${r.motivos.join(', ')}).`);
      logar(c, 'Rascunho de recusa', 'auto', `Montou o texto de recusa da condição ${i + 1} a partir da regra. Aguarda confirmação do revisor.`);
    } else {
      it.status = 'aguardando'; it.alcada = ALCADA_MAP[vc.alcada_necessaria];
      logar(c, 'Regras', 'auto', `${rotulo} ${i + 1}: regras atendidas${it.alertas.length ? ` (com ${it.alertas.length} alerta(s) para a alçada)` : ''}.`);
      logar(c, 'Roteamento', 'auto', `Condição ${i + 1} roteada para ${NIVEL_NOME[it.alcada]} (${it.tipo === 'DESC' ? it.valor + '%' : brlTxt(it.valor)}).`);
    }
  });
  await checkDone(c);
}

async function criarCaso(input, ext, val) {
  const extH = herdarLoja(ext);
  const anexo = input.anexo_lojas || '';
  const forn = val.caso.fornecedor || {};
  const fornecResolvido = !!forn.cod_fornecedor;
  const issuesCaso = (val.condicoes[0] ? val.condicoes[0].issues : []).filter((i) => /^(FORNECEDOR_|POSSIVEL_INJECAO)/.test(i.codigo) || (i.codigo === 'BAIXA_CONFIANCA' && i.campo === 'fornecedor'));
  const fornDuvida = issuesCaso.some((i) => ['FORNECEDOR_AMBIGUO', 'FORNECEDOR_CNPJ_NOME_DIVERGEM', 'BAIXA_CONFIANCA'].includes(i.codigo));
  const c = {
    id: await proximoId(), assunto: input.assunto || '(sem assunto)', remetente: input.remetente || '(remetente não informado)',
    assina: nomeRemetente(input.remetente), fornTxt: (ext.fornecedor && ext.fornecedor.nome_citado) || '(não identificado)',
    cands: candidatos(ext.fornecedor && ext.fornecedor.nome_citado, forn.cod_fornecedor), fornId: null,
    recebido: normalizaRecebido(input.recebido_em), hoje: val.hoje, origem: input.origem_referencia || null, anexo, ext: extH,
    stage: 'val1', skippedReview: false, log: [], resposta: null, revisao: [],
  };
  c.itens = extH.condicoes.map((ce, i) => itemDeExtracao(ce, val.condicoes[i], !!(anexo && String(anexo).length)));
  c.itens.forEach((it) => { it.orig = { cat: it.cat, valor: it.valor, ini: it.ini, fim: it.fim, loja: it.loja }; });
  c.body = corpoHtml(input.corpo, extH, `<p><i>O corpo do e-mail não foi enviado ao validador (campo "corpo"). Dados lidos pelo extrator:</i></p>` +
    c.itens.map((it, i) => `<p>• Condição ${i + 1}: ${it.tipo === 'DESC' ? 'desconto' : 'verba'} de ${escH(it.valor)} em ${escH(it.cat)}, ${escH(it.loja)}, de ${fmtData(it.ini)} a ${fmtData(it.fim)}.</p>`).join(''));
  logar(c, 'Porta de entrada', 'auto', `E-mail recebido de ${c.remetente} e caso ${c.id} aberto.`);
  logar(c, 'Agente Extrator', 'ia', `Leu o e-mail e extraiu ${c.itens.length} condição(ões), com confiança e evidência por campo.`);
  logar(c, 'Conciliador', 'auto', fornecResolvido ? `Fornecedor encontrado: ${forn.razao_social}.` : (c.cands.length ? `Encontrou ${c.cands.length} fornecedor(es) parecido(s) e não conseguiu decidir sozinho.` : 'Não encontrou fornecedor parecido na base.'));
  logar(c, 'Validador', 'auto', `Aplicou a política comercial e conferiu o cadastro do SAP: ${val.status_geral}.`);
  const revisar = !fornecResolvido || fornDuvida || val.condicoes.some((vc) => vc.issues.some((x) => x.severidade === 'DECISAO' && !TOLERADOS.has(x.codigo)));
  c.revisao = [...new Map(val.condicoes.flatMap((vc) => vc.issues).filter((x) => x.severidade === 'DECISAO' && !TOLERADOS.has(x.codigo)).map((x) => [x.codigo + '|' + x.campo + '|' + x.mensagem, { codigo: x.codigo, campo: x.campo, mensagem: x.mensagem }])).values()];
  if (revisar) {
    logar(c, 'Revisão', 'auto', 'Há campos ou fornecedor que o validador não fechou sozinho. Enviado para validação do revisor.');
  } else {
    c.fornId = forn.cod_fornecedor; c.skippedReview = true;
    logar(c, 'Revisão', 'auto', 'Tudo identificado com confiança. Revisão humana dispensada.');
    await aplicarResultado(c, val);
  }
  return c;
}

// ---------- processamento do que chega do Make ----------
async function processarValidacao(input) {
  if (!input.hoje && getProp('HOJE_FIXO')) input.hoje = getProp('HOJE_FIXO');
  const r = validar(input);
  if (r.status_geral === 'DESCARTAR' || input.gravar === false || input.gravar === 'false') return r;
  return await comLock(async () => {
    const ext = objeto(input.extracao);
    if (!(ext.condicoes || []).length) { r.caso_mesa = { id: null, motivo: 'sem condições extraídas' }; return r; }
    const origem = input.origem_referencia || null;
    const dup = origem && (await lerCasos()).find((x) => x.origem === origem);
    if (dup) { r.caso_mesa = { id: dup.id, duplicado: true }; return r; }
    const c = await criarCaso(input, ext, r); await gravarCaso(c);
    r.caso_mesa = { id: c.id, stage: c.stage };
    return r;
  });
}

// ---------- fim do caso e resposta ao fornecedor ----------
async function checkDone(c) {
  if (c.stage === 'fim') return;
  if (!c.itens.every((it) => ['concluido', 'recusa_enviada'].includes(it.status))) return;
  c.stage = 'fim';
  const ok = c.itens.filter((i) => i.status === 'concluido'), no = c.itens.filter((i) => i.status === 'recusa_enviada');
  c.resposta = { ok, no, t: agoraIso(), enviada: false };
  const url = getProp('MAKE_WEBHOOK_URL');
  if (!url) { logar(c, 'Log e aviso', 'auto', 'Histórico gravado. Resposta ao fornecedor montada (envio automático desligado: falta MAKE_WEBHOOK_URL).'); return; }
  try {
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caso: c.id, para: c.remetente, assunto: 'Re: ' + c.assunto, origem: c.origem, nome: c.assina,
        aprovadas: ok.map((i) => ({ tipo: i.tipo, categoria: i.cat, valor: i.valor, inicio: i.ini, fim: i.fim, cod_condicao: i.sap })),
        recusadas: no.map((i) => ({ tipo: i.tipo, categoria: i.cat, valor: i.valor, texto: i.recusaTexto })) }) });
    c.resposta.enviada = resp.status < 300;
    logar(c, 'Log e aviso', 'auto', c.resposta.enviada ? 'Histórico gravado e resposta enviada ao fornecedor (via Make).' : `Histórico gravado. O Make respondeu ${resp.status}; resposta ao fornecedor pendente.`);
  } catch (e) {
    logar(c, 'Log e aviso', 'auto', 'Histórico gravado. Falha ao acionar o Make; resposta ao fornecedor pendente.');
  }
}

// ---------- executor do cadastro no ERP ----------
async function enviarErp(c, i, por) {
  const it = c.itens[i];
  const val = await validarCaso(c, c.ext); const vc = val.condicoes[i];
  if (vc.status === 'BLOQUEADA' || !vc.payload_erp) {
    const r = redigirRecusa(c, it, vc, val);
    it.status = 'recusa_pendente'; it.motivos = r.motivos; it.draft = r.texto; it.checks = montarChecks(it, vc, val);
    logar(c, 'Validador', 'auto', `Nova checagem antes de gravar: a condição ${i + 1} deixou de atender a política (${r.motivos.join(', ')}). Não foi enviada ao SAP.`);
    return;
  }
  const sig = assinaturaConflitos(vc);
  if (sig !== it.sig) {
    it.sig = sig; it.conflitos = vc.conflitos; it.sugestao = vc.sugestao_substituicao; it.substituir = null; it.checks = montarChecks(it, vc, val);
    it.alertas = vc.issues.filter((x) => x.severidade !== 'BLOQUEIO').map((x) => ({ codigo: x.codigo, mensagem: x.mensagem }));
    it.status = 'aguardando'; it.alcada = ALCADA_MAP[vc.alcada_necessaria];
    logar(c, 'Validador', 'auto', `O SAP mudou desde a análise (condições conflitantes: ${sig || 'nenhuma'}). A condição ${i + 1} voltou para ${NIVEL_NOME[it.alcada]} reaprovar.`);
    return;
  }
  const payload = clonar(vc.payload_erp);
  payload.aprovador = { matricula: por.matricula, nome: por.nome };
  if (!payload.origem.referencia) payload.origem.referencia = c.id;
  if (it.substituir) payload.cod_condicao_substituida = it.substituir;
  it.idem = it.idem || crypto.randomUUID();
  it.aprovador = { matricula: por.matricula, nome: por.nome };
  let r = null;
  for (let t = 1; t <= 2; t++) {
    r = await erpPost(payload, it.idem);
    if (r.status !== 503) break;
    if (t < 2) await sleep(1200);
  }
  const n = i + 1;
  if (r.status === 201) {
    it.status = 'concluido'; it.sap = r.body.cod_condicao; it.erro = null;
    logar(c, 'SAP', 'erp', `Condição ${n} cadastrada no SAP (${it.sap})${r.replay ? '. A mesma chave de idempotência devolveu o cadastro original, sem duplicar' : ''}${it.substituir ? `. ${it.substituir} encerrada na véspera do início` : ''}.`);
  } else if (r.status === 422 && r.body.error === 'SUPPLIER_NOT_ACTIVE') {
    const rr = redigirRecusa(c, it, { issues: [{ severidade: 'BLOQUEIO', codigo: 'FORNECEDOR_INATIVO', mensagem: r.body.message, detalhe: null }] }, { caso: { fornecedor: { razao_social: c.fornTxt } } });
    it.status = 'recusa_pendente'; it.motivos = ['FORNECEDOR_INATIVO']; it.draft = rr.texto;
    logar(c, 'SAP', 'erp', `Condição ${n} recusada pelo SAP: fornecedor sem cadastro ativo. Texto de recusa montado para o revisor.`);
  } else {
    it.status = 'erro_erp';
    if (r.status === 429) it.erro = `SAP respondeu 429 (limite de requisições). Aguarde ${r.headers['Retry-After']} s e reenvie.`;
    else if (r.status === 503) it.erro = 'SAP respondeu 503 (sistema em manutenção) nas 2 tentativas. Reenvie em instantes.';
    else if (r.status === 400) it.erro = `SAP respondeu 400: ${r.body.message}.`;
    else it.erro = `SAP respondeu 422: ${(r.body.campos || []).map((x) => `${x.campo} ${x.erro}`).join('; ') || r.body.message}. Reenviar não resolve; acione o time técnico.`;
    logar(c, 'SAP', 'erp', `Falha ao cadastrar a condição ${n} (HTTP ${r.status}). Pendência aberta para o revisor.`);
  }
  await checkDone(c);
}

// ---------- ações da Mesa ----------
async function executarAcao(d) {
  const por = PERSONAS_SRV[d.persona];
  if (!por) return { ok: false, erro: 'perfil desconhecido' };
  const pn = `${por.nome} (${por.papel})`;
  return await comLock(async () => {
    const c = await lerCaso(d.id);
    if (!c) return { ok: false, erro: 'caso não encontrado' };
    const i = Number(d.i);
    const it = c.itens[i];
    const exigeItem = ['approve', 'reject', 'sendrec', 'retry'].includes(d.acao);
    if (exigeItem && !it) return { ok: false, erro: 'condição não encontrada' };
    let aviso = null;

    if (d.acao === 'val1') {
      if (c.stage !== 'val1') return { ok: false, erro: 'o caso não está em validação' };
      if (d.persona !== 'rev') return { ok: false, erro: 'só o revisor valida' };
      const fornId = d.fornId || null;
      const forn = fornId ? ERP_FORNECEDORES.itens.find((f) => f.cod_fornecedor === fornId) : null;
      if (fornId && !forn) return { ok: false, erro: 'fornecedor inexistente' };
      c.fornId = fornId;
      (d.edits || []).forEach((e) => { const x = c.itens[e.i]; if (x && MESA_CAMPO[e.p]) x[e.p] = e.p === 'valor' ? (e.v === '' ? '' : Number(e.v)) : e.v; });
      logar(c, pn, 'hum', `Validou os campos e escolheu o fornecedor: ${forn ? forn.razao_social : 'sem cadastro'}.`);
      const sus = (c.ext.alertas || []).some((a) => a.tipo === 'possivel_injecao');
      if (sus) logar(c, pn, 'hum', 'Revisou o alerta de instrução suspeita no e-mail (instruções ao sistema são ignoradas).');
      if (!forn) {
        c.stage = 'andamento';
        c.itens.forEach((x, k) => {
          x.status = 'recusa_pendente'; x.motivos = ['FORNECEDOR_NAO_ENCONTRADO']; x.alcada = null; x.checks = [{ id: 'cadastro', nome: 'Fornecedor com cadastro ativo', ok: false, det: 'Sem cadastro na base' }];
          x.draft = TEXTO_RECUSA.FORNECEDOR_NAO_ENCONTRADO(c);
          logar(c, 'Regras', 'auto', `${x.tipo === 'DESC' ? 'Desconto' : 'Verba'} ${k + 1}: fornecedor sem cadastro.`);
        });
        await checkDone(c);
      } else {
        const ext2 = clonar(c.ext);
        ext2.fornecedor = { nome_citado: forn.razao_social, cnpj: forn.cnpj, confianca: 100, evidencia: 'revisão humana' };
        ext2.ambiguidades = []; ext2.alertas = [];
        ext2.condicoes.forEach((ce, k) => {
          const x = c.itens[k];
          ['categoria', 'valor', 'vigencia_inicio', 'vigencia_fim', 'loja'].forEach((cp) => {
            const mk = CAMPO_MESA[cp]; const v = x[mk];
            ce[cp] = { valor: v === '' ? null : v, confianca: 100, evidencia: (ce[cp] && ce[cp].evidencia) || 'revisão humana' };
          });
          ce.tipo = { valor: x.tipo, confianca: 100, evidencia: (ce.tipo && ce.tipo.evidencia) || null };
          x.conf = { cat: 100, valor: 100, ini: 100, fim: 100, loja: 100 };
        });
        c.ext = ext2;
        await aplicarResultado(c, await validarCaso(c, ext2));
      }
    } else if (d.acao === 'approve') {
      if (it.status !== 'aguardando') return { ok: false, erro: 'a condição não está aguardando aprovação' };
      if (por.level !== it.alcada) return { ok: false, erro: `esta condição é da alçada ${NIVEL_NOME[it.alcada]}` };
      it.substituir = d.substituir && it.sugestao ? it.sugestao.cod_condicao_substituida : null;
      logar(c, pn, 'hum', `Aprovou ${it.tipo === 'DESC' ? 'o desconto' : 'a verba'} da condição ${i + 1}${it.substituir ? ` e autorizou encerrar ${it.substituir}` : ''}.`);
      await enviarErp(c, i, por);
    } else if (d.acao === 'reject') {
      if (it.status !== 'aguardando') return { ok: false, erro: 'a condição não está aguardando aprovação' };
      if (por.level !== it.alcada) return { ok: false, erro: `esta condição é da alçada ${NIVEL_NOME[it.alcada]}` };
      const just = String(d.just || '').trim(); if (just.length < 5) return { ok: false, erro: 'justificativa obrigatória' };
      it.status = 'recusa_pendente'; it.motivos = ['decisao'];
      logar(c, pn, 'hum', `Recusou a condição ${i + 1}. Justificativa: ${just}`);
      it.draft = `Após análise pela ${NIVEL_NOME[por.level]}, a condição de ${it.tipo === 'DESC' ? 'desconto de ' + it.valor + '%' : 'verba de ' + brlTxt(it.valor)} para ${CATEGORIAS_NOME[it.cat] || it.cat} não foi aprovada.\n\nMotivo: ${just}\n\nFicamos à disposição para avaliar uma nova proposta.`;
      logar(c, 'Rascunho de recusa', 'auto', `Montou o texto de recusa a partir da decisão da ${NIVEL_NOME[por.level]}.`);
      await checkDone(c);
    } else if (d.acao === 'sendrec') {
      if (d.persona !== 'rev') return { ok: false, erro: 'só o revisor confirma a recusa' };
      if (it.status !== 'recusa_pendente') return { ok: false, erro: 'a condição não tem recusa pendente' };
      const t = String(d.text || '').trim(); if (!t) return { ok: false, erro: 'texto vazio' };
      it.status = 'recusa_enviada'; it.recusaTexto = t;
      logar(c, pn, 'hum', `Confirmou a recusa da condição ${i + 1}${getProp('MAKE_WEBHOOK_URL') ? ' (vai ao fornecedor na resposta final)' : ''}.`);
      await checkDone(c);
    } else if (d.acao === 'retry') {
      if (d.persona !== 'rev') return { ok: false, erro: 'só o revisor reenvia' };
      if (it.status !== 'erro_erp') return { ok: false, erro: 'a condição não está com erro' };
      logar(c, pn, 'hum', `Reenviou a condição ${i + 1} ao SAP.`);
      await enviarErp(c, i, it.aprovador || por);
    } else return { ok: false, erro: 'ação desconhecida' };

    await gravarCaso(c);
    return { ok: true, caso: paraMesa(c), aviso };
  });
}

function paraMesa(c) { const o = clonar(c); delete o.ext; delete o.anexo; return o; }

module.exports = { processarValidacao, executarAcao, paraMesa, lerCasos, supsParaMesa, erpCondicoes, erpPost, ERP_FORNECEDORES, ERP_LOJAS, store };
