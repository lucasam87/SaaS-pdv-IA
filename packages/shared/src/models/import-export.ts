import { ProductUnit } from './product';

export interface ExtractedProductDraft {
  barcode?: string;
  name: string;
  currentStock: number;
  costPrice: number;
  sellingPrice: number;
  unit: ProductUnit;
  category?: string;
  isValid: boolean;
  warnings?: string[];
}

export interface ImportPreviewResult {
  jobId: string;
  sourceType: 'PDF' | 'EXCEL';
  fileName: string;
  totalFound: number;
  validCount: number;
  warningCount: number;
  items: ExtractedProductDraft[];
  createdAt: number;
}
