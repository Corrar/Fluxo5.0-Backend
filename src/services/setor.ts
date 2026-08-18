// src/services/setor.ts — Fluxo Royale 5.0
// Vocabulário de SETOR: normalização e o de-para setor -> armazém.
//
// Este módulo não fala com o banco de propósito: é lógica de vocabulário pura, testável sem
// Postgres. Quem traduz o `code` daqui para o uuid de `warehouses` é o
// `resolveDestinationWarehouseId` em `warehouse.ts`.

// ─────────────────────────────────────────────────────────────────────────────────────────────
// POR QUE ISTO EXISTE: "setor" é campo de TEXTO LIVRE em duas pontas — `profiles.sector`
// (cadastro de usuário, `pages_admin.jsx:1109-1110`) e `separations.destination` (digitado pelo
// operador). Medido em produção em 18/08/2026, o MESMO setor aparece em até três grafias:
// "ELETRICA" (62), "Elétrica" (27) e "eletrica" (2). Comparar por igualdade de string erraria a
// maioria das linhas — e erraria em SILÊNCIO, concluindo que o setor não existe.
// Ver DIVIDAS.md, "REQUISITO DO LOTE SEGUINTE" da seção do de-para.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Forma canônica de um nome de setor: sem acento, MAIÚSCULO, espaço normalizado, sem o prefixo
 * "Setor:".
 *
 * O strip do prefixo é DEFENSIVO e tem número: a migration 025 tirou "Setor: " de `profiles.sector`
 * (5 perfis) e com isso a torneira estancou, mas **210 de 2.641 solicitações históricas** ainda têm
 * `requests.sector = "Setor: Usinagem"` (janela medida: 12/06/2026 a 17/08/2026). Quem ler esse
 * histórico precisa chegar em USINAGEM, não em "SETOR: USINAGEM".
 *
 * Normalização em TypeScript, não `unaccent` do Postgres: a extension exigiria migration e
 * privilégio, e o de-para tem de funcionar igual dentro e fora de transação. NFD + remoção da faixa
 * de diacríticos combinantes (U+0300–U+036F) resolve sem nada disso.
 */
export function canonSetor(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim().replace(/\s+/g, ' ');   // colapsa espaço interno múltiplo
  if (!s) return null;
  s = s.replace(/^setor\s*:\s*/i, '').trim();        // "Setor: Usinagem" -> "Usinagem"
  if (!s) return null;                               // o valor era SÓ o prefixo
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ⚠ A FONTE DO DE-PARA É ESTE MAPA — NÃO `warehouses.sector`.
//
// `warehouses.sector` existe e parece a fonte óbvia, mas NÃO é, por três razões medidas no M5
// (produção, 18/08/2026):
//
//   1. VOCABULÁRIO DIFERENTE. A coluna guarda slug snake_case — `producao_3d`, `eletrica`,
//      `classificadora` — que não bate nem com o canônico daqui (`PRODUCAO 3D`, `ELETRICA`) nem
//      com o texto livre das duas pontas ("Produção 3D", "Elétrica", "eletrica").
//   2. É 1→1, e o de-para é N→1. `3D` e `PRODUCAO 3D` apontam AMBOS para `P3D`; uma coluna com um
//      valor por armazém não tem onde guardar sinônimo.
//   3. Não carrega a decisão de "SEM ARMAZÉM". Escritório, Chefia, Viagem e os outros 15 são
//      decisão de produto (consomem na entrega, sem custódia) e não existem como linha em
//      `warehouses` — não há onde escrevê-los lá.
//
// ⚠⚠ E A PRESCRIÇÃO, que é a parte que importa: a coluna é GRAVÁVEL e não tem CHECK, e foi a
// própria migration 024 que escreveu aqueles slugs. O risco real não é alguém LER dela — é alguém
// tentar "consertar o de-para" com um `UPDATE warehouses SET sector = ...` e achar que resolveu,
// enquanto o resolver continua lendo daqui e nada muda.
//
//        SETOR NOVO ENTRA COMO **CHAVE NESTE MAPA**, NUNCA COMO UPDATE EM `warehouses.sector`.
//
// `warehouses.sector` fica como metadado descritivo do armazém. Este lote NÃO altera a coluna: é
// dado de produção, está correta para o que ela é, e não estorva.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * De-para FECHADO (decisão do Bruno, 18/08/2026 — ver DIVIDAS.md).
 * Chave = forma canônica (`canonSetor`). Valor = `warehouses.code`, ou `null` para "consome na
 * entrega, sem custódia".
 *
 * `null` aqui é DECISÃO REGISTRADA, não ausência: a diferença entre "decidi que não tem armazém" e
 * "nunca ouvi falar desse setor" é o que `resolveDestinationWarehouse` existe para distinguir.
 */
export const SETOR_ARMAZEM: Record<string, string | null> = {
  // ── COM ARMAZÉM: guardam custódia (recebem por transferência, apontam consumo depois) ──
  'USINAGEM': 'USINAGEM',
  'ELETRICA': 'ELET',
  '3D': 'P3D',
  'PRODUCAO 3D': 'P3D',               // sinônimo de 3D — o N→1 que a coluna não comportaria
  'ESTEIRA': 'ESTEIRA',
  'LAVADORA': 'LAVADORA',
  'FLOW': 'FLOW',
  'CLASSIFICADORA': 'CLASSIF',
  'EMBALADORA': 'EMBALAD',
  'PROTOTIPO': 'PROTOTIPO',
  'DESENVOLVIMENTO': 'DESENV',

  // ── SEM ARMAZÉM: consomem na entrega, sem custódia, sem apontamento ──
  // Criar armazém para quem não guarda material seria criar saldo que ninguém aponta.
  'ESCRITORIO': null,
  'CHEFIA': null,
  'FINANCEIRO': null,
  'COMPRAS': null,
  'GERENCIA': null,
  'ASSISTENTE TECNICO': null,
  'ENGENHARIA': null,
  'FERRO': null,
  'GERAL': null,
  'OUTROS SETORES': null,
  'OUTRO': null,
  'ALMOXARIFADO': null,
  'VIAGEM': null,
  'TERCEIROS': null,
  'REPOSICAO': null,
  'ACUMULADOR': null,
  'GRANJA NATUROVOS': null,
  // OBRAS é valor LEGADO, e entra por fato medido, não por analogia: as 2 solicitações com
  // `requests.sector = 'Obras'` (25/03 e 02/04/2026) são do mesmo usuário, cujo `profiles.sector`
  // HOJE é "Outros Setores" — que já é null aqui. A derivação atual (requests.controller.ts:133-137)
  // não consegue mais gerar "Obras", porque nenhum perfil tem esse setor. A chave fecha o
  // histórico; não decide política nova.
  'OBRAS': null,

  // ── INDEFINIDOS, fora do mapa de propósito: MONTAGEM e EXPEDICAO ──
  // Os armazéns MONT e EXP existem desde a 004, estão vazios (0 linhas de `stock`) e não têm
  // tráfego em `separations.destination`. Não se sabe se guardam custódia; chutar plantaria
  // de-para errado onde o transfer vai ler como verdade. Ficam FORA até decisão — e, por estarem
  // fora, caem no ramo `conhecido: false`, que AVISA. É o comportamento desejado: um setor
  // indefinido que aparecer em produção tem de gritar, não passar batido.
};

/** Resultado da tradução. `conhecido` separa decisão registrada de buraco no mapa. */
export interface DestinoSetor {
  /** `warehouses.code` do destino, ou `null` quando o setor não tem armazém. */
  code: string | null;
  /** `true` = o setor está no mapa (com ou sem armazém). `false` = o mapa não o conhece. */
  conhecido: boolean;
}

/**
 * Traduz um setor cru em destino.
 *
 * Os três casos, e por que a distinção não é detalhe:
 *   • chave presente com code   -> { code, conhecido: true }
 *   • chave presente com null   -> { code: null, conhecido: true }   decisão registrada
 *   • chave AUSENTE             -> { code: null, conhecido: false }  + aviso no log
 *
 * Os dois últimos produzem o MESMO efeito prático — sem armazém —, e é isso que garante o
 * fallback: **NUNCA falhar por setor desconhecido**. Um nome novo digitado no cadastro não pode
 * travar a operação de quem está no chão de fábrica.
 *
 * Mas eles não são a mesma coisa, e sem a distinção o mapa desatualiza em silêncio: "decidi que
 * não tem armazém" e "nunca ouvi falar desse setor" viram o mesmo `null`, e ninguém descobre que
 * apareceu setor novo até alguém ir conferir à mão.
 */
export function resolveDestinationWarehouse(sector: string | null | undefined): DestinoSetor {
  const canon = canonSetor(sector);
  if (canon === null) return { code: null, conhecido: true };   // sem setor é ausência, não buraco

  if (!Object.prototype.hasOwnProperty.call(SETOR_ARMAZEM, canon)) {
    // Não é erro: é o mapa envelhecendo. Loga o cru E o canônico — sem o cru não dá para saber o
    // que foi digitado; sem o canônico não dá para saber qual chave acrescentar.
    console.warn(
      `[setor] SETOR DESCONHECIDO no de-para: cru=${JSON.stringify(sector)} canônico=${JSON.stringify(canon)}. ` +
      'A solicitação segue SEM armazém de destino (fallback). Acrescente a chave em SETOR_ARMAZEM ' +
      '(src/services/setor.ts) — NUNCA com UPDATE em warehouses.sector.',
    );
    return { code: null, conhecido: false };
  }

  return { code: SETOR_ARMAZEM[canon], conhecido: true };
}
