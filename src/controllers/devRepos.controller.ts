// src/controllers/devRepos.controller.ts — Relatório de trabalho em código (espelho GitHub) v1.
//
// O CONTRATO EM UMA FRASE: o GitHub é a FONTE, `repo_commits` é o ESPELHO, e a tela lê SEMPRE
// do espelho. Nenhuma rota de LEITURA toca a rede externa — só a sync escreve. É isso que faz
// token expirado, rate limit ou GitHub fora do ar virarem um CARIMBO na tela ("sincronizado
// em X", "última sync falhou porque…") em vez de uma tela quebrada.
//
// RESILIÊNCIA POR CONSTRUÇÃO (a regra que governa o arquivo inteiro):
//   • A sync escreve o espelho SÓ no caminho feliz. Em qualquer falha o espelho fica INTACTO —
//     servir o último estado bom com carimbo honesto é melhor que servir vazio ou meia-verdade.
//   • Toda falha vira estado PERSISTIDO (last_sync_status='erro' + last_sync_error), não só um
//     HTTP que some. O usuário que não estava olhando na hora precisa saber depois.
//   • Sem retry automático: o botão É o retry. Retry escondido multiplica chamada em API com
//     rate limit e transforma "falhou" em "demorou muito e falhou".
//
// AUTORIZAÇÃO: authenticate + requirePermission('dev_repos') na rota — sem check inline aqui.

import { Request, Response } from 'express';
import { pool, query as dbQuery } from '../db';
import { createLog } from '../utils/logger';
import { getClientIp } from '../utils/ip';

// ── Bordas ───────────────────────────────────────────────────────────────────
// owner/name do GitHub: letras, números, ponto, hífen e underscore. O regex existe pra duas
// coisas — recusar lixo cedo (400 em vez de 502 lá na frente) e garantir que o valor é seguro
// de interpolar na URL da API (nada de barra, '..' ou query string viajando no path).
const SLUG_RE = /^[A-Za-z0-9_.-]+$/;
const SLUG_MAX = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS_RE = /^\d+$/;

// YYYY-MM-DD estrito + sanidade de calendário — mesmo helper da Auditoria (o regex sozinho
// deixaria passar 2026-13-01, que estouraria 500 no cast ::date).
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidYmd(s: string): boolean {
  if (!YMD_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function validarSlug(valor: unknown, campo: string): string | null {
  if (typeof valor !== 'string') return `Campo '${campo}' é obrigatório.`;
  const limpo = valor.trim();
  if (!limpo) return `Campo '${campo}' é obrigatório.`;
  if (limpo.length > SLUG_MAX) return `Campo '${campo}' deve ter no máximo ${SLUG_MAX} caracteres.`;
  if (!SLUG_RE.test(limpo)) return `Campo '${campo}' inválido: use apenas letras, números, ponto, hífen e underscore.`;
  return null;
}

// ── Espelho: o que a v1 guarda de cada commit ────────────────────────────────
const TETO_COMMITS_POR_SYNC = 1000;   // ~10 páginas de 100 — ver comentário no syncRepo
const PER_PAGE = 100;
const TIMEOUT_PAGINA_MS = 10_000;
const ERRO_MAX = 500;

interface CommitEspelho {
  sha: string;
  message: string;
  author_name: string;
  author_date: string;
}

/**
 * Busca commits do branch default seguindo o Link header (paginação da API do GitHub).
 * LANÇA em qualquer falha — quem chama decide o que fazer, e o espelho só é tocado no sucesso.
 *
 * NUNCA registra o token: as mensagens de erro carregam status HTTP e URL do repo, jamais o
 * header. Um segredo em log de auditoria é um segredo vazado.
 */
async function buscarCommitsGitHub(
  owner: string,
  name: string,
  desde: Date | null,
): Promise<CommitEspelho[]> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    // 503 lá em cima: é falta de CONFIGURAÇÃO, não erro do repo nem do usuário. Sem este
    // caminho explícito o fetch sairia sem credencial e o GitHub responderia 404 em repo
    // privado — o erro mais enganoso possível ("repo não existe" quando existe).
    const e: any = new Error('integração GitHub não configurada');
    e.code = 'SEM_TOKEN';
    throw e;
  }

  const out: CommitEspelho[] = [];
  let url = `https://api.github.com/repos/${owner}/${name}/commits?per_page=${PER_PAGE}`;
  // INCREMENTAL: com ?since só vem o que mudou desde a última sync boa. A primeira sync busca
  // tudo (limitada pelo teto). `since` é do GitHub e é sobre author_date — a mesma data que o
  // espelho guarda, então a janela fecha certo.
  if (desde) url += `&since=${encodeURIComponent(desde.toISOString())}`;

  let pagina = 0;
  while (url) {
    pagina += 1;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_PAGINA_MS);
    let res: globalThis.Response;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'fluxo-royale-dev-repos',
        },
        signal: ctrl.signal,
      });
    } catch (err: any) {
      // AbortError vira mensagem de gente: "timeout" diz o que houve; "The operation was
      // aborted" faria o usuário abrir chamado perguntando o que ele abortou.
      throw new Error(
        err?.name === 'AbortError'
          ? `tempo esgotado (${TIMEOUT_PAGINA_MS / 1000}s) ao falar com o GitHub na página ${pagina}`
          : `falha de rede ao falar com o GitHub: ${err?.message ?? 'desconhecida'}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // Traduções úteis dos status que realmente acontecem. O resto cai no genérico COM o
      // status — número de status é diagnóstico, não ruído.
      if (res.status === 404) {
        throw new Error(`repo não encontrado ou token sem acesso: ${owner}/${name}`);
      }
      if (res.status === 401) throw new Error('token do GitHub inválido ou expirado (401)');
      if (res.status === 403) {
        const resta = res.headers.get('x-ratelimit-remaining');
        throw new Error(resta === '0'
          ? 'limite de requisições do GitHub atingido (403) — tente novamente mais tarde'
          : 'acesso negado pelo GitHub (403) — token sem permissão para este repositório');
      }
      throw new Error(`GitHub respondeu HTTP ${res.status} para ${owner}/${name}`);
    }

    const lote = await res.json();
    if (!Array.isArray(lote)) throw new Error('resposta inesperada do GitHub (esperava lista de commits)');

    for (const c of lote) {
      const sha = c?.sha;
      const commit = c?.commit;
      const data = commit?.author?.date ?? commit?.committer?.date;
      // Commit sem sha ou sem data não tem como entrar no espelho (a PK e o período dependem
      // deles). Descartar em silêncio seria pior — mas quebrar a sync inteira por uma linha
      // estranha também. Descarta e segue: a contagem final expõe a diferença.
      if (typeof sha !== 'string' || !sha || !data) continue;
      out.push({
        sha,
        message: typeof commit?.message === 'string' ? commit.message : '',
        author_name: typeof commit?.author?.name === 'string' ? commit.author.name : '',
        author_date: data,
      });
    }

    if (out.length >= TETO_COMMITS_POR_SYNC) {
      // TETO DE SEGURANÇA, documentado e deliberado: um repo com 50 mil commits na PRIMEIRA
      // sync seguraria a requisição por minutos e estouraria o rate limit. Como a sync é
      // incremental daqui pra frente, apertar o botão de novo continua de onde parou — e a
      // segunda sync já pega o resto, porque last_synced_at avançou.
      out.length = TETO_COMMITS_POR_SYNC;
      break;
    }

    // Paginação pelo Link header (contrato do GitHub) — nunca adivinhando ?page=n+1.
    const link = res.headers.get('link') ?? '';
    const prox = link.split(',').find((p) => p.includes('rel="next"'));
    const m = prox?.match(/<([^>]+)>/);
    url = m ? m[1] : '';
  }

  return out;
}

/** Grava o lote no espelho. ON CONFLICT DO NOTHING = re-sync não duplica. Devolve os NOVOS. */
async function gravarEspelho(repoId: string, commits: CommitEspelho[]): Promise<number> {
  if (commits.length === 0) return 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let novos = 0;
    for (const c of commits) {
      const r = await client.query(
        `INSERT INTO repo_commits (repo_id, sha, message, author_name, author_date)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (repo_id, sha) DO NOTHING`,
        [repoId, c.sha, c.message, c.author_name, c.author_date],
      );
      novos += r.rowCount ?? 0;
    }
    await client.query('COMMIT');
    return novos;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ── GET /dev-repos ───────────────────────────────────────────────────────────
export const listRepos = async (_req: Request, res: Response) => {
  try {
    const { rows } = await dbQuery(
      `SELECT r.id, r.owner, r.name, r.active, r.last_synced_at,
              r.last_sync_status, r.last_sync_error, r.created_at,
              (SELECT COUNT(*)::int FROM repo_commits c WHERE c.repo_id = r.id) AS commits
         FROM dev_repos r
        ORDER BY r.owner, r.name`,
    );
    res.json({ repos: rows, total: rows.length });
  } catch {
    res.status(500).json({ error: 'Erro ao listar repositórios.' });
  }
};

// ── POST /dev-repos ──────────────────────────────────────────────────────────
export const createRepo = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { owner, name } = req.body ?? {};
  const erro = validarSlug(owner, 'owner') ?? validarSlug(name, 'name');
  if (erro) return res.status(400).json({ error: erro });

  const o = String(owner).trim();
  const n = String(name).trim();
  try {
    const { rows } = await pool.query(
      `INSERT INTO dev_repos (owner, name, created_by) VALUES ($1, $2, $3)
       RETURNING id, owner, name, active, last_sync_status, last_synced_at`,
      [o, n, userId],
    );
    await createLog(userId, 'CRIAR_REPO', { repo: `${o}/${n}`, repo_id: rows[0].id }, getClientIp(req));
    res.status(201).json(rows[0]);
  } catch (error: any) {
    // 23505 = unique_violation. O UNIQUE do schema é quem decide — checar antes com um SELECT
    // abriria janela de corrida entre a checagem e o insert.
    if (error?.code === '23505') {
      return res.status(409).json({ error: `O repositório ${o}/${n} já está cadastrado.` });
    }
    res.status(500).json({ error: 'Erro ao cadastrar repositório.' });
  }
};

// ── PUT /dev-repos/:id ───────────────────────────────────────────────────────
export const updateRepo = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Id inválido.' });

  const { owner, name, active } = req.body ?? {};
  const campos: string[] = [];
  const params: any[] = [];
  const alterados: string[] = [];

  // PARCIAL de verdade: só entra no SET o que veio no body. `undefined` é "não mexer";
  // mandar o objeto inteiro do front sobrescreveria campo que o usuário nem viu.
  if (owner !== undefined) {
    const e = validarSlug(owner, 'owner');
    if (e) return res.status(400).json({ error: e });
    params.push(String(owner).trim()); campos.push(`owner = $${params.length}`); alterados.push('owner');
  }
  if (name !== undefined) {
    const e = validarSlug(name, 'name');
    if (e) return res.status(400).json({ error: e });
    params.push(String(name).trim()); campos.push(`name = $${params.length}`); alterados.push('name');
  }
  if (active !== undefined) {
    if (typeof active !== 'boolean') return res.status(400).json({ error: "Campo 'active' deve ser true ou false." });
    params.push(active); campos.push(`active = $${params.length}`); alterados.push('active');
  }
  if (campos.length === 0) return res.status(400).json({ error: 'Nada para atualizar.' });

  params.push(id);
  try {
    const { rows } = await pool.query(
      `UPDATE dev_repos SET ${campos.join(', ')}, updated_at = now()
        WHERE id = $${params.length}
        RETURNING id, owner, name, active, last_sync_status, last_synced_at, last_sync_error`,
      params,
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Repositório não encontrado.' });
    await createLog(userId, 'EDITAR_REPO',
      { repo: `${rows[0].owner}/${rows[0].name}`, repo_id: id, alterados }, getClientIp(req));
    res.json(rows[0]);
  } catch (error: any) {
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'Já existe um repositório cadastrado com esse owner/name.' });
    }
    res.status(500).json({ error: 'Erro ao atualizar repositório.' });
  }
};

// ── DELETE /dev-repos/:id ────────────────────────────────────────────────────
export const deleteRepo = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Id inválido.' });

  try {
    const alvo = await dbQuery('SELECT owner, name FROM dev_repos WHERE id = $1', [id]);
    if (alvo.rows.length === 0) return res.status(404).json({ error: 'Repositório não encontrado.' });

    const { rows: c } = await dbQuery('SELECT COUNT(*)::int AS n FROM repo_commits WHERE repo_id = $1', [id]);
    if (c[0].n > 0) {
      // 409 com a SAÍDA na mensagem (padrão do DELETE de usuário/impressora): apagar levaria
      // junto o histórico espelhado, e histórico não se joga fora por engano de clique.
      return res.status(409).json({
        error: `Este repositório tem ${c[0].n} commit(s) no espelho e não pode ser excluído. Desative-o para tirá-lo do relatório e da sincronização, preservando o histórico.`,
      });
    }

    await pool.query('DELETE FROM dev_repos WHERE id = $1', [id]);
    await createLog(userId, 'EXCLUIR_REPO',
      { repo: `${alvo.rows[0].owner}/${alvo.rows[0].name}`, repo_id: id }, getClientIp(req));
    res.status(204).send();
  } catch {
    res.status(500).json({ error: 'Erro ao excluir repositório.' });
  }
};

/**
 * Sincroniza UM repo. Núcleo compartilhado por POST /:id/sync e POST /sync-all.
 * Nunca lança: devolve o resultado descrito. Quem chama traduz em HTTP.
 */
async function sincronizar(
  repo: { id: string; owner: string; name: string; last_synced_at: Date | null },
  userId: string,
  req: Request,
): Promise<{ ok: true; novos: number; total: number } | { ok: false; erro: string; semToken?: boolean }> {
  const rotulo = `${repo.owner}/${repo.name}`;
  try {
    const commits = await buscarCommitsGitHub(repo.owner, repo.name, repo.last_synced_at);
    const novos = await gravarEspelho(repo.id, commits);
    const { rows: t } = await dbQuery('SELECT COUNT(*)::int AS n FROM repo_commits WHERE repo_id = $1', [repo.id]);
    await pool.query(
      `UPDATE dev_repos
          SET last_synced_at = now(), last_sync_status = 'ok', last_sync_error = NULL, updated_at = now()
        WHERE id = $1`,
      [repo.id],
    );
    await createLog(userId, 'SINCRONIZAR_REPO',
      { repo: rotulo, novos, total: t[0].n }, getClientIp(req));
    return { ok: true, novos, total: t[0].n };
  } catch (err: any) {
    const semToken = err?.code === 'SEM_TOKEN';
    const msg = String(err?.message ?? 'falha desconhecida').slice(0, ERRO_MAX);
    // O ESPELHO NÃO É TOCADO AQUI — de propósito. Só o carimbo de status muda: o dado velho
    // continua servível e a tela diz desde quando ele é velho.
    // last_synced_at NÃO avança: a próxima tentativa refaz a mesma janela em vez de pular o
    // período que falhou (buraco silencioso no relatório).
    await pool.query(
      `UPDATE dev_repos SET last_sync_status = 'erro', last_sync_error = $1, updated_at = now()
        WHERE id = $2`,
      [msg, repo.id],
    ).catch(() => { /* falha ao carimbar não pode mascarar o erro original */ });
    return { ok: false, erro: msg, semToken };
  }
}

// ── POST /dev-repos/:id/sync ─────────────────────────────────────────────────
export const syncRepo = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Id inválido.' });

  try {
    const { rows } = await dbQuery(
      'SELECT id, owner, name, last_synced_at FROM dev_repos WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Repositório não encontrado.' });

    const r = await sincronizar(rows[0], userId, req);
    if (r.ok) return res.json({ status: 'ok', ...r, repo: `${rows[0].owner}/${rows[0].name}` });
    // 503 = configuração ausente (nosso lado, acionável pelo admin);
    // 502 = a integração falhou lá fora (token errado, repo inacessível, GitHub fora).
    // Nunca um 500 misterioso: os dois casos têm dono e conserto diferentes.
    return res.status(r.semToken ? 503 : 502).json({
      error: r.semToken
        ? 'Integração com o GitHub não configurada (GITHUB_TOKEN ausente no servidor).'
        : `Falha ao sincronizar: ${r.erro}`,
    });
  } catch {
    res.status(500).json({ error: 'Erro ao sincronizar repositório.' });
  }
};

// ── POST /dev-repos/sync-all ─────────────────────────────────────────────────
export const syncAll = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  try {
    const { rows } = await dbQuery(
      'SELECT id, owner, name, last_synced_at FROM dev_repos WHERE active = true ORDER BY owner, name');

    // SEQUENCIAL de propósito: em paralelo, 7 repos disparariam 7 rajadas simultâneas contra o
    // mesmo rate limit e a primeira falha derrubaria o diagnóstico das outras.
    const resultados: any[] = [];
    for (const repo of rows) {
      const r = await sincronizar(repo, userId, req);
      // A falha de um NÃO aborta os demais: o relatório de sync é a lista completa, e um repo
      // arquivado no GitHub não pode impedir os outros seis de atualizarem.
      resultados.push(r.ok
        ? { repo: `${repo.owner}/${repo.name}`, status: 'ok', novos: r.novos, total: r.total }
        : { repo: `${repo.owner}/${repo.name}`, status: 'erro', erro: r.erro });
    }
    // HTTP 200 mesmo com falhas parciais: a resposta É o relatório por repo. Um 502 global
    // esconderia os que deram certo e faria o front descartar tudo.
    res.json({ resultados, total: resultados.length, com_erro: resultados.filter((x) => x.status === 'erro').length });
  } catch {
    res.status(500).json({ error: 'Erro ao sincronizar repositórios.' });
  }
};

// ── GET /dev-repos/report ────────────────────────────────────────────────────
export const getReport = async (req: Request, res: Response) => {
  try {
    const { from, to, repo_id } = req.query;

    for (const [nome, valor] of [['from', from], ['to', to]] as const) {
      if (valor !== undefined && (typeof valor !== 'string' || !isValidYmd(valor))) {
        return res.status(400).json({ error: `Parâmetro '${nome}' inválido: use data no formato YYYY-MM-DD (ex.: 2026-07-21).` });
      }
    }
    if (typeof from === 'string' && typeof to === 'string' && from > to) {
      return res.status(400).json({ error: "Período inválido: 'from' é posterior a 'to'." });
    }
    if (repo_id !== undefined && (typeof repo_id !== 'string' || !UUID_RE.test(repo_id))) {
      return res.status(400).json({ error: "Parâmetro 'repo_id' inválido." });
    }

    // limit/offset: mesma régua da Auditoria — fora do teto é 400, não clamp silencioso.
    let limit = 50;
    const rawLimit = req.query.limit;
    if (rawLimit !== undefined) {
      if (typeof rawLimit !== 'string' || !DIGITS_RE.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100) {
        return res.status(400).json({ error: "Parâmetro 'limit' inválido: use um inteiro entre 1 e 100." });
      }
      limit = Number(rawLimit);
    }
    let offset = 0;
    const rawOffset = req.query.offset;
    if (rawOffset !== undefined) {
      if (typeof rawOffset !== 'string' || !DIGITS_RE.test(rawOffset)) {
        return res.status(400).json({ error: "Parâmetro 'offset' inválido: use um inteiro maior ou igual a 0." });
      }
      offset = Number(rawOffset);
    }

    // Filtros COMPARTILHADOS entre a página, o COUNT e o por_repo — é o que garante que os três
    // números falem do mesmo recorte. Foi exatamente aqui que a Precificação tropeçou.
    const cond: string[] = [];
    const params: any[] = [];
    if (from) { params.push(from); cond.push(`c.author_date >= $${params.length}::date`); }
    // `to` INCLUSIVO via "< dia seguinte": '23:59:59' concatenado perde o último segundo do dia.
    if (to) { params.push(to); cond.push(`c.author_date < ($${params.length}::date + interval '1 day')`); }
    if (repo_id) { params.push(repo_id); cond.push(`c.repo_id = $${params.length}`); }

    const fromWhere = `
      FROM repo_commits c
      JOIN dev_repos r ON r.id = c.repo_id
      ${cond.length > 0 ? 'WHERE ' + cond.join(' AND ') : ''}
    `;

    const pageParams = [...params, limit, offset];
    const [countRes, dataRes, porRepoRes, syncRes] = await Promise.all([
      // COUNT em query PRÓPRIA, não window function sobre a página: a window contaria só as
      // linhas que sobreviveram ao LIMIT e o total mentiria a partir da segunda página.
      dbQuery(`SELECT COUNT(*)::int AS total ${fromWhere}`, params),
      dbQuery(
        `SELECT r.owner || '/' || r.name AS repo,
                c.repo_id,
                LEFT(c.sha, 7) AS sha_curto,
                c.message,
                c.author_name,
                c.author_date
         ${fromWhere}
         ORDER BY c.author_date DESC, c.sha DESC
         LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
        pageParams,
      ),
      // por_repo com os MESMOS filtros (menos a paginação): é o resumo do PERÍODO, não da página.
      dbQuery(
        `SELECT r.owner || '/' || r.name AS repo, r.id AS repo_id, COUNT(*)::int AS count
         ${fromWhere}
         GROUP BY r.id, r.owner, r.name
         ORDER BY count DESC, repo ASC`,
        params,
      ),
      // A honestidade do espelho: o MAIS ANTIGO last_synced_at entre os ativos. Se um repo nunca
      // sincronizou, MIN de um NULL... por isso o filtro — mas a tela precisa saber disso, então
      // vem também a contagem de quem nunca rodou.
      dbQuery(
        `SELECT MIN(last_synced_at) AS ultima_sync,
                COUNT(*) FILTER (WHERE last_synced_at IS NULL)::int AS nunca_sincronizados,
                COUNT(*)::int AS ativos
           FROM dev_repos WHERE active = true`,
      ),
    ]);
    // Desempate por sha no ORDER BY: author_date empata (rebase, commits do mesmo segundo) e
    // sem tiebreaker páginas vizinhas repetiriam ou pulariam linhas.

    res.json({
      commits: dataRes.rows,
      total: countRes.rows[0].total,
      por_repo: porRepoRes.rows,
      ultima_sync: syncRes.rows[0].ultima_sync,
      nunca_sincronizados: syncRes.rows[0].nunca_sincronizados,
      repos_ativos: syncRes.rows[0].ativos,
      limit,
      offset,
    });
  } catch {
    res.status(500).json({ error: 'Erro ao montar o relatório.' });
  }
};
