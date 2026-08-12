# Dívidas técnicas — Fluxo Royale 5.0 (Backend)

Registro nomeado das dívidas aceitas conscientemente, com o porquê e o caminho de saída.
(Dívidas menores vivem como comentários no ponto exato do código; aqui ficam as que precisam
de decisão ou de trabalho estrutural futuro. Padrão espelhado do DIVIDAS.md do front.)

---

# INCIDENTE — 07/08/2026: 6 linhas de `stock_ledger` apagadas por cleanup de smoke

**Registrado por decisão do Bruno na missão V.** Fica no topo do arquivo de propósito: é a única
entrada aqui que não é dívida de projeto, e sim erro cometido e assumido.

**O que aconteceu.** Durante a missão V (vocabulário de OP), o `smoke_op_status` movimentou estoque
de verdade pela via do usuário — a prova (iii) consumiu 3 unidades do físico, a prova (iv) reservou
2 — e o passo de limpeza **apagou as linhas de razão desses movimentos com `DELETE`**, em vez de
compensá-las. Duas ocorrências, **6 linhas no total**:

| origem | linhas | quais |
|---|---|---|
| script manual de limpeza de resíduo (a 1ª execução do smoke teve o cleanup abortado por erro de tipo e deixou resíduo; o script foi escrito para removê-lo) | **3** | `receive` +20, `consume` −3, `reserve` +2 — todas do produto `9.98.0001` criado pelo próprio smoke |
| cleanup do `smoke_op_status`, 2ª execução | **3** | mesmos três tipos de movimento, produto de teste recriado |

As três primeiras estão **reconstruídas acima a partir das ações que o smoke asseriu** (o `rowCount`
reportado foi exatamente 3), porque elas não podem mais ser lidas — e é esse o dano.

**As linhas NÃO foram recriadas, por doutrina.** `INSERT` reconstruindo movimento apagado é
fabricação de razão: produziria um livro que *parece* íntegro e cujo conteúdo foi digitado depois.
O buraco fica documentado aqui. Esta é a decisão do Bruno, não uma omissão.

**Consequência numérica medida: nenhuma.** O grafo saiu inteiro (razão + `stock` + `products`), então
não sobrou saldo mentindo. Medido em 07/08 na validação, depois da limpeza:

- `stock.quantity_on_hand` × Σ`delta_on_hand` no POOLED/ALMOX, todos os produtos vivos → **0 divergências**;
- linhas de razão apontando para produto inexistente → **0**;
- linhas de razão apontando para separation inexistente → **0**;
- linhas de razão apontando para request inexistente → **2**, e as duas são de **21/07**, pré-existentes
  e já descritas no cabeçalho da migration 020 (as "duas reservas de 21/07 cujas requests foram
  apagadas", 3+2 = as 5 unidades de divergência daquele diagnóstico). **Nada a ver com este incidente.**

**Consequência doutrinária: total.** Um livro que às vezes é editado deixa de ser prova de qualquer
coisa. É por isso que o incidente é registrado em vez de silenciosamente consertado.

**Causa raiz, e ela é mais velha que a missão V.** O `DELETE FROM stock_ledger` do cleanup **já
estava commitado** em `smoke_requests_3d.ts` desde o lote I-a, chamado de "cleanup cirúrgico" — nome
que descrevia o cuidado e escondia o ato. A missão V copiou a linha em vez de questioná-la.

**E o padrão antigo era muito maior que as 6 linhas acima.** Assim que o `smoke_requests_3d` passou
a logar contagem por tabela (exigência da disciplina C), o número apareceu: **38 linhas de razão por
execução**, dos 8 produtos que ele cria. Enquanto não logava, isso rodava invisível a cada
`npm run smoke:requests3d` — inclusive na execução de regressão desta missão. As 6 linhas foram o que
se enxergou; 38 por rodada era o que já acontecia. **O erro individual foi propagar o padrão; o
problema estrutural é que ele era silencioso.**

**O que mudou junto com este registro**: disciplina C nos dois smokes (entrada seguinte) e o
`smoke_requests_3d` passou a logar contagem por tabela.

---

# EXCEÇÃO NOMEADA — cleanup de smoke apaga razão da própria execução (disciplina C)

**Asterisco consciente sobre "`stock_ledger` é append-only".** A regra continua valendo para todo
código de produção, sem exceção. O que ganha exceção é o **instrumento de teste**, e só nas condições
abaixo.

**Por que a exceção é necessária, e não é preguiça.** `stock_ledger.product_id` tem FK para
`products`. Um smoke que cria produto e movimenta estoque tem duas saídas, e só duas:

- apagar o razão dele junto — e editar o livro; ou
- deixar produto de teste acumulando **para sempre** no banco de validação, aparecendo em toda tela
  de produto do sistema (o `smoke_requests_3d` já convive com isso: tem lógica de "próximo SKU livre
  na faixa 9.99" porque a faixa acumula).

Não existe terceira opção **enquanto smoke e validação dividirem o mesmo banco** — e é exatamente
essa premissa que a missão B remove.

**A disciplina, implementada em `src/smokes/_cleanup.ts`
(`destruicaoEscopadaDeDadosDeTeste`)**. O nome diz o ato, não o cuidado. Antes de **qualquer**
`DELETE`:

1. **posse conferida no banco** — todo produto do escopo tem que carregar a marca única da execução
   (o `stamp`) no `name`. Pega o caso em que a lista de ids foi poluída por um id alheio, que é
   exatamente como um smoke destrói dado real;
2. **razão levantado e conferido linha a linha** — os ids das linhas a apagar são coletados, todo
   `product_id` tem que pertencer ao conjunto em memória, e o `DELETE` roda **por esses ids
   explícitos**. Nunca por `product_id`, e **jamais por faixa de SKU** (a faixa serve para *medir*
   resíduo, nunca para apagar);
3. **`rowCount` conferido contra o levantado** — apagou mais que o conferido é erro, não sucesso;
4. **qualquer violação aborta sem apagar nada** e devolve o motivo, que o smoke transforma em check
   vermelho. Recusar-se a limpar e deixar resíduo visível é melhor que apagar uma linha que não é nossa;
5. **contagem por tabela logada E assertada**, incluindo a linha explícita "razão apagado nesta
   execução: N linha(s)".

**Onde vale**: `smoke_op_status.ts` e `smoke_requests_3d.ts`. **Onde NÃO se aplica**: `audit_logs`
nunca é tocado por smoke nenhum, e os smokes de devolução (`_smoke.ts`) rodam em transação com
`ROLLBACK` — não escrevem nada e não precisam de exceção.

**Saída**: morre com a missão B, abaixo.

---

# MISSÃO B (futura, nomeada) — smokes em branch Neon efêmero por execução

**Decidida como caminho de saída em 07/08/2026; não implementada.**

Cada execução de smoke cria seu próprio branch Neon, roda contra ele e o **destrói** no fim.
Destruir o banco substitui editar o livro — e aí:

- a **exceção nomeada acima morre** e `src/smokes/_cleanup.ts` sai inteiro do repo;
- desaparece a acumulação de produto de teste na validação (as faixas `9.98.%`/`9.99.%` e a lógica
  de "próximo SKU livre" saem junto);
- volta a ser possível provar **migration em banco virgem a toda execução**. Hoje não é: a `(vii.a)`
  do `smoke_op_status` (pré-guarda da 021 abortando com linha fora do vocabulário) e o backfill só
  são reproduzíveis num banco pré-021, e desmontar o CHECK de um banco compartilhado para reprovar
  seria cirurgia destrutiva. O smoke detecta isso e diz em voz alta que a prova depende da missão B;
- os smokes deixam de depender do estado de contas do seed (hoje as 7 contas não-admin da validação
  estão suspensas desde 05–06/08, o que derruba todo smoke que precisa de ator não-admin).

**Escopo**: criação/destruição de branch pela API do Neon, credencial do harness, aplicação da
sequência de migrations no branch novo, e o gancho de CI. **Não** é conserto de smoke: é
infraestrutura de teste.

---

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

## ~~tasks: guard de OP encerrada compara valores fantasmas~~ — FECHADA (missão V, 07/08/2026)

Os quatro guards de `tasks.controller` (create/update de tarefa e de tarefa da elétrica), mais
os de `requests.controller` e `stock.controller`, comparavam `'finalizada'`/`'encerrada'` —
valores que nunca existiram em `client_services`. Os seis passaram a comparar `=== 'concluido'`
e as mensagens `OP_FINALIZADA`, escritas e nunca alcançadas, saíram do código morto.

**NÃO confundir com a família vizinha, que segue aberta**: os 8 hits de `'finalizada'` em
`system.controller` (linhas 69, 83, 120, 147, 194, 252, 265, 286) são de `separations.status`,
outra coluna. Medido em 07/08 na validação: `separations.status` só tem `'concluida'` (6 linhas)
— `'finalizada'` e `'entregue'` nunca aparecem nesses `IN`. São filtros de relatório, não guards
de escrita, então o efeito é diferente (nada passa indevidamente; o `IN` só carrega palavra
morta). Vocabulário próprio, recon próprio, missão própria.

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

## `requests.sector` carrega DOIS significados no mesmo campo

Registrada em 06/08/2026, no recon da fase 2 da dívida (f). **Prioridade MÉDIA.**

O campo é preenchido por dois emissores com semânticas **diferentes**:

| Tela | O que grava | Natureza |
|---|---|---|
| **Meus Pedidos** (`pedidos.jsx`) | o setor de **quem pediu** | ORIGEM — é identidade |
| **Encomendar 3D** (`pages_rest.jsx:331,378,543`) | um `<input>` que o usuário **digita**, default `"Produção 3D"` | DESTINO — dado de negócio |

A fase 2 fechou só a metade que é identidade: o backend passou a **derivar** `profiles.sector` do
token quando o corpo não manda, e Meus Pedidos parou de mandar. O 3D segue enviando o destino
digitado, e o servidor não o sobrescreve — retrocompatível de propósito.

**O que continua aberto**: enquanto `sector` for **texto livre aceito no corpo**, qualquer cliente
grava o que quiser. Não há whitelist, não há CHECK, e a coluna é nullable dos dois lados
(`requests.sector` e `profiles.sector`). Medido na validação em 06/08: das 16 solicitações, 10
tinham `sector` diferente do setor do perfil do requester — **7 eram resíduo dos meus próprios
smokes** (passei strings arbitrárias pela API), 1 de um smoke do 005 e **2 são do seed real**
(`Elétrica` e `Manutenção`, ambas com requester `001`/Diretoria). Nenhuma veio do mecanismo da
dívida (f) — todas vieram de um valor explícito no corpo, que é o comportamento projetado.

**A decisão que fecha, e é de produto/schema — não de código:**
- ou `sector` é **sempre origem** (deriva sempre, sai do contrato do POST) e o 3D ganha coluna
  própria `destination_sector`;
- ou é **sempre destino** (campo declarado) e a origem passa a vir só do `requester_id`, com as
  telas lendo o setor pelo join em vez da coluna.

Escolher é obrigatório antes de qualquer relatório que agrupe por setor: hoje um `GROUP BY sector`
mistura "de onde veio" com "para onde foi", e o número sai sem significado único.

Achado lateral do mesmo recon: `auth.controller.ts:44-52` cria perfil faltante **no login** com
`sector` chumbado em `'Geral'` — é a origem do `Geral` de perfis que nunca foram cadastrados pela
tela de Usuários.

## ~~Vocabulário de status de OP divergente entre 2.0 e 5.0~~ — DECIDIDA E FECHADA (missão V, 07/08/2026)

**Decisão do Bruno: opção 1 — `pendente` SAI do vocabulário.** A migration 021 fecha
`client_services.status` em `em_andamento | concluido` (DEFAULT `em_andamento`, NOT NULL, CHECK),
com guarda de premissa que aborta diante de qualquer palavra desconhecida e backfill
`pendente → em_andamento` / `NULL → em_andamento`. `createService` passa a gravar o status
EXPLÍCITO e `updateServiceStatus` ganhou whitelist na borda, 400 para corpo sem status e 404 para
`serviceId` inexistente.

**O que o recon de 07/08 acrescentou ao diagnóstico abaixo, e mudou o tamanho do problema**: a
coluna era NULLABLE sem CHECK (o vocabulário real tinha QUATRO estados, o quarto sendo NULL) e o
`createService` **omitia a coluna no INSERT** — ou seja, toda OP criada pela tela nascia
`'pendente'`. "pendente tem zero linhas" era foto de um banco semeado por SQL, não propriedade do
sistema. **A tradução da carga continua obrigatória** (`pendente → em_andamento` para as 18 OPs
ativas do 2.0); a diferença é que agora, se ela for esquecida, o CHECK barra alto no dia da carga
em vez de a OP entrar viva e sumir das telas.

O texto original fica abaixo como registro do diagnóstico.

---

Registrada em 06/08/2026, no recon do filtro de OPs. **Prioridade ALTA**: não é dívida de código
rodando errado hoje, é uma armadilha que só dispara no dia da migração — e nesse dia, em silêncio.

**Os dois vocabulários, medidos:**

| | ativo | encerrado | contagem |
|---|---|---|---|
| **2.0** (`ep-mute-feather`) | `pendente` | `concluido` | 18 + 24 |
| **5.0** (`ep-summer-wave`) | `em_andamento` | `concluido` | 5 + 2 |

No 2.0 **não existe OP planejada**: `pendente` É o estado de execução. No 5.0 `pendente` é o
**DEFAULT da coluna** (`client_services.status`) e hoje nenhuma linha o usa. A mesma palavra
significa "em execução" de um lado e "nunca começou" do outro.

**Tradução obrigatória na carga**: `pendente` → `em_andamento`.

**O que a cópia crua faria**: as 18 OPs ativas do 2.0 entrariam no 5.0 marcadas como `pendente`.
Qualquer fluxo que filtre por igualdade com `em_andamento` passa a tratá-las como inexistentes —
some OP viva de seletor, de relatório, de qualquer lista. Sem erro, sem log: a OP simplesmente
não aparece.

**A consequência inversa, igualmente séria**: se o 5.0 passar a receber linhas em `pendente` e
algum código futuro ler `pendente` como "ainda não começou", o comportamento diverge em silêncio na
direção oposta — OP tratada como planejada quando está em execução.

**Por que o front já está protegido, e por que isso NÃO fecha a dívida**: o seletor de OP filtra por
`!frIsOpConcluida(status)` — exclui o que acabou e mantém todo o resto, então sobrevive aos dois
vocabulários. Isso protege a TELA, não o DADO: o banco continuaria com duas palavras para o mesmo
estado, e a próxima query escrita por igualdade recria o furo.

**DECISÃO PENDENTE DO BRUNO**: no 5.0, `pendente` continua sendo estado válido (OP planejada de
verdade, distinta de em execução) ou **sai do vocabulário**? Se continuar, os dois significados
coexistem no mesmo banco depois da carga e alguém vai confundir — e aí a tradução da carga precisa
ser irreversível e documentada, não uma conversão que o próximo import desfaz. Se sair, o DEFAULT da
coluna muda junto (hoje é `'pendente'`) e cabe um CHECK com a lista fechada.

**Escopo**: script de carga (a tradução) + decisão de produto (o vocabulário) + eventual migration
(DEFAULT e CHECK). **Não** é conserto de uma linha.

Parente direta dos **guards fantasma**: `requests.controller.ts:157`, `stock.controller.ts:231` e
`tasks.controller.ts:46,81,163,192` comparam com `'finalizada'`/`'encerrada'` — valores que não
existem em nenhum dos dois bancos. Estão dormentes hoje; um vocabulário aberto (o
`updateServiceStatus` grava sem whitelist) pode acordá-los.

> _(fim do texto original. Os seis guards foram corrigidos na missão V — ver a dívida de `tasks`
> acima, também fechada. A decisão que este bloco pedia foi tomada: opção 1.)_

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

## ~~Cancelamento de solicitação não tem ownership~~ — DECIDIDA 08/08/2026 (decisão (b))

**DECISÃO DO BRUNO: modelo RECEPTOR-CANCELA, ratificado.** O comportamento atual está CORRETO e
fica como está — **zero linha de código muda por esta decisão**.

O desenho, dito por inteiro: quem cancela solicitação é quem a RECEBE (admin/almoxarife). O
solicitante que errou o pedido **avisa pelo WhatsApp** e o almoxarifado cancela. Não é contorno
nem gambiarra — é o fluxo real da casa, e o sistema estava certo ao espelhá-lo. A alternativa
("cada um cancela o seu") foi considerada e RECUSADA: o pedido entra numa fila que o almoxarifado
já está trabalhando, e deixar o solicitante puxar item de dentro dela pelas costas de quem separa
é pior do que a ligação de WhatsApp.

Isto encerra as duas consequências registradas abaixo — as duas seguem verdadeiras, e as duas são
**intencionais**, não furos:

1. admin/almoxarife cancela a solicitação de qualquer pessoa → **é o modelo**, não um vazamento.
2. o solicitante comum não cancela nem o próprio → **é o modelo**. O botão "Cancelar pedido" de
   Meus Pedidos aparecer só para admin/almoxarife é o comportamento certo, não um bug de gate.

**Medido, não presumido**: o comportamento descrito abaixo foi conferido contra o código na data da
decisão. A saída proposta na época (`requester_id = userId` como alternativa ao gate de cargo) fica
DESCARTADA — não implementar.

**Fica em aberto, e é outra coisa**: o solicitante vê o pedido virar "Recusado" sem saber quem o
recusou. O `audit_log` grava (`REJEITAR_SOLICITACAO` com motivo), mas nenhuma tela mostra. Isso é
dívida de EXIBIÇÃO, não de permissão, e não bloqueia esta decisão.

---

O registro original, de 06/08/2026, preservado abaixo porque é ele que a decisão ratifica:

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
