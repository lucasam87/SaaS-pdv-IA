# Tasks de correção — SaaS PDV IA

## Instrução ao Gemini

Atue como engenheiro sênior responsável pela correção do projeto SaaS-pdv-IA. Execute uma task por vez, na ordem abaixo, começando pela Task 1. Ao concluir, apresente evidências e aguarde a solicitação da próxima etapa.

Base: revisão do [commit ad2f3bb](https://github.com/lucasam87/SaaS-pdv-IA/commit/ad2f3bb5597ca88e36e110208f99533537128db3). Os problemas referem-se a essa versão; inspecione o código atual antes de alterar, pois correções posteriores podem existir. Este roteiro não certifica o estado atual do projeto.

## Regras de execução

- Preserve alterações existentes e evite refatorações sem relação com a task.
- Diferencie implementação real, simulação e integração pendente.
- Não considere comentários, nomes de funções ou mensagens de sucesso como prova.
- Não marque uma operação como concluída sem confirmação efetiva.
- Não altere testes apenas para fazê-los passar.
- Use dados e ambientes de teste, sem credenciais ou transações de produção.
- Preserve vendas e histórico nas migrações.
- Registre arquivos alterados, comportamento corrigido, comandos executados, resultados e limitações.
- Identifique testes não executados e o motivo. Não declare validação de produção com base em mocks.
- Marque uma task como concluída somente quando seus critérios de aceite estiverem demonstrados. Se houver impedimento, registre como bloqueada.
- Não publique nem faça deploy automaticamente.

## Controle de progresso

- [x] Task 1 — Eliminar confirmações falsas de sincronização
- [ ] Task 2 — Corrigir SQLite no Tauri
- [ ] Task 3 — Persistir antes do envio
- [ ] Task 4 — Implementar backend transacional autenticado
- [ ] Task 5 — Recuperar e desbloquear a fila
- [ ] Task 6 — Corrigir regras de segurança
- [ ] Task 7 — Reconstruir caixa por dados persistidos
- [ ] Task 8 — Reconciliar estoque e isolar dados locais
- [ ] Task 9 — Separar venda e impressão
- [ ] Task 10 — Validar o fluxo completo

## Task 1 — Eliminar confirmações falsas de sincronização

**Arquivos iniciais:** `apps/desktop/src/App.tsx`, `apps/desktop/src/services/sale-writer.ts`, `apps/desktop/src/services/sync-worker-client.ts`.

### Ações

- [x] Remover do fluxo operacional handlers que retornam sucesso sem enviar dados ao backend.
- [x] Restringir simulações a testes ou modo demonstrativo explícito.
- [x] Manter vendas na outbox enquanto não houver integração real.
- [x] Validar a resposta remota: Promise resolvida com `success:false` não é sucesso.
- [x] Exibir contagens reais de confirmadas, pendentes e falhas.

**Aceite:** sem backend ou sem rede, nenhuma venda recebe `SYNCED`. Resposta negativa não remove pendência.

## Task 2 — Corrigir SQLite no Tauri

**Arquivos iniciais:** `apps/desktop/src/db/sqlite-driver.ts`, `apps/desktop/src/db/local-db.ts`, `apps/desktop/src/db/schema.ts`.

### Ações

- [x] Uniformizar contrato assíncrono de `query`, `execute` e `transaction`.
- [x] Remover `any` que esconde incompatibilidade entre Promise e array.
- [x] Atualizar todos os consumidores para aguardar as operações.
- [x] Centralizar inicialização em uma única Promise e aguardar migrations e cache antes de habilitar vendas.
- [x] Garantir conexão exclusiva durante a transação; se o plugin não assegurar isso, usar comando Rust dedicado.
- [x] Distinguir transações aninhadas legítimas de chamadas concorrentes independentes.
- [x] Propagar erros de commit e rollback.
- [x] Usar arquivo persistente no desktop e arquivo temporário nos testes de recuperação.

**Aceite:** a venda sobrevive à reabertura do banco. Falha intermediária não deixa venda, itens, pagamentos, baixa ou outbox parcialmente gravados. Validar também no Tauri; Node não substitui essa etapa.

## Task 3 — Persistir a venda antes de qualquer envio

**Arquivos iniciais:** `sale-writer.ts`, `local-db.ts`, `App.tsx`.

### Ações

- [x] Gerar `saleId` e `operationId` uma vez por venda e preservá-los nas retentativas.
- [x] Gravar venda, itens, pagamentos, movimentos e outbox em uma transação local antes do envio.
- [x] Padronizar IDs: no commit revisado, `operation_id` recebe `sale.id`; preservar compatibilidade com pendências existentes.
- [x] Tentar sincronizar imediatamente após commit local.
- [x] Tratar timeout como resultado remoto desconhecido, mantendo a operação recuperável.
- [x] Atualizar para `SYNCED` somente após confirmação válida.
- [x] Detectar mesmo ID com conteúdo comercial divergente, sem sobrescrever silenciosamente.
- [x] Impedir confirmação e impressão quando a persistência local falhar.

**Aceite:** interrupção após commit não perde a venda. Vendas legítimas idênticas recebem IDs diferentes; retentativas mantêm os IDs originais.

## Task 4 — Implementar backend transacional autenticado

**Arquivos iniciais:** `functions/src/cloud-sale-handler.ts`, `functions/src/index.ts`.

### Ações

- [x] Implementar endpoint autenticado e adaptador Firestore reais.
- [x] Validar vínculo com tenant, permissões, dispositivo e payload no servidor.
- [x] Aplicar venda dentro de `runTransaction`.
- [x] Ler operação e todos os produtos antes de qualquer escrita.
- [x] Consolidar quantidades quando o produto aparecer em mais de um item.
- [x] Gravar atomicamente venda, movimentos, estoque e comprovante de operação.
- [x] Validar quantidades, valores, descontos e pagamentos.
- [x] Permitir saldo negativo para vendas físicas válidas, gerando sinal auditável.
- [x] Detectar conteúdo divergente com mesmo `operationId`.
- [x] Conectar envio imediato e worker ao mesmo endpoint.
- [x] Manter impressão e mensagens fora do callback transacional.

**Aceite:** no emulador, dois envios simultâneos da mesma operação produzem uma venda e uma aplicação dos movimentos. Simular resposta perdida e commit tardio seguido de reenvio, sem duplicação.

## Task 5 — Tornar a fila recuperável

**Arquivos iniciais:** `sync-worker-client.ts`, `local-db.ts`, `schema.ts`.

### Ações

- [ ] Implementar prazo de processamento e recuperação de `PROCESSING` abandonado.
- [ ] Reivindicar operações atomicamente para impedir processamento concorrente indevido.
- [ ] Persistir `nextAttemptAt` com backoff e jitter.
- [ ] Selecionar registros elegíveis antes do limite do lote.
- [ ] Evitar que tentativas esgotadas bloqueiem as operações seguintes.
- [ ] Criar estado de revisão e mecanismo de reprocessamento.
- [ ] Aplicar timeout ao envio para uma chamada travada não paralisar o worker.
- [ ] Fazer o botão manual antecipar retentativas transitórias sem contornar autenticação e validação.
- [ ] Contabilizar todas as operações ainda não confirmadas.

**Aceite:** interrupção em `PROCESSING` permite recuperação. Vinte operações esgotadas não bloqueiam a seguinte. Worker e botão simultâneos não duplicam efeitos.

## Task 6 — Corrigir regras de segurança

**Arquivo inicial:** `firebase/firestore.rules`.

### Ações

- [x] Reservar ao backend a gravação de comprovantes em `operations`.
- [x] Impedir criação direta de vendas que contorne o endpoint transacional.
- [x] Restringir caixa por papel, responsável, campos e transições válidas.
- [x] Armazenar segredos em documentos privados, sem cópias em documentos públicos ao tenant.
- [x] Validar autorização nas Functions independentemente das Rules.
- [x] Revisar origem e manutenção das claims de tenant e papel.

**Aceite:** emulador nega acesso cruzado, falso comprovante, leitura de segredos e alteração financeira indevida. Fluxos autorizados permanecem funcionais.

## Task 7 — Reconstruir caixa por dados persistidos

**Arquivos iniciais:** `App.tsx`, `local-db.ts`, componentes de abertura e fechamento.

### Ações

- [ ] Remover sessão demonstrativa fixa do fluxo operacional.
- [ ] Restaurar sessão ativa do terminal na inicialização.
- [ ] Calcular fechamento por pagamentos, suprimentos, sangrias e demais movimentos persistidos.
- [ ] Definir se `payment.amount` é recebido ou líquido aplicado; tratar troco uma única vez.
- [ ] Distribuir pagamentos mistos por valores efetivos.
- [ ] Sincronizar sessões e movimentos de forma durável e idempotente.
- [ ] No fechamento cego, ocultar saldo esperado até registrar a contagem.

**Aceite:** abrir, vender, registrar suprimento/sangria, reiniciar e fechar preserva o saldo. Validar dinheiro com troco e pagamentos mistos.

## Task 8 — Reconciliar estoque e isolar dados locais

**Arquivos iniciais:** `cache-reconciler.ts`, `local-db.ts`, `schema.ts`.

### Ações

- [ ] Impedir sobrescrita de baixas pendentes por saldo remoto.
- [ ] Separar saldo remoto confirmado de movimentos ainda não incorporados.
- [ ] Reconciliar confirmações sem dupla baixa.
- [ ] Implementar paginação e cursor com desempate de timestamp.
- [ ] Tratar produtos desativados.
- [ ] Aplicar dados e avançar cursor atomicamente.
- [ ] Isolar banco, consultas, cache e cursores por tenant.

**Aceite:** atualização com vendas pendentes preserva saldo correto. Confirmação seguida de reconciliação não duplica baixas. Timestamps iguais não causam omissões.

## Task 9 — Separar conclusão da venda e impressão

**Arquivos iniciais:** `App.tsx`, `PaymentModal.tsx`, `printer-usb.ts`.

### Ações

- [ ] Manter trava imediata contra submissões concorrentes.
- [ ] Impedir Escape e fechamento durante etapa crítica.
- [ ] Separar falha de impressão de falha de persistência.
- [ ] Registrar trabalho de impressão recuperável.
- [ ] Reimprimir usando venda existente, sem gerar novo `saleId`.
- [ ] Diferenciar envio à impressora de impressão física confirmada conforme capacidade do equipamento.
- [ ] Tratar resultado de impressão desconhecido sem presumir falha ou repetir automaticamente o cupom.

**Aceite:** falha da impressora após commit mantém uma venda e uma baixa. Reimpressão, duplo clique e Enter repetido não criam outra operação comercial.

## Task 10 — Validar fluxo completo e relatório de testes

**Arquivo inicial:** `test-verification.ts`.

### Ações

- [ ] Separar testes unitários, SQLite persistente, emuladores e desktop.
- [ ] Usar dados isolados e resultados reproduzíveis.
- [ ] Conferir estado persistido, não apenas mensagens ou objetos preparados.
- [ ] Cobrir cenários de falha das tasks anteriores.
- [ ] Testar dois terminais com bases distintas, vendas offline e reconexão simultânea.
- [ ] Conferir vendas, estoque, movimentos, outbox e fechamento após convergência.
- [ ] Identificar testes dependentes de Windows, impressora e ambiente externo.
- [ ] Substituir “100% validado” por descrição exata do escopo aprovado.

**Aceite:** entregar matriz de cenário, ambiente, resultado e evidência. Toda simulação e teste não executado permanece identificado.

## Modelo de entrega por task

| Campo | Preencher após execução |
| --- | --- |
| Task e estado | Pendente / em andamento / bloqueada / concluída |
| Versão examinada | Commit ou estado do checkout |
| Diagnóstico | Problema confirmado no código atual |
| Arquivos alterados | Caminhos reais |
| Correção | Comportamento resultante |
| Validação | Comandos e resultados observados |
| Evidências | Asserções, registros e estado persistido |
| Limitações | Mocks, testes não executados e impedimentos |
| Próximo passo | Task seguinte ou resolução do impedimento |

## Comando inicial

> Leia este arquivo integralmente. Execute somente a Task 1 no código atual. Implemente a correção, valide os critérios de aceite e preencha o modelo de entrega. Não avance para a Task 2 nesta execução.

## Limite do roteiro

Concluir estas tasks corrige o escopo identificado; não substitui homologação operacional, teste físico de impressão, validação de fechamento diário com dados atrasados ou avaliação de backup e restauração. Não declarar produção liberada sem evidência dessas etapas quando aplicáveis.
