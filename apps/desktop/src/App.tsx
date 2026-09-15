import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { ProductScanner } from './components/ProductScanner';
import { CartTable } from './components/CartTable';
import { PaymentModal } from './components/PaymentModal';
import { CashSessionModal } from './components/CashSessionModal';
import { ShortcutsBar } from './components/ShortcutsBar';
import { localDb } from './db/local-db';
import { ThermalPrinterService } from './services/printer-usb';
import { DeviceConfigService } from './services/device-config';
import { SaleWriterService } from './services/sale-writer';
import { Product, Sale, SaleItem, SalePayment, CashSession, TenantSettings } from '@pdv/shared';
import { CheckCircle } from 'lucide-react';

const DEMO_TENANT_ID = 'tenant_demo_001';
const DEFAULT_SETTINGS: TenantSettings = {
  receiptHeader: 'MERCEARIA CENTRAL\nRUA DAS FLORES, 123 - CENTRO',
  receiptFooter: 'SISTEMA INTELIGENTE PDV\nAGRADECEMOS A PREFERENCIA!',
  receiptWidthMm: 80,
  maxDiscountPercentageAllowedForCashier: 5,
  enableTelegramAlerts: true,
};

export const App: React.FC = () => {
  // Identificação do Terminal (Dispositivo)
  const [deviceConfig] = useState(() => DeviceConfigService.getConfig());

  // Estado do Caixa
  const [currentSession, setCurrentSession] = useState<CashSession | null>(() => {
    return {
      id: 'session_001',
      tenantId: DEMO_TENANT_ID,
      terminalNumber: DeviceConfigService.getConfig().terminalNumber,
      deviceId: DeviceConfigService.getConfig().deviceId,
      openedByUserId: 'user_01',
      openedByName: 'Lucas (Operador)',
      openedAt: Date.now(),
      initialAmount: 100.0,
      totalCashSales: 0,
      totalPixSales: 0,
      totalCardSales: 0,
      totalCreditSales: 0,
      totalSangrias: 0,
      totalSuprimentos: 0,
      status: 'OPEN',
    };
  });

  // Estado da Venda Atual
  const [cartItems, setCartItems] = useState<SaleItem[]>([]);
  const [discount, setDiscount] = useState<number>(0);
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [isCashModalOpen, setIsCashModalOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Sincronização & Rede
  const [isOnline] = useState(true);
  const [pendingSyncCount, setPendingSyncCount] = useState(0);

  // Inicialização e Carga de Produtos Demo
  useEffect(() => {
    localDb.seedDemoProductsIfEmpty(DEMO_TENANT_ID);
    setPendingSyncCount(localDb.getPendingSales().length);
  }, []);

  // Atalhos Globais de Teclado
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Se algum modal estiver aberto, não processa os atalhos de fundo
      if (isPaymentModalOpen || isCashModalOpen) return;

      if (e.key === 'F2') {
        e.preventDefault();
        handleNewSale();
      } else if (e.key === 'F8') {
        e.preventDefault();
        setIsCashModalOpen(true);
      } else if (e.key === 'F10') {
        e.preventDefault();
        if (cartItems.length > 0 && currentSession?.status === 'OPEN') {
          setIsPaymentModalOpen(true);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleCancelSale();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [cartItems, isPaymentModalOpen, isCashModalOpen, currentSession]);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 4000);
  };

  // Adiciona produto ao carrinho
  const handleAddProduct = (product: Product, quantity: number) => {
    if (currentSession?.status !== 'OPEN') {
      showToast('Abra o caixa [F8] antes de passar produtos!');
      return;
    }

    setCartItems((prev) => {
      const existingIndex = prev.findIndex((item) => item.productId === product.id);
      if (existingIndex >= 0) {
        const updated = [...prev];
        const newQty = updated[existingIndex].quantity + quantity;
        updated[existingIndex] = {
          ...updated[existingIndex],
          quantity: newQty,
          totalPrice: newQty * product.sellingPrice,
          totalCost: newQty * product.costPrice,
        };
        return updated;
      }

      const newItem: SaleItem = {
        productId: product.id,
        productName: product.name,
        barcode: product.barcode,
        quantity,
        unitPrice: product.sellingPrice,
        unitCost: product.costPrice,
        discount: 0,
        totalPrice: quantity * product.sellingPrice,
        totalCost: quantity * product.costPrice,
      };
      return [...prev, newItem];
    });
  };

  const handleUpdateQuantity = (index: number, newQty: number) => {
    if (newQty <= 0) {
      handleRemoveItem(index);
      return;
    }
    setCartItems((prev) => {
      const updated = [...prev];
      const item = updated[index];
      updated[index] = {
        ...item,
        quantity: newQty,
        totalPrice: newQty * item.unitPrice,
        totalCost: newQty * item.unitCost,
      };
      return updated;
    });
  };

  const handleRemoveItem = (index: number) => {
    setCartItems((prev) => prev.filter((_, i) => i !== index));
  };

  const handleNewSale = () => {
    setCartItems([]);
    setDiscount(0);
  };

  const handleCancelSale = () => {
    if (cartItems.length > 0) {
      if (window.confirm('Deseja realmente cancelar a venda atual?')) {
        handleNewSale();
        showToast('Venda cancelada.');
      }
    }
  };

  const subtotal = cartItems.reduce((acc, item) => acc + item.totalPrice, 0);
  const total = Math.max(0, subtotal - discount);

  // Conclusão e Impressão da Venda
  const handleConfirmPayment = async (payments: SalePayment[], customerName?: string) => {
    const saleNumber = Math.floor(Math.random() * 9000) + 1000;
    const newSale: Sale = {
      id: `sale_${Date.now()}`,
      tenantId: DEMO_TENANT_ID,
      sessionId: currentSession?.id || 'session_001',
      saleNumber,
      deviceId: deviceConfig.deviceId,
      userId: 'user_01',
      userName: 'Lucas (Operador)',
      customerName,
      subtotal,
      discount,
      total,
      totalCost: cartItems.reduce((acc, i) => acc + i.totalCost, 0),
      items: cartItems,
      payments,
      status: 'COMPLETED',
      createdAt: Date.now(),
    };

    // 1. Processa a venda aplicando estratégia Online-First com Fallback local
    const writeResult = await SaleWriterService.processSale(newSale, isOnline);
    setPendingSyncCount(localDb.getPendingSales().length);

    // 2. Dispara a impressão na impressora térmica USB
    await ThermalPrinterService.printSaleReceipt(writeResult.sale, {
      storeName: 'Mercearia Central',
      storeCnpj: '12.345.678/0001-90',
      settings: DEFAULT_SETTINGS,
    });

    // 3. Atualiza totais da sessão do caixa
    if (currentSession) {
      const isCash = payments.some((p) => p.method === 'DINHEIRO');
      const isPix = payments.some((p) => p.method === 'PIX');
      const isCard = payments.some((p) => p.method === 'DEBITO' || p.method === 'CREDITO');
      const isCredit = payments.some((p) => p.method === 'FIADO');

      setCurrentSession((prev) => {
        if (!prev) return null;
        return {
          ...prev,
          totalCashSales: isCash ? prev.totalCashSales + total : prev.totalCashSales,
          totalPixSales: isPix ? prev.totalPixSales + total : prev.totalPixSales,
          totalCardSales: isCard ? prev.totalCardSales + total : prev.totalCardSales,
          totalCreditSales: isCredit ? prev.totalCreditSales + total : prev.totalCreditSales,
        };
      });
    }

    // 4. Limpa e prepara o caixa para o próximo cliente
    setIsPaymentModalOpen(false);
    handleNewSale();
    const modeBadge = writeResult.mode === 'ONLINE_TRANSACTION' ? '✅ Nuvem' : '⚡ Fila Local';
    showToast(`Venda #${saleNumber} concluída [${modeBadge}] e impressa!`);
  };

  // Gestão de Caixa (Abertura, Fechamento, Sangria)
  const handleOpenSession = (initialAmount: number) => {
    setCurrentSession({
      id: `session_${Date.now()}`,
      tenantId: DEMO_TENANT_ID,
      terminalNumber: deviceConfig.terminalNumber,
      deviceId: deviceConfig.deviceId,
      openedByUserId: 'user_01',
      openedByName: 'Lucas (Operador)',
      openedAt: Date.now(),
      initialAmount,
      totalCashSales: 0,
      totalPixSales: 0,
      totalCardSales: 0,
      totalCreditSales: 0,
      totalSangrias: 0,
      totalSuprimentos: 0,
      status: 'OPEN',
    });
    showToast(`Caixa aberto no [${deviceConfig.deviceName}]! Troco: R$ ${initialAmount.toFixed(2)}`);
  };

  const handleCloseSession = (finalReported: number, notes?: string) => {
    if (!currentSession) return;
    const expected = currentSession.initialAmount + currentSession.totalCashSales - currentSession.totalSangrias + currentSession.totalSuprimentos;
    const difference = finalReported - expected;

    setCurrentSession((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        closedAt: Date.now(),
        finalReportedAmount: finalReported,
        systemCalculatedAmount: expected,
        differenceAmount: difference,
        status: 'CLOSED',
        notes,
      };
    });

    const diffMsg = difference === 0
      ? 'Caixa fechado com 100% de exatidão!'
      : difference > 0
      ? `Caixa fechado com Sobra de R$ ${difference.toFixed(2)}.`
      : `Caixa fechado com Falta de R$ ${Math.abs(difference).toFixed(2)}.`;

    showToast(diffMsg);
  };

  const handleSangria = (amount: number, reason: string) => {
    setCurrentSession((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        totalSangrias: prev.totalSangrias + amount,
      };
    });
    showToast(`Sangria de R$ ${amount.toFixed(2)} registrada (${reason}).`);
  };

  const handleSuprimento = (amount: number, reason: string) => {
    setCurrentSession((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        totalSuprimentos: prev.totalSuprimentos + amount,
      };
    });
    showToast(`Suprimento de R$ ${amount.toFixed(2)} adicionado (${reason}).`);
  };

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 select-none overflow-hidden">
      {/* Header Principal */}
      <Header
        storeName="Mercearia Central"
        deviceId={deviceConfig.deviceId}
        deviceName={deviceConfig.deviceName}
        currentUser={{ name: 'Lucas', role: 'Operador' }}
        currentSession={currentSession}
        isOnline={isOnline}
        pendingSyncCount={pendingSyncCount}
        onSyncNow={() => {
          showToast('Sincronização com o Firebase concluída!');
          setPendingSyncCount(0);
        }}
        onOpenCashModal={() => setIsCashModalOpen(true)}
      />

      {/* Corpo do PDV */}
      <main className="flex-1 p-6 grid grid-cols-12 gap-6 overflow-hidden">
        {/* Coluna Esquerda: Scanner de Produtos e Informações */}
        <div className="col-span-5 flex flex-col gap-6">
          <div className="bg-slate-900/90 p-5 rounded-2xl border border-slate-800 shadow-xl space-y-3">
            <h2 className="text-xs uppercase font-bold text-emerald-400 tracking-wider">
              Leitor de Código de Barras / Busca
            </h2>
            <ProductScanner
              onAddProduct={handleAddProduct}
              disabled={currentSession?.status !== 'OPEN'}
            />
          </div>

          {/* Card Rápido de Dicas e Atalhos */}
          <div className="flex-1 bg-slate-900/40 p-5 rounded-2xl border border-slate-800/60 flex flex-col justify-between">
            <div className="space-y-2">
              <span className="text-xs font-bold text-slate-400 uppercase">Dicas Rápidas do Caixa:</span>
              <ul className="text-xs text-slate-400 space-y-1.5 list-disc pl-4 font-medium">
                <li>Bipe produtos direto com o leitor USB sem clicar na tela.</li>
                <li>Multiplicador: digite <code className="text-emerald-300 font-bold">3*codigo</code> para passar 3 unidades de uma vez.</li>
                <li>Pressione <code className="text-emerald-300 font-bold">F10</code> a qualquer momento para abrir a tela de pagamentos.</li>
              </ul>
            </div>

            <div className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 flex items-center justify-between">
              <span className="text-xs text-slate-400">Total na Gaveta (Dinheiro):</span>
              <span className="text-lg font-mono font-bold text-slate-200">
                R$ {((currentSession?.initialAmount || 0) + (currentSession?.totalCashSales || 0) - (currentSession?.totalSangrias || 0) + (currentSession?.totalSuprimentos || 0)).toFixed(2)}
              </span>
            </div>
          </div>
        </div>

        {/* Coluna Direita: Carrinho de Compras e Totais */}
        <div className="col-span-7 h-full">
          <CartTable
            items={cartItems}
            onUpdateQuantity={handleUpdateQuantity}
            onRemoveItem={handleRemoveItem}
            subtotal={subtotal}
            discount={discount}
            total={total}
          />
        </div>
      </main>

      {/* Barra de Atalhos Inferior */}
      <ShortcutsBar
        onNewSale={handleNewSale}
        onOpenCashModal={() => setIsCashModalOpen(true)}
        onFinalize={() => {
          if (cartItems.length > 0 && currentSession?.status === 'OPEN') {
            setIsPaymentModalOpen(true);
          } else {
            showToast('Passe pelo menos um produto para finalizar!');
          }
        }}
        onCancelSale={handleCancelSale}
      />

      {/* Modal de Pagamentos (F10) */}
      {isPaymentModalOpen && (
        <PaymentModal
          total={total}
          onConfirmPayment={handleConfirmPayment}
          onClose={() => setIsPaymentModalOpen(false)}
        />
      )}

      {/* Modal de Sessão de Caixa (F8) */}
      {isCashModalOpen && (
        <CashSessionModal
          currentSession={currentSession}
          onOpenSession={handleOpenSession}
          onCloseSession={handleCloseSession}
          onSangria={handleSangria}
          onSuprimento={handleSuprimento}
          onClose={() => setIsCashModalOpen(false)}
        />
      )}

      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-14 right-6 bg-slate-800 text-slate-100 border border-emerald-500/50 px-5 py-3 rounded-2xl shadow-2xl flex items-center gap-3 z-50 animate-in slide-in-from-bottom-5">
          <CheckCircle className="w-5 h-5 text-emerald-400 flex-shrink-0" />
          <span className="text-sm font-semibold">{toastMessage}</span>
        </div>
      )}
    </div>
  );
};
