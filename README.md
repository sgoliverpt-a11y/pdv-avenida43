# PDV Avenida 43

Sistema de PDV da loja Avenida 43 (Casa Albinel de Legumes, Rio de Janeiro), substituindo o Loyverse.

- **PDV no celular**: app web (PWA) no Chrome do Android, funciona sem internet e imprime via Bluetooth nas Kapbom 58 mm.
- **Back office no PC**: produtos, estoque, clientes, recibos, relatórios e configurações.
- **Back end**: Supabase. **Hospedagem**: Vercel.

## Rodar localmente

```bash
cp .env.example .env   # preencha URL e chave publicável do Supabase
npm install
npm run dev
```

## Banco de dados

As migrações ficam em `supabase/migrations/`. Pontos principais:

- `produtos` agrupa; `variantes` é o que se vende (preço, SKU, estoque). Produto sem variações tem uma variante.
- `composicao` liga um kit às variantes que ele consome. Vender um kit baixa o estoque dos componentes.
- `estoque_movimentos` é o histórico; o saldo em `variantes.estoque_atual` é atualizado por trigger.
- `registrar_venda(jsonb)` grava venda, itens, pagamentos e baixa de estoque numa transação. É idempotente: o id da venda vem do celular, então reenviar após queda de internet não duplica.
- `fila_impressao` + `pegar_trabalho_impressao()` organizam as 2 impressoras entre os 4 celulares.

## Importar produtos do Loyverse

No Loyverse: Itens > Lista de itens > Exportar. Depois:

```bash
node scripts/importar-loyverse.ts itens.csv > importacao.sql               # só catálogo
node scripts/importar-loyverse.ts itens.csv --com-estoque > importacao.sql # e o saldo atual
```

Aplique o SQL gerado no Supabase. Pode rodar de novo: atualiza pelo Handle e pelo SKU.
