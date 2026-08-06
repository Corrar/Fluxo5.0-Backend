// config/cors.ts — allowlist de CORS configurável por ambiente.
//
// Fonte das origens:
//   • CORS_ORIGINS setada  -> usa ELA (lista separada por vírgula, com trim e filtro de vazios).
//       ex.: CORS_ORIGINS="https://meufront.vercel.app,https://fluxo-royale.com.br"
//   • CORS_ORIGINS ausente/vazia -> FALLBACK hard-coded abaixo (dev local não quebra).
//
// localhost:5173 (Vite dev) é SEMPRE incluído na allowlist, independente da env, para
// não travar o desenvolvimento mesmo quando CORS_ORIGINS lista só as origens de produção.

// O FALLBACK É A REDE DE SEGURANÇA, e ela precisa listar o front REAL deste backend.
//
// Até 06/08/2026 esta lista tinha um defeito silencioso: autorizava dois domínios que NÃO são
// deste sistema e NÃO listava `fluxo-royale50.vercel.app`, que é o front que fala com este
// backend. O front só funcionava porque a env CORS_ORIGINS do Render supria a ausência — uma
// variável de ambiente de distância da indisponibilidade TOTAL: se ela sumisse, fosse esvaziada
// ou reescrita num redeploy, o backend cairia para este fallback, o front real perderia todo
// acesso (cada request bloqueado pelo navegador) e os dois estranhos continuariam autorizados.
//
// OS DOIS DOMÍNIOS DO 2.0 SAÍRAM, e a remoção foi verificada antes — não presumida. Medido em
// 06/08/2026 baixando o bundle publicado de cada um:
//   fluxo-royale.vercel.app   -> https://fluxo-royale-backend.onrender.com
//   fluxoroyale21.vercel.app  -> https://fluxo-royale-backend2-1.onrender.com
// Nenhum dos dois contém a string `fluxo5-0-backend`: são aplicações vivas, com backend PRÓPRIO,
// que nunca dependeram desta allowlist. Removê-los não quebra app vizinho — só para de autorizar
// origem que não tem por que estar aqui.
export const CORS_FALLBACK_ORIGINS: string[] = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:8080',             // Front dev (Vite) local
  'http://127.0.0.1:8080',             // Front dev local (loopback IPv4)
  'http://[::1]:8080',                 // Front dev local (loopback IPv6)
  'https://fluxo-royale50.vercel.app', // O FRONT DESTE BACKEND (projeto fluxo-royale5.0)
  'https://fluxo-royale.com.br',       // Domínio oficial
  'https://www.fluxo-royale.com.br',   // Subdomínio oficial
];

// localhost:5173 sempre permitido para desenvolvimento (Vite default).
const DEV_ALWAYS = 'http://localhost:5173';

/** Parse de CORS_ORIGINS: split por vírgula, trim, remove vazios. */
function parseEnvOrigins(raw?: string): string[] {
  return (raw || '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

/** 'env' se CORS_ORIGINS tiver ao menos uma origem válida; senão 'fallback'. */
export function corsSourceLabel(raw: string | undefined = process.env.CORS_ORIGINS): 'env' | 'fallback' {
  return parseEnvOrigins(raw).length > 0 ? 'env' : 'fallback';
}

/**
 * Monta a allowlist final. CORS_ORIGINS (se setada) tem prioridade sobre o fallback;
 * DEV_ALWAYS (localhost:5173) é sempre adicionado; o resultado é deduplicado.
 */
export function buildAllowedOrigins(raw: string | undefined = process.env.CORS_ORIGINS): string[] {
  const env = parseEnvOrigins(raw);
  const base = env.length > 0 ? env : CORS_FALLBACK_ORIGINS;
  return Array.from(new Set(base.concat(DEV_ALWAYS)));
}
