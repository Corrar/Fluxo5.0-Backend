// src/middlewares/validators.ts

export const validatePositiveItems = (items: any[]) => {
  if (!items || !Array.isArray(items) || items.length === 0) {
    throw new Error('Lista de itens inválida ou vazia.');
  }

  for (const item of items) {
    // 🟢 ADICIONADO: quantity_to_return (Devoluções) e quantity_delivered (Aprovações/Conferência)
    // Utilizamos o nullish coalescing (??) para pegar o primeiro valor que exista.
    const rawQty = item.quantity ?? 
                   item.quantity_requested ?? 
                   item.qty_requested ?? 
                   item.quantity_out ?? 
                   item.quantity_to_return ?? 
                   item.quantity_delivered;

    const qty = Number(rawQty);

    // 🟢 ALTERADO PARA < 0: O almoxarife pode precisar enviar '0' durante uma aprovação/ajuste
    // se descobrir que a prateleira afinal está vazia, ou durante devoluções onde o user
    // selecione 0 para devolver nalguns itens. Bloqueamos apenas números negativos.
    if (isNaN(qty) || qty < 0) {
      throw new Error(`Tentativa de manipulação detectada: Quantidade inválida (${qty}). Apenas valores positivos ou zero são permitidos.`);
    }
  }
};
