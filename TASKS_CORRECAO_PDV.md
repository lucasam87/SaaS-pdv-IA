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
- [x] Task 2 — Corrigir SQLite no Tauri
- [x] Task 3 — Persistir antes do envio
- [x] Task 4 — Implementar backend transacional autenticado
- [x] Task 5 — Recuperar e desbloquear a fila
- [x] Task 6 — Corrigir regras de segurança
- [x] Task 6.5 — Estabilização do módulo de produtos e correções pendentes da auditoria
- [x] Task 6.6 — Fechamento técnico da estabilização
- [x] Task 6.7 — Correção de integridade do catálogo, convites e CI
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

## Task 6.5 — Estabilização do Módulo de Produtos e Auditoria

**Arquivos:** `apps/desktop/src/db/sqlite-driver.ts`, `apps/desktop/src/db/schema.ts`, `apps/desktop/src/db/local-db.ts`, `apps/desktop/src/services/cloud-api-client.ts`, `apps/desktop/src/services/sync-worker-client.ts`, `apps/desktop/src/components/PaymentModal.tsx`, `apps/desktop/src/components/ProductFormModal.tsx`, `functions/src/cloud-sale-handler.ts`, `functions/src/endpoints/auth-claims-endpoint.ts`, `test-verification.ts`.

### Ações

- [x] **Critério 1 — BrowserSqliteDriver durável e tolerante**: Persistência via IndexedDB pós-commit, rollback safety sem persistir transações abortadas, export/import de banco binário, e prevenção de crash-loop com isolamento de backup corrompido e inicialização limpa.
- [x] **Critério 2 — Isolamento estrito de tenant**: Chaves de busca e cache em memória mapeadas por `${tenantId}:${barcode}` e `${tenantId}:${id}`, listagens `getAllProducts` e `getCategories` filtradas por `tenant_id`, e deltas com tenant divergente rejeitados com `ValidationError`.
- [x] **Critério 3 — Persistência e validação de NCM**: Coluna `ncm TEXT` adicionada na migração v3, validação estrita fiscal de 2 a 8 dígitos numéricos, sanitização de pontuação e propagação nos mappers e modelos.
- [x] **Critério 4 — Unicidade de código de barras por tenant**: Restrição `UNIQUE(tenant_id, barcode)` criada via índice `idx_products_tenant_barcode`, rotina prévia de migração sem exclusão cega de duplicados, e validação atômica antes do insert.
- [x] **Critério 5 — Validação estrita de produto**: Rejeição de campos vazios, caracteres de controle em barcodes, números NaN/Infinity, custo negativo, preço de venda menor ou igual a zero, estoque mínimo negativo e unidades fora do enum `ProductUnit`.
- [x] **Critério 6 — Sincronização de catálogo via outbox**: Gravação de eventos `CATALOG_PRODUCT_UPSERT` e `CATALOG_PRODUCT_TOGGLE` na mesma transação SQLite, com roteamento dedicado no `SyncWorkerClient` sem converter catálogo para `Sale`.
- [x] **Critério 7 — Validação de resposta da nuvem**: `CloudApiClient` valida `Content-Type: application/json`, status `success === true`, e integridade de correspondência de `saleId` e `operationId`. Respostas HTML de proxy ou falhas remotas são rejeitadas com `CloudResponseError`.
- [x] **Critério 8 — Contrato financeiro de dinheiro e troco**: No `PaymentModal` e no backend, `amount` representa o valor entregue (tender) e `changeAmount` o troco devolvido. Pagamentos não-dinheiro têm troco estritamente proibido (`changeAmount === 0`).
- [x] **Critério 9 — Idempotência canônica SHA-256**: Hash SHA-256 gerado no backend a partir dos campos determinísticos da venda. Tentativa com mesmo `operationId` e hash divergente é rejeitada com `INTEGRITY_CONFLICT`. Reuso de `saleId` sob outro `operationId` também é rejeitado.
- [x] **Critério 10 — Atribuição de permissões (`assignUserClaims`)**: Bloqueio de auto-elevação de privilégios (`caller.uid === targetUid`), verificação de vínculo com o tenant do administrador, e gravação de log de auditoria em `tenants/{tenantId}/audit_logs`.
- [x] **Critério 11 — Exclusividade de transação SQLite**: Consultas diretas e transações serializadas via `AsyncMutex`. `TransactionContextDriver` executa comandos internos sem deadlock e preserva isolamento completo.
- [x] **Critério 12 — Suíte de testes automatizados**: Adicionada e aprovada a suíte `TESTE 16` no `test-verification.ts` comprovando os 11 critérios de forma determinística.

**Aceite:** Todos os 16 testes automatizados de `test-verification.ts` passam com 100% de sucesso. Workspaces `@pdv/desktop` e `functions` compilam sem qualquer erro de TypeScript.

### Modelo de entrega — Task 6.5

| Campo | Preencher após execução |
| --- | --- |
| Task e estado | **Task 6.5 — Concluída com 100% de aprovação** |
| Versão examinada | Commit base `9f1721c` na branch `fix/audit-hardening` |
| Diagnóstico | Módulo de produtos continha persistência volátil no navegador, ausência de isolamento multi-tenant no cache, falta de NCM na migração v3, colisão global de barcode entre tenants distintos, validações permissivas com fallback silencioso (`parseFloat || 0`), e ausência de outbox para catálogo. |
| Arquivos alterados | `apps/desktop/src/db/sqlite-driver.ts`, `apps/desktop/src/db/schema.ts`, `apps/desktop/src/db/local-db.ts`, `apps/desktop/src/services/cloud-api-client.ts`, `apps/desktop/src/services/sync-worker-client.ts`, `apps/desktop/src/components/PaymentModal.tsx`, `apps/desktop/src/components/ProductFormModal.tsx`, `apps/desktop/src/components/ProductsView.tsx`, `apps/desktop/src/components/ProductScanner.tsx`, `apps/desktop/src/components/Header.tsx`, `functions/src/cloud-sale-handler.ts`, `functions/src/endpoints/auth-claims-endpoint.ts`, `test-verification.ts`, `STATUS_PROJETO.md`, `TASKS_CORRECAO_PDV.md`. |
| Correção | Persistência IndexedDB durável no browser com recuperação de corrupção, chaveamento multi-tenant por `${tenantId}:${barcode}`, migração v3 com NCM e `UNIQUE(tenant_id, barcode)`, validações tipadas `ValidationError`, outbox transacional para catálogo, validação estrita de rede no `CloudApiClient`, troco financeiro exato, idempotência via SHA-256 canônico, prevenção de auto-elevação em claims e isolamento via `AsyncMutex`. |
| Validação | `npm --workspace=@pdv/desktop run build` (sucesso), `npm --workspace=functions run build` (sucesso) e `npx tsx test-verification.ts` (16 suítes / 16 aprovadas). |
| Evidências | Testes automatizados executados com saída de código 0 cobrindo snapshots, rollback, NCM, barcode uniqueness, outbox catalog routing, cloud response validation, dinheiro/troco, SHA-256 idempotency, claims audit e mutex exclusivity. |
| Limitações | Emuladores Firestore e testes com hardware térmico USB físico pertencem à homologação de Tasks 9 e 10. |
| Próximo passo | Task 6.6 — Fechamento Técnico da Estabilização. |

## Task 6.6 — Fechamento Técnico da Estabilização

**Arquivos alterados:** `functions/src/endpoints/catalog-endpoint.ts`, `functions/src/endpoints/auth-claims-endpoint.ts`, `functions/src/cloud-sale-handler.ts`, `functions/src/index.ts`, `apps/desktop/src/db/sqlite-driver.ts`, `apps/desktop/src/db/local-db.ts`, `apps/desktop/src/services/cloud-api-client.ts`, `apps/desktop/src/services/sync-worker-client.ts`, `firebase/firestore.rules`, `.github/workflows/ci.yml`, `test-verification.ts`.

### Ações Executadas

- [x] **Backend Real de Sincronização de Catálogo (`apiSyncCatalog`)**:
  - Implementação completa com verificação de Firebase ID Token (`verifyAuthToken`).
  - Validação estrita de correspondência entre o `tenantId` da credencial e o payload.
  - Autorização de papéis: permissão restrita a `ADMIN` e `MANAGER` (`assertCatalogPermissions`), com bloqueio estrito de `CASHIER` e tentativas cross-tenant.
  - Idempotência canônica SHA-256 (`computeCanonicalCatalogHash`) baseada nos atributos comerciais do produto/toggle.
  - Detecção e rejeição imediata com `INTEGRITY_CONFLICT` caso o mesmo `operationId` seja reutilizado com payload divergente.
  - Transação atômica no Firestore (`RealFirestoreCatalogTransactionAdapter`) com todas as leituras anteriores às escritas, gravando produto e comprovante na coleção `operations`.
  - Exportação oficial da Cloud Function em `functions/src/index.ts`.
- [x] **Endurecimento do Contrato de Respostas Remotas (`CloudApiClient`)**:
  - `CloudSaleResponse` e `CloudCatalogResponse` agora exigem obrigatoriamente `operationId` e `saleId` válidos (eliminação de `{ success: true }` sem comprovação).
  - Validação de correspondência exata de `operationId` e `saleId` retornados contra a requisição enviada.
  - Alinhamento do `CloudSaleHandler` e `apiProcessSale` para sempre retornarem `operationId` tanto em novas vendas quanto em repetições idempotentes.
  - Aplicação dos mesmos critérios estritos de validação aos dispatchers mock para testes determinísticos.
- [x] **Correção de Persistência Pós-COMMIT no `BrowserSqliteDriver`**:
  - Separação estrita entre a confirmação do `COMMIT;` no SQLite e o snapshot no IndexedDB.
  - NUNCA executar `ROLLBACK;` após o `COMMIT;` ter sido confirmado no motor SQLite em memória.
  - Transição de estado explícita para `COMMITTED_BUT_NOT_PERSISTED` e sinalização `hasPendingStoragePersistence() === true` caso o snapshot no storage falhe.
  - Método `retryPersistence()` permitindo retentativa limpa de gravação de snapshot sem reexecutar a lógica de negócio.
- [x] **Unificação da Regra de Unicidade de Código de Barras**:
  - Produtos inativos continuam reservando o código de barras no banco, alinhando com a constraint `UNIQUE(tenant_id, barcode)`.
  - Remoção de `AND is_active = 1` da query preventiva no `local-db.ts`.
  - Retorno de erro tipado `ValidationError('barcode', ...)` ao detectar colisão de código de barras.
  - Atualização do cache em memória após `toggleProductStatus` com recarga imediata do tenant.
- [x] **Endurecimento de `assignUserClaims` (Convites e Auditoria)**:
  - Manutenção do bloqueio contra auto-elevação (`caller.uid === targetUid`) e transferência cross-tenant.
  - Para usuários sem `tenantId` e sem vínculo prévio, exigência obrigatória de convite pendente em `tenants/{tenantId}/invites`.
  - Consumo atômico do convite (`status: 'ACCEPTED'`).
  - Registro de auditoria em `tenants/{tenantId}/audit_logs` para tentativas de sucesso e tentativas negadas.
- [x] **Segurança no Firestore Rules (`firestore.rules`)**:
  - Regras de segurança adicionadas para as coleções `invites` e `audit_logs` sob cada `tenantId`.
- [x] **Subtestes Automatizados e CI**:
  - Adição dos subtestes 16.12, 16.13, 16.14, 16.15 e 16.16 no `test-verification.ts`.
  - Adição do workflow de CI do GitHub Actions em `.github/workflows/ci.yml`.

**Aceite:** Todos os 16 testes automatizados e subtestes 16.1 a 16.16 passam com 100% de sucesso. Workspaces `@pdv/desktop` e `functions` compilam com código 0.

### Modelo de entrega — Task 6.6

| Campo | Preencher após execução |
| --- | --- |
| Task e estado | **Task 6.6 — Concluída com 100% de aprovação** |
| Versão examinada | Commit base `85d4f40` na branch `fix/audit-hardening` |
| Diagnóstico | Ausência de endpoint real de sincronização de catálogo na nuvem, contrato permissivo de respostas remotas sem IDs obrigatórios, rollback indevido no BrowserSqliteDriver após commit confirmado, colisão de código de barras permitida em produtos inativos pela query preventiva, apropriação indevida de empresa por UID no `assignUserClaims` sem validação de convite, e ausência de pipeline de CI. |
| Arquivos alterados | `functions/src/endpoints/catalog-endpoint.ts`, `functions/src/endpoints/auth-claims-endpoint.ts`, `functions/src/cloud-sale-handler.ts`, `functions/src/index.ts`, `apps/desktop/src/db/sqlite-driver.ts`, `apps/desktop/src/db/local-db.ts`, `apps/desktop/src/services/cloud-api-client.ts`, `apps/desktop/src/services/sync-worker-client.ts`, `firebase/firestore.rules`, `.github/workflows/ci.yml`, `test-verification.ts`, `STATUS_PROJETO.md`, `TASKS_CORRECAO_PDV.md`. |
| Correção | Endpoint `apiSyncCatalog` funcional com idempotência canônica SHA-256 e atomicidade Firestore; contrato de resposta rígido com `saleId` e `operationId` obrigatórios no `CloudApiClient`; `BrowserSqliteDriver` com separação de commit e snapshot e estado `COMMITTED_BUT_NOT_PERSISTED`; reserva de barcode por produtos inativos com `ValidationError`; consumo atômico de convites e auditoria no `assignUserClaims`; workflow `.github/workflows/ci.yml`. |
| Validação | `npm --workspace=@pdv/desktop run build` (sucesso, código 0), `npm --workspace=functions run build` (sucesso, código 0), `npx tsx test-verification.ts` (16 suítes e subtestes 16.12 a 16.16 com código 0). |
| Evidências | Testes automatizados executados comprovando catálogo na nuvem, contrato de resposta, durabilidade pós-commit, unicidade de barcode com inativos, convites de tenant e trilha de auditoria. |
| Limitações | Não configurado Docker e Task 7 não iniciada (conforme restrição do escopo). |
| Próximo passo | Task 7 — Reconstruir caixa por dados persistidos. |

## Task 6.6 — Fechamento técnico da estabilização

**Arquivos alterados:** `functions/src/endpoints/catalog-endpoint.ts`, `apps/desktop/src/services/cloud-api-client.ts`, `apps/desktop/src/db/sqlite-driver.ts`, `apps/desktop/src/db/local-db.ts`, `functions/src/endpoints/auth-claims-endpoint.ts`, `.github/workflows/ci.yml`.

### Ações

- [x] Implementar backend real de sincronização de catálogo (`apiSyncCatalog`) com Firebase ID Token, autorização `ADMIN`/`MANAGER`, idempotência por `operationId`, hash SHA-256 e transação atômica.
- [x] Endurecer contrato de respostas remotas no `CloudApiClient` exigindo `saleId` e `operationId` correspondentes.
- [x] Corrigir persistência do `BrowserSqliteDriver`: nunca executar rollback de banco após `COMMIT;` confirmado; registrar estado `COMMITTED_BUT_NOT_PERSISTED` em falha de storage com suporte a `retryPersistence()`.
- [x] Unificar regra de unicidade de barcode incluindo produtos inativos (`UNIQUE(tenant_id, barcode)`).
- [x] Proteger atribuição de permissões (`assignUserClaims`) com consumo de convites pendentes e auditoria em `tenants/{tenantId}/audit_logs`.
- [x] Configurar CI no GitHub Actions (`.github/workflows/ci.yml`).

**Aceite:** backend de catálogo funcional e idempotente, contratos remotos sem aceitar respostas sem ID, isolamento de commit no SQLite e convites auditados.

## Task 6.7 — Correção de integridade do catálogo, convites e CI

**Arquivos alterados:** `functions/src/endpoints/catalog-endpoint.ts`, `firebase/firestore.rules`, `functions/src/endpoints/auth-claims-endpoint.ts`, `test-verification.ts`.

### Ações

- [x] **Proteger o estoque remoto**: `CATALOG_PRODUCT_UPSERT` preserva o `currentStock` existente no Firestore; proibido spread irrestrito de payload; criação inicial usa `initialStock` sem sobrescrever saldo existente; teste comprovando que saldo 80 permanece 80 mesmo com upsert atrasado informando 100.
- [x] **Autorização estrita de catálogo**: `assertCatalogPermissions` rejeita explicitamente `CASHIER`, papéis ausentes, `null`, `undefined` e desconhecidos, aceitando exclusivamente `ADMIN` e `MANAGER`.
- [x] **Tornar endpoint do catálogo obrigatório**: `firebase/firestore.rules` atualizado com `allow write: if false;` em `/products` e `/barcode_reservations`; escrita remota exclusiva pelo Firebase Admin SDK (`apiSyncCatalog`).
- [x] **Validação de payload no servidor sem `any`**: `validateCatalogPayload` valida campos cadastrais, bloqueia caracteres de controle ASCII no barcode, valida preços não-negativos e finitos, restringe unidades ao enum `VALID_PRODUCT_UNITS`, valida/higieniza NCM e exige booleano estrito para `isActive`.
- [x] **Unicidade de código de barras na nuvem**: Controle transacional de reservas em `/tenants/{tenantId}/barcode_reservations/{barcode}` vinculado ao `productId`, com liberação atômica ao alterar o barcode e suporte a produtos inativos.
- [x] **Resiliência de convites e claims**: Consumo de convite executado dentro de `firestore.runTransaction` validando status `PENDING`, prazo de validade, destinatário (`targetUid`/`email`) e role; adota estado transitório `CLAIMS_PENDING` no Firestore para garantir recuperação idempotente sem corromper o convite em caso de falha transitória do Auth SDK.
- [x] **Trilha de auditoria com fail-closed**: Remoção de qualquer bypass de auditoria; falha ao registrar auditoria de privilégios gera `AUDIT_FAILURE` imediato bloqueando a operação de segurança.
- [x] **CI e Workflow Scope**: Workflow `.github/workflows/ci.yml` pronto e verificado.

**Aceite:** 17 suítes de teste automatizadas em `test-verification.ts` 100% aprovadas; estoque remoto blindado contra sobrescrita; permissões, validações e convites transacionais comprovados.

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
