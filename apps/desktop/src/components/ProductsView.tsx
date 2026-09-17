import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Package,
  Plus,
  Search,
  AlertTriangle,
  DollarSign,
  TrendingUp,
  Edit2,
  Power,
  RefreshCw,
  Filter,
  ArrowLeft,
  Boxes,
} from 'lucide-react';
import { Product } from '@pdv/shared';
import { localDb } from '../db/local-db';
import { ProductFormModal, ProductFormInput } from './ProductFormModal';

interface ProductsViewProps {
  tenantId: string;
  onBackToPdv: () => void;
  onShowToast: (message: string) => void;
}

export const ProductsView: React.FC<ProductsViewProps> = ({
  tenantId,
  onBackToPdv,
  onShowToast,
}) => {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Filtros
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(false);

  // Modal de edição/cadastro
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);

  const onShowToastRef = useRef(onShowToast);
  useEffect(() => {
    onShowToastRef.current = onShowToast;
  }, [onShowToast]);

  // Carga dos produtos
  const loadData = useCallback(async () => {
    try {
      setIsLoading(true);
      const [prods, cats] = await Promise.all([
        localDb.getAllProducts(true),
        localDb.getCategories(),
      ]);
      setProducts(prods);
      setCategories(cats);
    } catch (err) {
      console.error('Erro ao carregar produtos:', err);
      onShowToastRef.current('Falha ao carregar catálogo de produtos.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Cálculos de KPIs
  const kpis = useMemo(() => {
    const activeProducts = products.filter((p) => p.isActive);
    const lowStockCount = activeProducts.filter((p) => p.currentStock <= p.minStock).length;
    const totalInventoryCost = activeProducts.reduce(
      (sum, p) => sum + p.costPrice * Math.max(p.currentStock, 0),
      0
    );
    const totalInventoryValue = activeProducts.reduce(
      (sum, p) => sum + p.sellingPrice * Math.max(p.currentStock, 0),
      0
    );

    return {
      totalActive: activeProducts.length,
      lowStockCount,
      totalInventoryCost,
      totalInventoryValue,
    };
  }, [products]);

  // Filtragem dos produtos
  const filteredProducts = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return products.filter((p) => {
      if (!includeInactive && !p.isActive) return false;
      if (lowStockOnly && p.currentStock > p.minStock) return false;
      if (selectedCategory !== 'ALL' && p.category !== selectedCategory) return false;
      if (q) {
        const matchName = p.name.toLowerCase().includes(q);
        const matchBarcode = p.barcode.toLowerCase().includes(q);
        const matchCat = p.category?.toLowerCase().includes(q);
        if (!matchName && !matchBarcode && !matchCat) return false;
      }
      return true;
    });
  }, [products, searchQuery, selectedCategory, lowStockOnly, includeInactive]);

  // Handlers
  const handleOpenCreateModal = () => {
    setSelectedProduct(null);
    setIsModalOpen(true);
  };

  const handleOpenEditModal = (product: Product) => {
    setSelectedProduct(product);
    setIsModalOpen(true);
  };

  const handleSaveProduct = async (productData: ProductFormInput) => {
    const isNew = !productData.id;
    await localDb.saveProduct(productData);
    await loadData();
    onShowToast(
      isNew
        ? `Produto "${productData.name}" cadastrado com sucesso!`
        : `Produto "${productData.name}" atualizado!`
    );
  };

  const handleToggleStatus = async (product: Product) => {
    try {
      const newStatus = await localDb.toggleProductStatus(product.id);
      await loadData();
      onShowToast(
        newStatus
          ? `Produto "${product.name}" reativado para vendas.`
          : `Produto "${product.name}" inativado.`
      );
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : 'Erro ao alterar status.');
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-950 p-6 overflow-hidden select-none">
      {/* Barra de Topo da Gestão */}
      <div className="flex items-center justify-between pb-5 border-b border-slate-800 flex-shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={onBackToPdv}
            title="Voltar para a tela de vendas [F1]"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-slate-300 hover:text-slate-100 border border-slate-700/80 rounded-xl text-xs font-semibold transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Voltar ao PDV [F1]</span>
          </button>
          <div>
            <h1 className="text-xl font-extrabold text-slate-100 flex items-center gap-2">
              <Boxes className="w-5 h-5 text-emerald-400" />
              Catálogo & Gestão de Estoque
            </h1>
            <p className="text-xs text-slate-400 font-medium">
              Controle de preços, margem de lucro, alertas de estoque e cadastro de produtos
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={loadData}
            title="Recarregar dados do SQLite local"
            className="p-2 bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-100 border border-slate-800 rounded-xl transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-emerald-400' : ''}`} />
          </button>
          <button
            onClick={handleOpenCreateModal}
            className="flex items-center gap-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold px-4 py-2 rounded-xl text-xs shadow-lg shadow-emerald-500/20 transition-all"
          >
            <Plus className="w-4 h-4" />
            <span>Novo Produto</span>
          </button>
        </div>
      </div>

      {/* Cards de Métricas e KPIs Rápidos */}
      <div className="grid grid-cols-4 gap-4 py-4 flex-shrink-0">
        <div className="bg-slate-900/80 border border-slate-800 p-4 rounded-2xl flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Produtos Ativos</span>
            <div className="text-2xl font-black text-slate-100 mt-0.5">{kpis.totalActive}</div>
          </div>
          <div className="bg-blue-500/10 text-blue-400 p-2.5 rounded-xl border border-blue-500/20">
            <Package className="w-5 h-5" />
          </div>
        </div>

        <div
          onClick={() => setLowStockOnly(!lowStockOnly)}
          className={`cursor-pointer transition-all border p-4 rounded-2xl flex items-center justify-between ${
            lowStockOnly
              ? 'bg-amber-950/40 border-amber-500/60 ring-1 ring-amber-500/40'
              : 'bg-slate-900/80 border-slate-800 hover:border-amber-500/30'
          }`}
        >
          <div>
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Estoque Baixo</span>
            <div className={`text-2xl font-black mt-0.5 ${kpis.lowStockCount > 0 ? 'text-amber-400' : 'text-slate-200'}`}>
              {kpis.lowStockCount}
            </div>
          </div>
          <div className="bg-amber-500/10 text-amber-400 p-2.5 rounded-xl border border-amber-500/20">
            <AlertTriangle className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-slate-900/80 border border-slate-800 p-4 rounded-2xl flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Custo Total Estoque</span>
            <div className="text-2xl font-black font-mono text-slate-200 mt-0.5">
              R$ {kpis.totalInventoryCost.toFixed(2)}
            </div>
          </div>
          <div className="bg-slate-800 text-slate-300 p-2.5 rounded-xl border border-slate-700">
            <DollarSign className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-slate-900/80 border border-slate-800 p-4 rounded-2xl flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">Valor Venda Estoque</span>
            <div className="text-2xl font-black font-mono text-emerald-400 mt-0.5">
              R$ {kpis.totalInventoryValue.toFixed(2)}
            </div>
          </div>
          <div className="bg-emerald-500/10 text-emerald-400 p-2.5 rounded-xl border border-emerald-500/20">
            <TrendingUp className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* Barra de Filtros e Busca */}
      <div className="flex items-center gap-3 pb-4 flex-shrink-0">
        {/* Campo de Busca */}
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Pesquisar por nome, código de barras ou categoria..."
            className="w-full bg-slate-900/90 border border-slate-800 rounded-xl pl-10 pr-4 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors"
          />
        </div>

        {/* Filtro de Categoria */}
        <div className="w-52">
          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 transition-colors"
          >
            <option value="ALL">Todas as Categorias</option>
            {categories.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>
        </div>

        {/* Botão Apenas Estoque Baixo */}
        <button
          onClick={() => setLowStockOnly(!lowStockOnly)}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold border transition-all ${
            lowStockOnly
              ? 'bg-amber-500/20 text-amber-300 border-amber-500/50'
              : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200'
          }`}
        >
          <Filter className="w-3.5 h-3.5" />
          <span>Abaixo do Mínimo</span>
        </button>

        {/* Toggle de Inativos */}
        <label className="flex items-center gap-2 px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-300 cursor-pointer hover:bg-slate-850">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
            className="w-3.5 h-3.5 rounded text-emerald-600 focus:ring-emerald-500 bg-slate-950 border-slate-700"
          />
          <span>Exibir Inativos</span>
        </label>
      </div>

      {/* Tabela de Produtos */}
      <div className="flex-1 bg-slate-900/60 border border-slate-800/80 rounded-2xl overflow-hidden flex flex-col shadow-inner">
        <div className="overflow-y-auto flex-1">
          <table className="w-full text-left border-collapse text-xs">
            <thead className="bg-slate-900/90 sticky top-0 z-10 border-b border-slate-800 text-slate-400 uppercase tracking-wider font-semibold">
              <tr>
                <th className="py-3 px-4">Código / EAN</th>
                <th className="py-3 px-4">Produto</th>
                <th className="py-3 px-4">Categoria</th>
                <th className="py-3 px-4 text-right">Custo</th>
                <th className="py-3 px-4 text-right">Venda</th>
                <th className="py-3 px-4 text-center">Margem</th>
                <th className="py-3 px-4 text-center">Estoque Atual / Mín</th>
                <th className="py-3 px-4 text-center">Status</th>
                <th className="py-3 px-4 text-right">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filteredProducts.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-slate-500">
                    <Package className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    <p className="font-semibold">Nenhum produto encontrado com os filtros atuais.</p>
                    <p className="text-[11px] text-slate-600 mt-1">
                      Cadastre novos produtos pelo botão acima ou altere os filtros de busca.
                    </p>
                  </td>
                </tr>
              ) : (
                filteredProducts.map((p) => {
                  const profit = p.sellingPrice - p.costPrice;
                  const grossMargin = p.sellingPrice > 0 ? (profit / p.sellingPrice) * 100 : 0;
                  const isLowStock = p.currentStock <= p.minStock;

                  return (
                    <tr
                      key={p.id}
                      className={`hover:bg-slate-800/40 transition-colors ${
                        !p.isActive ? 'opacity-50 bg-slate-950/40' : ''
                      }`}
                    >
                      {/* Código de Barras */}
                      <td className="py-3 px-4 font-mono font-medium text-slate-300">
                        {p.barcode}
                      </td>

                      {/* Nome do Produto */}
                      <td className="py-3 px-4">
                        <div className="font-bold text-slate-100">{p.name}</div>
                        <div className="text-[11px] text-slate-500 font-mono">
                          Unidade: <span className="text-slate-400">{p.unit}</span>
                          {p.ncm ? ` | NCM: ${p.ncm}` : ''}
                        </div>
                      </td>

                      {/* Categoria */}
                      <td className="py-3 px-4">
                        <span className="bg-slate-800 text-slate-300 px-2 py-0.5 rounded text-[11px] border border-slate-700/60">
                          {p.category || 'Geral'}
                        </span>
                      </td>

                      {/* Preço de Custo */}
                      <td className="py-3 px-4 text-right font-mono text-slate-400">
                        R$ {p.costPrice.toFixed(2)}
                      </td>

                      {/* Preço de Venda */}
                      <td className="py-3 px-4 text-right font-mono font-bold text-emerald-400">
                        R$ {p.sellingPrice.toFixed(2)}
                      </td>

                      {/* Margem */}
                      <td className="py-3 px-4 text-center">
                        <span
                          className={`font-mono text-[11px] font-bold px-2 py-0.5 rounded ${
                            grossMargin >= 30
                              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                              : grossMargin >= 10
                              ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                              : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                          }`}
                        >
                          {grossMargin.toFixed(1)}%
                        </span>
                      </td>

                      {/* Estoque */}
                      <td className="py-3 px-4 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <span
                            className={`font-mono font-bold px-2 py-0.5 rounded ${
                              isLowStock
                                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                                : 'text-slate-200'
                            }`}
                          >
                            {p.currentStock} {p.unit}
                          </span>
                          <span className="text-slate-500 font-mono text-[11px]">
                            / mín {p.minStock}
                          </span>
                        </div>
                      </td>

                      {/* Status */}
                      <td className="py-3 px-4 text-center">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${
                            p.isActive
                              ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                              : 'bg-slate-800 text-slate-500 border border-slate-700'
                          }`}
                        >
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              p.isActive ? 'bg-emerald-400' : 'bg-slate-600'
                            }`}
                          />
                          {p.isActive ? 'Ativo' : 'Inativo'}
                        </span>
                      </td>

                      {/* Ações */}
                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => handleOpenEditModal(p)}
                            title="Editar Dados do Produto"
                            className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-slate-100 rounded-lg border border-slate-700 transition-colors"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleToggleStatus(p)}
                            title={p.isActive ? 'Inativar Produto' : 'Reativar Produto'}
                            className={`p-1.5 rounded-lg border transition-colors ${
                              p.isActive
                                ? 'bg-slate-800 hover:bg-rose-950 text-slate-400 hover:text-rose-300 border-slate-700 hover:border-rose-500/40'
                                : 'bg-slate-800 hover:bg-emerald-950 text-slate-500 hover:text-emerald-300 border-slate-700 hover:border-emerald-500/40'
                            }`}
                          >
                            <Power className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Rodapé da Tabela com Totalizadores */}
        <div className="bg-slate-900 px-6 py-2.5 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400 font-medium">
          <span>
            Exibindo <span className="text-slate-200 font-bold">{filteredProducts.length}</span> de{' '}
            <span className="text-slate-200 font-bold">{products.length}</span> produtos cadastrados
          </span>
          <span className="font-mono text-[11px] text-slate-500">
            Sincronizado automaticamente com o catálogo do leitor PDV
          </span>
        </div>
      </div>

      {/* Modal de Cadastro / Edição */}
      <ProductFormModal
        isOpen={isModalOpen}
        productToEdit={selectedProduct}
        existingCategories={categories}
        tenantId={tenantId}
        onSave={handleSaveProduct}
        onClose={() => setIsModalOpen(false)}
      />
    </div>
  );
};
