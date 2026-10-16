'use strict';
/**
 * Validador determinístico de condições comerciais (POL-COM-004 v3.2 + contrato do ERP).
 * Sem LLM. Função pura: validar(input) -> resultado.
 *
 * input:
 *   extracao         saída do Agente Extrator (extracao.v1), objeto ou string JSON
 *   fornecedores     resposta do GET /fornecedores (objeto com .itens ou array)
 *   lojas            resposta do GET /lojas
 *   condicoes        resposta do GET /condicoes?status=VIGENTE (consultada na hora)
 *   anexo_lojas      (opcional) linhas do CSV anexo: array de objetos ou texto CSV com ";"
 *   origem_referencia Message-ID do e-mail
 *   hoje             AAAA-MM-DD (data do cadastro). Default: hoje em America/Sao_Paulo
 */

const POLITICA = {
  tetos: {
    GENERICOS: 15, MEDICAMENTOS_REFERENCIA: 12, MIP: 18,
    HIGIENE_BELEZA: 20, DERMOCOSMETICOS: 20, SUPLEMENTOS: 20,
  },
  // Rodapé da política: campanha sazonal aprovada pelo Trade Marketing
  teto_sazonal: { GENERICOS: 30, MIP: 30 },
  max_meses: 12,
  confianca_minima: 80,
  recente_dias: 7,
};

// ---------- utilitários ----------
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

const lista = (x) => (Array.isArray(x) ? x : (x && Array.isArray(x.itens) ? x.itens : []));

// Cadastros do ERP são obrigatórios: se a consulta falhou (429/503) ou veio vazia de "itens",
// falhar alto em vez de validar sem checar fornecedor, loja ou sobreposição.
const exigir = (x, nome) => {
  let v = x;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch (e) { throw new Error(`${nome}: JSON inválido`); }
  }
  const l = Array.isArray(v) ? v : (v && Array.isArray(v.itens) ? v.itens : null);
  if (!l) throw new Error(`${nome}: resposta do ERP ausente ou sem "itens" (a consulta falhou?)`);
  return l;
};

const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v == null) return null;
  let s = String(v).replace(/[R$%\s]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const dataOk = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

const fimMaximo = (inicio, meses) => {
  const d = new Date(inicio + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + meses);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

const diasEntre = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);

const hojeSP = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());

const duasCasas = (n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;

const I = (codigo, severidade, campo, mensagem, detalhe) =>
  ({ codigo, severidade, campo, mensagem, ...(detalhe !== undefined ? { detalhe } : {}) });

function parseCsv(texto) {
  const linhas = String(texto).split(/\r?\n/).filter((l) => l.trim());
  if (!linhas.length) return [];
  const cab = linhas[0].split(';').map((h) => h.trim().replace(/^\ufeff/, ''));
  return linhas.slice(1).map((l) => {
    const c = l.split(';');
    return Object.fromEntries(cab.map((h, i) => [h, (c[i] ?? '').trim()]));
  });
}

// ---------- fornecedor ----------
const STOP_FORN = new Set(['LTDA', 'SA', 'DE', 'DA', 'DO', 'EIRELI', 'ME', 'EPP']);
const GENERICAS = new Set(['DISTRIBUIDORA', 'LABORATORIOS', 'LABORATORIO', 'INDUSTRIA', 'FARMACEUTICA',
  'COSMETICOS', 'DERMOCOSMETICOS', 'GENERICOS', 'SUPLEMENTOS', 'PRODUTOS', 'HIGIENE', 'ALIMENTARES', 'FARMA']);
const tokensForn = (s) => norm(s).split(' ').filter((t) => t.length >= 3 && !STOP_FORN.has(t));

function resolverFornecedor(f, cadastro) {
  const issues = [];
  const cnpj = String(f?.cnpj ?? '').replace(/\D/g, '');
  let candidatos = [];
  if (cnpj) candidatos = cadastro.filter((x) => String(x.cnpj).replace(/\D/g, '') === cnpj);
  const porCnpj = candidatos.length === 1;
  if (!porCnpj) {
    const citados = tokensForn(f?.nome_citado);
    if (citados.length && citados.some((t) => !GENERICAS.has(t))) {
      candidatos = cadastro.filter((x) => {
        const t = new Set(tokensForn(x.razao_social));
        return citados.every((c) => t.has(c));
      });
    } else candidatos = [];
  } else if (f?.nome_citado) {
    const t = new Set(tokensForn(candidatos[0].razao_social));
    const citados = tokensForn(f.nome_citado);
    if (!citados.every((c) => t.has(c)))
      issues.push(I('FORNECEDOR_CNPJ_NOME_DIVERGEM', 'DECISAO', 'fornecedor',
        'CNPJ e nome citado apontam para cadastros diferentes', { nome_citado: f.nome_citado, razao_social: candidatos[0].razao_social }));
  }

  if (candidatos.length === 0) {
    issues.push(I('FORNECEDOR_NAO_ENCONTRADO', 'BLOQUEIO', 'fornecedor',
      'Fornecedor não localizado no cadastro do ERP', { nome_citado: f?.nome_citado ?? null }));
    return { cod: null, razao: null, status: null, issues };
  }
  if (candidatos.length > 1) {
    issues.push(I('FORNECEDOR_AMBIGUO', 'DECISAO', 'fornecedor',
      'Mais de um fornecedor compatível; escolher na mesa',
      candidatos.map((x) => ({ cod: x.cod_fornecedor, razao_social: x.razao_social }))));
    return { cod: null, razao: null, status: null, issues };
  }
  const forn = candidatos[0];
  if (forn.status !== 'ATIVO') {
    issues.push(I('FORNECEDOR_INATIVO', 'BLOQUEIO', 'fornecedor',
      'Fornecedor sem cadastro ativo (política, seção 8). Regularizar com Cadastro antes de negociar',
      { status: forn.status, data_inativacao: forn.data_inativacao, motivo: forn.motivo_inativacao }));
  }
  if (!porCnpj && (f?.confianca ?? 0) < POLITICA.confianca_minima)
    issues.push(I('BAIXA_CONFIANCA', 'DECISAO', 'fornecedor', 'Fornecedor identificado com confiança baixa',
      { confianca: f?.confianca, evidencia: f?.evidencia }));
  return { cod: forn.cod_fornecedor, razao: forn.razao_social, status: forn.status, issues };
}

// ---------- lojas ----------
const STOP_LOJA = new Set(['UNIDADE', 'UNIDADES', 'LOJA', 'LOJAS', 'DA', 'DO', 'DE', 'DAS', 'DOS', 'NA', 'NO',
  'NAS', 'NOS', 'AS', 'OS', 'E', 'PARA', 'DROG', 'VITALIS']);
const limpaLoja = (s) => norm(s).split(' ').filter((t) => t && !STOP_LOJA.has(t)).join(' ');

function resolverLojas(texto, cadastro) {
  const porCodigo = new Map(cadastro.map((l) => [l.cod_loja, l]));
  const porNome = new Map(cadastro.map((l) => [limpaLoja(l.nome), l]));
  const codigos = new Set(); const naoResolvidas = []; const invalidas = [];
  const partes = String(texto ?? '').split(/[,;\/\n]|\s+e\s+|\s+&\s+/i).map((p) => p.trim()).filter(Boolean);
  for (const p of partes) {
    const m = p.match(/LOJA[-\s]?(\d{3})/i);
    let loja = null;
    if (m) {
      loja = porCodigo.get(`LOJA-${m[1]}`);
      if (!loja) { invalidas.push(`LOJA-${m[1]}`); continue; }
    } else loja = porNome.get(limpaLoja(p));
    if (!loja) { naoResolvidas.push(p); continue; }
    if (loja.status !== 'ATIVA') { invalidas.push(`${loja.cod_loja} (${loja.status})`); continue; }
    codigos.add(loja.cod_loja);
  }
  return { codigos: [...codigos].sort(), naoResolvidas, invalidas };
}

function resolverUnidade(u, cadastro) {
  const r = resolverLojas(u, cadastro);
  return r.codigos.length === 1 && !r.naoResolvidas.length && !r.invalidas.length
    ? { cod: r.codigos[0] } : { erro: String(u) };
}

const interseccao = (a, b) => {
  if (a.includes('REDE') && b.includes('REDE')) return ['REDE'];
  if (a.includes('REDE')) return b;
  if (b.includes('REDE')) return a;
  return a.filter((x) => b.includes(x));
};

// ---------- alçadas ----------
function alcadaDesconto(p) {
  if (p <= 10) return 'COORDENACAO_COMERCIAL';
  if (p <= 20) return 'GERENCIA_COMERCIAL';
  if (p <= 25) return 'DIRETORIA_COMERCIAL';
  return 'VEDADO';
}
function alcadaVerba(v) {
  if (v <= 5000) return 'GERENCIA_COMERCIAL';
  if (v <= 20000) return 'DIRETORIA_COMERCIAL';
  return 'COMITE_COMERCIAL';
}

// ---------- validação de uma condição ----------
function validarCondicao(c, ctx) {
  const { hoje, lojasCad, vigentes, anexo, issuesCaso, origemRef, forn, ambiguidades } = ctx;
  const issues = [...issuesCaso];
  const campo = (k) => c[k] ?? { valor: null, confianca: 0, evidencia: null };
  const val = (k) => campo(k).valor ?? null;

  const tipo = { DESC: 'DESCONTO_PERCENTUAL', VERBA: 'VERBA_EXPOSICAO' }[val('tipo')] ?? null;
  const categoria = val('categoria');
  const valor = num(val('valor'));
  const inicio = val('vigencia_inicio');
  const fim = val('vigencia_fim');
  const textoLoja = val('loja');

  // 1. campos obrigatórios
  const obrig = { tipo, categoria, valor, vigencia_inicio: inicio, vigencia_fim: fim, loja: textoLoja };
  for (const [k, v] of Object.entries(obrig))
    if (v == null) issues.push(I('CAMPO_AUSENTE', 'DECISAO', k, `Campo obrigatório não informado na proposta: ${k}`));

  // 2. lojas
  let lojas = null; let lojasViaAnexo = false;
  if (textoLoja != null) {
    if (norm(textoLoja) === 'REDE') lojas = ['REDE'];
    else {
      const mencionaAnexo = /anex|planilha|arquivo|csv|tabela/i.test(textoLoja);
      if (mencionaAnexo && !anexo.length) {
        issues.push(I('ANEXO_NAO_FORNECIDO', 'DECISAO', 'loja',
          'A proposta remete as lojas a um anexo que não chegou ao pipeline', { texto: textoLoja }));
      } else if (mencionaAnexo) {
        lojasViaAnexo = true;
        const cods = new Set(); const erros = [];
        for (const row of anexo) {
          const r = resolverUnidade(row.unidade, lojasCad);
          if (r.cod) cods.add(r.cod); else erros.push(r.erro);
        }
        if (erros.length) issues.push(I('LOJAS_NAO_RESOLVIDAS', 'DECISAO', 'loja',
          'Unidades do anexo sem correspondência única e ativa no cadastro de lojas', erros));
        lojas = [...cods].sort();
        // consistência anexo x corpo do e-mail
        if (tipo === 'DESCONTO_PERCENTUAL' && valor != null) {
          const ds = [...new Set(anexo.map((r) => num(r.desconto_proposto)).filter((x) => x != null))];
          if (ds.some((d) => Math.abs(d - valor) > 0.001))
            issues.push(I('ANEXO_DIVERGE_DESCONTO', 'DECISAO', 'valor',
              'Percentuais do anexo diferem do informado no corpo do e-mail', { corpo: valor, anexo: ds }));
        }
        if (tipo === 'VERBA_EXPOSICAO' && valor != null) {
          const vs = anexo.map((r) => num(r.verba_exposicao)).filter((x) => x != null);
          const soma = Math.round(vs.reduce((a, b) => a + b, 0) * 100) / 100;
          if (vs.length && Math.abs(soma - valor) > 0.01)
            issues.push(I('ANEXO_DIVERGE_VERBA', 'DECISAO', 'valor',
              'Soma da verba no anexo difere do total do e-mail', { corpo: valor, soma_anexo: soma }));
        }
        const obs = anexo.filter((r) => String(r.observacao ?? '').trim());
        if (obs.length) issues.push(I('ANEXO_OBSERVACOES', 'DECISAO', 'loja',
          'Anexo traz observações por unidade; conferir antes de aprovar',
          obs.map((r) => ({ unidade: r.unidade, observacao: r.observacao }))));
      } else {
        const r = resolverLojas(textoLoja, lojasCad);
        lojas = r.codigos;
        if (r.naoResolvidas.length) issues.push(I('LOJAS_NAO_RESOLVIDAS', 'DECISAO', 'loja',
          'Trechos de loja sem correspondência única no cadastro', r.naoResolvidas));
        if (r.invalidas.length) issues.push(I('LOJA_INVALIDA', 'BLOQUEIO', 'loja',
          'Loja inexistente ou inativa', r.invalidas));
      }
      if (lojas && !lojas.length && !issues.some((i) => i.campo === 'loja')) lojas = null;
    }
  }

  // 3. confiança baixa (loja só conta se veio do texto)
  const checaConf = { tipo, categoria, valor, vigencia_inicio: inicio, vigencia_fim: fim };
  if (!lojasViaAnexo && textoLoja != null && norm(textoLoja) !== 'REDE') checaConf.loja = textoLoja;
  for (const k of Object.keys(checaConf)) {
    const f = campo(k);
    if (f.valor != null && (f.confianca ?? 0) < POLITICA.confianca_minima)
      issues.push(I('BAIXA_CONFIANCA', 'DECISAO', k, `Campo lido com confiança ${f.confianca}; confirmar com a proposta`,
        { valor: f.valor, confianca: f.confianca, evidencia: f.evidencia }));
  }

  // 4. ambiguidades levantadas pelo extrator
  for (const a of ambiguidades) {
    if (a.campo === 'loja' && (lojasViaAnexo || norm(textoLoja) === 'REDE')) continue;
    issues.push(I('AMBIGUIDADE_EXTRATOR', 'DECISAO', a.campo, a.motivo, a.alternativas));
  }

  // 5. valor, teto e alçada
  let alcada = null;
  if (valor != null && tipo) {
    if (tipo === 'DESCONTO_PERCENTUAL') {
      if (!(valor > 0 && valor <= 100) || !duasCasas(valor)) {
        issues.push(I('VALOR_INVALIDO', 'BLOQUEIO', 'valor', 'Percentual fora de (0, 100] ou com mais de 2 casas', valor));
      } else {
        alcada = alcadaDesconto(valor);
        if (alcada === 'VEDADO')
          issues.push(I('DESCONTO_VEDADO', 'BLOQUEIO', 'valor', 'Desconto acima de 25% é vedado (política, seção 5)', valor));
        if (categoria && POLITICA.tetos[categoria] != null && valor > POLITICA.tetos[categoria]) {
          const sazonal = POLITICA.teto_sazonal[categoria];
          if (sazonal != null && valor <= sazonal)
            issues.push(I('TETO_EXCEDIDO_EXCECAO_SAZONAL', 'DECISAO', 'valor',
              `Acima do teto de ${POLITICA.tetos[categoria]}% de ${categoria}. Só vale como campanha sazonal aprovada pelo Trade Marketing (até ${sazonal}%); anexar a aprovação`,
              { teto: POLITICA.tetos[categoria], teto_sazonal: sazonal, valor }));
          else
            issues.push(I('TETO_EXCEDIDO', 'BLOQUEIO', 'valor',
              `Acima do teto de ${POLITICA.tetos[categoria]}% da categoria ${categoria} (política, seção 4)`, valor));
        }
      }
    } else {
      if (!(valor > 0) || !duasCasas(valor)) issues.push(I('VALOR_INVALIDO', 'BLOQUEIO', 'valor', 'Verba deve ser maior que zero, com até 2 casas', valor));
      else alcada = alcadaVerba(valor);
      if (!val('contrapartida'))
        issues.push(I('CONTRAPARTIDA_AUSENTE', 'DECISAO', 'contrapartida',
          'Verba de exposição exige contrapartida descrita (política, seção 7)'));
    }
  }
  if (val('contrapartida') && String(val('contrapartida')).length > 500)
    issues.push(I('CONTRAPARTIDA_LONGA', 'DECISAO', 'contrapartida', 'Contrapartida acima de 500 caracteres'));

  // 6. vigência
  const iniOk = inicio != null && dataOk(inicio);
  const fimOk = fim != null && dataOk(fim);
  if (inicio != null && !iniOk) issues.push(I('DATA_INVALIDA', 'BLOQUEIO', 'vigencia_inicio', 'Data de início inválida', inicio));
  if (fim != null && !fimOk) issues.push(I('DATA_INVALIDA', 'BLOQUEIO', 'vigencia_fim', 'Data de fim inválida', fim));
  if (iniOk && inicio < hoje)
    issues.push(I('INICIO_ANTERIOR_AO_CADASTRO', 'BLOQUEIO', 'vigencia_inicio',
      'Início anterior à data do cadastro (política, seção 6)', { inicio, hoje }));
  if (iniOk && fimOk) {
    if (fim < inicio) issues.push(I('FIM_ANTES_DO_INICIO', 'BLOQUEIO', 'vigencia_fim', 'Fim anterior ao início', { inicio, fim }));
    else if (fim > fimMaximo(inicio, POLITICA.max_meses))
      issues.push(I('VIGENCIA_MAIOR_QUE_12_MESES', 'BLOQUEIO', 'vigencia_fim',
        'Vigência máxima de 12 meses (política, seção 6)', { inicio, fim, fim_maximo: fimMaximo(inicio, 12) }));
  }

  // 7. sobreposição (mesmo fornecedor, categoria, tipo, loja e período)
  const conflitos = []; let sugestao = null;
  if (forn.cod && categoria && tipo && lojas && lojas.length && iniOk && fimOk) {
    for (const e of vigentes) {
      if (e.cod_fornecedor !== forn.cod || e.cod_categoria !== categoria || e.tipo !== tipo) continue;
      if (!(inicio <= e.data_fim && e.data_inicio <= fim)) continue;
      const comum = interseccao(lojas, e.lojas);
      if (!comum.length) continue;
      conflitos.push({
        cod_condicao: e.cod_condicao, lojas_em_comum: comum, vigencia: [e.data_inicio, e.data_fim],
        percentual: e.percentual ?? null, valor: e.valor ?? null,
        ultima_alteracao: e.ultima_alteracao, alterado_por: e.alterado_por ?? null,
        alterada_recentemente: diasEntre(String(e.ultima_alteracao).slice(0, 10), hoje) <= POLITICA.recente_dias,
      });
    }
    if (conflitos.length) {
      issues.push(I('SOBREPOSICAO', 'DECISAO', 'loja',
        'Já existe condição vigente do mesmo fornecedor, categoria e tipo para as mesmas lojas e período (política, seção 9)', conflitos));
      if (conflitos.length === 1) {
        const e = vigentes.find((x) => x.cod_condicao === conflitos[0].cod_condicao);
        const cobre = lojas.includes('REDE') || e.lojas.every((l) => lojas.includes(l));
        if (cobre && e.data_inicio < inicio) sugestao = {
          cod_condicao_substituida: e.cod_condicao,
          efeito: `${e.cod_condicao} seria encerrada em ${diaAntes(inicio)}`,
        };
      }
    }
  }

  // 8. origem
  if (!origemRef) issues.push(I('ORIGEM_AUSENTE', 'DECISAO', 'origem', 'Message-ID do e-mail não informado'));

  const status = issues.some((i) => i.severidade === 'BLOQUEIO') ? 'BLOQUEADA'
    : issues.some((i) => i.severidade === 'DECISAO') ? 'PRECISA_DECISAO' : 'PRONTA';

  // 9. rascunho do payload (aprovador e Idempotency-Key entram na aprovação)
  let payload = null;
  if (status !== 'BLOQUEADA' && forn.cod && categoria && tipo && lojas && lojas.length && valor != null && iniOk && fimOk) {
    payload = {
      cod_fornecedor: forn.cod, cod_categoria: categoria, tipo, lojas,
      ...(tipo === 'DESCONTO_PERCENTUAL' ? { percentual: valor } : { valor }),
      data_inicio: inicio, data_fim: fim,
      ...(val('contrapartida') ? { contrapartida: val('contrapartida') } : {}),
      aprovador: null,
      origem: { tipo: 'EMAIL', referencia: origemRef },
    };
  }

  return {
    idx: c.idx, status, alcada_necessaria: alcada,
    resumo: { tipo, categoria, valor, vigencia_inicio: inicio, vigencia_fim: fim, lojas },
    issues, conflitos, sugestao_substituicao: sugestao, payload_erp: payload,
    payload_pendente: payload ? ['aprovador', 'Idempotency-Key'] : null,
  };
}

const diaAntes = (s) => {
  const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10);
};

// ---------- entrada principal ----------
function validar(input) {
  const ext = typeof input.extracao === 'string' ? JSON.parse(input.extracao) : input.extracao;
  const hoje = input.hoje || hojeSP();
  const anexo = typeof input.anexo_lojas === 'string' ? parseCsv(input.anexo_lojas) : lista(input.anexo_lojas);

  if (!ext.e_proposta) {
    return { schema_version: 'validacao.v1', caso_id: ext.caso_id, hoje, status_geral: 'DESCARTAR',
      caso: { e_proposta: false }, condicoes: [] };
  }

  const fornCad = exigir(input.fornecedores, 'fornecedores');
  const lojasCad = exigir(input.lojas, 'lojas');
  const vigentes = exigir(input.condicoes, 'condicoes').filter((c) => c.status === 'VIGENTE');

  const issuesCaso = [];
  const alertas = ext.alertas ?? [];
  const suspeito = alertas.some((a) => a.tipo === 'possivel_injecao');
  if (suspeito) issuesCaso.push(I('POSSIVEL_INJECAO', 'DECISAO', 'email',
    'O e-mail contém instruções dirigidas ao sistema. Ignoradas; revisão humana obrigatória',
    alertas.filter((a) => a.tipo === 'possivel_injecao').map((a) => a.trecho)));

  const forn = resolverFornecedor(ext.fornecedor, fornCad);
  issuesCaso.push(...forn.issues);

  // "nessas mesmas lojas" herda o texto de loja da condição anterior
  let lojaAnterior = null;
  const condsExt = (ext.condicoes ?? []).map((c) => {
    const l = c.loja ?? { valor: null, confianca: 0, evidencia: null };
    if (l.valor != null && /mesmas lojas|nessas lojas|essas lojas|mesmas unidades/i.test(l.valor) && lojaAnterior)
      return { ...c, loja: { ...lojaAnterior, confianca: Math.min(l.confianca ?? 100, lojaAnterior.confianca ?? 100), evidencia: l.evidencia } };
    if (l.valor != null) lojaAnterior = l;
    return c;
  });

  const condicoes = condsExt.map((c) => validarCondicao(c, {
    hoje, lojasCad, vigentes, anexo, issuesCaso, origemRef: input.origem_referencia ?? null,
    forn, ambiguidades: ext.ambiguidades ?? [],
  }));

  const ordem = ['PRONTA', 'PRECISA_DECISAO', 'BLOQUEADA'];
  const status_geral = condicoes.length
    ? ordem[Math.max(...condicoes.map((c) => ordem.indexOf(c.status)))] : 'PRECISA_DECISAO';

  return {
    schema_version: 'validacao.v1', caso_id: ext.caso_id, hoje, status_geral,
    caso: {
      e_proposta: true, suspeito,
      fornecedor: { cod_fornecedor: forn.cod, razao_social: forn.razao, status: forn.status },
    },
    condicoes,
  };
}


module.exports = { validar, POLITICA, num, dataOk, diaAntes, tokensForn, norm };
