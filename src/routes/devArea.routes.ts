// src/routes/devArea.routes.ts — Área Dev v1 (agenda, notas, snippets).

import { Router } from 'express';
import { authenticate, requirePermission } from '../middlewares/auth';
import {
  listBlocks, createBlock, updateBlock, deleteBlock,
  listNotes, createNote, updateNote, deleteNote,
  listSnippets, createSnippet, deleteSnippet,
} from '../controllers/devArea.controller';

const router = Router();

// Sessão válida + a page_key 'dev_area' em TODA rota, inclusive as leituras: agenda, notas e
// snippets são material de trabalho pessoal, não informação de qualquer logado. DB-driven — a
// tela de Permissões concede a outro papel sem tocar em código.
// Chave-FOLHA: o requirePermission casa por igualdade, então 'dev_area' não abre nem é aberta
// por nenhuma outra chave.
router.use(authenticate, requirePermission('dev_area'));

// 📅 Agenda — evento e tarefa na mesma coleção (`kind` separa).
router.get('/blocks', listBlocks);          // ?from=&to= — a visão mês pede o range real
router.post('/blocks', createBlock);
router.put('/blocks/:id', updateBlock);     // parcial: cobre o `done` da tarefa
router.delete('/blocks/:id', deleteBlock);

// 📝 Notas — fixar, marcar e colorir são atributos, não workflow.
router.get('/notes', listNotes);
router.post('/notes', createNote);
router.put('/notes/:id', updateNote);       // parcial: pin/tags/cor/body
router.delete('/notes/:id', deleteNote);

// 💻 Snippets — busca por rótulo E por conteúdo, com paginação.
router.get('/snippets', listSnippets);      // ?q=&limit=&offset=
router.post('/snippets', createSnippet);
// SEM PUT: na v1 o snippet se cria e se apaga. Oferecer edição exigiria updated_at, e a
// coluna não existe de propósito (ver a migration 019).
router.delete('/snippets/:id', deleteSnippet);

export default router;
