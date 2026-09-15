import ExcelJS from 'exceljs';
import { Product } from '@pdv/shared';

/**
 * Exporta o catálogo completo de produtos em uma planilha Excel estilizada.
 */
export async function exportProductsToExcelBuffer(
  products: Product[],
  storeName: string
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'PDV Inteligente';
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet('Estoque de Produtos');

  // Cabeçalho da Loja
  worksheet.mergeCells('A1:G1');
  const titleCell = worksheet.getCell('A1');
  titleCell.value = `RELATÓRIO DE ESTOQUE — ${storeName.toUpperCase()}`;
  titleCell.font = { name: 'Arial', size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
  titleCell.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF15803D' }, // Verde Emerald escuro
  };
  titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  worksheet.getRow(1).height = 30;

  // Linha de Cabeçalho da Tabela
  const headers = [
    'Código de Barras (EAN)',
    'Nome do Produto',
    'Categoria',
    'Unidade',
    'Estoque Atual',
    'Preço de Custo (R$)',
    'Preço de Venda (R$)',
  ];
  worksheet.getRow(2).values = headers;
  const headerRow = worksheet.getRow(2);
  headerRow.height = 24;
  headerRow.eachCell((cell) => {
    cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1F2937' }, // Slate escuro
    };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' },
    };
  });

  // Linhas de Dados
  products.forEach((p, index) => {
    const row = worksheet.addRow([
      p.barcode,
      p.name,
      p.category || 'Geral',
      p.unit,
      p.currentStock,
      p.costPrice,
      p.sellingPrice,
    ]);

    row.height = 20;

    // Formatação de Moeda
    row.getCell(5).numFmt = '#,##0.00';
    row.getCell(6).numFmt = 'R$ #,##0.00';
    row.getCell(7).numFmt = 'R$ #,##0.00';

    // Zebra striping
    if (index % 2 === 0) {
      row.eachCell((cell) => {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF9FAFB' },
        };
      });
    }

    row.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        right: { style: 'thin', color: { argb: 'FFE5E7EB' } },
      };
    });
  });

  // Ajuste automático da largura das colunas
  worksheet.columns.forEach((column) => {
    let maxLength = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    column.eachCell?.({ includeEmpty: true }, (cell: any) => {
      const colLength = cell.value ? cell.value.toString().length : 10;
      if (colLength > maxLength) {
        maxLength = colLength;
      }
    });
    column.width = Math.min(Math.max(maxLength + 3, 12), 40);
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
