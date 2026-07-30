// src/controllers/pricing3d.controller.ts — Precificação 3D (aba nova do módulo).
//
// A FÓRMULA CANÔNICA VIVE AQUI, E SÓ AQUI (decisão travada — o front EXIBE, não calcula):
//   custo_material = (filament_grams / 1000) × preço_kg_do_filamento_vinculado
//   custo_energia  = (production_minutes / 60) × (power_watts / 1000) × tarifa_kwh
//   custo_total    = custo_material + custo_energia
//   preco_venda    = custo_total × (1 + margin_percent / 100)
// Duas cópias da mesma conta divergem no dia em que uma delas mudar — e quem descobre é o
// cliente, no orçamento errado. Por isso até o `aplicar_preco` RECALCULA no servidor e ignora
// qualquer preço que venha no body.
//
// ARITMÉTICA EM `numeric`, NÃO EM FLOAT: a conta inteira roda no Postgres com numeric (decimal
// exato). Float acumula erro em dinheiro — 0.1 + 0.2 é o exemplo clássico. Política de
// arredondamento, explícita: os intermediários saem com 4 casas (custo_material, custo_energia,
// custo_total, preco_venda) e SÓ o que é gravado em products.sales_price — numeric(10,2) — é
// arredondado a 2 (`preco_venda_arredondado`). Nada de arredondar no meio e somar depois: isso
// cria a diferença de centavo que ninguém consegue explicar.
//
// A FICHA MANDA, O HISTÓRICO INFORMA (decisão travada): o custo usa filament_grams e
// production_minutes do CADASTRO. A média real das produções vem junto como `media_real`, em
// campo separado, pra tela poder dizer "a ficha diz 100 g, a realidade diz 112 g" — corrigir a
// ficha é decisão humana. Cálculo que se auto-ajusta pelo histórico é número que ninguém explica.
//
// NULL É RESPOSTA, NÃO FALHA: sem filamento vinculado, sem tarifa configurada ou sem impressora
// de referência, a parcela correspondente vem NULL, o total vem NULL e a peça carrega `alertas`
// dizendo o quê falta. Preencher buraco com zero seria dizer que material/energia são de graça.
//
// v1 usa UMA impressora de referência (settings 'impressora_padrao_3d'). Peça × impressora
// específica é v2 — hoje ninguém sabe em qual máquina cada peça vai rodar.
//
// PAGINAÇÃO SERVER-SIDE: envelope { pecas, total, limit, offset } com ?limit (default 25, teto
// 100), ?offset e ?q (ILIKE sobre sku OU name). O `total` traz o universo FILTRADO, e a mesma
// condição de busca vale para a página e para a contagem — total que não obedece ao filtro faz
// o "X–Y de Z" mentir. Fora da faixa é 400, não clamp (política herdada da Auditoria).
// A ordem do LIMIT dentro da query importa e está explicada em PRICING_SQL.

import { Request, Response } from 'express';
import { query as dbQuery } from '../db';
import { createLog } from '../utils/logger';
import { getClientIp } from '../utils/ip';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_GRAMS = 1_000_000;   // 1 tonelada de filamento numa peça já é erro de digitação.
const MAX_MINUTES = 1_000_000; // ~694 dias de impressão idem.
const MAX_MARGIN = 9999.99;    // teto do numeric(6,2).

// Config global: tarifa e impressora de referência. '' e '0' significam NÃO CONFIGURADA — o
// NULLIF garante que a ausência chegue como NULL na conta, nunca como zero silencioso.
const CFG_SQL = `
  cfg AS (
    SELECT
      NULLIF((SELECT value FROM settings WHERE key = 'energia_kwh_brl'), '')::numeric      AS tarifa,
      NULLIF((SELECT value FROM settings WHERE key = 'impressora_padrao_3d'), '')::uuid    AS printer_id
  )`;

// A conta de UMA PÁGINA de peças.
//   $1 = limit · $2 = offset · $3 = termo de busca (NULL = sem busca) · $4 = uma peça (NULL = todas)
//
// O $4 existe para o `aplicar_preco` recalcular UMA peça com esta mesma query — a fórmula mora num
// lugar só, e é decisão travada que continue assim. Antes isso era um .replace() no texto do WHERE;
// a paginação reescreveu esse WHERE e o replace passou a injetar $1 num segundo papel, quebrando o
// aplicar_preco (o smoke pegou). SQL não se remenda por busca-e-troca: se o filtro é variável, ele
// nasce parâmetro.
//
// O LIMIT/OFFSET vive na CTE `pagina`, ANTES do LEFT JOIN LATERAL do agregado — e essa ordem é o
// ponto inteiro desta query. O LATERAL varre productions_3d por peça; deixá-lo antes do corte
// faria o banco agregar o histórico das oito (amanhã, oitocentas) peças para depois jogar fora
// tudo menos a página. Cortando primeiro, o agregado roda sobre as N linhas que vão para a tela.
//
// ORDENAÇÃO name ASC + DESEMPATE POR id: sem o desempate, duas peças de mesmo nome podem trocar
// de lugar entre uma página e outra — a mesma linha apareceria duas vezes ou nenhuma ao virar a
// página. O mesmo par (name, id) se repete no ORDER BY final porque CTE não garante ordem.
const PRICING_SQL = `
  WITH ${CFG_SQL},
  pagina AS (
    SELECT p.id, p.sku, p.name, p.filament_grams, p.production_minutes,
           p.margin_percent, p.sales_price, p.filament_product_id
      FROM products p
     WHERE p.is_3d = true AND p.active = true
       AND ($3::text IS NULL OR p.sku ILIKE $3 OR p.name ILIKE $3)
       AND ($4::uuid IS NULL OR p.id = $4)
     ORDER BY p.name ASC, p.id ASC
     LIMIT $1 OFFSET $2
  ),
  base AS (
    SELECT p.id, p.sku, p.name,
           p.filament_grams, p.production_minutes, p.margin_percent, p.sales_price,
           f.id AS filament_id, f.sku AS filament_sku, f.name AS filament_name,
           f.unit_price AS filament_preco_kg,
           pr.id AS printer_id, pr.display_no AS printer_display_no, pr.name AS printer_name,
           pr.power_watts,
           cfg.tarifa,
           COALESCE(ag.impressas, 0)   AS impressas,
           COALESCE(ag.producoes, 0)   AS producoes,
           ag.gramas_reais, ag.minutos_reais,
           -- Material: NULL sem bobina vinculada (jamais chuta uma).
           CASE WHEN f.id IS NULL THEN NULL
                ELSE ROUND((p.filament_grams::numeric / 1000) * f.unit_price, 4)
           END AS custo_material,
           -- Energia: NULL sem tarifa (> 0) ou sem impressora de referência.
           CASE WHEN pr.power_watts IS NULL OR cfg.tarifa IS NULL OR cfg.tarifa <= 0 THEN NULL
                ELSE ROUND((p.production_minutes::numeric / 60) * (pr.power_watts::numeric / 1000) * cfg.tarifa, 4)
           END AS custo_energia
      -- FROM pagina (não products): o filtro, a ordem e o corte já aconteceram acima.
      FROM pagina p
      CROSS JOIN cfg
      -- O JOIN exige is_filament: vínculo apontando pra produto que deixou de ser bobina não
      -- vira preço fantasma — vira NULL + alerta, e alguém conserta o cadastro.
      LEFT JOIN products f    ON f.id = p.filament_product_id AND f.is_filament = true
      LEFT JOIN printers_3d pr ON pr.id = cfg.printer_id
      -- Agrega SÓ o histórico das peças desta página (ver o comentário do LIMIT acima).
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS producoes,
               SUM(pd.quantity)::int AS impressas,
               -- Média REAL por unidade produzida (diagnóstico, nunca entra no cálculo).
               ROUND(SUM(pd.filament_grams)::numeric / NULLIF(SUM(pd.quantity), 0), 2) AS gramas_reais,
               ROUND(SUM(pd.total_minutes)::numeric  / NULLIF(SUM(pd.quantity), 0), 2) AS minutos_reais
          FROM productions_3d pd WHERE pd.product_id = p.id
      ) ag ON TRUE
  )
  SELECT b.*,
         -- Total só existe se AS DUAS parcelas existem: um total que ignora a energia em silêncio
         -- é um número errado com cara de certo.
         CASE WHEN b.custo_material IS NULL OR b.custo_energia IS NULL THEN NULL
              ELSE ROUND(b.custo_material + b.custo_energia, 4) END AS custo_total,
         CASE WHEN b.custo_material IS NULL OR b.custo_energia IS NULL THEN NULL
              ELSE ROUND((b.custo_material + b.custo_energia) * (1 + b.margin_percent / 100), 4) END AS preco_venda,
         CASE WHEN b.custo_material IS NULL OR b.custo_energia IS NULL THEN NULL
              ELSE ROUND((b.custo_material + b.custo_energia) * (1 + b.margin_percent / 100), 2) END AS preco_venda_arredondado
    FROM base b
   ORDER BY b.name ASC, b.id ASC`;

// COUNT com EXATAMENTE o mesmo filtro da página, e em query própria de propósito: um
// `count(*) OVER ()` viajando nas linhas se perderia justo quando a página vem vazia (offset
// além do fim), que é quando o front mais precisa do total pra saber onde voltar.
const PRICING_COUNT_SQL = `
  SELECT COUNT(*)::int AS total
    FROM products p
   WHERE p.is_3d = true AND p.active = true
     AND ($1::text IS NULL OR p.sku ILIKE $1 OR p.name ILIKE $1)`;

const num = (v: any): number | null => (v === null || v === undefined ? null : Number(v));

// ── GET /producao-3d/pricing — uma PÁGINA da aba Precificação ────────────────
// ENVELOPE ADITIVO: `pecas` continua sendo `pecas` e mantém o mesmo shape por item; `total`,
// `limit` e `offset` entram AO LADO. O front que já está no ar ignora os campos novos e recebe
// as 25 primeiras peças — degrada para "a primeira página" durante a janela de deploy, nunca
// para tela quebrada. É o que permite subir backend antes de front sem coreografia.
export const getPricing = async (req: Request, res: Response) => {
  try {
    // ── Validação NA BORDA, mesma política da Auditoria (system.controller) ──
    // Fora da faixa é 400, NÃO clamp: o consumidor é o nosso próprio front, e devolver 100 pra
    // quem pediu 200 calado esconderia bug de chamada em vez de denunciá-lo.
    const DIGITS_RE = /^\d+$/;
    const { limit: rawLimit, offset: rawOffset, q: rawQ } = req.query;

    let limit = 25;
    if (rawLimit !== undefined) {
      if (typeof rawLimit !== 'string' || !DIGITS_RE.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100) {
        return res.status(400).json({ error: "Parâmetro 'limit' inválido: use um inteiro entre 1 e 100." });
      }
      limit = Number(rawLimit);
    }
    let offset = 0;
    if (rawOffset !== undefined) {
      if (typeof rawOffset !== 'string' || !DIGITS_RE.test(rawOffset)) {
        return res.status(400).json({ error: "Parâmetro 'offset' inválido: use um inteiro maior ou igual a 0." });
      }
      offset = Number(rawOffset);
    }
    if (rawQ !== undefined && typeof rawQ !== 'string') {
      return res.status(400).json({ error: "Parâmetro 'q' inválido: envie um único valor." });
    }
    // Termo vazio/só espaço = SEM busca (NULL), não busca por ''. Curingas % e _ digitados não
    // são escapados — buscar por '100%' casa tudo; mesma licença aceita na Auditoria.
    const termo = typeof rawQ === 'string' && rawQ.trim() ? `%${rawQ.trim()}%` : null;

    const [linhas, total, cfg, filamentos] = await Promise.all([
      dbQuery(PRICING_SQL, [limit, offset, termo, null], { retryable: true }),
      dbQuery(PRICING_COUNT_SQL, [termo], { retryable: true }),
      dbQuery(`WITH ${CFG_SQL}
               SELECT cfg.tarifa, pr.id AS printer_id, pr.display_no, pr.name, pr.power_watts, pr.status
                 FROM cfg LEFT JOIN printers_3d pr ON pr.id = cfg.printer_id`, [], { retryable: true }),
      // As bobinas disponíveis pro vínculo. Vive AQUI porque o GET /products não devolve a flag
      // is_filament (é view de outro módulo, com outro contrato) — e as duas abas novas precisam
      // exatamente desta lista: o dropdown da Precificação e a seção Filamentos do Registro de
      // Valores. Uma fonte só, o mesmo gate.
      dbQuery(`SELECT id, sku, name, unit, unit_price::float8 AS preco_kg
                 FROM products WHERE is_filament = true AND active = true ORDER BY name`, [], { retryable: true }),
    ]);

    const c = cfg.rows[0] ?? {};
    const tarifa = num(c.tarifa);
    const tarifaOk = tarifa !== null && tarifa > 0;
    const impressora = c.printer_id
      ? { id: c.printer_id, display_no: c.display_no, name: c.name, power_watts: c.power_watts, status: c.status }
      : null;

    const pecas = linhas.rows.map((r: any) => {
      const alertas: string[] = [];
      if (!r.filament_id) alertas.push('SEM_FILAMENTO');
      if (!tarifaOk) alertas.push('SEM_TARIFA');
      if (!impressora) alertas.push('SEM_IMPRESSORA');
      // Ficha zerada não impede a conta (dá zero honesto), mas é o alerta mais útil da tela:
      // era exatamente o estado das 8 peças no recon.
      if (!r.filament_grams || !r.production_minutes) alertas.push('FICHA_INCOMPLETA');

      return {
        id: r.id, sku: r.sku, name: r.name,
        ficha: { filament_grams: r.filament_grams, production_minutes: r.production_minutes },
        filament: r.filament_id
          ? { id: r.filament_id, sku: r.filament_sku, name: r.filament_name, preco_kg: num(r.filament_preco_kg) }
          : null,
        impressas: r.impressas,
        // null quando não há produção: 0 sugeriria "gastou zero", e o que houve foi nada.
        media_real: r.producoes > 0
          ? { producoes: r.producoes, gramas: num(r.gramas_reais), minutos: num(r.minutos_reais) }
          : null,
        custo: { material: num(r.custo_material), energia: num(r.custo_energia), total: num(r.custo_total) },
        margin_percent: num(r.margin_percent),
        preco_venda: num(r.preco_venda),
        preco_venda_arredondado: num(r.preco_venda_arredondado),
        sales_price_atual: num(r.sales_price),
        alertas,
      };
    });

    return res.json({
      tarifa_kwh: tarifa,
      tarifa_configurada: tarifaOk,
      impressora,
      impressora_configurada: !!impressora,
      filamentos: filamentos.rows,
      pecas,
      // `total` MUDOU DE SIGNIFICADO: era pecas.length (tamanho da resposta), agora é o universo
      // filtrado — é ele que dimensiona "X–Y de Z" e diz se existe próxima página. Os dois valores
      // eram idênticos enquanto tudo cabia numa resposta só, e o campo não tinha consumidor no
      // front (que lê `custo.total` por peça, outra coisa). `limit` e `offset` são novos.
      total: total.rows[0]?.total ?? 0,
      limit,
      offset,
      gerado_em: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('getPricing:', error?.message ?? error);
    return res.status(500).json({ error: 'Erro ao montar a precificação.' });
  }
};

// ── PUT /producao-3d/parts/:id/pricing — ficha técnica + margem (+ aplicar preço) ──
export const updatePartPricing = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Peça não encontrada.' });

  const { filament_grams, production_minutes, filament_product_id, margin_percent, aplicar_preco } = req.body ?? {};
  const sets: string[] = [];
  const vals: any[] = [];
  const alterados: string[] = [];

  if (filament_grams !== undefined) {
    const g = Number(filament_grams);
    if (!Number.isInteger(g) || g < 0 || g > MAX_GRAMS) return res.status(400).json({ error: 'Gramas devem ser um inteiro entre 0 e 1.000.000.' });
    vals.push(g); sets.push(`filament_grams = $${vals.length}`); alterados.push('filament_grams');
  }
  if (production_minutes !== undefined) {
    const m = Number(production_minutes);
    if (!Number.isInteger(m) || m < 0 || m > MAX_MINUTES) return res.status(400).json({ error: 'Minutos devem ser um inteiro entre 0 e 1.000.000.' });
    vals.push(m); sets.push(`production_minutes = $${vals.length}`); alterados.push('production_minutes');
  }
  if (margin_percent !== undefined) {
    const mp = Number(margin_percent);
    if (!Number.isFinite(mp) || mp < 0 || mp > MAX_MARGIN) return res.status(400).json({ error: 'Margem deve ser um número entre 0 e 9999,99.' });
    vals.push(mp); sets.push(`margin_percent = $${vals.length}`); alterados.push('margin_percent');
  }
  if (filament_product_id !== undefined) {
    if (filament_product_id === null || filament_product_id === '') {
      vals.push(null); sets.push(`filament_product_id = $${vals.length}`); alterados.push('filament_product_id');
    } else {
      const fid = String(filament_product_id);
      if (!UUID_RE.test(fid)) return res.status(400).json({ error: 'filament_product_id inválido.' });
      // O vínculo SÓ aceita quem é bobina de verdade: apontar a peça pra um parafuso daria um
      // "preço por kg" que não significa nada.
      const f = await dbQuery('SELECT id, is_filament FROM products WHERE id = $1', [fid]);
      if (f.rows.length === 0) return res.status(404).json({ error: 'Filamento não encontrado.' });
      if (f.rows[0].is_filament !== true) {
        return res.status(400).json({ error: 'O produto escolhido não está marcado como filamento (is_filament). Marque-o como bobina antes de vincular.' });
      }
      vals.push(fid); sets.push(`filament_product_id = $${vals.length}`); alterados.push('filament_product_id');
    }
  }

  if (sets.length === 0 && aplicar_preco !== true) return res.status(400).json({ error: 'Nada para atualizar.' });

  try {
    // A peça tem de ser peça 3D ativa — a aba não edita ficha de material comum.
    const peca = await dbQuery('SELECT id, sku, is_3d, active FROM products WHERE id = $1', [id]);
    if (peca.rows.length === 0 || peca.rows[0].is_3d !== true) return res.status(404).json({ error: 'Peça 3D não encontrada.' });

    if (sets.length > 0) {
      vals.push(id);
      await dbQuery(`UPDATE products SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    }

    // aplicar_preco: RECALCULA no servidor a partir do estado JÁ GRAVADO e escreve em
    // sales_price. Nunca aceita preço pronto do body — o front manda a intenção, não o número.
    let precoAplicado: number | null = null;
    if (aplicar_preco === true) {
      // Mesma query da tela, filtrada em UMA peça pelo $4: uma fórmula, uma fonte.
      const calc = await dbQuery(PRICING_SQL, [1, 0, null, id], { retryable: true });
      const linha = calc.rows[0];
      if (!linha || linha.preco_venda_arredondado === null) {
        return res.status(400).json({
          error: 'Não dá pra aplicar o preço: o custo está incompleto (falta filamento vinculado, tarifa de energia ou impressora de referência).',
        });
      }
      precoAplicado = Number(linha.preco_venda_arredondado);
      await dbQuery('UPDATE products SET sales_price = $1 WHERE id = $2', [precoAplicado, id]);
      alterados.push('sales_price');
    }

    await createLog(userId, 'EDITAR_FICHA_3D', { id, sku: peca.rows[0].sku, alterados }, getClientIp(req));
    return res.json({ id, sku: peca.rows[0].sku, alterados, preco_aplicado: precoAplicado });
  } catch (error: any) {
    console.error('updatePartPricing:', error?.message ?? error);
    return res.status(500).json({ error: 'Erro ao salvar a ficha da peça.' });
  }
};
