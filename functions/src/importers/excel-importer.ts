import ExcelJS from 'exceljs';
import { ExtractedProductDraft, ImportPreviewResult } from '@pdv/shared';

/**
 * Importador de Estoque a partir de Planilha Excel (.xlsx / .csv).
 * Mapeia dinamicamente e com precisão cirúrgica o cabeçalho e dados de produtos.
 */
export async function extractProductsFromExcel(
  fileBuffer: Buffer,
  fileName: string
): Promise<ImportPreviewResult> {
  const workbook = new ExcelJS.Workbook();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await workbook.xlsx.load(fileBuffer as any);

  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new Error('A planilha enviada está vazia ou não possui abas válidas.');
  }

  const items: ExtractedProductDraft[] = [];
  let validCount = 0;
  let warningCount = 0;

  let headerRowNumber = -1;
  let headerMap: { [colIndex: number]: string } = {};

  // Busca a verdadeira linha de cabeçalho (ignorando banners como "RELATÓRIO DE ESTOQUE")
  for (let r = 1; r <= Math.min(worksheet.rowCount, 10); r++) {
    const row = worksheet.getRow(r);
    const tempMap: { [colIndex: number]: string } = {};

    let hasNameOrBarcode = false;
    let hasPriceOrStock = false;

    row.eachCell((cell, colNumber) => {
      const rawVal = String(cell.value ?? cell.text ?? '').toLowerCase().trim();

      // Ignora banners e títulos mesclados
      if (rawVal.includes('relatório') || rawVal.includes('relatorio') || rawVal.includes('sistema')) {
        return;
      }

      if (rawVal.includes('código') || rawVal.includes('codigo') || rawVal.includes('ean') || rawVal.includes('barras')) {
        tempMap[colNumber] = 'barcode';
        hasNameOrBarcode = true;
      } else if (rawVal.includes('nome') || rawVal.includes('descri') || rawVal.includes('produto') || rawVal.includes('item')) {
        tempMap[colNumber] = 'name';
        hasNameOrBarcode = true;
      } else if (rawVal.includes('custo')) {
        tempMap[colNumber] = 'costPrice';
        hasPriceOrStock = true;
      } else if (rawVal.includes('venda') || rawVal.includes('preço') || rawVal.includes('preco') || rawVal.includes('unitário')) {
        tempMap[colNumber] = 'sellingPrice';
        hasPriceOrStock = true;
      } else if (rawVal.includes('estoque') || rawVal.includes('qtd') || rawVal.includes('quant') || rawVal.includes('saldo')) {
        tempMap[colNumber] = 'currentStock';
        hasPriceOrStock = true;
      } else if (rawVal === 'un' || rawVal.includes('unidade')) {
        tempMap[colNumber] = 'unit';
      } else if (rawVal.includes('categoria') || rawVal.includes('grupo')) {
        tempMap[colNumber] = 'category';
      }
    });

    if (hasNameOrBarcode && hasPriceOrStock) {
      headerRowNumber = r;
      headerMap = tempMap;
      break;
    }
  }

  if (headerRowNumber === -1) {
    throw new Error('Não foi possível identificar as colunas de produtos (Nome/Código e Preço/Estoque) na planilha.');
  }

  const parseNumberSafe = (val: unknown): number => {
    if (typeof val === 'number') return val;
    if (!val) return 0;
    const str = String(val).replace(/[^\d.,-]/g, '').replace(',', '.');
    return parseFloat(str) || 0;
  };

  // Itera a partir da linha seguinte ao cabeçalho encontrado
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRowNumber) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rowData: any = {};
    row.eachCell((cell, colNumber) => {
      const field = headerMap[colNumber];
      if (field) {
        rowData[field] = cell.value ?? cell.text;
      }
    });

    if (!rowData.name && !rowData.barcode) return; // Linha vazia

    const warnings: string[] = [];
    const name = String(rowData.name || 'Produto Sem Nome').trim();
    const barcode = rowData.barcode ? String(rowData.barcode).trim() : undefined;
    const currentStock = parseNumberSafe(rowData.currentStock);
    const costPrice = parseNumberSafe(rowData.costPrice);
    const sellingPrice = parseNumberSafe(rowData.sellingPrice);

    if (!barcode) warnings.push('Sem código de barras');
    if (sellingPrice <= 0) warnings.push('Preço de venda zerado');

    const isValid = warnings.length === 0;
    if (isValid) validCount++;
    else warningCount++;

    items.push({
      barcode,
      name,
      currentStock,
      costPrice,
      sellingPrice,
      unit: 'UN',
      category: rowData.category ? String(rowData.category).trim() : 'Geral',
      isValid,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  });

  return {
    jobId: `job_${Date.now()}`,
    sourceType: 'EXCEL',
    fileName,
    totalFound: items.length,
    validCount,
    warningCount,
    items,
    createdAt: Date.now(),
  };
}
