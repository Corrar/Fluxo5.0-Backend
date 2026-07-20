# RENDER_DEPLOY.md — Fluxo Royale 5.0 · Deploy do backend no Render + front na Vercel

> **Documentação — nada aqui roda sozinho.** Passo-a-passo com a divisão explícita
> **[CLAUDE CODE]** (código, já feito/versionável) × **[BRUNO]** (painel Render/Vercel, sem acesso do assistente).
> A ordem abaixo resolve a dependência circular front↔back.

---

## 0) Estado do código (o que já está pronto)

| Item | Confirmado | Fonte |
|---|---|---|
| **Build command** | `npm install && npm run build` (`build` = `tsc`) | `package.json` → `"build": "tsc"` |
| **Start command** | `npm start` → **`node dist/server.js`** | `package.json` → `"start": "node dist/server.js"` |
| **Entry compilado** | `dist/server.js` (de `src/server.ts`; `tsconfig`: `rootDir src` → `outDir dist`) | `tsconfig.json` |
| **Porta** | `process.env.PORT \|\| 3000` — Render injeta a porta | `server.ts:175` |
| **DB** | 100% de `DATABASE_URL` (sem URL hard-coded) | `db.ts:32` |
| **CORS** | agora via env `CORS_ORIGINS`, com fallback | `server.ts` + `config/cors.ts` |
| **tsc** | compila limpo pra `dist/` | verificado |

> ⚠️ **Peso morto (recomendado remover antes do 1º deploy):** `whatsapp-web.js` e `qrcode-terminal`
> estão no `package.json` mas **não são importados no `src`**. O `whatsapp-web.js` puxa `puppeteer`
> (download de Chromium ~150 MB no `npm install`) — deixa o build do Render lento e arrisca o free tier.
> Alertas WhatsApp reais usam Green API (HTTP). **[CLAUDE CODE] pode remover com teu OK.**

---

## 1) [BRUNO] Gerar o `JWT_SECRET` de produção (local)

Rode um destes e **guarde o valor** (vai colar no Render no passo 2):

```bash
# Node (qualquer OS):
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
# ou openssl:
openssl rand -hex 48
```

> Use um segredo **novo** pra produção (não reaproveite o de dev). É só do backend (assina+verifica o JWT); o front não precisa dele.

---

## 2) [BRUNO · painel Render] Criar o Web Service

1. **New → Web Service** → conectar o repositório **`Corrar/Fluxo5.0-Backend`**, branch **`main`**.
   - **Root Directory:** deixar **vazio/raiz** (o repo já é o backend; `package.json` está na raiz).
2. **Runtime:** Node.
3. **Build Command:** `npm install && npm run build`
4. **Start Command:** `npm start`   *(equivale a `node dist/server.js`)*
5. **Region:** **US East (Ohio)** — o Neon está em `us-east-2`; mesma região = menor latência de banco.
6. **Instance Type:** Free (ver §6 sobre cold start) ou paga (always-on).
7. **Environment Variables** — colar:

   | Nome | Valor | Obs |
   |---|---|---|
   | `DATABASE_URL` | a connection string **pooled** do Neon (branch única já migrada) | obrigatória |
   | `JWT_SECRET` | o valor gerado no passo 1 | obrigatória |
   | `PEROP_CUTOFF_DATE` | data real de virada `YYYY-MM-DD` | recomendada (senão fallback `2026-07-17`) |
   | `CORS_ORIGINS` | **deixar em branco por enquanto** — preenche no passo 5 | ver §5 |

   **NÃO** setar `PORT` (Render injeta) nem `PG_SSL` (vazio = SSL ligado, que o Neon exige).
   Opcionais de feature (só se quiser): `GREEN_API_ID`, `GREEN_API_TOKEN`, `ALMOXARIFADO_PHONE`, `WONCA_API_KEY`.

8. **Create Web Service** → aguardar o build+deploy.

> **Migrations:** nada a rodar. A branch Neon única já tem **004–009** aplicadas, grão fechado
> (`op_split=0`) e RBAC ok (auditoria §0 do `DEPLOY_GOLIVE.md` rodada e confirmada). Só criar uma
> branch Neon **nova/vazia** exigiria aplicar as migrations — não é o caso aqui.

---

## 3) [BRUNO] Pegar a URL do Render

Ao terminar o deploy, o Render gera uma URL, ex.: **`https://fluxo-backend.onrender.com`**. Anote.
Teste rápido no navegador/curl: `GET https://…onrender.com/` deve responder (não CORS-bloqueado; GET simples).

---

## 4) [BRUNO · painel Vercel] Deploy do front apontando pro Render

1. **Import Project** → repo **`Corrar/Fluxo5.0-Front`**.
2. **Environment Variable:**

   | Nome | Valor |
   |---|---|
   | `VITE_API_URL` | a URL do Render do passo 3 (ex.: `https://fluxo-backend.onrender.com`) |

   > **É esta a env que o front usa** pra achar a API — no REST (`lib/api.js` → `import.meta.env.VITE_API_URL`)
   > **e** no realtime (`lib/socket.js`, que faz `.replace('/api','')` na mesma URL). Sem ela, o front cai em
   > `http://localhost:3000` e o browser bloqueia por **mixed-content** (front HTTPS → API HTTP). **Obrigatória.**

3. **(Recomendado) Nome do projeto:** se o domínio Vercel sair como **`fluxo-royale.vercel.app`** ou
   **`fluxoroyale21.vercel.app`**, o CORS já aceita mesmo sem `CORS_ORIGINS` (estão no fallback).
4. **Deploy** → anotar a URL final da Vercel (ex.: `https://SEU-FRONT.vercel.app`).

---

## 5) [BRUNO · painel Render] Fechar o CORS com a URL da Vercel

1. No Web Service do Render → **Environment** → setar:

   ```
   CORS_ORIGINS = https://SEU-FRONT.vercel.app,https://fluxo-royale.com.br
   ```
   (lista separada por vírgula; inclua todos os domínios do front que forem usar — apex + www + domínio custom).

2. **Salvar.** ✅ **O Render redeploya AUTOMÁTICO ao salvar uma env var** — não precisa disparar deploy manual.
   Aguarde o novo deploy concluir (~1–3 min). No log de boot vai aparecer:
   `[CORS] origens permitidas (fonte: env): https://SEU-FRONT.vercel.app, …`

> **Por que este passo existe (a dependência circular):** o front precisa da URL do back (passo 4) e o
> back precisa da URL do front pro CORS. Quebramos assim: **back sobe primeiro** (não precisa do front pra
> bootar — CORS tem fallback) → front sobe com a URL do back → **volta e seta `CORS_ORIGINS`** com a URL do front.
> Se você nomeou o projeto Vercel como `fluxo-royale`/`fluxoroyale21`, o passo 5 é **opcional** (já está no fallback).

---

## 6) Cold start (Render free tier) × cold start do Neon

- **Render Free:** o serviço **dorme após ~15 min ocioso**. A **primeira request** depois disso espera o
  container subir (~**30–50 s**), aí o app boota.
- **Neon serverless:** o compute também **suspende** por ociosidade e leva alguns segundos pra acordar.
- **Empilhamento no 1º acesso:** Render acorda (~30–50 s) → app boota → `void warmup()` (`server.ts:181`)
  dispara pra **acordar o Neon** de forma assíncrona → a 1ª query real ainda pode pegar o Neon frio,
  mas o `db.ts` tem **defesa de cold start** (retry 3×, `PG_CONNECT_TIMEOUT=20s`, 1ª tentativa curta de 6s).
- **Comportamento esperado:** **o primeiro acesso após ociosidade é lento (~30–60 s no total) e pode dar
  1 erro transitório**; recarregar/re-tentar já vem rápido. Isso é do free tier, não é bug.
- **Como eliminar (opcional):** instância **paga** do Render (always-on) **ou** um ping periódico
  (cron/uptime robot batendo em `GET /` a cada ~10 min) pra não deixar dormir.

---

## 7) [BRUNO] Validação — front↔back conversando

Faça **login** no front publicado. Se o login funcionar, os três estão ok de uma vez:
- **CORS ok** — o browser não bloqueou a chamada `POST /auth/login` (origem aceita).
- **JWT ok** — o backend assinou o token com `JWT_SECRET` e o front guardou.
- **DB ok** — o backend leu o usuário no Neon (branch migrada).

Depois, abra uma tela **funcional** (ex.: **Estoque › Produtos** = `GET /products`) e confirme que
lista dados reais. Cheque o log do Render: sem `Bloqueio CORS: Origem não permitida`.

> Se login der **erro de CORS** no console do browser → a URL exata do front **não** está em `CORS_ORIGINS`
> (confira http×https, www×apex, barra no fim). Ajuste a env no Render (redeploy automático) e teste de novo.

---

## Resumo da divisão

| Fase | [CLAUDE CODE] (código) | [BRUNO] (painel) |
|---|---|---|
| CORS por env | ✅ feito (`config/cors.ts` + `server.ts`) | setar `CORS_ORIGINS` (passo 5) |
| (opcional) tirar peso morto | remover `whatsapp-web.js`/`qrcode-terminal` (com OK) | — |
| Backend no Render | — | passos 1–3 |
| Front na Vercel | — | passo 4 (`VITE_API_URL`) |
| Fechar CORS | — | passo 5 |
| Validar | — | passo 7 (login) |
| Migrations | ✅ nada a fazer (branch já migrada) | — |
