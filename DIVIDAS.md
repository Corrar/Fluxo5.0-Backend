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

## Controle de Estoque — soma entre armazéns exige mudar o contrato da rota (lote futuro)

**Registrado em 17/08/2026** (LOTE 0, veredito V1 do arquiteto). `GET /stock` devolve `s.*` —
inclusive **`s.id`, o id da LINHA de stock**, que é a chave de `PUT /stock/:id` (ajuste de
inventário) e `GET /stock/:id/reservations`, com contrato escrito em
`Frontend-5.0-App/src/types/domain.ts:52-63` (`StockRow`). Por isso o LOTE 0 **filtrou**
(`warehouse_id = ALMOX AND op_id IS NULL`) em vez de agregar: agregar por produto destruiria o
`id` ou obrigaria a eleger um id de linha arbitrária — mentira pior que a duplicata que o lote
veio matar. Quando a tela precisar de fato do saldo somado de todos os armazéns, é **mudança de
contrato de rota + front junto** (campo agregado novo, ou rota separada, com as ações de ajuste
apontando para a linha certa). Não é conserto de leitor: é peça de produto.

## Smokes que leem `stock` sem filtrar armazém — não são bug hoje, viram bug amanhã

**Registrado em 17/08/2026** (varredura L4 do LOTE 0). Cinco smokes leem saldo com
`WHERE product_id = $1` sem `warehouse_id`: `smoke_demandas_3d.ts:173`, `smoke_op_status.ts:210`,
`smoke_requests_3d.ts:177`, `smoke_teto_conferencia.ts:176`, `smoke_returns_total_cost.ts:45`.
**Não são bug**: cada um opera em produto que ELE MESMO acabou de criar, com uma linha única de
stock. Passam a mentir no dia em que rodarem contra produto com múltiplas linhas (outro armazém
ou per-OP) — a leitura pegaria uma linha arbitrária e o smoke acusaria falha (ou sucesso) falsa.
O padrão certo já existe no repo: `smokes/_smoke.ts:61` (`getAlmoxId` + `op_id IS NULL`).

## LOTE 0 — os 20 smokes ficaram SEM EXECUÇÃO neste lote (motivo declarado)

**Registrado em 17/08/2026.** Nenhum dos 20 smokes do `package.json` rodou no lote que blindou os
três leitores de saldo, e o motivo não é preguiça nem regressão:

- **4 de semeadura em transação com ROLLBACK** (`returns:grao`, `returns:janela`,
  `returns:total-cost`, `returns:perop`) falham no `INSERT` porque o branch de validação está com
  **`default_transaction_read_only = on`** (medido: `SHOW default_transaction_read_only` → `on`,
  user `neondb_owner`, não é réplica). **Isso é proteção funcionando** — e o arquiteto decidiu
  **não liberar escrita nesse branch para rodar smoke**.
- **16 HTTP** (`users`, `tickets`, `permissions`, `security:*`, `dev*`, `pricing3d`, `assembly`,
  `opstatus`, `demandas3d`, `teto`, `requests3d`, `audit:logs`) exigem server local com escrita
  **commitada**, o que colide com o "zero escrita em banco" do próprio lote.

O critério de aceitação foi coberto por outras provas: **P1** (identidade byte-a-byte antes×depois
no dado real: 6 separações, 61 linhas de estoque, 1 inativo), **P2** (fixture de 2 linhas por CTE
`VALUES`, zero INSERT, mostrando duplicata antes e grão correto depois) e **build/typecheck**.
Para rodar os smokes: branch Neon próprio com escrita liberada e `FR_EXPECT_DB_HOST` declarado,
DEPOIS do push — nunca no branch de validação read-only.
---

# Lote R1 — recontagem física (`POST /stock/recount`), 17/08/2026

Quatro dívidas nomeadas ao ligar a recontagem. Nenhuma bloqueia o endpoint; todas foram
decididas com o Bruno antes de escrever a primeira linha.

## 1. RBAC: `estoque:edit` em vez de uma chave dedicada

A rota usa `requirePermission('estoque:edit')` — a chave que já existe e que já governa quem
corrige saldo (hoje: `almoxarife` e `usinagem_lider`). **Zero seed, zero migration.**

O mais correto em auditoria seria uma chave própria, `estoque:ajustar`: recontagem física é um
poder diferente de "editar estoque" — ela reescreve o saldo para um valor absoluto declarado por
uma pessoa, sem documento de origem (não há NF, não há separação). Quem audita quer poder
perguntar "quem pode recontar?" e receber uma lista, não deduzir a partir de outra chave.

**Ficou de fora por custo de matriz**: a chave nova teria de ser semeada e depois decidida para
as 15 classes na tela de Permissões, uma a uma. Saída, quando o custo valer a pena: seed da chave
+ trocar o `requirePermission` da rota + marcar as classes que hoje têm `estoque:edit`.

## 2. `STOCK_RECOUNT` aparece CRUA na tela de Auditoria

`audit_logs.action` é `text` sem CHECK e sem ENUM (medido na branch de produção em 17/08 —
76 verbos distintos já convivem lá), então o verbo novo entrou **sem migration**. O front tem
fallback explícito (`audit_format.js`: "action desconhecida cai no fallback, NUNCA lança"), então
a tela não quebra: mostra a action crua e os pares chave-valor do `details`.

**Pendência de front, uma linha**: somar a entrada `STOCK_RECOUNT` em `AUDIT_ACTIONS`
(`src/lib/audit_format.js`) para a Auditoria narrar o evento em português, como faz com
`UPDATE_STOCK` e `STOCK_ENTRY`. O `details` já vem no formato que a narrativa precisa:
`{ idem_key, total_itens, aplicados, replays, com_diferenca, itens: [{ product_id, sku, old_qty, new_qty }] }`.

## 3. `PUT /stock/:id` (a rota antiga) — duas dívidas que a rota nova NÃO herda

Decidido explicitamente: **o lote R1 não toca o `PUT /stock/:id`**. A tela nova de recontagem não
o usa, então nenhuma das duas dívidas abaixo a alcança. Ficam registradas porque a rota continua
viva e aberta a quem chamar a API direto.

**(a) `op_key` ancorada no VALOR FINAL.** A chave é `stock:<id>:adjust:<valor>` — o valor contado
faz parte dela. Consequência: recontar **10 → 12 → 10** faz o terceiro ajuste colidir com a chave
do primeiro, o `alreadyApplied` do motor dispara e o saldo **fica em 12, em silêncio** (HTTP 200,
sem aviso nenhum). Recontagem legítima para um valor já usado é indistinguível de replay. É
exatamente por isso que a rota nova exige `X-Idempotency-Key` e ancora a chave na SESSÃO
(`recount:<chave>:product:<id>`), nunca no valor — e há prova dedicada disso no `smoke_recount`.

**(b) Gate inline morto para Usinagem.** O `updateStock` não tem `requirePermission`: decide por
role hardcoded (`admin`/`almoxarife` passam) e, para os demais, exige
`profiles.sector.toLowerCase() === 'usinagem'` **e** produto com tag `usinagem`. O dado real de
`profiles.sector` em produção é **"Setor: Usinagem"** (5 usuários) — que em minúsculas é
`'setor: usinagem'` e **nunca** casa com `'usinagem'`. Na prática o ramo inteiro está morto: só
admin e almoxarife ajustam por lá. Efeito colateral de auditoria: por não usar `requirePermission`,
essa rota é a única mutação de saldo **invisível para a tela de Permissões** — quem administra a
matriz não tem como saber que ela existe.

> **Atualização 18/08/2026 (lote S1).** A metade do DADO está endereçada: a migration
> `025_normaliza_prefixo_setor.sql` tira o prefixo dos 5 perfis, e com isso o ramo volta a
> viver **sem tocar no código** — a prova do S1 mostra o mesmo operador levando 403 antes e
> passando depois, com a segunda condição (tag `usinagem` no produto) intacta. A metade do
> CÓDIGO continua aberta: ver "Lote S1 · 2" no fim deste arquivo.

## 4. Endpoint POOLER da VALIDAÇÃO em modo somente-leitura (achado de bancada)

Ao rodar o `smoke_recount` contra a validação (`ep-summer-wave`), toda escrita voltou
`cannot execute INSERT in a read-only transaction`. Medido na sequência:

| rota de conexão | `default_transaction_read_only` | escrita |
|---|---|---|
| `ep-summer-wave-ajlt26g5-**pooler**...` (a URL do `.env`) | **on** | recusada |
| `ep-summer-wave-ajlt26g5...` (direto, sem `-pooler`) | off | OK |

Não vem de `pg_roles.rolconfig` nem de `pg_db_role_setting` (ambos vazios) e o compute **não** está
em recovery (`pg_is_in_recovery = false`) — ou seja, não é réplica: é configuração do endpoint
pooled no Neon. **Produção (`ep-steep-breeze`) não é afetada** — escreveu normalmente durante todo
o dia 17/08. O `smoke_recount` rodou pelo endpoint direto, com o guard de host declarado
(`FR_EXPECT_DB_HOST=ep-summer-wave`) e as duas camadas conferidas.

**Consequência para quem vier depois**: qualquer smoke de escrita rodado com o `.env` do
repositório vai falhar em validação até isso ser resolvido no console do Neon (ou até a
`DATABASE_URL` do `.env` deixar de usar o pooler). Não é dívida de código deste repositório —
é estado de infraestrutura, registrado aqui para não custar meia hora de diagnóstico ao próximo.

**AÇÃO PENDENTE — antes do próximo lote que ESCREVA (verificação de infra, não de código):**
conferir no Render (serviço `fluxo5-0-backend-r49g`) se a `DATABASE_URL` de **PRODUÇÃO** usa
endpoint **pooler** ou **direto**, e medir `SHOW default_transaction_read_only` nele.

Por que isso importa: os dois endpoints da **mesma branch** divergiram em capacidade de escrita
**sem** que a diferença viesse de `pg_roles.rolconfig` ou de `pg_db_role_setting` — ou seja, a
diferença é do endpoint, não do banco. Um pooler read-only em produção derrubaria **toda** mutação
com **o guard de host passando em silêncio**: `FR_EXPECT_DB_HOST` confere o HOST, e o host estaria
certo — o modo é que estaria errado. O sintoma chegaria como 500 genérico em telas não
relacionadas, e o diagnóstico começaria no lugar errado.

Olhar também a **query string** da URL, não só o hostname: `options=` (pode carregar
`-c default_transaction_read_only=on`) e `target_session_attrs` (`any` × `read-write` — este
último recusa a conexão em vez de aceitar e depois negar cada escrita, que é o comportamento
preferível). Se produção estiver no pooler e escrevendo normalmente (foi o observado em 17/08),
o item vira apenas registro; se estiver perto de virar, é bloqueio de go-live.

## warehouses.sector é o QUARTO vocabulário de setor — unificar é PRÉ-REQUISITO do transfer

**Registrado em 17/08/2026** (LOTE W1, migration 024). O slug de `warehouses.sector` é minúsculo
sem acento (`esteira`, `lavadora`, `flow`, `classificadora`, `embaladora`, `prototipo`,
`desenvolvimento`, e da 004: `usinagem`,
`producao_3d`, `eletrica`, `montagem`, `expedicao`). Ele **não casa** com:
- `profiles.sector` — forma de exibição, com maiúscula e acento ("Usinagem", "Elétrica");
- `separations.destination` — texto livre MAIÚSCULO/misto, escrito pelo operador;
- `VALID_SECTORS` do `manualWithdrawal` (stock.controller) — lista própria com acento e nomes que
  não existem como armazém ("Terceiros", "Acumulador", "Reposição", "Viagem", "Outros").

São **quatro vocabulários independentes para a mesma coisa**. A 024 seguiu o slug da 004 de
propósito: divergir criaria um QUINTO. **A unificação é lote próprio e é pré-requisito do
transfer** — transferir material de setor para setor exige um de-para confiável entre "o setor que
o usuário vê" e "o armazém que guarda o saldo"; hoje esse de-para não existe em lugar nenhum.

### DE-PARA FECHADO (decisão do Bruno, 18/08/2026) — a peça que o transfer vai consumir

O de-para deixou de "não existir em lugar nenhum": está fechado abaixo e replicado no comentário
de topo da 024. Ele **não** substitui a unificação de vocabulário — é a decisão de PRODUTO (quem
guarda custódia) que a unificação vai ter de respeitar quando virar tabela.

**COM ARMAZÉM — guardam custódia (recebem por transferência, apontam consumo depois):**

| setor | armazém | origem |
|---|---|---|
| Usinagem | `USINAGEM` | 004 |
| Elétrica | `ELET` | 004 |
| 3D | `P3D` | 004 |
| Esteira | `ESTEIRA` | 024 |
| Lavadora | `LAVADORA` | 024 |
| Flow | `FLOW` | 024 |
| Classificadora | `CLASSIF` | 024 |
| Embaladora | `EMBALAD` | 024 |
| **Protótipo** | `PROTOTIPO` | **024, emenda W2** |
| **Desenvolvimento** | `DESENV` | **024, emenda W2** |

**SEM ARMAZÉM — consomem na entrega, sem custódia** (armazém aqui seria saldo que ninguém aponta):
Escritório, Chefia, Financeiro, Compras, Gerência, Assistente Técnico, Engenharia, Ferro, Geral,
Outros Setores, Almoxarifado, Viagem, Terceiros, Reposição, Acumulador, Granja NaturOvos.

**INDEFINIDOS — fora do de-para até decisão:** Montagem, Expedição. Os armazéns `MONT` e `EXP`
existem desde a 004, estão vazios (0 linhas de `stock`) e não têm tráfego em
`separations.destination`. Não se sabe se guardam custódia; chutar plantaria de-para errado.

#### O que a medição de 18/08 (produção, READ ONLY) mostrou sobre este de-para

**Os nomes vêm de DUAS fontes, e isso é parte da dívida.** Os dez com armazém e onze dos sem
armazém saem de `profiles.sector`; **Viagem, Terceiros, Reposição, Acumulador e Granja NaturOvos
só existem em `separations.destination`** — nunca foram setor de ninguém. Um de-para que só olhe
uma das pontas fica cego para metade dos nomes.

**A evidência que sustenta Protótipo e Desenvolvimento**: `separations.destination` tem
`DESENVOLVIMENTO` (23 separações) e `Protótipo` (13) + `PROTÓTIPO` (1) — ou seja, material JÁ é enviado
para esses dois setores hoje. A decisão da engenharia bate com o tráfego medido.

**⚠ Três buracos conhecidos, nomeados para não serem descobertos tarde:**

1. **`Classificadora` e `Embaladora` não têm NENHUMA evidência de uso.** Não aparecem em
   `profiles.sector` (nenhum perfil) nem em `separations.destination` (nenhuma separação). Os dois
   armazéns nascem da 024 por decisão de domínio, não por dado observado. Se a fábrica não usar
   esses nomes, sobram dois armazéns vazios — inócuo, mas vale reconferir com a engenharia.
2. **`separations.destination` tem o mesmo setor em até TRÊS grafias**: `ELETRICA` (62),
   `Elétrica` (27) e `eletrica` (2); `ESTEIRA` (105) e `Esteira` (8); `USINAGEM` (45) e
   `Usinagem` (26); `FLOW` (49) e `Flow` (8); `LAVADORA` (58) e `Lavadora` (8). Qualquer de-para
   que case por igualdade de string vai errar a maioria das linhas — tem de normalizar
   (minúsculas + sem acento) antes de comparar.
3. **`Outro` (1 separação) não está em NENHUMA das três listas.** É o valor de escape do texto
   livre. Um de-para completo precisa decidir o que fazer com ele em vez de deixá-lo cair fora.

#### ⚠ REQUISITO DO LOTE SEGUINTE (quem for implementar o de-para lê isto primeiro)

**1. A comparação setor→armazém NÃO PODE SER POR IGUALDADE DE STRING.**

Medido em produção em 18/08/2026, `separations.destination`:

| grafias do MESMO setor | separações |
|---|---|
| `ELETRICA` / `Elétrica` / `eletrica` | 62 / 27 / 2 |
| `ESTEIRA` / `Esteira` | 105 / 8 |
| `USINAGEM` / `Usinagem` | 45 / 26 |
| `FLOW` / `Flow` | 49 / 8 |
| `LAVADORA` / `Lavadora` | 58 / 8 |
| `REPOSIÇÃO` / `Reposição` | 48 / 7 |
| `TERCEIROS` / `Terceiros` | 10 / 7 |
| `PROTÓTIPO` / `Protótipo` | 1 / 13 |

Casar por igualdade **erraria a maioria das linhas** — e erraria em silêncio, achando que o setor
não existe. **A normalização mínima é `lower()` + remoção de acento** (`unaccent` ou equivalente),
**aplicada nos DOIS lados** da comparação: no valor lido e na chave do de-para. Aplicar só de um
lado é o mesmo defeito com outro nome — foi exatamente assim que o `toLowerCase()` sozinho do
`stock.controller.ts:127` deixou 5 usuários com 403 (ver "Lote S1 · 2").

Nota de infra: `unaccent` é EXTENSION, não função nativa — exige `CREATE EXTENSION IF NOT EXISTS
unaccent` (disponível no Neon). Se a preferência for não depender de extension, `translate()` com
a tabela de acentos do português resolve; o que **não** pode é comparar sem normalizar.

**2. Valor NÃO MAPEADO → SEM ARMAZÉM → consome na entrega. Nunca falhar por setor desconhecido.**

O de-para tem de ter fallback declarado, e o fallback é o comportamento SEGURO: um nome que não
está em nenhuma das listas cai em "sem custódia" e o material é consumido na entrega — que é o
que já acontece hoje para a maioria dos setores. Erguer exceção ou devolver erro por setor
desconhecido transformaria um cadastro novo (o campo é `<input>` de texto livre nas duas pontas)
em operação travada no chão de fábrica.

Isso inclui o **`Outro`** (1 separação), que não está em nenhuma das três listas do Bruno, e
inclui qualquer nome que alguém digite amanhã. **A regra é: o de-para responde "qual armazém?"
com um armazém ou com "nenhum" — nunca com um erro.**

#### ✅ IMPLEMENTADO em 18/08/2026 (lote D1) — e a régua que o acompanha

O requisito acima virou código: `canonSetor` e `SETOR_ARMAZEM` em **`src/services/setor.ts`**,
`resolveDestinationWarehouseId` em `src/services/warehouse.ts`, e o carimbo de
`requests.warehouse_id` em `createRequest`. A normalização é `lower`+sem-acento em TypeScript
(`NFD` + faixa U+0300–U+036F), não `unaccent` do Postgres — sem extension, sem migration.

### ⚠ RÉGUA: `warehouses.sector` NÃO é a fonte do de-para

**Resolver de destino que leia `warehouses.sector` é BUG.** A coluna parece a fonte óbvia e não é,
por três motivos medidos no M5 (produção, 18/08/2026):

| | `warehouses.sector` | `SETOR_ARMAZEM` (a fonte) |
|---|---|---|
| vocabulário | slug snake_case: `producao_3d`, `eletrica` | canônico: `PRODUCAO 3D`, `ELETRICA` |
| cardinalidade | **1→1** (uma linha por armazém) | **N→1** (`3D` e `PRODUCAO 3D` → `P3D`) |
| "sem armazém" | não tem onde guardar | 18 chaves com `null`, decisão registrada |

**A coluna não representa sinônimos.** É metadado descritivo do armazém, e continua correta para
o que ela é — este lote não a alterou de propósito (é dado de produção e não estorva).

**A PRESCRIÇÃO, que é a parte que importa:**

> **Setor novo entra como CHAVE em `SETOR_ARMAZEM` (`src/services/setor.ts`), NUNCA como UPDATE em
> `warehouses.sector`.**

O risco real não é alguém LER da coluna — é alguém tentar **"consertar o de-para" editando-a**. Ela
é gravável, não tem CHECK, e foi a própria migration 024 que escreveu aqueles slugs, o que a faz
parecer a fonte canônica. Um `UPDATE warehouses SET sector = ...` roda sem erro, parece ter
funcionado, e não muda nada — porque o resolver lê o mapa, não a coluna. Falha silenciosa com
aparência de conserto.

### Cobertura medida do mapa (produção, 18/08/2026)

**61 valores distintos** nas três pontas. Antes do D1:

| fonte | distintos | desconhecidos |
|---|---|---|
| `profiles.sector` | 19 | **0** |
| `separations.destination` | 25 | 1 — `Granja NaturOvos` |
| `requests.sector` | 17 | 1 — `Obras` |

As duas lacunas foram fechadas no lote, e por motivos diferentes:

- **`Granja NaturOvos`** era omissão de transcrição: já estava na lista SEM ARMAZÉM decidida no W2,
  acima nesta mesma seção, mas a chave não tinha chegado ao código.
- **`Obras`** entra por FATO medido, não por analogia: as 2 solicitações com `requests.sector =
  'Obras' (25/03 e 02/04/2026) são do mesmo usuário, cujo `profiles.sector` HOJE é
  "Outros Setores" — que já era `null` no mapa. A derivação atual
  (`requests.controller.ts:133-137`) **não consegue mais gerar** "Obras", porque nenhum perfil tem
  esse setor. A chave fecha o histórico; não decide política nova.

**MONTAGEM e EXPEDIÇÃO seguem FORA do mapa de propósito** — e, por estarem fora, caem no ramo
`conhecido: false`, que avisa no log. É o comportamento desejado: setor indefinido que apareça em
produção tem de gritar, não passar batido.

### O carimbo: o que ele é e o que ele não é

`requests.warehouse_id` (coluna com FK desde a 004, **0 de 2.641 preenchida** antes deste lote)
passa a ser gravada na criação da solicitação. **É carimbo, não ponteiro vivo**: resolvido uma vez,
no nascimento. Se a pessoa mudar de setor amanhã, a solicitação antiga não muda — que é o que um
registro histórico deve fazer. As 2.641 existentes **ficam com NULL**: o carimbo não retroage, e
inventar destino para o passado seria adivinhar.

Ele nasce ANTES do transfer existir, de propósito, para que quando o transfer entrar o destino já
esteja gravado em todas as solicitações novas. **A entrega segue chamando `consume`** — este lote
não liga transferência nenhuma.

### Nota para o lote do TRANSFER

`separations.destination` é OUTRO campo livre, com 25 valores distintos. Quando o transfer entrar
no caminho de separação, ele passa pelo **MESMO `canonSetor` e pelo MESMO `SETOR_ARMAZEM`** — não
nasce cópia. Uma segunda tabela para os 25 valores reintroduziria, em duas linhas, exatamente o
problema de vocabulário múltiplo que este lote existe para resolver.

## Os 7 armazéns novos NÃO aparecem nos dropdowns do front (e por quê)

**Registrado em 17/08/2026** (LOTE W1). Nenhum front lê a tabela `warehouses` — **não existe rota
`GET /warehouses`**. Os seletores de armazém são arrays LITERAIS no código do front, com 6 nomes
cada: `ARMAZENS` (`fluxo-royale-react/src/parts/pages_admin.jsx:7`) e `SEP_ARMAZENS`
(`separacoes.jsx:735`). O valor escolhido é rótulo local e nem é enviado ao backend (o
`POST /stock/entries` recebe só `nf_number`, `type`, `entries`). Consequência honesta: os sete
armazéns existem no banco e **não vão aparecer em tela** até que exista a rota e o front passe a
enumerar o banco — lote de front próprio. O lado bom: por isso mesmo a 024 não quebra tela nenhuma.

## Provas ancoradas em ep-summer-wave NÃO são reproduzíveis (o read_only oscila sozinho)

**Registrado em 17/08/2026.** O mesmo endpoint `-pooler` do branch de validação mediu
`default_transaction_read_only = on` durante o LOTE 0 e `off` poucas horas depois, no LOTE W1,
**sem intervenção de ninguém** — e o guard de host não pega isso (host certo, modo diferente).
Some-se que o `stock` de lá tem 71 linhas com 1 armazém povoado, o que não representa produção
(recon #3: 2.350 linhas). **Regra: prova de migration roda em branch Neon própria, criada sem
expiração, com `FR_EXPECT_DB_HOST` declarado** — nunca no branch de validação compartilhado.

## Régua de desmonte de worktree: `-Recurse` através de junction APAGA O ALVO

**Registrado em 17/08/2026** (dano real observado). O `node_modules` de `Backend-Fluxo2.0` foi
encontrado VAZIO (0 itens; `pg` e `dotenv` ausentes) horas depois de estar íntegro. Assinatura:
worktree removido com `Remove-Item -Recurse` atravessando a junction de `node_modules` — o
`-Recurse` segue o link e apaga o conteúdo do ORIGINAL, não só o link. **A régua (já registrada
para o front, agora com dano medido no backend): apagar a junction PRIMEIRO, com `cmd /c rmdir`
(sem -Recurse), e só então remover o worktree.** Recuperação: `npm ci` no repositório afetado.

## O repo NÃO versiona schema-base — medido no LOTE W1 sobre banco VAZIO (a dívida AINDA VALE)

**Medido em 17/08/2026** (LOTE W1, container Postgres 16 local e descartável). Aplicando as
migrations do repo **em ordem sobre um banco vazio**, **18 das 19 falham**; só a `014_drop_dev_tasks`
passa (é `DROP ... IF EXISTS` sobre nada). A causa é única: as migrations começam em **004** e
pressupõem um schema-base que **nunca foi versionado** (veio do 2.0).

Tabelas-base pressupostas, extraídas das próprias mensagens de guard das migrations:
`audit_logs, client_services, dev_projects, op_material_events, op_returns, products,
request_items, role_permissions, separation_items, separations, settings, stock, stock_ledger,
tickets, users, xml_logs` — mais `profiles`, que aparece pelos smokes.

**O lado bom, também medido:** as migrations **não explodem com erro criptográfico** — 15 delas
abortam com guard nomeado ("X ausente — schema base não encontrado"), o que torna o diagnóstico
imediato. **A consequência prática:** não existe caminho "banco novo → migrations → sistema
rodando"; provisionar ambiente novo exige um dump do schema atual. E as suítes de smoke não são
executáveis em container vazio (as 4 de ROLLBACK morrem em `profiles` ausente; as 16 HTTP exigem
schema completo + server) — o LOTE W1 provou a 024 construindo à mão um schema-base MÍNIMO
(products, stock, client_services, requests, request_items, separations, separation_items,
separation_returns), rodando a **004 real** sobre ele e só então a 024.
**Versionar o schema-base (001_base.sql, gerado por `pg_dump --schema-only` do estado atual) é
lote próprio** — e é pré-requisito de qualquer prova de migration que não dependa de dump.

# Lote S1 — prefixo "Setor: " em `profiles.sector`, 18/08/2026

A migration `025_normaliza_prefixo_setor.sql` tira o prefixo de **5 perfis** (`"Setor: Usinagem"`
-> `"Usinagem"`), consertando o 403 de `PUT /stock/:id` para os 4 `usinagem_operador` e o 1
`usinagem_lider`. Escopo deliberadamente estreito: só o prefixo, só `profiles`. Duas coisas
ficaram nomeadas e FORA.

## 1. `requests.sector` — 210 linhas já carregam o prefixo. Reescrever histórico é decisão do Bruno.

**Medido em 18/08/2026 contra a produção (`ep-steep-breeze`, sessão READ ONLY):**

| medida | valor |
|---|---|
| solicitações totais | 2.630 |
| com `sector` = `"Setor: Usinagem"` | **210 (8,0%)** |
| janela | 12/06/2026 → 17/08/2026 |
| `requests.sector` NULL | 0 |

**O vetor** é `requests.controller.ts:133-137`: quando o corpo não manda `sector`, o servidor
deriva de `profiles.sector`. Meus Pedidos **nunca** manda — setor de quem pede é identidade, e
identidade vem do token, não do corpo (foi assim de propósito, para fechar a divergência de
sessão da dívida (f)). Logo, toda solicitação de um usuário da Usinagem gravou o prefixo junto.

**A torneira ESTANCA sozinha com a 025**: a derivação passa a copiar `"Usinagem"` limpo, sem
nenhuma mudança em `requests.controller.ts`. O que resta é **histórico** — e é só sobre ele que
há decisão a tomar.

**A favor de NÃO reescrever**: o histórico registra o que estava gravado na época. Uma
solicitação de junho realmente nasceu com `"Setor: Usinagem"`; reescrevê-la é apagar o rastro do
defeito, não o defeito.

**A favor de reescrever**: `reportsBi.controller.ts:111` agrupa por `requests.sector`
(`COALESCE(NULLIF(TRIM(r.sector), ''), 'Sem setor')`). Sem normalizar, o relatório passa a tratar
`"Setor: Usinagem"` e `"Usinagem"` como **setores DIFERENTES** — dois pontos no mesmo gráfico para
a mesma Usinagem, com o consumo dela partido ao meio na data da migration. Quem lê o BI não tem
como saber que é a mesma gente.

**Lote próprio, com decisão explícita do Bruno.** Se for reescrever, o mesmo desenho da 025 serve
(condição que só casa o que ainda tem prefixo + guard de premissa ancorado em 210), mas o guard
precisa ser remedido na hora: 210 é de 18/08/2026 e a janela seguia aberta até a 025 rodar.

## 2. O gate de `PUT /stock/:id` compara STRING SOLTA onde deveria haver chave de RBAC

**A 025 conserta o DADO, não o desenho.** `stock.controller.ts:127` continua decidindo assim:

```ts
if (userCheck.rows[0]?.sector?.toLowerCase() !== 'usinagem' || !hasTag) return 403;
```

Autorização ancorada em **texto digitado num `<input>` livre** (`pages_admin.jsx:1109-1110`), sem
allowlist, sem tela de edição depois do cadastro. Qualquer variação de digitação — `"Usinagem "`,
`"USINAGEM"` passa (o `toLowerCase`), mas `"Usinagem 2"`, `"Usinagem/Torno"` ou o próximo prefixo
que alguém invente — volta a matar o ramo, em silêncio e com 403 sem explicação. **Foi assim que
esta dívida nasceu**: ninguém escreveu código errado; alguém digitou um rótulo.

O desenho certo é o mesmo já discutido no **Lote R1 · 1** (`estoque:edit` vs. uma chave dedicada)
e no **Lote R1 · 3** (as duas dívidas do `PUT /stock/:id`): **chave de RBAC**, semeada, decidida
na tela de Permissões classe a classe, e checada por `requirePermission` — não `sector` comparado
com literal. Hoje `usinagem_lider` **já tem** `estoque:edit`; o que falta é a rota usar isso.

Efeito colateral que continua valendo: por não usar `requirePermission`, esta rota é a única
mutação de saldo **invisível para a tela de Permissões** — quem administra a matriz não tem como
saber que ela existe.

**NÃO foi consertado no S1 de propósito.** Duas mudanças ao mesmo tempo (dado + gate) tornariam
impossível provar qual delas destravou a rota. O S1 provou que foi o DADO: mesmo operador, mesmo
produto, mesma expressão — 403 antes, passa depois. O conserto do desenho é lote próprio e agora
tem uma prova de regressão pronta para reusar.

# Réguas de instrumentação — aprendidas medindo, não por teoria

**Registradas em 18/08/2026** (lote D1). As duas nasceram de prova que ficou VERDE estando errada,
ou VERMELHA estando certa. Instrumento que erra em silêncio é pior que instrumento ausente: o
ausente você sabe que não tem.

## Asserir CARDINALIDADE junto com conteúdo

> **Instrumento que degrada para um conjunto menor passa vazio — asserir cardinalidade junto com
> conteúdo.**

**O caso que criou a régua.** A prova P6 do D1 comparava as 23 chamadas de `resolveWarehouseId`
antes e depois, para provar que nenhuma tinha sido tocada. O parser do harness quebrava em 22 das
23 linhas (ver a régua do CRLF abaixo) e devolvia `null`, que era filtrado — sobrava **uma**. A
comparação então rodava sobre uma lista de 1 elemento contra outra de 23, e num cenário ligeiramente
diferente teria dado **verde comparando quase nada**.

O padrão é geral e não depende de CRLF: `.filter(Boolean)`, `.filter(x => x.ok)`, `try/catch` que
engole item ruim, `LIMIT` esquecido, regex que não casa — todos **encolhem o conjunto sob teste** em
vez de falhar. Um teste que só pergunta "todos os que rodaram passaram?" responde SIM para o
conjunto vazio.

**Como aplicar:** todo laço de verificação assere **quantos** entraram, além de **se** passaram.

```js
// FRÁGIL — verde com lista vazia, verde com lista truncada
if (itens.every(ok)) aprovado();

// COM CARDINALIDADE — só passa se rodou sobre o conjunto que se pretendia medir
if (itens.length === ESPERADO && itens.every(ok)) aprovado();
```

E, quando o número esperado vem de uma medição (61 valores de setor, 23 chamadas, 5 perfis),
**o número entra no teste como constante**, não como `itens.length`. Comparar um conjunto consigo
mesmo é tautologia: `itens.length === itens.length` é sempre verdade, inclusive com zero.

## CRLF: normalizar ANTES de comparar ou casar regex

> **Neste ambiente, normalizar `\r\n` → `\n` antes de qualquer comparação ou regex sobre arquivo do
> repositório.**

O repo está com `core.autocrlf=true`: o **objeto git guarda LF** e a **árvore de trabalho é CRLF**.
Toda ferramenta que cruza as duas pontas vê bytes diferentes para conteúdo idêntico.

**Já mordeu três vezes, em dois lotes:**

| onde | sintoma | o que mascarava |
|---|---|---|
| S1, ao commitar | `warning: LF will be replaced by CRLF` | nada — mas exigiu conferir o blob contra o arquivo provado |
| D1, prova P6 (corpo) | `git show` (LF) × arquivo (CRLF) davam md5 diferente | **falso VERMELHO**: a função estava intocada |
| D1, prova P6 (chamadas) | `git grep` na árvore devolve a linha com `\r`; `(.*)$` não casa depois dele | **falso VERDE em potencial**: 22 de 23 linhas viravam `null` em silêncio |

A segunda é a perigosa e merece o detalhe: em JavaScript, `.` **não** casa `\r` (é terminador de
linha), e `$` sem a flag `m` casa só no fim da string. Então `/^([^:]+):(\d+):(.*)$/` falha em toda
linha terminada em `\r` — e falha **devolvendo null**, não lançando.

**Como aplicar:**

- comparação de conteúdo: normalizar os DOIS lados (`t.split(String.fromCharCode(13)).join('')`);
- saída de `git grep`/`git show` sobre a árvore: tirar o `\r` de cada linha antes de qualquer regex;
- ao gerar o normalizador por camada de shell, **evitar o escape de `\r`** — ele se perdeu duas
  vezes em 18/08 atravessando o shell e virou uma quebra de linha literal, quebrando o script.
  `String.fromCharCode(13)` não tem backslash e sobrevive a qualquer camada.

## Senha de smoke LITERAL em 5 arquivos — lote futuro: SMOKE_SENHA/SMOKE_ADMIN por env

**Registrado em 18/08/2026** (portão G2 do lote D1). Os cinco smokes que criam solicitação
(`smoke_requests_3d`, `smoke_op_status`, `smoke_demandas_3d`, `smoke_teto_conferencia`,
`smoke_recount`) carregam a credencial CHUMBADA:

```ts
const SENHA_SEED = 'Teste@123';
const ADMIN = '001@fluxoroyale.local';
```

Duas consequências, uma operacional e uma de segurança:

1. **Os smokes só rodam onde essa senha vale** — na prática, só no seed de validação
   (`ep-summer-wave`), que está DESQUALIFICADO como alvo de prova (read_only oscilante, dado não
   representativo). Para rodá-los na branch de ensaio em 18/08 foi preciso TROCAR a senha das
   contas 001/002/005 na branch e restaurar depois — instrumentação que não deveria ser
   necessária.
2. **Senha literal versionada em 5 arquivos é dívida de segurança**, não só de ergonomia — ainda
   que seja a senha do seed, ela está no histórico do git e aparece em qualquer grep.

**Saída (zero lógica nova, 5 arquivos):**

```ts
const SENHA_SEED = process.env.SMOKE_SENHA ?? 'Teste@123';
const ADMIN = process.env.SMOKE_ADMIN ?? '001@fluxoroyale.local';
```

Fallback no literal atual = comportamento byte-idêntico para quem roda hoje contra a validação;
quem rodar contra a branch de ensaio passa a credencial por env, sem UPDATE em banco nenhum.
`smoke_recount` usa também `002@` (ator com estoque:edit) e `005@` (sem a chave) — entram como
`SMOKE_ATOR`/`SMOKE_SEM_CHAVE` no mesmo molde.