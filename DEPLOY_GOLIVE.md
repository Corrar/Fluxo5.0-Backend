# DEPLOY_GOLIVE.md — Fluxo Royale 5.0 · Checklist de go-live (backend)

> **Documentação — NADA aqui roda sozinho.** O código das peças 1–3 (armazém de material por OP +
> devolução com conferência) já está em `main`/prod, mas o **estado do banco de prod não foi tocado**.
> Prod está **vazia (zero usuários)**, então os endpoints novos dão **500 transitório** até os itens
> abaixo serem cumpridos. Rode cada passo **conscientemente contra PROD** — as migrations são todas
> idempotentes (`IF NOT EXISTS` / `ON CONFLICT DO NOTHING`), mas confira o resultado da auditoria antes.
>
> ⚠️ Eu (assistente) **não tenho o `DATABASE_URL` de prod** — só o de dev. Os valores "confirmados"
> abaixo vêm do repo e do banco **dev**. A **fonte da verdade do que falta em prod** é o bloco de
> **AUDITORIA** (§0), que você roda em prod (read-only).

---

## 0) AUDITORIA (rode em PROD, READ-ONLY) — a lista definitiva do que falta

```sql
-- ---- MIGRATIONS: NULL (regclass) ou 0 (count) = NÃO aplicada em prod ----
SELECT
  to_regclass('public.warehouses')                                                                     AS m004_warehouses,
  to_regclass('public.stock_ledger')                                                                   AS m004_stock_ledger,
  to_regclass('public.stock_transfers')                                                                AS m004_stock_transfers,
  (SELECT count(*) FROM information_schema.columns WHERE table_name='stock'         AND column_name IN ('warehouse_id','op_id')) AS m004_stock_cols_de_2,
  (SELECT count(*) FROM information_schema.columns WHERE table_name='profiles'      AND column_name='warehouse_id')     AS m005_profiles_wh,
  (SELECT count(*) FROM information_schema.columns WHERE table_name='request_items' AND column_name='conference_note')  AS m006_conf_note,
  (SELECT count(*) FROM information_schema.columns WHERE table_name='xml_logs'      AND column_name='nf_number')        AS m007_nf_number,
  to_regclass('public.op_material_events')                                                             AS m008_op_material_events,
  (SELECT count(*) FROM role_permissions WHERE page_key='producao:apontar')                            AS m008_perm_apontar_rows,
  to_regclass('public.op_returns_pending')                                                             AS m009_op_returns_pending;

-- ---- GRÃO DO ESTOQUE: op_split DEVE ser 0; a 2ª query NÃO deve retornar linha ----
SELECT count(*) AS stock_rows, count(*) FILTER (WHERE op_id IS NOT NULL) AS op_split FROM stock;
SELECT product_id, count(*) FROM stock GROUP BY product_id HAVING count(*) > 1;

-- ---- RBAC das rotas de devolução: quem tem cada chave ----
SELECT page_key, array_agg(role ORDER BY role) AS roles
  FROM role_permissions WHERE page_key IN ('producao:apontar','entradas:add')
 GROUP BY page_key;
```

---

## A) MIGRATIONS a aplicar em PROD (em ordem)

O repo tem **6** migrations. Todas idempotentes; **aplique EM ORDEM** (as de baixo dependem das de cima):

| Migration | O que cria/altera | Assinatura pra auditar |
|---|---|---|
| `004_stock_integrity.sql` | **FUNDAÇÃO 5.0**: `warehouses`, `stock_ledger` (+ `uq_stock_ledger_opkey`), `stock_transfers`, colunas `stock.warehouse_id/op_id`, `separations/requests.version`, `separation_items.picked_*` | `warehouses`, `stock_ledger` existem |
| `005_profiles_warehouse.sql` | `profiles.warehouse_id` | coluna existe |
| `006_conference_note.sql` | `request_items.conference_note` | coluna existe |
| `007_nf_number.sql` | `stock_ledger.nf_number`, `xml_logs.nf_number` | colunas existem |
| `008_op_material_events.sql` | **peça 1**: `op_material_events` + **seed `producao:apontar`** (8 papéis) | tabela existe + `producao:apontar` tem linhas |
| `009_op_returns_pending.sql` | **peça 3**: `op_returns_pending` | tabela existe |

- **Represadas confirmadas (dev-only):** `008` e `009`. **Se as demais (004–007) aparecerem NULL/0 na auditoria, também estão represadas** — não dá pra afirmar sem rodar §0 em prod. `008`/`009` dependem de `004` (StockService inteiro fala com `stock`/`stock_ledger`); sem `004`, nada de estoque 5.0 funciona.
- **Como aplicar:** o repo **não tem migration runner** — o padrão é rodar cada `.sql` na branch Neon e promover (ver cabeçalho das migrations). Aplicar cada arquivo faltante contra prod, na ordem 004→009.

---

## B) RBAC — `producao:apontar` (peça 1) e `entradas:add` (devolução conferência)

- **`producao:apontar`** é semeada **pela própria migration `008`** para estes 8 papéis (idempotente):
  `admin, chefe, setor, usinagem_lider, usinagem_operador, prototipo, engenharia, desenvolvimento`.
  → **Aplicar 008 já seeda.** Confirmado em **dev**: as 8 linhas existem.
- **Verificar em prod que os 8 papéis batem com o pessoal REAL de produção** (quem registra devolução).
  Em dev os papéis existentes são: `setor(6), usinagem_operador(4), chefe(3), usinagem_lider(1),
  prototipo(1), engenharia(1), desenvolvimento(1), admin(1)` — todos cobertos. Fora (de propósito):
  `almoxarife, compras, escritorio, financeiro, gerente, assistente_tecnico, obras`.
- **`entradas:add`** (usada por **confer/reject** da devolução, além de entradas/saídas): **pré-existente**,
  não é seedada pelas migrations desta leva. **Confirmar em prod que o `almoxarife` (quem confere) a tem** —
  ver a 3ª query da §0. Se faltar, o almoxarife não consegue conferir/rejeitar (403).

---

## C) VARIÁVEIS DE AMBIENTE — delta das peças 1–3

- **Única nova:** `PEROP_CUTOFF_DATE` (peça 1) — data de go-live da fila de Recebimento per-OP (`GET
  /op-materials/pending-receipts` só mostra separação entregue a partir dela). **Opcional**: sem ela,
  fallback hardcoded `'2026-07-17'` em `opMaterials.controller.ts`. **Recomendação:** setar em prod com a
  data REAL de virada (senão a fila pode nascer com meses de separações já consumidas).
- **Nenhuma outra env nova** nas peças 1–3 (o `.env.example` já reflete o conjunto completo).
- Lembrete do baseline obrigatório em prod (não é novo, mas confirmar): `DATABASE_URL`, `JWT_SECRET`.
  Opcionais com default: `PORT`, `PG_*` (timeouts/pool/SSL), `GREEN_API_*`/`ALMOXARIFADO_PHONE` (WhatsApp),
  `WONCA_API_KEY` (rastreio). Ver `.env.example`.

---

## D) INVARIANTE DO GRÃO — prod tem de bater com dev

O `conferReturn` credita o físico central com `receive` **POOLED** (`op_id = NULL`) — pressupõe **uma linha
por (produto, ALMOX), sem split por OP**. Se prod já tiver linhas `op_id != NULL`, o receive credita
outra linha e o saldo se fragmenta.

- **Dev (referência, medido agora):** `stock` = **2098 linhas**, `op_id IS NOT NULL` = **0**, produtos com
  **>1 linha = 0**. Grão fechado. ✅
- **Verificar em prod** (2ª/3ª query da §0): esperado `op_split = 0` e **nenhuma** linha na query de `>1`.
  Se prod divergir (existir `op_id != NULL` ou produto com múltiplas linhas), **investigar antes do go-live**
  — provavelmente `004`/backfill aplicado pela metade, ou dado herdado do 2.0.

---

## Ordem sugerida de go-live
1. Rodar **§0 (auditoria)** em prod → saber exatamente o que falta.
2. Aplicar migrations faltantes **004→009** (idempotentes) na ordem.
3. Reconferir §0: todas as colunas não-NULL, `producao:apontar` com linhas, grão `op_split = 0`.
4. Confirmar `entradas:add` no `almoxarife` e o mapa de papéis reais (§B).
5. Setar `PEROP_CUTOFF_DATE` em prod (§C).
6. (Re)deploy do backend se necessário e smoke manual: registrar devolução → aparecer na Conferência →
   conferir com divergência → checar `total_cost` da OP abatido.
