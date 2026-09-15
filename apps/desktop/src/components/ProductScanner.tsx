import React, { useState, useRef, useEffect } from 'react';
import { Barcode, AlertCircle } from 'lucide-react';
import { Product } from '@pdv/shared';
import { localDb } from '../db/local-db';

interface ProductScannerProps {
  onAddProduct: (product: Product, quantity: number) => void;
  disabled?: boolean;
}

export const ProductScanner: React.FC<ProductScannerProps> = ({ onAddProduct, disabled }) => {
  const [inputValue, setInputValue] = useState('');
  const [searchResults, setSearchResults] = useState<Product[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Mantém o foco sempre no input para que o leitor USB funcione sem precisar clicar
  useEffect(() => {
    const focusInput = () => {
      if (!disabled && inputRef.current) {
        inputRef.current.focus();
      }
    };
    focusInput();
    const interval = setInterval(focusInput, 3000);
    return () => clearInterval(interval);
  }, [disabled]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setInputValue(val);
    setErrorMessage(null);

    // Se tiver mais de 2 caracteres e não for só número de código de barras, busca por nome
    if (val.trim().length >= 2 && isNaN(Number(val))) {
      const results = localDb.search(val, 6);
      setSearchResults(results);
      setSelectedIndex(0);
    } else {
      setSearchResults([]);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev: number) => (prev < searchResults.length - 1 ? prev + 1 : prev));
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev: number) => (prev > 0 ? prev - 1 : 0));
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      processInput();
    }
  };

  const processInput = () => {
    const raw = inputValue.trim();
    if (!raw) return;

    // Se tiver resultados da busca por nome e o usuário der Enter
    if (searchResults.length > 0 && selectedIndex >= 0 && selectedIndex < searchResults.length) {
      const selected = searchResults[selectedIndex];
      onAddProduct(selected, 1);
      resetInput();
      return;
    }

    // Suporte para multiplicador: ex "3*7891000100101"
    let qty = 1;
    let barcode = raw;

    if (raw.includes('*')) {
      const parts = raw.split('*');
      const parsedQty = parseFloat(parts[0]);
      if (!isNaN(parsedQty) && parsedQty > 0) {
        qty = parsedQty;
        barcode = parts[1].trim();
      }
    }

    // Busca instantânea no SQLite Local (< 1ms)
    const product = localDb.findByBarcode(barcode);

    if (product) {
      onAddProduct(product, qty);
      resetInput();
    } else {
      setErrorMessage(`Produto não encontrado com o código: ${barcode}`);
      setTimeout(() => setErrorMessage(null), 3500);
    }
  };

  const resetInput = () => {
    setInputValue('');
    setSearchResults([]);
    setErrorMessage(null);
  };

  return (
    <div className="relative w-full">
      <div className="relative flex items-center">
        <div className="absolute left-4 pointer-events-none text-slate-400">
          <Barcode className="w-6 h-6 text-emerald-400" />
        </div>

        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={
            disabled
              ? 'Abra o caixa para começar a vender...'
              : 'Bipe o código de barras ou digite o nome (ex: 2*789...)'
          }
          className="w-full bg-slate-900/90 text-slate-100 placeholder-slate-500 font-mono text-lg font-bold pl-14 pr-12 py-4 rounded-xl border-2 border-slate-700 focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/20 shadow-inner transition-all outline-none"
        />

        <div className="absolute right-4 text-xs font-mono text-slate-500 bg-slate-800 px-2 py-1 rounded border border-slate-700">
          ENTER
        </div>
      </div>

      {/* Alerta de Produto Não Encontrado */}
      {errorMessage && (
        <div className="absolute top-full mt-2 left-0 right-0 bg-rose-950/90 border border-rose-500/60 text-rose-200 text-xs font-semibold px-4 py-2.5 rounded-lg flex items-center gap-2 shadow-lg z-30 animate-shake">
          <AlertCircle className="w-4 h-4 text-rose-400 flex-shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Resultados da busca por nome (Dropdown rápido) */}
      {searchResults.length > 0 && (
        <div className="absolute top-full mt-2 left-0 right-0 bg-slate-800/95 backdrop-blur-md border border-slate-700 rounded-xl shadow-2xl overflow-hidden z-40">
          <div className="px-3 py-1.5 bg-slate-900/60 border-b border-slate-700/60 text-[11px] font-semibold text-slate-400 flex justify-between">
            <span>PRODUTOS ENCONTRADOS (Use ↑ ↓ e ENTER)</span>
            <span>PREÇO</span>
          </div>
          <div className="divide-y divide-slate-700/50 max-h-64 overflow-y-auto">
            {searchResults.map((item: Product, idx: number) => (
              <div
                key={item.id}
                onClick={() => {
                  onAddProduct(item, 1);
                  resetInput();
                }}
                className={`px-4 py-2.5 flex items-center justify-between cursor-pointer transition-colors ${
                  idx === selectedIndex ? 'bg-emerald-600/30 text-emerald-200' : 'hover:bg-slate-700/40 text-slate-200'
                }`}
              >
                <div>
                  <div className="font-semibold text-sm">{item.name}</div>
                  <div className="text-xs text-slate-400 font-mono">EAN: {item.barcode} • Estoque: {item.currentStock} {item.unit}</div>
                </div>
                <div className="font-mono font-bold text-emerald-400 text-base">
                  R$ {item.sellingPrice.toFixed(2)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
