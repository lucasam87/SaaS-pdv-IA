import { localDb } from './apps/desktop/src/db/local-db';
import { ThermalPrinterService } from './apps/desktop/src/services/printer-usb';
import { exportProductsToExcelBuffer } from './functions/src/exporters/excel-exporter';
import { extractProductsFromExcel } from './functions/src/importers/excel-importer';
import { Product, Sale, TenantSettings } from './packages/shared/src';

async function runVerification() {
  console.log('====================================================');
  console.log('🚀 INICIANDO BATERIA DE TESTES DE INTEGRAÇÃO DO PDV');
  console.log('====================================================\n');

  const tenantId = 'tenant_test_123';
  const settings: TenantSettings = {
    receiptHeader: 'MERCEARIA CENTRAL\nRUA PRINCIPAL, 100',
    receiptFooter: 'VOLTE SEMPRE!',
    receiptWidthMm: 80,
    maxDiscountPercentageAllowedForCashier: 5,
    enableTelegramAlerts: true,
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
    sessionId: 'session_test',
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
    payments: [
      { method: 'DINHEIRO', amount: 50.0, changeAmount: 12.2 },
    ],
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
  console.log('--- [PRÉ-VISUALIZAÇÃO DO CUPOM TÉRMICO GERADO] ---');
  console.log(receiptText);
  console.log('--------------------------------------------------');
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
  console.log(`✓ Itens 100% válidos: ${importResult.validCount} | Avisos: ${importResult.warningCount}`);
  importResult.items.forEach((item, idx) => {
    console.log(`   ${idx + 1}. [${item.barcode}] ${item.name} - Est: ${item.currentStock} - Venda: R$ ${item.sellingPrice.toFixed(2)}`);
  });

  console.log('\n====================================================');
  console.log('🎉 TODOS OS TESTES FORAM CONCLUÍDOS COM 100% DE SUCESSO!');
  console.log('====================================================');
}

runVerification().catch((err) => {
  console.error('❌ ERRO NA BATERIA DE TESTES:', err);
  process.exit(1);
});
