# Dívidas técnicas — Fluxo Royale 5.0 (Backend)

Registro nomeado das dívidas aceitas conscientemente, com o porquê e o caminho de saída.
(Dívidas menores vivem como comentários no ponto exato do código; aqui ficam as que precisam
de decisão ou de trabalho estrutural futuro. Padrão espelhado do DIVIDAS.md do front.)

## users.role — coluna ENUM vestigial (fonte dupla latente)

`users.role` (ENUM `user_role`, default 'setor') é vestígio: TODOS os gates e o login usam
`profiles.role` (text), e o `updateRole` não toca `users.role` — as duas colunas divergem
silenciosamente a cada troca de cargo. Nada lê a coluna hoje, mas ela é uma armadilha pra
quem for consultar "o papel" direto de `users`. Saída: migração futura derruba a coluna
(ou a sincroniza e documenta qual é a fonte).

## profiles.total_minutes / profiles.last_active — duplicados vestigiais

O heartbeat escreve métricas em `users.total_minutes`/`users.last_active`; as colunas
homônimas de `profiles` não são escritas por ninguém e ficam congeladas. Mesma classe da
dívida acima: fonte dupla latente, migração futura remove.

## Troca obrigatória de senha no 1º login — não existe

A criação de usuário (POST /auth/register) entrega uma senha DEFINIDA PELO ADMIN e nada
força o usuário a trocá-la no primeiro acesso (não há campo `must_change_password` nem
fluxo de troca). Decisão consciente da v1 da tela de Usuários (28/07/2026). Saída futura:
coluna + check no login + tela de troca.

## updateStatus / resetPassword — gate inline em vez de canManageUsers

Os dois handlers checam admin em tempo real INLINE (mesmo efeito do middleware
`canManageUsers` usado nas rotas vizinhas, mensagens levemente diferentes). Cosmético;
unificar no middleware quando estes handlers forem tocados de novo.

## authenticate consulta is_active por request — custo aceito (furo 12)

authenticate agora consulta is_active por request (fail-closed). Custo: 1 query/request —
irrelevante em 15 usuários; se doer em escala, cache curto (30-60s) invalidado pelo
updateStatus.

## Hard-delete de usuário só pra conta que nunca logou

Hard-delete de usuário só é possível pra conta que nunca logou (LOGIN audita com o id do
próprio). Sugestão v2 avaliada e NÃO adotada por ora: DELETE ignorar histórico só-LOGIN
removeria do livro o registro de que a conta existiu — contra o princípio do livro
append-only. Revisitar apenas se o 409 virar atrito operacional real.

## Helpdesk: anexos de chamado fora da v1 — amarrado ao storage de arquivos

Anexos de chamado (o print de erro do painelti prometia até 4 imagens) ficaram FORA da v1
por decisão: o sistema não tem storage de arquivos — a decisão é a mesma do upload de
imagens de produto (URL via VPS+Caddy ou R2/S3, nunca base64 no banco). É a ausência que o
usuário final mais vai sentir; entra na carona quando o storage nascer, nos dois lugares.

## Helpdesk: GET /tickets e /tickets/my sem paginação

Volume esperado baixo (chamados de TI de ~15 contas). O envelope {tickets, total} já nasce
pronto pra ganhar limit/offset depois sem quebrar consumidor (mesmo caminho do
GET /admin/logs, que nasceu paginado por ser livro que só cresce — chamado encerra).

## tasks: guard de OP encerrada compara valores fantasmas

O create/update de tasks (e eletrica_tasks) rejeita OP com status 'finalizada'/'encerrada',
mas os status REAIS em uso em client_services são 'em_andamento'/'concluido' — o guard
nunca dispara ('concluido' passa). Mesma família dos guards de OP fechada já registrados.
Corrigir quando o Quadro de Tarefas for atacado.

## tasks: completed/completed_at inexistentes na tabela

O updateTask escreve completed/completed_at, colunas que NÃO existem em tasks (eletrica_tasks
tem) — PUT com completed → erro SQL 500. O CRUD nunca rodou de verdade (0 linhas). Decidir o
destino da tabela (migration corretiva vs status com CHECK) junto com o Quadro de Tarefas.

## dev_projects: capa/anexos fora da v1 — mesma dívida de storage

O mock de projetos prometia capa e anexos (DataURL local). Ficaram fora — mesma dívida de
storage do helpdesk e das imagens de produto (URL via VPS+Caddy ou R2/S3, nunca base64).
Entram na carona quando o storage nascer.

## notifications (tabela órfã) segue órfã — por decisão

A notificação do helpdesk v1 é SÓ o socket ticket_updated pra user:${requester} (cortesia,
não garantia — offline refaz o GET ao abrir a tela). Sino in-app persistente lendo/escrevendo
a tabela notifications é feature própria futura, não carona do helpdesk.

## ordens_producao — tabela rival órfã (candidata ao destino do dev_tasks)

`ordens_producao` (numero_op, cliente_nome, status, closed_at) tem **0 linhas**, nenhuma FK
apontando pra ela e nenhuma rota: é uma "OP" concorrente da `client_services`, que é a OP viva
de todo o sistema (razão de material, separações, retornos, projetos, máquinas). Manter duas
noções de OP é o tipo de ambiguidade que um dia vira bug de relatório. Destino provável: DROP
com **guarda de premissa** (padrão da 014) quando o Bruno decidir — não antes, porque tabela
vazia não incomoda ninguém e a decisão é dele.

## Montagem v1: parada NÃO trava consumo e NÃO notifica

Duas decisões conscientes da v1 (migration 016):
- **Parada é sinalização de gestão, não bloqueio de material.** Uma máquina `parada` continua
  aceitando consumo etiquetado — o razão responde por saldo, a máquina por andamento, e misturar
  os dois faria o status de uma tela travar a contabilidade de outra. Se a trava for desejada,
  ela nasce no consume com mensagem própria, e é decisão de v2.
- **Sem notificação persistente.** O mock prometia avisar Compras/Financeiro/Comercial/PCP; a
  v1 grava `stopped_sector` e para por aí, porque `notifications` segue órfã por decisão (ver
  acima). Quando o sino in-app nascer, a parada é o primeiro assinante natural.

## Montagem v1: a árvore soma só 'consumido'

A árvore do produto (GET /assembly-machines/:id) é `SUM(qty)` dos eventos `consumido` com
`machine_id = X`. `devolvido` e `transferido_out/in` **ainda não carregam machine_id** — a
etiqueta nasceu no consume. Subtrair devolução da árvore hoje daria um número que o razão não
sustenta. Quando o evento de devolução for etiquetado, a fórmula ganha o sinal — e o comentário
do `getMachine` precisa mudar junto (está escrito lá).

## `date` de productions_3d vem do relógio do CLIENTE

O POST `/producao-3d/productions` grava o `date` que vem no corpo, e quem preenche é o navegador
(`producao3d.jsx:263` manda `new Date().toISOString()`; não existe campo de data no formulário).
O servidor deveria carimbar `now()` — precedente na casa: o "hoje do Postgres" do dev-painel, que
existe justamente para nenhum número depender do relógio da máquina de quem olha.

O sintoma medido (30/07): produção registrada num PC adiantado nasce "no futuro" para quem lê
noutra máquina. O Dashboard 3D descartava essas linhas em silêncio — o card mostrava menos peças
do que o estoque e do que a Precificação. **O clamp no front (fix do Dashboard) mitiga a leitura;
a raiz continua aqui.**

Não é fix de uma linha: mudar quem carimba a data altera o contrato de um POST **com consumidor
no ar** e muda o significado do histórico (passa a ser a hora do servidor, não a da máquina que
produziu). Missão própria, com recon dos consumidores do campo `date` antes de qualquer troca.

## Área Dev e Custos (019): três coisas que o design prometia e NÃO nasceram

Registradas na clarificação do Bruno de 03/08/2026, na abertura da Fase 4. Nenhuma é
esquecimento: as três nascem **quando houver fonte**, e nunca como número inventado.

### Sync com Google Agenda — FORA
No design a Área Dev tinha um botão de sincronizar com o Google Agenda, e ele era **simulado**:
mexia só no estado da tela. Integração externa de verdade tem OAuth, refresh de token, conflito
de edição dos dois lados e um modelo de "quem ganha" que ninguém decidiu. É **missão própria** —
e, quando vier, segue o padrão do dev-repos: o Google é a FONTE, o nosso banco é o ESPELHO, e
falha lá fora vira carimbo na tela, não tela quebrada.

### Monitoramento vivo de uso (CPU/RAM/tokens) — FORA
A tela de Custos do design mostrava consumo por serviço. **Não temos coletor**: nem agente nas
máquinas, nem integração com o billing dos provedores. O que sobrou é `dev_costs.usage_note`,
texto livre escrito por gente — honesto sobre ser uma ANOTAÇÃO e não uma medição. Uma barra de
"72% de uso" sem coletor seria exatamente o tipo de número sem query atrás que a régua proíbe.

### Histórico mensal / delta do Custos — FORA até existirem meses de dado
`dev_costs` é a FOTO do que se paga hoje: uma linha por serviço, sem competência. "Subiu 32% no
mês" exige pelo menos dois meses fechados, e a tabela nasceu agora — o primeiro gráfico seria
ficção com aparência de dado. Quando houver meses, nasce a tabela de competência
(`dev_cost_entries` ou equivalente) e o delta passa a ser derivado dela, não estimado.

## `DELETE /requests/:id` devolve 500 em estado bloqueado, não 400

Medido no smoke de 06/08/2026, contra o Render: `DELETE` sobre uma solicitação já `rejeitado`
responde **HTTP 500** com o corpo `{"error":"Não é possível cancelar no estado atual."}` — a
mensagem certa com o status errado.

**Causa**: o guard de estado em `deleteRequest` lança `new Error('Não é possível cancelar no
estado atual.')`, um `Error` comum. O `catch` só trata `StockError` e a sentinela `__NOT_FOUND__`;
tudo o mais cai no `res.status(500)`. O `PUT /:id/status` faz certo no mesmo caso — lança a
sentinela `TRANSICAO_INVALIDA:` e o catch converte em 400 (medido no mesmo smoke).

**Impacto**: baixo hoje. A UI de cancelamento usa o `PUT` (que responde 400 corretamente), e a
rota `DELETE` exige `minhas_solicitacoes:delete`, chave que nenhum papel tem — na prática só o
admin passa, pelo bypass. O dano é de diagnóstico: 500 diz "o servidor quebrou" para uma recusa
de regra de negócio, e polui qualquer alerta que conte 5xx.

**Escopo**: uma linha — trocar por uma sentinela e converter no catch, exatamente como o `PUT`
já faz. **Prioridade**: BAIXA.

## Cancelamento de solicitação não tem ownership — DECISÃO DE PRODUTO PENDENTE

Registrada em 06/08/2026, ao ligar a exclusão real de solicitação nas duas telas do front.

**O fato**: nem `deleteRequest` nem `updateRequestStatus` olham quem é o dono da solicitação.
Os dois exigem cargo `admin` **ou** `almoxarife` (`SELECT role FROM profiles` no topo de cada
um) e nada além disso. Consequências, as duas reais e nenhuma óbvia pela tela:

1. Qualquer admin/almoxarife cancela a solicitação de **qualquer pessoa**. Não há "só o meu".
2. O solicitante comum **não cancela nem o próprio pedido** — toma 403 no gate de cargo, pelas
   duas rotas. O botão "Cancelar pedido" de Meus Pedidos era falso desde que nasceu (mexia só
   no estado da tela); ao ligá-lo de verdade ele passou a aparecer **só** para admin/almoxarife,
   que é a única plateia que o backend atende hoje.

`audit_log` grava quem cancelou (`REJEITAR_SOLICITACAO` com `motivo`), então o rastro existe —
mas **nenhuma tela mostra esse rastro**, e o solicitante vê o pedido virar "Recusado" sem saber
que foi outra pessoa.

**Não é bug até o Bruno decidir**: pode ser intencional (o almoxarifado gerencia a fila e cancela
o que for preciso) ou pode ser furo (cada um cancela o seu, o almoxarifado recusa com motivo).
São desenhos diferentes, não graus do mesmo. Saída, se virar furo: `requester_id = userId` como
alternativa ao gate de cargo em `deleteRequest`, e exibir o autor do cancelamento no drawer.
