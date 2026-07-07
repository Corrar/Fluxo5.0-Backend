# Fluxo Royale 5.0 — Backend

API do ERP **Fluxo Royale 5.0**: estoque multi-armazém com razão imutável (stock ledger),
solicitações, separações, produção 3D, RH, compras, assistência e financeiro. Concorrência
otimista e transações ACID no motor de estoque.

## Stack
- **Node.js + TypeScript**
- **Express 5**
- **PostgreSQL** (Neon) via `pg`
- **Socket.IO** (eventos em tempo real)
- **JWT** (autenticação), **Helmet**, **express-rate-limit**
- **web-push** e **WhatsApp (Green API)** para notificações

## Pré-requisitos
- **Node.js 20+** e npm
- Um banco **PostgreSQL** (recomendado: [Neon](https://neon.tech))

## Setup
1. Clone e entre na pasta:
   ```bash
   git clone https://github.com/Corrar/Fluxo5.0-Backend.git
   cd Fluxo5.0-Backend
   ```
2. Instale as dependências:
   ```bash
   npm install
   ```
3. Configure o ambiente — copie o exemplo e preencha:
   ```bash
   cp .env.example .env
   ```
   Obrigatórias: **`DATABASE_URL`** e **`JWT_SECRET`**. As demais têm default (ver `.env.example`).
4. Aplique as **migrations** (ver seção abaixo).
5. Rode em desenvolvimento:
   ```bash
   npm run dev
   ```
   A API sobe em **`http://localhost:3000`**.

## Scripts
| Comando | O que faz |
|---|---|
| `npm run dev` | Sobe a API com `ts-node` (dev, porta 3000) |
| `npm run build` | Compila TypeScript (`tsc`) para `dist/` |
| `npm start` | Roda o build compilado (`node dist/server.js`) |

## Migrations
Os scripts de schema ficam em **`src/migrations/`** (ex.: `004_stock_integrity.sql`,
`005_profiles_warehouse.sql`). **Não há runner automático** — aplique-os **manualmente,
em ordem numérica**, no banco apontado por `DATABASE_URL`:
```bash
psql "$DATABASE_URL" -f src/migrations/004_stock_integrity.sql
psql "$DATABASE_URL" -f src/migrations/005_profiles_warehouse.sql
```
(ou cole o conteúdo no SQL editor do Neon.)

## Porta
HTTP em **`3000`** — configurável via a variável `PORT`.
