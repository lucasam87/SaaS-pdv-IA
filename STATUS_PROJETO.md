# Status do Projeto — SaaS PDV IA

**Data de Atualização:** 16/09/2026  
**Repositório:** [https://github.com/lucasam87/SaaS-pdv-IA](https://github.com/lucasam87/SaaS-pdv-IA)  
**Branch:** `fix/audit-hardening`  
**Stack Tecnológica:** Monorepo npm, TypeScript, React 18, Vite, Tailwind CSS, Tauri (Rust), SQLite (local) e Firebase (Functions, Firestore, Auth).

---

## 📌 Visão Geral do Sistema

O **SaaS PDV IA** é um sistema de frente de caixa e retaguarda desenhado especificamente para pequenos comércios e varejo físico, com arquitetura **Offline-First**. O terminal opera com máxima velocidade e disponibilidade local (armazenando catálogo, clientes, sessões de caixa e vendas diretamente no SQLite local), e sincroniza em segundo plano de forma atômica e idempotente com a nuvem (Firebase Cloud Functions / Firestore).

---

## ✅ O Que Já Foi Feito

### 1. Preparação de Ambiente & Infraestrutura Local
- [x] **Setup no Windows**: Node.js v22.23.2 (com suporte nativo ao `node:sqlite`), npm 10.9.8, Rust & Cargo 1.98.1 e Microsoft Edge WebView2 Runtime.
- [x] **Compatibilidade Híbrida do SQLite Local (`sqlite-driver.ts`)**:
  - `NodeSqliteDriver`: Para testes automatizados e ambiente Node com `node:sqlite`.
  - `TauriSqliteDriver`: Para a aplicação desktop empacotada em Tauri.
  - `BrowserSqliteDriver` (WebAssembly): Implementado com `sql.js` local (`/sql-wasm.js` e `.wasm` offline), permitindo desenvolvimento, testes de interface e homologação rápida em qualquer navegador comum sem travar ou exigir compilador Rust em tempo de desenvolvimento.

---

### 2. Endurecimento Arquitetural e Auditoria (Tasks 1 a 6 — Testes Automatizados)
Foram executadas baterias de testes com **15 suítes automatizadas (`test-verification.ts`) 100% aprovadas**:

- [x] **Task 1 — Eliminação de Confirmações Falsas de Sincronização**:
  - Remoção de mocks que simulavam sincronização remota sem enviar dados.
  - Vendas offline permanecem obrigatoriamente na fila `outbox` como pendentes até receberem resposta real do backend.
  - Exibição de contadores reais no Header: confirmadas, pendentes e falhas de comunicação.
- [x] **Task 2 — SQLite Assíncrono com Mutex e Durabilidade**:
  - Conexão local protegida por fila `AsyncMutex` serializada, prevenindo lock e colisões concorrentes.
  - Transações atômicas com `SAVEPOINT` e propagação estrita de rollback.
  - Durabilidade comprovada: dados sobrevivem a fechamentos e reaberturas do banco intactos.
- [x] **Task 3 — Persistência Prévia Obrigatória & Idempotência**:
  - A venda, seus itens, formas de pagamento, baixas de estoque e registro na outbox são gravados em transação atômica local **antes** de qualquer chamada de rede.
  - Padronização de IDs (`operation_id = sale.id`) preservados nas retentativas para evitar vendas duplicadas.
  - Detecção de vendas com mesmo ID e dados divergentes, bloqueando sobrescritas acidentais.
- [x] **Task 4 — Backend Transacional Autenticado (Cloud Functions)**:
  - Processamento via `runTransaction` no Firestore com leitura de todos os produtos antes das escritas.
  - Consolidação de quantidades repetidas do mesmo item na venda.
  - Suporte a saldo negativo para varejo físico sem travar o operador de caixa, gerando sinal auditável de auditoria (`STOCK_NEGATIVE_CONFLICT`).
- [x] **Task 5 — Fila Outbox Recuperável & Resiliência**:
  - Recuperação automática de operações abandonadas em estado `PROCESSING`.
  - Reivindicação atômica de lotes evitando duplicidade entre worker periódico e clique manual.
  - Estratégia de backoff exponencial com jitter e isolamento para que falhas consecutivas não travem operações novas.
- [x] **Task 6 — Regras de Segurança Rigorosas no Firestore**:
  - Regras no `firestore.rules` bloqueando gravação direta de vendas por clientes contornando o backend.
  - Isolamento multi-tenant estrito (Cross-Tenant bloqueado).
  - Proteção de segredos e configurações privadas (`private_config`).

---

### 3. Módulo de Gestão & Cadastro de Produtos (Backoffice)
- [x] **Métodos CRUD no SQLite Local (`local-db.ts`)**:
  - `getAllProducts(includeInactive)`: listagem completa com suporte a inativos.
  - `saveProduct(input)`: criação e edição com validação de unicidade de código de barras e sincronização imediata com o cache de memória do leitor do caixa.
  - `toggleProductStatus(id)`: ativação/desativação instantânea.
  - `getCategories()`: agrupamento dinâmico de categorias.
- [x] **Tela de Catálogo & Estoque (`ProductsView.tsx`)**:
  - Cards de KPIs no topo: Total de Produtos Ativos, Total com Estoque Baixo, Custo Total em Estoque (R$) e Valor Potencial de Venda (R$).
  - Campo de busca instantânea (por nome, código de barras ou categoria).
  - Filtros rápidos: dropdown de categorias, botão "Abaixo do Mínimo" e toggle para exibir produtos inativos.
  - Tabela com margem bruta em cores, status e botões rápidos de edição e ativação.
- [x] **Modal de Cadastro & Edição (`ProductFormModal.tsx`)**:
  - Campos: Nome, EAN-13, Categoria, Unidade (`UN`, `KG`, `CX`, `PCT`, `L`, `M`), Custo, Venda, Estoque Atual, Estoque Mínimo, NCM e Ativo.
  - **Gerador de EAN-13 Interno**: Geração com prefixo 200 e cálculo do dígito verificador.
  - **Painel Financeiro em Tempo Real**: Cálculo ao vivo de Lucro Unitário, Markup e Margem Bruta com badges coloridos.
- [x] **Navegação Integrada e Atalhos (`Header.tsx` e `App.tsx`)**:
  - Abas centrais: `Frente de Caixa [F1]` e `Produtos & Estoque [F3]`.
  - Atalhos globais no teclado: `F1` abre PDV, `F3` abre Produtos, `F2` inicia nova venda.
  - **Preservação Total**: Ao alternar de tela, os itens do carrinho e a venda atual não são perdidos.
- [x] **Correção de Estabilidade do Formulário**:
  - Blindagem do formulário com `useRef` e `useCallback` para impedir que os ciclos de checagem da fila outbox limpem os campos enquanto o usuário está digitando.

---

## ⏳ O Que Falta Fazer (Roadmap & Pendências)

### 1. Correções Arquiteturais Pendentes do Roteiro (`TASKS_CORRECAO_PDV.md`)
- [ ] **Task 7 — Reconstruir Sessão de Caixa por Dados Persistidos**:
  - Substituir a sessão em memória mockada (`session_001` no `App.tsx`) pela leitura real da última sessão aberta no SQLite local.
  - Manter sessão aberta persistente ao reiniciar a aplicação ou fechar a aba.
  - Cálculo estrito de fechamento cego com base nos pagamentos, sangrias e suprimentos persistidos.
  - Correção na forma como o troco é enviado para a Cloud Function (evitar rejeição de vendas em dinheiro com troco).
- [ ] **Task 8 — Reconciliação Delta de Estoque & Isolamento Multi-Tenant**:
  - Separar saldo remoto confirmado de baixas pendentes na fila local para evitar sobreposição incorreta de estoque.
  - Implementar paginação por cursor temporal com desempate de timestamp nas sincronizações remotas.
- [ ] **Task 9 — Separação Estrita de Venda e Impressão Térmica**:
  - Registrar trabalho de impressão em fila recuperável para que falhas de papel ou USB não travem a confirmação comercial da venda.
  - Mecanismo de reimpressão de cupom usando a venda gravada, sem duplicar o `saleId`.
- [ ] **Task 10 — Homologação Completa Integrada**:
  - Testes integrados com múltiplos terminais offline reconectando simultaneamente ao emulador/nuvem.

---

### 2. Próximos Módulos Funcionais do Sistema
- [ ] **Histórico e Relatório de Vendas**:
  - Tela de consulta de vendas efetuadas com filtros por data, operador e forma de pagamento.
  - Detalhes da venda, itens e reimpressão de cupom não-fiscal.
  - Opção de cancelamento de venda com estorno de estoque e lançamento financeiro.
- [ ] **Módulo de Clientes & Venda a Prazo (Fiado / Caderneta)**:
  - Cadastro de clientes (Nome, CPF/CNPJ, Telefone, Endereço, Limite de Crédito).
  - Forma de pagamento "Crediário/Fiado" com baixa posterior e quitação parcial ou total.
- [ ] **Gestão Financeira & Despesas**:
  - Lançamento de contas a pagar (fornecedores, aluguel, energia).
  - Conciliação do fluxo de caixa diário (entradas de vendas vs. saídas de sangrias e despesas).
- [ ] **Entrada de Mercadorias via XML de NF-e**:
  - Leitor/Importador de arquivo XML de nota fiscal de compra.
  - Cadastro automático de novos produtos e atualização instantânea de estoque e preço de custo.
- [ ] **Agentes de IA & Grafo Noturno (Automação)**:
  - Disparo programado do Grafo Noturno para consolidação de métricas do dia.
  - Alertas automáticos via Telegram/WhatsApp para o dono da loja (sugestão de compras, produtos com validade próxima ou risco de ruptura).
- [ ] **Geração dos Instaladores de Produção**:
  - Configuração final de build do Tauri para gerar `.exe` / `.msi` para Windows com ícone oficial e auto-update.

---

## 🚀 Como Executar o Projeto Localmente

1. **Instalação das dependências:**
   ```bash
   npm ci
   ```

2. **Rodar a suíte de testes de auditoria (15 testes):**
   ```bash
   npx tsx test-verification.ts
   ```

3. **Iniciar a aplicação em modo desenvolvimento:**
   ```bash
   npm --workspace=@pdv/desktop run dev
   ```
   Acesse no navegador: **[http://localhost:1420/](http://localhost:1420/)**
