import React from 'react';
import { Trash2, Plus, Minus, ShoppingBag } from 'lucide-react';
import { SaleItem } from '@pdv/shared';

interface CartTableProps {
  items: SaleItem[];
  onUpdateQuantity: (index: number, newQty: number) => void;
  onRemoveItem: (index: number) => void;
  subtotal: number;
  discount: number;
  total: number;
}

export const CartTable: React.FC<CartTableProps> = ({
  items,
  onUpdateQuantity,
  onRemoveItem,
  subtotal,
  discount,
  total,
}) => {
  return (
    <div className="flex flex-col h-full bg-slate-900/60 rounded-2xl border border-slate-800/80 overflow-hidden shadow-xl">
      {/* Cabeçalho da Tabela de Itens */}
      <div className="grid grid-cols-12 gap-2 px-5 py-3 bg-slate-800/80 border-b border-slate-700/60 text-xs font-bold text-slate-400 uppercase tracking-wider">
        <div className="col-span-1 text-center">#</div>
        <div className="col-span-6">Produto</div>
        <div className="col-span-2 text-center">Qtd</div>
        <div className="col-span-1 text-right">Unitário</div>
        <div className="col-span-2 text-right">Total</div>
      </div>

      {/* Lista de Itens do Carrinho */}
      <div className="flex-1 overflow-y-auto divide-y divide-slate-800/60 p-1">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-500 py-16">
            <ShoppingBag className="w-16 h-16 stroke-[1.2] mb-3 text-slate-600" />
            <p className="text-base font-semibold text-slate-400">Caixa Livre</p>
            <p className="text-xs text-slate-500">Passe o primeiro produto no leitor de código de barras</p>
          </div>
        ) : (
          items.map((item, index) => (
            <div
              key={`${item.productId}-${index}`}
              className="grid grid-cols-12 gap-2 items-center px-4 py-3 hover:bg-slate-800/40 transition-colors group"
            >
              {/* Número do Item */}
              <div className="col-span-1 text-center font-mono text-xs font-bold text-slate-400">
                {String(index + 1).padStart(2, '0')}
              </div>

              {/* Nome e Código */}
              <div className="col-span-6 pr-2">
                <div className="font-bold text-slate-100 text-sm leading-tight truncate">
                  {item.productName}
                </div>
                <div className="text-[11px] font-mono text-slate-500 mt-0.5">
                  EAN: {item.barcode}
                </div>
              </div>

              {/* Controles de Quantidade */}
              <div className="col-span-2 flex items-center justify-center gap-1.5">
                <button
                  onClick={() => onUpdateQuantity(index, item.quantity - 1)}
                  className="w-6 h-6 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center transition-colors"
                >
                  <Minus className="w-3 h-3" />
                </button>
                <span className="font-mono font-bold text-sm text-slate-100 min-w-[28px] text-center">
                  {item.quantity}
                </span>
                <button
                  onClick={() => onUpdateQuantity(index, item.quantity + 1)}
                  className="w-6 h-6 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center transition-colors"
                >
                  <Plus className="w-3 h-3" />
                </button>
              </div>

              {/* Valor Unitário */}
              <div className="col-span-1 text-right font-mono text-xs text-slate-400">
                R$ {item.unitPrice.toFixed(2)}
              </div>

              {/* Valor Total do Item e Botão Deletar */}
              <div className="col-span-2 flex items-center justify-end gap-2">
                <span className="font-mono font-bold text-slate-100 text-sm">
                  R$ {item.totalPrice.toFixed(2)}
                </span>
                <button
                  onClick={() => onRemoveItem(index)}
                  className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-rose-400 transition-all p-1"
                  title="Remover item"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Painel de Totais Inferior */}
      <div className="bg-slate-900 border-t border-slate-800 p-5 shadow-2xl">
        <div className="flex justify-between items-center text-xs text-slate-400 mb-1.5 font-medium">
          <span>Subtotal ({items.reduce((acc, i) => acc + i.quantity, 0)} itens):</span>
          <span className="font-mono text-sm text-slate-300">R$ {subtotal.toFixed(2)}</span>
        </div>

        {discount > 0 && (
          <div className="flex justify-between items-center text-xs text-rose-400 mb-1.5 font-medium">
            <span>Desconto concedido:</span>
            <span className="font-mono text-sm font-semibold">- R$ {discount.toFixed(2)}</span>
          </div>
        )}

        <div className="flex justify-between items-baseline pt-2 border-t border-slate-800">
          <span className="text-sm font-bold text-slate-300 uppercase tracking-wide">Total a Pagar:</span>
          <span className="text-3xl font-black font-mono text-emerald-400 tracking-tight">
            R$ {total.toFixed(2)}
          </span>
        </div>
      </div>
    </div>
  );
};
