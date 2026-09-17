import React, { useState, useEffect, useRef } from 'react';
import { X, Sparkles, AlertCircle, Save, Package, Barcode, Layers, Hash } from 'lucide-react';
import { Product, ProductUnit } from '@pdv/shared';

export type ProductFormInput = Omit<Product, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };

interface ProductFormModalProps {
  isOpen: boolean;
  productToEdit?: Product | null;
  existingCategories: string[];
  tenantId: string;
  onSave: (product: ProductFormInput) => Promise<void>;
  onClose: () => void;
}

const UNITS: { value: ProductUnit; label: string }[] = [
  { value: 'UN', label: 'Unidade (UN)' },
  { value: 'KG', label: 'Quilograma (KG)' },
  { value: 'CX', label: 'Caixa (CX)' },
  { value: 'PCT', label: 'Pacote (PCT)' },
  { value: 'L', label: 'Litro (L)' },
  { value: 'M', label: 'Metro (M)' },
];

export const ProductFormModal: React.FC<ProductFormModalProps> = ({
  isOpen,
  productToEdit,
  existingCategories,
  tenantId,
  onSave,
  onClose,
}) => {
  const [name, setName] = useState('');
  const [barcode, setBarcode] = useState('');
  const [category, setCategory] = useState('');
  const [unit, setUnit] = useState<ProductUnit>('UN');
  const [costPriceStr, setCostPriceStr] = useState('0.00');
  const [sellingPriceStr, setSellingPriceStr] = useState('0.00');
  const [currentStockStr, setCurrentStockStr] = useState('0');
  const [minStockStr, setMinStockStr] = useState('5');
  const [ncm, setNcm] = useState('');
  const [isActive, setIsActive] = useState(true);

  const [isSaving, setIsSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const prevIsOpenRef = useRef(false);
  const prevEditIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const justOpened = isOpen && !prevIsOpenRef.current;
    const changedProduct = isOpen && productToEdit?.id !== prevEditIdRef.current;

    if (justOpened || changedProduct) {
      if (productToEdit) {
        setName(productToEdit.name);
        setBarcode(productToEdit.barcode);
        setCategory(productToEdit.category || '');
        setUnit(productToEdit.unit || 'UN');
        setCostPriceStr(productToEdit.costPrice.toFixed(2));
        setSellingPriceStr(productToEdit.sellingPrice.toFixed(2));
        setCurrentStockStr(String(productToEdit.currentStock));
        setMinStockStr(String(productToEdit.minStock));
        setNcm(productToEdit.ncm || '');
        setIsActive(productToEdit.isActive !== false);
      } else {
        setName('');
        setBarcode('');
        setCategory(existingCategories.length > 0 ? existingCategories[0] : 'Geral');
        setUnit('UN');
        setCostPriceStr('0.00');
        setSellingPriceStr('0.00');
        setCurrentStockStr('10');
        setMinStockStr('5');
        setNcm('');
        setIsActive(true);
      }
      setErrorMsg(null);
    }

    prevIsOpenRef.current = isOpen;
    prevEditIdRef.current = productToEdit?.id;
  }, [isOpen, productToEdit?.id]);

  // Fechar com ESC
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSaving) {
        onClose();
      }
    };
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSaving, onClose]);

  if (!isOpen) return null;

  const costPrice = parseFloat(costPriceStr.replace(',', '.')) || 0;
  const sellingPrice = parseFloat(sellingPriceStr.replace(',', '.')) || 0;

  // Cálculo da Margem Bruta
  const profit = sellingPrice - costPrice;
  const grossMargin = sellingPrice > 0 ? (profit / sellingPrice) * 100 : 0;
  const markup = costPrice > 0 ? (profit / costPrice) * 100 : 0;

  // Gerador de Código de Barras EAN-13 Interno
  const generateInternalBarcode = () => {
    // Prefixo 200 (reservado para uso interno em lojas) + 9 dígitos aleatórios
    const prefix = '200';
    let code = prefix;
    for (let i = 0; i < 9; i++) {
      code += Math.floor(Math.random() * 10);
    }
    // Dígito verificador EAN-13
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      sum += parseInt(code[i], 10) * (i % 2 === 0 ? 1 : 3);
    }
    const checkDigit = (10 - (sum % 10)) % 10;
    setBarcode(`${code}${checkDigit}`);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const trimmedName = name.trim();
    const trimmedBarcode = barcode.trim();

    if (!trimmedName) {
      setErrorMsg('O nome do produto é obrigatório.');
      return;
    }

    if (!trimmedBarcode) {
      setErrorMsg('O código de barras é obrigatório.');
      return;
    }

    if (/[\x00-\x1F\x7F]/.test(trimmedBarcode)) {
      setErrorMsg('Código de barras contém caracteres inválidos.');
      return;
    }

    const parsedCost = parseFloat(costPriceStr.replace(',', '.'));
    const parsedSelling = parseFloat(sellingPriceStr.replace(',', '.'));
    const parsedStock = parseFloat(currentStockStr.replace(',', '.'));
    const parsedMinStock = parseFloat(minStockStr.replace(',', '.'));

    if (isNaN(parsedCost) || !isFinite(parsedCost) || parsedCost < 0) {
      setErrorMsg('Preço de custo inválido. Deve ser um número maior ou igual a zero.');
      return;
    }

    if (isNaN(parsedSelling) || !isFinite(parsedSelling) || parsedSelling <= 0) {
      setErrorMsg('Preço de venda inválido. Deve ser um número maior que zero.');
      return;
    }

    if (isNaN(parsedStock) || !isFinite(parsedStock)) {
      setErrorMsg('Estoque atual inválido. Deve ser um número válido.');
      return;
    }

    if (isNaN(parsedMinStock) || !isFinite(parsedMinStock) || parsedMinStock < 0) {
      setErrorMsg('Estoque mínimo inválido. Não pode ser negativo.');
      return;
    }

    if (ncm.trim()) {
      const clean = ncm.trim().replace(/[\.\s]/g, '');
      if (!/^\d{2,8}$/.test(clean)) {
        setErrorMsg('NCM inválido. Deve conter entre 2 e 8 dígitos numéricos.');
        return;
      }
    }

    setIsSaving(true);
    try {
      await onSave({
        id: productToEdit?.id,
        tenantId,
        name: trimmedName,
        barcode: trimmedBarcode,
        costPrice: parsedCost,
        sellingPrice: parsedSelling,
        currentStock: parsedStock,
        minStock: parsedMinStock,
        unit,
        category: category.trim() || 'Geral',
        ncm: ncm.trim() || undefined,
        isActive,
      });
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Erro ao salvar produto.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-950/85 backdrop-blur-md flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-slate-900 border-2 border-slate-700 w-full max-w-2xl rounded-3xl shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-150 my-auto">
        {/* Topo do Modal */}
        <div className="bg-slate-800/90 px-6 py-4 border-b border-slate-700/80 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-emerald-600/20 p-2 rounded-xl border border-emerald-500/30 text-emerald-400">
              <Package className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-100">
                {productToEdit ? 'Editar Produto' : 'Cadastrar Novo Produto'}
              </h2>
              <p className="text-xs text-slate-400 font-medium">
                {productToEdit ? `Código: ${productToEdit.barcode}` : 'Preencha os dados cadastrais e fiscais'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={isSaving}
            className="p-1 rounded-lg bg-slate-700/50 hover:bg-slate-700 text-slate-400 hover:text-slate-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Formulário */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {errorMsg && (
            <div className="p-3 bg-rose-950/70 border border-rose-500/60 rounded-xl text-rose-300 text-xs flex items-start gap-2.5 animate-in fade-in">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span className="font-semibold">{errorMsg}</span>
            </div>
          )}

          {/* Linha 1: Nome do Produto */}
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
              Nome do Produto / Descrição <span className="text-emerald-400">*</span>
            </label>
            <input
              type="text"
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex: Arroz Tipo 1 Camil 5kg"
              className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-slate-100 text-sm focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors"
            />
          </div>

          {/* Linha 2: Código de Barras + Botão Gerar */}
          <div className="grid grid-cols-12 gap-3">
            <div className="col-span-8">
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                Código de Barras (EAN-13) <span className="text-emerald-400">*</span>
              </label>
              <div className="relative">
                <Barcode className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                <input
                  type="text"
                  required
                  value={barcode}
                  onChange={(e) => setBarcode(e.target.value)}
                  placeholder="Ex: 7891234567890"
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl pl-10 pr-4 py-2.5 text-slate-100 text-sm font-mono focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors"
                />
              </div>
            </div>
            <div className="col-span-4 flex items-end">
              <button
                type="button"
                onClick={generateInternalBarcode}
                title="Gera um código EAN padrão interno 200..."
                className="w-full bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-slate-100 border border-slate-700 font-semibold text-xs py-2.5 px-3 rounded-xl flex items-center justify-center gap-1.5 transition-colors"
              >
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                <span>Gerar Interno</span>
              </button>
            </div>
          </div>

          {/* Linha 3: Categoria e Unidade */}
          <div className="grid grid-cols-12 gap-3">
            <div className="col-span-7">
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                Categoria
              </label>
              <div className="relative">
                <Layers className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                <input
                  type="text"
                  list="category-options"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="Ex: Mercearia, Bebidas..."
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl pl-10 pr-4 py-2.5 text-slate-100 text-sm focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors"
                />
                <datalist id="category-options">
                  {existingCategories.map((cat) => (
                    <option key={cat} value={cat} />
                  ))}
                </datalist>
              </div>
            </div>
            <div className="col-span-5">
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                Unidade de Medida
              </label>
              <select
                value={unit}
                onChange={(e) => setUnit(e.target.value as ProductUnit)}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-slate-100 text-sm focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors"
              >
                {UNITS.map((u) => (
                  <option key={u.value} value={u.value}>
                    {u.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Linha 4: Preço de Custo, Preço de Venda e Margem */}
          <div className="bg-slate-950/70 p-4 rounded-2xl border border-slate-800 space-y-3">
            <div className="grid grid-cols-12 gap-3">
              <div className="col-span-6">
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
                  Preço de Custo (R$)
                </label>
                <div className="relative">
                  <span className="text-slate-500 text-xs font-bold absolute left-3.5 top-3">R$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={costPriceStr}
                    onChange={(e) => setCostPriceStr(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 rounded-xl pl-10 pr-3 py-2 text-slate-100 font-mono text-sm focus:outline-none focus:border-emerald-500 transition-colors"
                  />
                </div>
              </div>

              <div className="col-span-6">
                <label className="block text-xs font-semibold text-emerald-400 uppercase tracking-wider mb-1">
                  Preço de Venda (R$) <span className="text-emerald-400">*</span>
                </label>
                <div className="relative">
                  <span className="text-emerald-400 text-xs font-bold absolute left-3.5 top-3">R$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    value={sellingPriceStr}
                    onChange={(e) => setSellingPriceStr(e.target.value)}
                    className="w-full bg-slate-900 border border-emerald-500/50 rounded-xl pl-10 pr-3 py-2 text-emerald-300 font-mono text-sm font-bold focus:outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400 transition-colors"
                  />
                </div>
              </div>
            </div>

            {/* Painel Informativo de Margem e Lucro */}
            <div className="flex items-center justify-between pt-2 border-t border-slate-800 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-slate-400">Lucro Unitário:</span>
                <span className={`font-mono font-bold ${profit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  R$ {profit.toFixed(2)}
                </span>
              </div>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-400">Markup:</span>
                  <span className="font-mono text-slate-200">{markup.toFixed(1)}%</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-400">Margem Bruta:</span>
                  <span
                    className={`font-mono font-bold px-2 py-0.5 rounded ${
                      grossMargin >= 30
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                        : grossMargin >= 10
                        ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                        : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                    }`}
                  >
                    {grossMargin.toFixed(1)}%
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Linha 5: Estoque e NCM */}
          <div className="grid grid-cols-12 gap-3">
            <div className="col-span-4">
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                Estoque Atual
              </label>
              <input
                type="number"
                step="any"
                value={currentStockStr}
                onChange={(e) => setCurrentStockStr(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-slate-100 font-mono text-sm focus:outline-none focus:border-emerald-500 transition-colors"
              />
            </div>

            <div className="col-span-4">
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                Estoque Mínimo
              </label>
              <input
                type="number"
                step="any"
                value={minStockStr}
                onChange={(e) => setMinStockStr(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-slate-100 font-mono text-sm focus:outline-none focus:border-emerald-500 transition-colors"
              />
            </div>

            <div className="col-span-4">
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                NCM (Fiscal)
              </label>
              <div className="relative">
                <Hash className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-3" />
                <input
                  type="text"
                  value={ncm}
                  onChange={(e) => setNcm(e.target.value)}
                  placeholder="Ex: 8471.90"
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl pl-9 pr-3 py-2 text-slate-100 font-mono text-sm focus:outline-none focus:border-emerald-500 transition-colors"
                />
              </div>
            </div>
          </div>

          {/* Status Ativo */}
          <div className="pt-2 flex items-center justify-between">
            <label className="flex items-center gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 bg-slate-950 border-slate-700"
              />
              <span className="text-xs font-medium text-slate-300">
                Produto ativo para venda no caixa PDV
              </span>
            </label>
          </div>

          {/* Botões do Rodapé */}
          <div className="pt-4 border-t border-slate-800 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isSaving}
              className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-xl transition-colors"
            >
              Cancelar (ESC)
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="px-5 py-2 text-xs font-bold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-xl flex items-center gap-2 transition-colors disabled:opacity-50 shadow-lg shadow-emerald-500/20"
            >
              {isSaving ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-slate-950 border-t-transparent rounded-full animate-spin" />
                  <span>Salvando...</span>
                </>
              ) : (
                <>
                  <Save className="w-4 h-4" />
                  <span>Salvar Produto</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
