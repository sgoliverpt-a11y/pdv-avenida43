-- No Loyverse da loja o mesmo produto tem variações por peso (Kg) e por embalagem (Caixa, Saco, Dúzia).
-- A forma de venda passa a ser da variante; a do produto vira só o padrão para novas variações.
alter table public.variantes add column vendido_por text check (vendido_por in ('peso', 'unidade'));
update public.variantes v set vendido_por = p.vendido_por from public.produtos p where p.id = v.produto_id;
alter table public.variantes alter column vendido_por set not null;
alter table public.variantes alter column vendido_por set default 'unidade';

create or replace view public.estoque_baixo with (security_invoker = true) as
select v.id as variante_id, p.nome as produto, v.opcao1_valor, v.opcao2_valor, v.opcao3_valor,
       v.vendido_por, v.estoque_atual, v.estoque_minimo
  from public.variantes v
  join public.produtos p on p.id = v.produto_id
 where v.ativo and p.ativo and v.controla_estoque
   and v.estoque_minimo is not null and v.estoque_atual <= v.estoque_minimo;
