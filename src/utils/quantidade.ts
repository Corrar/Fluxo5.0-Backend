// ── QUANTIDADE: a régua ÚNICA de unidade do backend (lote V) ────────────────────────────────────
//
// Antes deste arquivo havia DUAS cópias da mesma lista no backend (requests.controller.ts:16 e
// stock.controller.ts:862) e mais três no front. Cópia de régua é régua que diverge: basta alguém
// acrescentar uma unidade num lugar para o mesmo produto passar num endpoint e ser recusado noutro.
// Aqui é a fonte; os antigos pontos delegam.
//
// A lista NÃO mudou ao ser promovida — é byte a byte a de requests.controller.ts, com o mesmo
// default seguro: unidade desconhecida conta como INTEIRA. 'UND' fica FORA de propósito (é sinônimo
// de 'UN', não medida contínua) e 'MT' fica DENTRO por fidelidade à lista original.
// Erro TIPADO da regua de unidade. Existe porque nem todo catch da casa converte `Error` generico
// em 400: os de stock.controller.ts mapeiam por CLASSE (StockError) ou por sentinela nomeada, e
// tudo o mais cai em 500. Um 500 aqui seria mentira — a requisicao esta errada, nao o servidor.
export class QuantidadeInvalidaError extends Error {
  constructor(message: string) { super(message); this.name = 'QuantidadeInvalidaError'; }
}

export const DECIMAL_UNITS = new Set(['M', 'MT', 'L', 'KG']);

export const isDecimalUnit = (un: unknown): boolean =>
  DECIMAL_UNITS.has(String(un ?? '').trim().toUpperCase());

// Valida a quantidade de UMA linha contra a unidade do produto.
// Devolve a mensagem de erro (para o operador, em português) ou `null` quando passa.
//
// ⚠ RECUSA, nunca arredonda nem reescreve — mesma disciplina do front (adapters.js). Arredondar
// silenciosamente é o que transforma erro de digitação em movimento de estoque errado.
// ⚠ Guarda de ESCRITA NOVA: nada aqui varre nem invalida o que já está gravado. Linha antiga com
// fração numa unidade de contagem continua existindo e sendo lida — só não se cria mais nenhuma.
export function validarQuantidade(
  bruto: unknown,
  unidade: unknown,
  opts?: { minimo?: number; rotulo?: string },
): string | null {
  const minimo = opts?.minimo ?? 0;            // 0 = precisa ser > 0 · use minimo:-Infinity p/ aceitar 0
  const rotulo = opts?.rotulo ? `${opts.rotulo}: ` : '';
  const n = Number(bruto);

  if (!Number.isFinite(n)) {
    return `${rotulo}quantidade inválida — informe um número.`;
  }
  if (n <= minimo) {
    return `${rotulo}informe uma quantidade maior que ${minimo}.`;
  }
  if (!isDecimalUnit(unidade) && !Number.isInteger(n)) {
    const un = String(unidade ?? '').trim() || '(sem unidade)';
    return `${rotulo}a unidade "${un}" não aceita casas decimais — informe um número inteiro.`;
  }
  return null;
}

// Busca as unidades de vários produtos numa tacada só. Devolve Map<product_id, unit>.
// Produto ausente do Map = produto que não existe; quem chama decide o que fazer com isso.
export async function unidadesDe(client: any, ids: string[]): Promise<Map<string, string>> {
  const unicos = Array.from(new Set(ids.filter(Boolean)));
  if (unicos.length === 0) return new Map();
  const r = await client.query('SELECT id, unit FROM products WHERE id = ANY($1::uuid[])', [unicos]);
  return new Map(r.rows.map((x: any) => [String(x.id), String(x.unit ?? '')]));
}

// Guarda de LOTE: valida todas as linhas de uma requisição de uma vez, com UMA consulta de unidade.
// Lança na primeira linha inválida — a mensagem já é a que vai para o operador (os catches dos
// controllers convertem `error.message` em 400). Dentro de withTransaction o throw faz ROLLBACK,
// então nada é gravado pela metade.
//
// ⚠ Só olha o que ESTÁ CHEGANDO. Não lê nem julga linha já gravada.
export async function assertQuantidadesValidas(
  client: any,
  itens: Array<{ product_id?: unknown; quantity?: unknown }>,
  opts?: { campo?: string; nomear?: (item: any, i: number) => string },
): Promise<void> {
  const lista = (itens ?? []).filter(Boolean);
  if (lista.length === 0) return;
  const campo = opts?.campo ?? 'quantity';
  const unidades = await unidadesDe(client, lista.map((i: any) => String(i.product_id ?? '')));

  for (let i = 0; i < lista.length; i++) {
    const item: any = lista[i];
    const pid = String(item.product_id ?? '');
    // Produto desconhecido não é problema DESTA guarda: quem escreve já falha no FK. Passar reto
    // aqui evita que a régua de unidade roube a mensagem de erro certa de outra validação.
    if (!unidades.has(pid)) continue;
    const rotulo = opts?.nomear ? opts.nomear(item, i) : (lista.length > 1 ? `Item ${i + 1}` : '');
    const erro = validarQuantidade(item[campo], unidades.get(pid), { rotulo });
    if (erro) throw new QuantidadeInvalidaError(erro);
  }
}

// Variante para os pontos em que ZERO é legítimo (zerar uma linha LIBERA a reserva — é operação
// válida, não erro). Só a régua de fração se aplica; negativo já é barrado antes, por quem chama.
export async function assertFracaoPermitida(client: any, productId: string, qty: number): Promise<void> {
  const unidades = await unidadesDe(client, [productId]);
  if (!unidades.has(productId)) return;
  const un = unidades.get(productId);
  if (!isDecimalUnit(un) && Number.isFinite(qty) && !Number.isInteger(qty)) {
    throw new QuantidadeInvalidaError(`A unidade "${String(un ?? '').trim() || '(sem unidade)'}" não aceita casas decimais — informe um número inteiro.`);
  }
}
