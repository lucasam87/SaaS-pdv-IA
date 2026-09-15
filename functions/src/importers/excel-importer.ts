import ExcelJS from 'exceljs';
import { ExtractedProductDraft, ImportPreviewResult } from '@pdv/shared';

/**
 * Converte strings e valores numéricos em pt-BR (ex: "1.234,56", "R$ 1.500,00", "25,90")
 * para número JavaScript ponto-flutuante com precisão.
 */
export function parseCurrencyOrNumberPtBr(val: unknown): number {
  if (typeof val === 'number') {
    return isNaN(val) ? 0 : val;
  }
  if (!val) return 0;

  let str = String(val).trim();
  // Remove símbolos monetários e caracteres não numéricos exceto . , e -
  str = str.replace(/[^\d.,-]/g, '');
  if (!str) return 0;

  const hasComma = str.includes(',');
  const hasDot = str.includes('.');

  if (hasComma && hasDot) {
    // Padrão brasileiro usual: 1.234,56 -> remove ponto, troca vírgula por ponto
    const lastComma = str.lastIndexOf(',');
    const lastDot = str.lastIndexOf('.');
    if (lastComma > lastDot) {
      // 1.234,56
      str = str.replace(/\./g, '').replace(',', '.');
    } else {
      // Formato americano com vírgula de milhar: 1,234.56
      str = str.replace(/,/g, '');
    }
  } else if (hasComma) {
    // Apenas vírgula: 25,90 -> 25.90
    str = str.replace(',', '.');
  } else if (hasDot) {
    // Apenas ponto: pode ser decimal (10.50) ou milhar inteiro (1.000)
    // Se tiver exatamente 3 dígitos após o ponto no final (ex: 1.000 ou 10.000) e for padrão BR
    if (/^\d{1,3}(\.\d{3})+$/.test(str)) {
      str = str.replace(/\./g, '');
    }
  }

  const result = parseFloat(str);
  return isNaN(result) ? 0 : result;
}

/**
 * Parser de CSV nativo que detecta delimitador (; ou ,) e preserva aspas e quebras de linha.
 */
export function parseCsv(text: string): string[][] {
  // Normaliza quebras de linha
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length === 0) return [];

  // Detecta o separador mais frequente na primeira linha válida
  const headerLine = lines.find((l) => l.trim().length > 0) || '';
  const commaCount = (headerLine.match(/,/g) || []).length;
  const semiCount = (headerLine.match(/;/g) || []).length;
  const delimiter = semiCount >= commaCount ? ';' : ',';

  const rows: string[][] = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    const row: string[] = [];
    let currentCell = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          // Aspas escapadas ""
          currentCell += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === delimiter && !inQuotes) {
        row.push(currentCell.trim());
        currentCell = '';
      } else {
        currentCell += char;
      }
    }
    row.push(currentCell.trim());
    rows.push(row);
  }

  return rows;
}

/**
 * Importador de Estoque a partir de Planilha Excel (.xlsx) ou arquivo (.csv).
 * Mapeia dinamicamente e com precisão cirúrgica o cabeçalho e dados de produtos.
 */
export async function extractProductsFromExcel(
  fileBuffer: Buffer,
  fileName: string
): Promise<ImportPreviewResult> {
  const isCsv = fileName.toLowerCase().endsWith('.csv');

  let rowsData: string[][] = [];

  if (isCsv) {
    const textContent = fileBuffer.toString('utf-8');
    rowsData = parseCsv(textContent);
  } else {
    const workbook = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workbook.xlsx.load(fileBuffer as any);

    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      throw new Error('A planilha enviada está vazia ou não possui abas válidas.');
    }

    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const rowArr: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        let val = cell.value;
        if (typeof val === 'object' && val !== null && 'text' in val) {
          val = (val as any).text;
        }
        rowArr.push(val !== undefined && val !== null ? String(val) : '');
      });
      rowsData.push(rowArr);
    });
  }

  if (rowsData.length === 0) {
    throw new Error('O arquivo enviado está vazio.');
  }

  let headerRowIndex = -1;
  const headerMap: { [colIndex: number]: string } = {};

  // Localiza a linha de cabeçalho
  for (let r = 0; r < Math.min(rowsData.length, 10); r++) {
    const row = rowsData[r];
    const tempMap: { [colIndex: number]: string } = {};
    let hasNameOrBarcode = false;
    let hasPriceOrStock = false;

    row.forEach((cellText, colIndex) => {
      const rawVal = cellText.toLowerCase().trim();

      if (rawVal.includes('relatório') || rawVal.includes('relatorio') || rawVal.includes('sistema')) {
        return;
      }

      if (rawVal.includes('código') || rawVal.includes('codigo') || rawVal.includes('ean') || rawVal.includes('barras')) {
        tempMap[colIndex] = 'barcode';
        hasNameOrBarcode = true;
      } else if (rawVal.includes('nome') || rawVal.includes('descri') || rawVal.includes('produto') || rawVal.includes('item')) {
        tempMap[colIndex] = 'name';
        hasNameOrBarcode = true;
      } else if (rawVal.includes('custo')) {
        tempMap[colIndex] = 'costPrice';
        hasPriceOrStock = true;
      } else if (rawVal.includes('venda') || rawVal.includes('preço') || rawVal.includes('preco') || rawVal.includes('unitário')) {
        tempMap[colIndex] = 'sellingPrice';
        hasPriceOrStock = true;
      } else if (rawVal.includes('estoque') || rawVal.includes('qtd') || rawVal.includes('quant') || rawVal.includes('saldo')) {
        tempMap[colIndex] = 'currentStock';
        hasPriceOrStock = true;
      } else if (rawVal === 'un' || rawVal.includes('unidade') || rawVal.includes('medida')) {
        tempMap[colIndex] = 'unit';
      } else if (rawVal.includes('categoria') || rawVal.includes('grupo')) {
        tempMap[colIndex] = 'category';
      }
    });

    if (hasNameOrBarcode && hasPriceOrStock) {
      headerRowIndex = r;
      Object.assign(headerMap, tempMap);
      break;
    }
  }

  if (headerRowIndex === -1) {
    throw new Error('Não foi possível identificar as colunas de produtos (Nome/Código e Preço/Estoque) na planilha.');
  }

  const items: ExtractedProductDraft[] = [];
  let validCount = 0;
  let warningCount = 0;

  for (let r = headerRowIndex + 1; r < rowsData.length; r++) {
    const row = rowsData[r];
    const rowData: Record<string, string> = {};

    row.forEach((cellText, colIndex) => {
      const field = headerMap[colIndex];
      if (field) {
        rowData[field] = cellText;
      }
    });

    if (!rowData.name && !rowData.barcode) continue;

    const warnings: string[] = [];
    const name = (rowData.name || 'Produto Sem Nome').trim();
    // Preserva zeros à esquerda em códigos de barras
    const barcode = rowData.barcode ? rowData.barcode.trim() : undefined;
    const currentStock = parseCurrencyOrNumberPtBr(rowData.currentStock);
    const costPrice = parseCurrencyOrNumberPtBr(rowData.costPrice);
    const sellingPrice = parseCurrencyOrNumberPtBr(rowData.sellingPrice);

    // Unidade de medida extraída ou padrão UN (suporta KG, L, etc.)
    const validUnits = new Set(['UN', 'KG', 'CX', 'PCT', 'L', 'M']);
    const rawUnit = rowData.unit ? rowData.unit.trim().toUpperCase() : 'UN';
    const unit = (validUnits.has(rawUnit) ? rawUnit : 'UN') as import('@pdv/shared').ProductUnit;

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
      unit,
      category: rowData.category ? rowData.category.trim() : 'Geral',
      isValid,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  }

  return {
    jobId: `job_${Date.now()}`,
    sourceType: isCsv ? 'EXCEL' : 'EXCEL',
    fileName,
    totalFound: items.length,
    validCount,
    warningCount,
    items,
    createdAt: Date.now(),
  };
}
