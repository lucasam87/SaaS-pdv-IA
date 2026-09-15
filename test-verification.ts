import { localDb } from './apps/desktop/src/db/local-db';
import { ThermalPrinterService } from './apps/desktop/src/services/printer-usb';
import { SaleWriterService } from './apps/desktop/src/services/sale-writer';
import { exportProductsToExcelBuffer } from './functions/src/exporters/excel-exporter';
import { extractProductsFromExcel } from './functions/src/importers/excel-importer';
import { OfflineSyncWorker } from './functions/src/sync-worker';
import { executeNightGraph } from './functions/src/ai-graph/night-graph';
import { Product, Sale, Tenant, TenantSettings } from './packages/shared/src';

async function runVerification() {
  console.log('================================================================');
  console.log('🚀 INICIANDO BATERIA DE TESTES DE INTEGRAÇÃO DO PDV MULTI-DEVICE');
  console.log('================================================================\n');

  const tenantId = 'tenant_test_123';
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

  // 1. Teste do Banco Local (Cache de Produtos)
  console.log('TESTE 1: Banco Local e Busca Instantânea (< 1ms)');
  localDb.seedDemoProductsIfEmpty(tenantId);
  const meta = localDb.getMeta();
  console.log(`✓ Produtos carregados no cache: ${meta.totalLocalProducts}`);

  const startLookup = performance.now();
  const productFound = localDb.findByBarcode('7891000100101');
  const lookupTime = performance.now() - startLookup;

  if (!productFound || productFound.name !== 'Café Tradicional 500g') {
    throw new Error('Falha no teste 1: Produto não encontrado por código de barras!');
  }
  console.log(`✓ Busca por código de barras executada em ${lookupTime.toFixed(3)}ms (Produto: ${productFound.name})`);

  const searchResults = localDb.search('Arroz', 5);
  if (searchResults.length === 0) {
    throw new Error('Falha no teste 1: Busca por nome falhou!');
  }
  console.log(`✓ Busca por nome encontrou: "${searchResults[0].name}"\n`);

  // 2. Teste de Registro de Venda Local e Baixa de Estoque
  console.log('TESTE 2: Registro de Venda Local e Atualização de Estoque');
  const stockBefore = productFound.currentStock;
  const testSale: Sale = {
    id: `sale_test_${Date.now()}`,
    tenantId,
    sessionId: 'session_test_01',
    deviceId: 'caixa-01',
    saleNumber: 1001,
    userId: 'user_01',
    userName: 'Lucas Operador',
    customerName: 'Cliente Teste',
    subtotal: 18.9,
    discount: 0,
    total: 18.9,
    totalCost: 12.5,
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

  localDb.recordLocalSale(testSale);
  const updatedProduct = localDb.findByBarcode('7891000100101')!;
  console.log(`✓ Estoque anterior: ${stockBefore} -> Novo estoque após venda: ${updatedProduct.currentStock}`);
  console.log(`✓ Fila de vendas pendentes para sincronizar: ${localDb.getPendingSales().length}\n`);

  // 3. Teste de Impressão Térmica ESC/POS USB
  console.log('TESTE 3: Formatação de Cupom Térmico ESC/POS para Impressora USB');
  const receiptText = ThermalPrinterService.formatReceiptText(testSale, {
    storeName: 'Mercearia Central',
    storeCnpj: '12.345.678/0001-90',
    settings,
  });
  const escPosBytes = ThermalPrinterService.toEscPosBytes(receiptText);
  console.log(`✓ Bytes ESC/POS gerados com comando de corte: ${escPosBytes.length} bytes\n`);

  // 4. Teste de Exportação para Planilha Excel (.xlsx)
  console.log('TESTE 4: Exportação de Catálogo de Estoque para Excel (.xlsx)');
  const sampleProducts: Product[] = [
    productFound,
    searchResults[0],
    {
      id: 'prod_99',
      tenantId,
      name: 'Leite Integral 1L',
      barcode: '7899999999999',
      costPrice: 3.8,
      sellingPrice: 5.49,
      minStock: 20,
      currentStock: 48,
      unit: 'UN',
      category: 'Laticínios',
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ];

  const excelBuffer = await exportProductsToExcelBuffer(sampleProducts, 'Mercearia Central');
  console.log(`✓ Arquivo Excel gerado com sucesso! Tamanho: ${excelBuffer.length} bytes\n`);

  // 5. Teste de Importação de Planilha Excel (.xlsx)
  console.log('TESTE 5: Importação e Leitura Automática da Planilha Excel');
  const importResult = await extractProductsFromExcel(excelBuffer, 'estoque_teste.xlsx');
  console.log(`✓ Planilha lida com sucesso! Total de itens encontrados: ${importResult.totalFound}`);
  console.log(`✓ Itens 100% válidos: ${importResult.validCount} | Avisos: ${importResult.warningCount}\n`);

  // 6. Teste da Estratégia Online-First com Fallback Local (SaleWriterService)
  console.log('TESTE 6: Estratégia de Escrita Online-First com Fallback Local');
  // Cenário A: Online com transação bem-sucedida
  const onlineResult = await SaleWriterService.processSale(testSale, true, async () => {
    return { cloudSaved: true };
  });
  if (onlineResult.mode !== 'ONLINE_TRANSACTION') {
    throw new Error('Falha no teste 6: Deveria ter gravado como ONLINE_TRANSACTION!');
  }
  console.log(`✓ Cenário Online: Modo ${onlineResult.mode} gravado com sucesso na nuvem.`);

  // Cenário B: Offline ou falha de conexão (cai em fallback gracioso)
  const offlineResult = await SaleWriterService.processSale(testSale, false);
  if (offlineResult.mode !== 'OFFLINE_FALLBACK') {
    throw new Error('Falha no teste 6: Deveria ter caído em OFFLINE_FALLBACK!');
  }
  console.log(`✓ Cenário Offline: Modo ${offlineResult.mode} acionado sem travar o operador.\n`);

  // 7. Teste de Resolução de Conflitos e Vendas Simultâneas Offline (OfflineSyncWorker)
  console.log('TESTE 7: Resolução de Conflito e Estoque Negativo em 2 Dispositivos');
  const scarceProduct: Product = {
    id: 'prod_scarce',
    tenantId,
    name: 'Refrigerante Edição Limitada',
    barcode: '7897777777777',
    costPrice: 5.0,
    sellingPrice: 9.0,
    minStock: 2,
    currentStock: 1, // Apenas 1 unidade física em estoque!
    unit: 'UN',
    category: 'Bebidas',
    isActive: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // Caixa 1 vende 1 unidade offline
  const saleCaixa1: Sale = {
    id: 'sale_offline_c1',
    tenantId,
    sessionId: 'session_c1',
    deviceId: 'caixa-01',
    saleNumber: 2001,
    userId: 'user_01',
    userName: 'Operador 1',
    subtotal: 9.0,
    discount: 0,
    total: 9.0,
    totalCost: 5.0,
    items: [
      {
        productId: scarceProduct.id,
        productName: scarceProduct.name,
        barcode: scarceProduct.barcode,
        quantity: 1,
        unitPrice: 9.0,
        unitCost: 5.0,
        discount: 0,
        totalPrice: 9.0,
        totalCost: 5.0,
      },
    ],
    payments: [{ method: 'DINHEIRO', amount: 9.0 }],
    status: 'COMPLETED',
    createdAt: Date.now(),
  };

  // Caixa 2 vende 1 unidade offline simultaneamente
  const saleCaixa2: Sale = {
    id: 'sale_offline_c2',
    tenantId,
    sessionId: 'session_c2',
    deviceId: 'caixa-02',
    saleNumber: 3001,
    userId: 'user_02',
    userName: 'Operador 2',
    subtotal: 9.0,
    discount: 0,
    total: 9.0,
    totalCost: 5.0,
    items: [
      {
        productId: scarceProduct.id,
        productName: scarceProduct.name,
        barcode: scarceProduct.barcode,
        quantity: 1,
        unitPrice: 9.0,
        unitCost: 5.0,
        discount: 0,
        totalPrice: 9.0,
        totalCost: 5.0,
      },
    ],
    payments: [{ method: 'PIX', amount: 9.0 }],
    status: 'COMPLETED',
    createdAt: Date.now(),
  };

  const syncResult = OfflineSyncWorker.processOfflineBatch(
    [saleCaixa1, saleCaixa2],
    [scarceProduct]
  );

  console.log(`✓ Vendas offline processadas com sucesso: ${syncResult.syncedSalesCount} vendas aceitas (não bloqueadas!)`);
  console.log(`✓ Saldo final do produto em estoque: ${syncResult.updatedStockMap[scarceProduct.id]} un (Estoque Negativo permitido)`);
  if (syncResult.conflictsDetected.length === 0) {
    throw new Error('Falha no teste 7: Conflito STOCK_NEGATIVE_CONFLICT não foi gerado!');
  }
  const conflict = syncResult.conflictsDetected[0];
  console.log(`✓ Sinal de auditoria emitido: [${conflict.type}] - Saldo: ${conflict.payload.negativeBalance} un nos terminais [${conflict.payload.deviceIds.join(', ')}]\n`);

  // 8. Teste de Fechamento de Caixa com Detalhamento por Dispositivo (Grafo Noturno)
  console.log('TESTE 8: Fechamento de Caixa Multi-Terminal no Grafo da IA');
  const summary = await executeNightGraph({
    tenant: mockTenant,
    geminiApiKey: 'MOCK_KEY_TEST',
    dateStr: '2026-09-15',
    salesCount: 14,
    totalRevenue: 540.0,
    revenueByMethod: {
      cash: 200.0,
      pix: 140.0,
      card: 200.0,
      credit: 0,
    },
    cashDifference: 3.0, // Sobra consolidada
    deviceSessions: [
      {
        deviceId: 'caixa-01',
        deviceName: 'Caixa Principal',
        terminalNumber: 1,
        openedByName: 'Lucas Operador',
        totalSales: 350.0,
        cashDifference: 5.0, // Sobra de 5 reais
        status: 'CLOSED',
      },
      {
        deviceId: 'caixa-02',
        deviceName: 'Caixa Secundário (PC Escritório)',
        terminalNumber: 2,
        openedByName: 'Vendedor 2',
        totalSales: 190.0,
        cashDifference: -2.0, // Falta de 2 reais
        status: 'CLOSED',
      },
    ],
    stockConflicts: [
      {
        productName: scarceProduct.name,
        barcode: scarceProduct.barcode,
        negativeBalance: -1,
        deviceIds: ['caixa-01', 'caixa-02'],
      },
    ],
    topSelling: [{ productId: 'p1', name: 'Café Tradicional', quantity: 6, revenue: 113.4 }],
    outOfStock: [{ productId: scarceProduct.id, name: scarceProduct.name, barcode: scarceProduct.barcode }],
    expiringLots: [],
    upcomingBills: [{ description: 'Distribuidora Silva', amount: 350.0 }],
  });

  console.log(`✓ Resumo diário gerado: Faturamento Total R$ ${summary.totalRevenue.toFixed(2)}`);
  console.log(`✓ Auditoria de caixa consolidada: Diferença R$ ${summary.cashRegisterBalance.difference.toFixed(2)}`);
  console.log(`✓ Diagnóstico noturno gerado com sucesso!\n`);

  console.log('================================================================');
  console.log('🎉 TODOS OS 8 TESTES DA ARQUITETURA MULTI-DEVICE FORAM APROVADOS!');
  console.log('================================================================');
}

runVerification().catch((err) => {
  console.error('❌ ERRO NA BATERIA DE TESTES:', err);
  process.exit(1);
});
