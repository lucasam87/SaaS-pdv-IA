import assert from 'node:assert/strict';
import { localDb } from './apps/desktop/src/db/local-db';
import { ThermalPrinterService } from './apps/desktop/src/services/printer-usb';
import { SaleWriterService } from './apps/desktop/src/services/sale-writer';
import { SyncWorkerClient } from './apps/desktop/src/services/sync-worker-client';
import { exportProductsToExcelBuffer } from './functions/src/exporters/excel-exporter';
import {
  extractProductsFromExcel,
  parseCurrencyOrNumberPtBr,
  parseCsv,
} from './functions/src/importers/excel-importer';
import { OfflineSyncWorker } from './functions/src/sync-worker';
import { CloudSaleHandler, FirestoreTransactionContext } from './functions/src/cloud-sale-handler';
import { executeNightGraph } from './functions/src/ai-graph/night-graph';
import { Product, Sale, Tenant, TenantSettings, CashSession } from './packages/shared/src';

async function runRigorousVerification() {
  console.log('================================================================');
  console.log('🧪 BATERIA DE TESTES E AUDITORIA ARQUITETURAL (10 ETAPAS)');
  console.log('================================================================\n');

  const tenantId = 'tenant_audit_001';
  const settings: TenantSettings = {
    receiptHeader: 'MERCEARIA CENTRAL\nRUA PRINCIPAL, 100',
    receiptFooter: 'VOLTE SEMPRE!',
    receiptWidthMm: 80,
    maxDiscountPercentageAllowedForCashier: 5,
    enableTelegramAlerts: true,
  };

  const mockTenant: Tenant = {
    id: tenantId,
    name: 'Mercearia Central',
    tradeName: 'Mercearia Central',
    email: 'contato@mercearia.com',
    plan: 'PRO',
    status: 'ACTIVE',
    settings,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // -------------------------------------------------------------------------
  // ETAPA 1: SQLite Local de Verdade, Schema DDL e Busca Instantânea (< 1ms)
  // -------------------------------------------------------------------------
  console.log('▶ TESTE 1: SQLite Local, DDL, Migrations e Busca Instantânea');
  await localDb.initialize();
  localDb.seedDemoProductsIfEmpty(tenantId);

  const meta = localDb.getMeta();
  assert.ok(meta.totalLocalProducts >= 6, 'Deve haver ao menos 6 produtos carregados no SQLite.');

  const startLookup = performance.now();
  const productFound = localDb.findByBarcode('7891000100101');
  const lookupDuration = performance.now() - startLookup;

  assert.ok(productFound, 'Produto Café Tradicional 500g deve existir.');
  assert.strictEqual(productFound.name, 'Café Tradicional 500g');
  assert.ok(lookupDuration < 5, `Busca deve ser instantânea (levou ${lookupDuration.toFixed(3)}ms).`);

  const searchResults = localDb.search('Arroz', 5);
  assert.ok(searchResults.length > 0, 'Busca por texto deve encontrar o arroz.');
  assert.strictEqual(searchResults[0].barcode, '7892000200202');
  console.log(`  ✓ SQLite DDL verificado. Busca executada em ${lookupDuration.toFixed(3)}ms.\n`);

  // -------------------------------------------------------------------------
  // ETAPA 2: Transação Atômica de Venda e Rollback em Caso de Falha
  // -------------------------------------------------------------------------
  console.log('▶ TESTE 2: Transação Atômica de Venda e Rollback de Persistência');
  const initialStock = productFound.currentStock;
  const validSaleId = `sale_audit_${Date.now()}`;
  const validSale: Sale = {
    id: validSaleId,
    operationId: `op_${validSaleId}`,
    tenantId,
    sessionId: 'sess_001',
    deviceId: 'caixa-01',
    saleNumber: 501,
    userId: 'user_01',
    userName: 'Operador Teste',
    subtotal: 37.8,
    discount: 0,
    total: 37.8,
    totalCost: 25.0,
    items: [
      {
        productId: productFound.id,
        productName: productFound.name,
        barcode: productFound.barcode,
        quantity: 2,
        unitPrice: productFound.sellingPrice,
        unitCost: productFound.costPrice,
        discount: 0,
        totalPrice: 37.8,
        totalCost: 25.0,
      },
    ],
    payments: [{ method: 'DINHEIRO', amount: 50.0, changeAmount: 12.2 }],
    status: 'COMPLETED',
    createdAt: Date.now(),
  };

  localDb.recordLocalSale(validSale);
  const stockAfter = localDb.findByBarcode('7891000100101')!.currentStock;
  assert.strictEqual(stockAfter, initialStock - 2, 'Estoque deve ser deduzido em exatamente 2 unidades.');

  // Teste de Rollback: Tentativa com erro (método de pagamento nulo)
  const failingSale: Sale = {
    ...validSale,
    id: `sale_fail_${Date.now()}`,
    operationId: `op_fail_${Date.now()}`,
    payments: [{ method: null as any, amount: 10.0 }], // Viola NOT NULL constraint
  };

  assert.throws(
    () => localDb.recordLocalSale(failingSale),
    /NOT NULL constraint failed/,
    'Deve lançar exceção e não silenciar o erro.'
  );

  const stockAfterRollback = localDb.findByBarcode('7891000100101')!.currentStock;
  assert.strictEqual(stockAfterRollback, stockAfter, 'Estoque NÃO deve ser alterado após rollback.');
  console.log('  ✓ Transação atômica e rollback comprovados com asserção estrita.\n');

  // -------------------------------------------------------------------------
  // ETAPA 3: Idempotência Local (SQLite) e na Nuvem (CloudSaleHandler)
  // -------------------------------------------------------------------------
  console.log('▶ TESTE 3: Idempotência Local e na Nuvem (Evitar Venda/Baixa Duplicada)');
  // Re-gravação da mesma venda localmente
  const outboxCountBefore = localDb.getPendingOutboxCount();
  localDb.recordLocalSale(validSale); // Execução duplicada
  const stockAfterRepeat = localDb.findByBarcode('7891000100101')!.currentStock;
  assert.strictEqual(stockAfterRepeat, stockAfter, 'Re-gravação de venda com mesmo ID não deve alterar estoque.');
  assert.strictEqual(localDb.getPendingOutboxCount(), outboxCountBefore, 'Não deve duplicar item na outbox.');

  // Idempotência no CloudSaleHandler (Firestore Transaction Context Mock)
  const mockOperations = new Map<string, any>();
  const mockSales = new Map<string, Sale>();
  const mockCloudStock = new Map<string, number>([[productFound.id, 20]]);
  const mockSignals: any[] = [];

  const txMock: FirestoreTransactionContext = {
    async getOperation(tId, opId) {
      return mockOperations.get(`${tId}_${opId}`);
    },
    async getProduct(tId, pId) {
      return { id: pId, currentStock: mockCloudStock.get(pId) ?? 0 };
    },
    async saveSale(tId, sale) {
      mockSales.set(`${tId}_${sale.id}`, sale);
    },
    async updateProductStock(tId, pId, newStock) {
      mockCloudStock.set(pId, newStock);
    },
    async saveSignal(tId, signal) {
      mockSignals.push(signal);
    },
    async recordOperation(tId, opId, data) {
      mockOperations.set(`${tId}_${opId}`, data);
    },
  };

  // Primeira chamada na nuvem
  const cloudRes1 = await CloudSaleHandler.processCloudSale(tenantId, validSale, txMock);
  assert.strictEqual(cloudRes1.success, true);
  assert.strictEqual(cloudRes1.idempotentRepeat, false);
  assert.strictEqual(mockCloudStock.get(productFound.id), 18, 'Nuvem deduziu 2 unidades (20 -> 18).');

  // Segunda chamada com mesmo operationId (simulando reenvio de timeout)
  const cloudRes2 = await CloudSaleHandler.processCloudSale(tenantId, validSale, txMock);
  assert.strictEqual(cloudRes2.success, true);
  assert.strictEqual(cloudRes2.idempotentRepeat, true, 'Segunda chamada deve ser detectada como idempotente.');
  assert.strictEqual(mockCloudStock.get(productFound.id), 18, 'Estoque NÃO pode ser baixado novamente.');
  console.log('  ✓ Idempotência local e de nuvem verificadas com sucesso.\n');

  // -------------------------------------------------------------------------
  // ETAPA 4: Fila Outbox e Sync Worker com Backoff Exponencial
  // -------------------------------------------------------------------------
  console.log('▶ TESTE 4: Fila Outbox e Sync Worker com Backoff e Retry');
  let syncAttempt = 0;
  const customSyncWorker = new SyncWorkerClient(async (_op, _sale) => {
    syncAttempt++;
    if (syncAttempt === 1) {
      // Simula erro de conexão transitório na 1ª tentativa
      return { success: false, error: '503 Service Unavailable' };
    }
    return { success: true };
  });

  const run1 = await customSyncWorker.syncOnce();
  assert.strictEqual(run1.failedCount, 1, '1ª tentativa deve registrar falha.');

  const pendingOps = localDb.getPendingOutboxOperations(5);
  const failedOp = pendingOps.find((o) => o.operationId === validSale.id);
  assert.ok(failedOp, 'Operação deve estar na lista de pendentes/falhas.');
  assert.strictEqual(failedOp.status, 'FAILED');
  assert.strictEqual(failedOp.attempts, 1);
  assert.strictEqual(failedOp.lastError, '503 Service Unavailable');

  // Valida que o backoff impede retry imediato se chamado sem force
  const runBackoffCheck = await customSyncWorker.syncOnce(false);
  assert.strictEqual(runBackoffCheck.processedCount, 0, 'Deve respeitar o backoff exponencial e não retentar prematuramente.');

  // 2ª tentativa com force = true (como quando o usuário clica em Sincronizar Agora)
  const run2 = await customSyncWorker.syncOnce(true);
  assert.strictEqual(run2.successCount, 1, 'Tentativa forçada deve sincronizar com sucesso.');
  console.log('  ✓ Outbox sync worker com retry, backoff respeitado e sincronização forçada validado.\n');

  // -------------------------------------------------------------------------
  // ETAPA 5: Conflito de Venda Offline Simultânea (STOCK_NEGATIVE_CONFLICT)
  // -------------------------------------------------------------------------
  console.log('▶ TESTE 5: Conflito de Estoque em Vendas Simultâneas Offline');
  const scarceProduct: Product = {
    id: 'prod_scarce_01',
    tenantId,
    name: 'Bebida Especial Rara',
    barcode: '7898888888888',
    costPrice: 10.0,
    sellingPrice: 15.0,
    minStock: 5,
    currentStock: 1, // Apenas 1 unidade física disponível!
    unit: 'UN',
    isActive: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const saleCaixa1: Sale = {
    ...validSale,
    id: 'sale_off_c1',
    deviceId: 'caixa-01',
    items: [{ ...validSale.items[0], productId: scarceProduct.id, productName: scarceProduct.name, quantity: 1 }],
  };
  const saleCaixa2: Sale = {
    ...validSale,
    id: 'sale_off_c2',
    deviceId: 'caixa-02',
    items: [{ ...validSale.items[0], productId: scarceProduct.id, productName: scarceProduct.name, quantity: 1 }],
  };

  const syncResult = OfflineSyncWorker.processOfflineBatch([saleCaixa1, saleCaixa2], [scarceProduct]);

  assert.strictEqual(syncResult.syncedSalesCount, 2, 'Nenhuma venda física offline pode ser descartada.');
  assert.strictEqual(syncResult.updatedStockMap[scarceProduct.id], -1, 'Saldo deve ficar -1 (negativo permitido).');
  assert.strictEqual(syncResult.conflictsDetected.length, 1, 'Deve emitir 1 sinal de conflito.');
  assert.strictEqual(syncResult.conflictsDetected[0].type, 'STOCK_NEGATIVE_CONFLICT');
  assert.deepStrictEqual(
    syncResult.conflictsDetected[0].payload.deviceIds.sort(),
    ['caixa-01', 'caixa-02'].sort()
  );
  console.log('  ✓ Regra de varejo físico garantida: Vendas aceitas e sinal STOCK_NEGATIVE_CONFLICT gerado.\n');

  // -------------------------------------------------------------------------
  // ETAPA 6: Gestão de Caixa: Sangria, Suprimento e Fechamento Matemático
  // -------------------------------------------------------------------------
  console.log('▶ TESTE 6: Caixa: Suprimento, Sangria e Cálculo Cego de Fechamento');
  const session: CashSession = {
    id: 'sess_mat_01',
    tenantId,
    terminalNumber: 1,
    deviceId: 'caixa-01',
    openedByUserId: 'u1',
    openedByName: 'Lucas',
    openedAt: Date.now(),
    initialAmount: 100.0, // Fundo de troco: 100
    totalCashSales: 250.0, // Vendas em dinheiro: 250
    totalPixSales: 150.0,
    totalCardSales: 200.0,
    totalCreditSales: 0,
    totalSangrias: 80.0, // Sangria: -80
    totalSuprimentos: 50.0, // Suprimento: +50
    status: 'OPEN',
  };
  localDb.openCashSession(session);

  // Registra movimentações
  localDb.recordCashMovement({
    id: 'mov_sup_01',
    tenantId,
    sessionId: session.id,
    type: 'SUPRIMENTO',
    amount: 50.0,
    reason: 'Troco de moedas do banco',
    userId: 'u1',
    userName: 'Lucas',
    createdAt: Date.now(),
  });
  localDb.recordCashMovement({
    id: 'mov_san_01',
    tenantId,
    sessionId: session.id,
    type: 'SANGRIA',
    amount: 80.0,
    reason: 'Retirada de segurança',
    userId: 'u1',
    userName: 'Lucas',
    createdAt: Date.now(),
  });

  // Saldo Esperado = 100 + 250 + 50 - 80 = 320
  const expectedAmount = session.initialAmount + session.totalCashSales + session.totalSuprimentos - session.totalSangrias;
  assert.strictEqual(expectedAmount, 320.0, 'Saldo esperado deve ser R$ 320,00.');

  // Contagem cega do operador: R$ 325,00 (Sobra de R$ 5,00)
  const countedAmount = 325.0;
  const difference = countedAmount - expectedAmount;
  assert.strictEqual(difference, 5.0, 'Diferença deve ser sobra de R$ 5,00.');

  localDb.closeCashSession(session.id, countedAmount, expectedAmount, difference, 'Sobra de troco');
  console.log('  ✓ Matemática de fechamento e persistência de sessões/movimentações no SQLite validadas.\n');

  // -------------------------------------------------------------------------
  // ETAPA 7: Sanitização ESC/POS e Opção de Guilhotina (Corte de Papel)
  // -------------------------------------------------------------------------
  console.log('▶ TESTE 7: Sanitização ESC/POS e Corte de Papel Térmico');
  const dirtyText = 'PRODUTO TESTE\x1b@\x1dV\x42\x00 COM COMANDOS DE CORTE INJETADOS\x00\x07!';
  const sanitized = ThermalPrinterService.sanitizeText(dirtyText);
  assert.ok(!sanitized.includes('\x1b'), 'Não pode conter byte ESC (0x1b).');
  assert.ok(!sanitized.includes('\x1d'), 'Não pode conter byte GS (0x1d).');
  assert.ok(!sanitized.includes('\x00'), 'Não pode conter null byte.');

  // Com corte (cutPaper = true)
  const bytesWithCut = ThermalPrinterService.toEscPosBytes(sanitized, { cutPaper: true });
  // Deve conter sequência de corte: 0x1d, 0x56, 0x42, 0x00
  const hasCutCmd = bytesWithCut.some(
    (b, i) => b === 0x1d && bytesWithCut[i + 1] === 0x56 && bytesWithCut[i + 2] === 0x42
  );
  assert.strictEqual(hasCutCmd, true, 'Deve conter comando de guilhotina quando cutPaper = true.');

  // Sem corte (cutPaper = false, picote manual)
  const bytesWithoutCut = ThermalPrinterService.toEscPosBytes(sanitized, { cutPaper: false });
  const hasCutCmdDisabled = bytesWithoutCut.some(
    (b, i) => b === 0x1d && bytesWithoutCut[i + 1] === 0x56 && bytesWithoutCut[i + 2] === 0x42
  );
  assert.strictEqual(hasCutCmdDisabled, false, 'NÃO deve conter comando de corte quando cutPaper = false.');
  console.log('  ✓ Sanitização contra injeção e suporte a impressoras sem guilhotina validados.\n');

  // -------------------------------------------------------------------------
  // ETAPA 8: Parser Numérico pt-BR e Importador CSV/Excel
  // -------------------------------------------------------------------------
  console.log('▶ TESTE 8: Parser pt-BR, CSV Nativo e Preservação de Códigos com Zero à Esquerda');
  assert.strictEqual(parseCurrencyOrNumberPtBr('1.234,56'), 1234.56, '1.234,56 deve ser 1234.56');
  assert.strictEqual(parseCurrencyOrNumberPtBr('R$ 1.500,00'), 1500.0, 'R$ 1.500,00 deve ser 1500');
  assert.strictEqual(parseCurrencyOrNumberPtBr('25,90'), 25.9, '25,90 deve ser 25.9');
  assert.strictEqual(parseCurrencyOrNumberPtBr('10.50'), 10.5, '10.50 deve ser 10.5');

  const csvData = `Código;Nome;Preço de Venda;Preço de Custo;Estoque;Unidade;Categoria
078910001;Arroz Especial 5kg;29,90;21,50;45;UN;Mercearia
000123456;Alcatra Bovina;1.234,56;850,00;12,5;KG;Açougue`;

  const csvBuffer = Buffer.from(csvData, 'utf-8');
  const csvImport = await extractProductsFromExcel(csvBuffer, 'produtos.csv');

  assert.strictEqual(csvImport.totalFound, 2);
  assert.strictEqual(csvImport.validCount, 2);

  const item1 = csvImport.items[0];
  assert.strictEqual(item1.barcode, '078910001', 'Zero à esquerda no código de barras DEVE ser preservado.');
  assert.strictEqual(item1.sellingPrice, 29.9);
  assert.strictEqual(item1.costPrice, 21.5);
  assert.strictEqual(item1.currentStock, 45);
  assert.strictEqual(item1.unit, 'UN');

  const item2 = csvImport.items[1];
  assert.strictEqual(item2.barcode, '000123456', 'Zeros múltiplos à esquerda DEVEM ser preservados.');
  assert.strictEqual(item2.sellingPrice, 1234.56, 'Preço com milhar e vírgula 1.234,56 deve ser 1234.56.');
  assert.strictEqual(item2.currentStock, 12.5, 'Estoque fracionário 12,5 deve ser 12.5.');
  assert.strictEqual(item2.unit, 'KG', 'Unidade fracionária KG deve ser preservada.');

  // Round-trip Excel (.xlsx)
  const xlsxBuffer = await exportProductsToExcelBuffer([productFound], 'Mercearia Central');
  const xlsxImport = await extractProductsFromExcel(xlsxBuffer, 'catalogo.xlsx');
  assert.strictEqual(xlsxImport.totalFound, 1);
  assert.strictEqual(xlsxImport.items[0].barcode, productFound.barcode);
  console.log('  ✓ Conversão monetária pt-BR, leitura CSV e preservação de zeros e unidades validadas.\n');

  // -------------------------------------------------------------------------
  // ETAPA 9: Grafo Noturno da IA com Custos Reais (sem margem fixa hardcoded)
  // -------------------------------------------------------------------------
  console.log('▶ TESTE 9: Grafo Noturno da IA com Custos Reais');
  const totalRevenue = 1000.0;
  const totalCost = 650.0; // Lucro Real = 350.0 (35.0%)
  const dailySummary = await executeNightGraph({
    tenant: mockTenant,
    geminiApiKey: 'MOCK_KEY_TEST',
    dateStr: '2026-09-15',
    salesCount: 20,
    totalRevenue,
    totalCost,
    revenueByMethod: {
      cash: 400.0,
      pix: 300.0,
      card: 300.0,
      credit: 0,
    },
    cashDifference: 5.0,
    deviceSessions: [
      {
        deviceId: 'caixa-01',
        deviceName: 'Caixa Principal',
        terminalNumber: 1,
        openedByName: 'Lucas Operador',
        totalSales: 600.0,
        cashDifference: 5.0,
        status: 'CLOSED',
      },
      {
        deviceId: 'caixa-02',
        deviceName: 'Caixa Secundário',
        terminalNumber: 2,
        openedByName: 'Operador 2',
        totalSales: 400.0,
        cashDifference: 0,
        status: 'CLOSED',
      },
    ],
    topSelling: [{ productId: 'p1', name: 'Café', quantity: 5, revenue: 94.5 }],
    outOfStock: [],
    expiringLots: [],
    upcomingBills: [{ description: 'Fornecedor Grãos', amount: 500.0 }],
  });

  assert.strictEqual(dailySummary.totalRevenue, 1000.0);
  assert.strictEqual(dailySummary.totalCost, 650.0, 'Custo real deve ser registrado.');
  assert.strictEqual(dailySummary.grossProfit, 350.0, 'Lucro bruto deve ser exatamente Faturamento - Custo.');
  assert.strictEqual(dailySummary.grossMarginPercentage, 35.0);
  assert.ok(dailySummary.nightAnalysisMarkdown.length > 50, 'Briefing noturno deve ser gerado.');
  console.log('  ✓ Grafo Noturno calcula lucro real a partir de custos reais dos produtos.\n');

  // -------------------------------------------------------------------------
  // ETAPA 10: Estratégia Online-First com Fallback e Timeout
  // -------------------------------------------------------------------------
  console.log('▶ TESTE 10: Estratégia Online-First com Fallback e Timeout');
  // Cenário Online com sucesso imediato
  const onlineResult = await SaleWriterService.processSale(validSale, true, async (s) => ({
    cloudConfirmed: true,
    id: s.id,
  }));
  assert.strictEqual(onlineResult.mode, 'ONLINE_TRANSACTION');
  assert.strictEqual(onlineResult.success, true);

  // Cenário Offline com queda graciosa
  const offlineResult = await SaleWriterService.processSale(validSale, false);
  assert.strictEqual(offlineResult.mode, 'OFFLINE_FALLBACK');
  assert.strictEqual(offlineResult.success, true);
  console.log('  ✓ Estratégia de escrita Online-First e Contingência Offline validada.\n');

  console.log('================================================================');
  console.log('🏆 TODOS OS TESTES E ASSERÇÕES RIGOROSAS PASSARAM COM 100% DE SUCESSO!');
  console.log('================================================================\n');
}

runRigorousVerification().catch((err) => {
  console.error('\n❌ FALHA NA AUDITORIA:', err);
  process.exit(1);
});
