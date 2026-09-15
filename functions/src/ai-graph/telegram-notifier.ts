/**
 * Serviço de Notificação via Bot Oficial do Telegram.
 * 100% Gratuito, sem risco de banimento e com suporte a Markdown.
 */
export async function sendTelegramNotification(
  botToken: string,
  chatId: string,
  messageText: string
): Promise<boolean> {
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: messageText,
        parse_mode: 'Markdown',
      }),
    });

    const data = await response.json();
    if (!data.ok) {
      console.error('[Telegram] Erro ao enviar mensagem:', data.description);
      return false;
    }

    console.log('[Telegram] Mensagem de fechamento entregue com sucesso!');
    return true;
  } catch (err) {
    console.error('[Telegram] Falha na requisição ao Telegram:', err);
    return false;
  }
}
