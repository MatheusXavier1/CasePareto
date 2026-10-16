# Central de Condições (Case Pareto) na Vercel

Mesma Mesa e mesmo backend do Apps Script, agora como projeto Vercel.

```
public/index.html   a Mesa (front)
api/index.js        rota única /api (mesmo contrato do Web App do Apps Script)
lib/validador.js    validador determinístico da POL-COM-004 (sem mudanças de regra)
lib/mesa.js         casos, alçadas, ERP simulado e envio ao SAP
lib/store.js        armazenamento em Redis (substitui a planilha)
lib/erp-dados.js    respostas capturadas do ERP (fornecedores, lojas, condições)
```

## 1. Subir para o GitHub

Na pasta do projeto, dentro do clone de `MatheusXavier1/CasePareto`:

```bash
git add .
git commit -m "Mesa e API na Vercel"
git push
```

A Vercel redeploya sozinha. O `index.html` fica em `public/`, então o 404 anterior some.

## 2. Banco (Redis)

Funciona com qualquer um dos dois, pelo Marketplace da Vercel (**Project → Storage**):

- **Redis (Redis Inc)**: cria `REDIS_URL`. A API usa conexão TCP (pacote `redis`, já no `package.json`).
- **Upstash for Redis**: cria `KV_REST_API_URL` e `KV_REST_API_TOKEN`. A API usa REST.

Conecte ao projeto sem prefixo personalizado. Sem banco a API roda em memória e perde os dados a cada execução. Confira em `/api?rota=ping`: deve responder `"armazenamento":"redis (tcp)"` ou `"redis (rest)"`.

## 3. Variáveis de ambiente

**Settings → Environment Variables**, depois **Redeploy**:

| Variável | Para quê |
|---|---|
| `TOKEN` | Segredo do Make e das rotas do ERP simulado (string longa e aleatória) |
| `TOKEN_MESA` | Segredo da Mesa (só `casos` e `acao`). Outro valor, diferente de `TOKEN` |
| `MAKE_WEBHOOK_URL` | Opcional. Webhook do Make que manda a resposta final ao fornecedor |
| `ERP_SIM` | Opcional. `normal` (20% de 503), `estavel` ou `falha` |
| `HOJE_FIXO` | Opcional. `AAAA-MM-DD` para congelar "hoje" na demonstração |

## 4. Abrir a Mesa

Primeira vez: `https://SEU-APP.vercel.app/?token=SEU_TOKEN_MESA`. O token fica salvo no navegador e sai da URL.
Sem token, a Mesa abre em modo demonstração (dados locais).

## 5. Make

No módulo HTTP que chamava `https://script.google.com/macros/s/.../exec?token=...`, troque a URL por:

```
https://SEU-APP.vercel.app/api?token=SEU_TOKEN
```

O corpo continua igual (`extracao`, `fornecedores`, `lojas`, `condicoes`, `anexo_lojas`, `origem_referencia`, `assunto`, `remetente`, `corpo`). Resposta final ao fornecedor: cenário com webhook, URL em `MAKE_WEBHOOK_URL`.

## 6. Rotas

| Método | Rota | Uso |
|---|---|---|
| POST | `/api?token=T` | Validador (Make). Cria o caso na Mesa se for proposta |
| GET | `/api?token=TM&rota=casos` | Lista de casos (Mesa) |
| POST | `/api?token=TM&rota=acao` | Ações da Mesa: `val1`, `approve`, `reject`, `sendrec`, `retry` |
| GET | `/api?token=T&rota=fornecedores`, `lojas`, `condicoes` | ERP simulado |
| POST | `/api?token=T&rota=limpar` | Zera os dados da demonstração |
| GET | `/api?rota=ping` | Saúde, sem token |

Token inválido responde HTTP 401 com `{"error":"nao autorizado"}`.

## Diferenças em relação ao Apps Script

- Dados em Redis, não em planilha. A auditoria fica numa lista Redis (`cp:auditoria`).
- Lock de concorrência por chave no Redis, no lugar do `LockService`.
- `TOKEN_MESA` fica no navegador de quem abriu a Mesa. Se a URL for pública, ative **Settings → Deployment Protection**.
