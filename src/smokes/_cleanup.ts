// src/smokes/_cleanup.ts — DISCIPLINA C: destruição escopada de dados de teste.
//
// ⚠️ ESTE MÓDULO É UMA VIOLAÇÃO CONSCIENTE DE APPEND-ONLY DO RAZÃO. ⚠️
//
// A doutrina da casa é: `stock_ledger` é livro, e livro não se edita. Este módulo APAGA linhas de
// `stock_ledger`. O nome dele diz isso na cara de propósito — o nome antigo ("cleanup cirúrgico")
// descrevia o cuidado e escondia o ato, e foi justamente essa maquiagem que deixou 6 linhas de
// razão serem apagadas em 07/08/2026 sem ninguém notar (incidente registrado no DIVIDAS.md).
//
// POR QUE EXISTE, e não é preguiça: `stock_ledger.product_id` tem FK para `products`. Um smoke que
// cria produto e movimenta estoque só tem duas saídas — ou apaga o razão dele junto (e edita o
// livro), ou deixa produto de teste acumulando PARA SEMPRE no banco de validação, aparecendo em
// toda tela de produto do sistema. Não há terceira opção enquanto smoke e validação dividirem o
// MESMO banco.
//
// ESCOPO RESTRITO À PRÓPRIA EXECUÇÃO, e isso é ASSERTADO antes de qualquer DELETE:
//   1. todo produto do escopo tem que carregar a MARCA desta execução no `name` (conferido no
//      banco, não na memória) — pega o caso em que a lista de ids foi poluída por um id alheio,
//      que é exatamente como um smoke destrói dado real;
//   2. as linhas de razão a apagar são LEVANTADAS E CONFERIDAS uma a uma (todo `product_id` tem
//      que pertencer ao conjunto em memória) e o DELETE roda POR ESSES IDS EXPLÍCITOS, nunca por
//      `product_id` e JAMAIS por faixa de SKU;
//   3. o `rowCount` do DELETE tem que bater com a contagem conferida — apagou mais que o
//      levantado, é erro, não "deu certo".
// Qualquer violação ABORTA sem apagar NADA e devolve o motivo. Recusar-se a limpar e deixar
// resíduo visível é infinitamente melhor que apagar uma linha que não é nossa.
//
// MORRE QUANDO A MISSÃO B CHEGAR: smokes rodando contra branch Neon efêmero criado e destruído
// por execução. Aí destruir o BANCO substitui editar o LIVRO, a exceção deixa de ser necessária
// e este módulo sai inteiro. Ver a entrada "MISSÃO B" no DIVIDAS.md.

import type { Pool } from 'pg';

export interface EscopoDeTeste {
  /** Marca única desta execução (o `stamp`). Tem que aparecer no `name` de todo produto criado. */
  marca: string;
  /** uuids dos produtos criados NESTA execução — coletados em memória, na hora da criação. */
  produtos: string[];
  /**
   * Etapas de destruição na ordem das FKs: [rótulo da tabela, SQL, params].
   * A etapa de `stock_ledger` NÃO entra aqui: ela é tratada pelo caminho conferido interno.
   */
  etapas: Array<[string, string, any[]]>;
}

export interface ResultadoDestruicao {
  ok: boolean;
  motivo: string;
  /** rowCount por rótulo de etapa, para o smoke logar e assertar. */
  contagem: Record<string, number>;
  /** Etapas que falharam individualmente (uma não contamina as outras). */
  falhas: string[];
  /** Linhas de razão conferidas e apagadas — o número que vai para o relatório do incidente. */
  razaoApagado: number;
}

/**
 * Confere o escopo e, se ele fechar, destrói os dados de teste desta execução.
 * NÃO lança: devolve `ok: false` com motivo, para o smoke transformar em check vermelho.
 */
export async function destruicaoEscopadaDeDadosDeTeste(
  pool: Pool,
  escopo: EscopoDeTeste,
): Promise<ResultadoDestruicao> {
  const out: ResultadoDestruicao = { ok: true, motivo: '', contagem: {}, falhas: [], razaoApagado: 0 };
  const produtos = escopo.produtos.filter(Boolean);

  // ── GUARDA 1: todo produto do escopo é NOSSO, e o banco é quem confirma ──────────────────
  if (produtos.length > 0) {
    if (!escopo.marca || escopo.marca.length < 6) {
      out.ok = false;
      out.motivo = `marca de execução ausente ou curta demais ("${escopo.marca}") — sem ela não há como provar posse dos produtos. NADA foi apagado.`;
      return out;
    }
    let confere;
    try {
      confere = await pool.query<{ id: string; sku: string; name: string }>(
        `SELECT id, sku, name FROM products WHERE id = ANY($1::uuid[])`, [produtos]);
    } catch (e: any) {
      out.ok = false;
      out.motivo = `falha ao conferir posse dos produtos: ${e?.message ?? e}. NADA foi apagado.`;
      return out;
    }
    const semMarca = confere.rows.filter((r) => !String(r.name ?? '').includes(escopo.marca));
    if (semMarca.length > 0) {
      out.ok = false;
      out.motivo =
        `ABORTADO: ${semMarca.length} produto(s) do escopo NÃO carregam a marca desta execução ` +
        `("${escopo.marca}") — ${semMarca.map((r) => `${r.sku}/${r.name}`).join(', ')}. ` +
        `A lista de ids foi poluída por dado que não é nosso. NADA foi apagado.`;
      return out;
    }
  }

  // ── GUARDA 2 + 3: razão levantado, conferido linha a linha, apagado POR ID ───────────────
  if (produtos.length > 0) {
    const conjunto = new Set(produtos);
    let alvo;
    try {
      alvo = await pool.query<{ id: string; product_id: string }>(
        `SELECT id, product_id FROM stock_ledger WHERE product_id = ANY($1::uuid[])`, [produtos]);
    } catch (e: any) {
      out.ok = false;
      out.motivo = `falha ao levantar o razão do escopo: ${e?.message ?? e}. NADA foi apagado.`;
      return out;
    }
    const fora = alvo.rows.filter((r) => !conjunto.has(r.product_id));
    if (fora.length > 0) {
      out.ok = false;
      out.motivo =
        `ABORTADO: ${fora.length} linha(s) de stock_ledger no alvo apontam para produto FORA do ` +
        `escopo desta execução (ids ${fora.slice(0, 5).map((r) => r.id).join(', ')}…). NADA foi apagado.`;
      return out;
    }
    const ids = alvo.rows.map((r) => r.id);
    if (ids.length > 0) {
      try {
        // POR ID EXPLÍCITO — a lista que acabou de ser conferida, e nada além dela.
        const r = await pool.query(`DELETE FROM stock_ledger WHERE id = ANY($1::bigint[])`, [ids]);
        if (r.rowCount !== ids.length) {
          out.ok = false;
          out.motivo =
            `INCOERÊNCIA: o DELETE do razão removeu ${r.rowCount} linha(s), mas ${ids.length} ` +
            `foram conferidas. Investigar ANTES de confiar neste banco.`;
          out.falhas.push('stock_ledger: rowCount divergente do conferido');
        }
        out.contagem['stock_ledger'] = r.rowCount ?? 0;
        out.razaoApagado = r.rowCount ?? 0;
      } catch (e: any) {
        out.falhas.push(`stock_ledger: ${e?.message ?? e}`);
      }
    } else {
      out.contagem['stock_ledger'] = 0;
    }
  }

  // ── As demais etapas, cada uma no seu try (uma falha não contamina as outras) ────────────
  for (const [rotulo, sql, params] of escopo.etapas) {
    const primeiro = params[0];
    if (Array.isArray(primeiro) && primeiro.filter((x) => x !== null && x !== undefined).length === 0) continue;
    if (primeiro === null || primeiro === undefined) continue;
    try {
      const r = await pool.query(sql, params);
      out.contagem[rotulo] = r.rowCount ?? 0;
    } catch (e: any) {
      out.falhas.push(`${rotulo}: ${e?.message ?? e}`);
    }
  }

  if (out.falhas.length > 0 && out.ok) {
    out.ok = false;
    out.motivo = `${out.falhas.length} etapa(s) de destruição falharam — pode haver resíduo.`;
  }
  return out;
}

/** Log em uma linha, no formato `tabela=n`, na ordem em que as etapas rodaram. */
export function formatarContagem(r: ResultadoDestruicao): string {
  const pares = Object.entries(r.contagem).map(([k, v]) => `${k}=${v}`);
  return pares.length ? pares.join(' ') : '(nada a apagar)';
}
