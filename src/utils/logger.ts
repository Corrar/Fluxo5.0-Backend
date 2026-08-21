import { pool } from '../db';

let ioInstance: any = null;

export const setLoggerIo = (io: any) => {
    ioInstance = io;
};

// ═══════════════════════════════════════════════════════════════════════════════════════════
// O SAVEPOINT — lote LG1 (21/08/2026)
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// ─── O QUE ESTAVA ERRADO ──────────────────────────────────────────────────────────────────
// Este `catch` engolia o erro e devolvia o controle ao chamador como se nada tivesse
// acontecido. FORA de transação isso é o comportamento certo: log é best-effort, e uma falha
// de auditoria não pode derrubar uma operação que deu certo.
//
// DENTRO de uma transação era ARMADILHA, e o `catch` em JS não tinha como consertá-la: quando
// um statement falha, o POSTGRES aborta a transação inteira (25P02) e recusa tudo que vier
// depois. O catch daqui não desaborta nada. O chamador seguia, fazia o `COMMIT`, e —
// medido, não deduzido — **o COMMIT numa transação abortada NÃO ESTOURA: devolve o command tag
// `ROLLBACK`**. O driver trata como sucesso, o handler responde 200, e a operação inteira foi
// revertida. Sucesso falso sobre operação que não aconteceu.
//
// Censo do lote: 86 chamadas, 45 passam client de transação, 41 usam o pool. Sonda: 1 de 45.
//
// ─── POR QUE SAVEPOINT, E NÃO try/catch ───────────────────────────────────────────────────
// É a régua que a casa já tem escrita ("best-effort em transação pede SAVEPOINT") e que o
// `rs1_carimbo` de requests.controller.ts:670 já aplica. O SAVEPOINT delimita o estrago: o
// `ROLLBACK TO` devolve a transação ao estado válido de antes do INSERT, e o trabalho do
// chamador — que é o que importa — sobrevive.
//
// ─── COMO SE SABE QUE É TRANSAÇÃO ─────────────────────────────────────────────────────────
// O default do 5º parâmetro É o `pool` importado deste mesmo módulo. Então `dbClient !== pool`
// distingue os dois casos com informação que a função JÁ TEM, sem tocar em NENHUM dos 86
// chamadores. (Confirmado por leitura no `1c858c9` antes de usar: se o default deixar de ser
// o pool, este critério cai junto — e o smoke PL2 quebra, que é o ponto dele.)
//
// ⚠ O COMPORTAMENTO FORA DE TRANSAÇÃO NÃO MUDA. As 41 seguem engolindo em silêncio, como
//   hoje. Fazer o logger parar de engolir seria a opção (a) do laudo, e ela transformaria
//   falha de auditoria em **500 numa operação que deu certo** — as 41 estão TODAS dentro de
//   try/catch que converteria a exceção em erro de resposta. Ver DIVIDAS.
//
// ─── O NOME DO SAVEPOINT ──────────────────────────────────────────────────────────────────
// Contador monotônico, nunca literal fixo. Medido: `travels.controller` chama `createLog`
// DENTRO DE LOOPS (5 chamadas, algumas por item), então a mesma transação produz N savepoints.
// O uso aqui é estritamente balanceado (todo SAVEPOINT termina em RELEASE), então um nome fixo
// também funcionaria — o contador existe para não ser preciso RACIOCINAR sobre aninhamento, e
// para nunca colidir com savepoint de chamador (hoje só `rs1_carimbo`).
// ⚠ O nome é INTERPOLADO no SQL, e por isso é gerado por CÓDIGO: prefixo fixo + inteiro. Nada
//   de entrada de requisição chega aqui.
let savepointSeq = 0;

export const createLog = async (userId: string | null, action: string, details: object, ip: string, dbClient: any = pool) => {
  // `dbClient !== pool` ⇒ é client de transação do chamador (ver a nota acima).
  const emTransacao = dbClient !== pool;
  const savepoint = emTransacao ? `fr_log_${++savepointSeq}` : null;

  try {
    if (savepoint) await dbClient.query(`SAVEPOINT ${savepoint}`);

    try {
      const insertResult = await dbClient.query(
        `INSERT INTO audit_logs (user_id, action, details, ip_address) VALUES ($1, $2, $3, $4) RETURNING id`,
        [userId, action, JSON.stringify(details), ip]
      );

      const fullLogQuery = `
        SELECT a.id, a.action, a.details, a.created_at, a.ip_address,
          COALESCE(p.name, u.email, 'Usuário Removido') as user_name,
          COALESCE(p.role::text, 'removido') as user_role
        FROM audit_logs a
        LEFT JOIN users u ON a.user_id = u.id LEFT JOIN profiles p ON u.id = p.id
        WHERE a.id = $1
      `;
      const fullLogResult = await dbClient.query(fullLogQuery, [insertResult.rows[0].id]);

      // O RELEASE vem ANTES do emit de propósito: o emit é socket, não banco. Se ele falhar,
      // o log JÁ está confirmado dentro da transação do chamador e não deve ser desfeito.
      if (savepoint) await dbClient.query(`RELEASE SAVEPOINT ${savepoint}`);

      if (ioInstance) {
          ioInstance.to('admin').emit('new_audit_log', fullLogResult.rows[0]);
      }
    } catch (err) {
      // ⚠ A RECUPERAÇÃO É O PONTO DO LOTE. Sem ela, a transação do chamador fica abortada e o
      // COMMIT dele vira ROLLBACK silencioso.
      if (savepoint) {
        // Tolera falha aqui: se o próprio ROLLBACK TO falhar, a conexão está perdida e não há
        // o que salvar — mas não se pode lançar de dentro do caminho de recuperação, senão o
        // erro de recuperação mascara o erro original.
        try { await dbClient.query(`ROLLBACK TO SAVEPOINT ${savepoint}`); } catch { /* conexão perdida */ }
        try { await dbClient.query(`RELEASE SAVEPOINT ${savepoint}`); } catch { /* idem */ }
      }
      throw err;   // sobe para o catch de fora, que loga e engole — o contrato de sempre
    }
  } catch (err) {
    console.error("Falha ao criar log de auditoria:", err);
  }
};
