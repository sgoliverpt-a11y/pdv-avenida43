// Gera o SQL de importação a partir do CSV de itens do Loyverse.
// Uso: node scripts/importar-loyverse.ts itens.csv [--com-estoque] [--controlar-estoque] > importacao.sql
//   --com-estoque        grava o saldo "In stock" do Loyverse como contagem inicial
//   --controlar-estoque  liga o controle de estoque em todas as variantes (no Loyverse da loja está desligado)
// Pode rodar de novo: atualiza pelo Handle (produto) e pelo SKU (variante).
// O SQL leva os dados como um único JSON, para caber numa chamada só.

import { readFileSync } from 'node:fs'
import { lerItensLoyverse } from '../src/lib/loyverse.ts'

const [arquivo, ...flags] = process.argv.slice(2)
if (!arquivo) {
  console.error('Uso: node scripts/importar-loyverse.ts itens.csv [--com-estoque] [--controlar-estoque]')
  process.exit(1)
}
const comEstoque = flags.includes('--com-estoque')
const forcarControle = flags.includes('--controlar-estoque')
const { produtos, avisos } = lerItensLoyverse(readFileSync(arquivo, 'utf8'))

const dados = produtos.map((p) => ({
  h: p.handle,
  nome: p.nome,
  cat: p.categoria,
  desc: p.descricao,
  vp: p.vendidoPor,
  o1: p.opcaoNomes[0], o2: p.opcaoNomes[1], o3: p.opcaoNomes[2],
  comp: p.componentes,
  var: p.variantes.map((v, i) => ({
    sku: v.sku ?? `LV-${p.handle}-${i + 1}`,
    vp: v.vendidoPor,
    v1: v.opcoes[0], v2: v.opcoes[1], v3: v.opcoes[2],
    cb: v.codigoBarras,
    preco: v.preco,
    custo: v.custo,
    // Kit não controla estoque próprio: a venda baixa os componentes
    ctrl: p.componentes.length > 0 ? false : forcarControle || v.controlaEstoque,
    est: comEstoque ? v.estoque : null,
    min: v.estoqueMinimo,
    ordem: i,
  })),
}))

// Campos vazios ficam de fora para o SQL ficar menor (->> devolve null para chave ausente)
const json = JSON.stringify(dados, (_k, v) => (v === null || v === false || (Array.isArray(v) && v.length === 0) ? undefined : v)).replace(/'/g, "''")

console.log(`-- Importação do Loyverse: ${produtos.length} produtos
drop table if exists _lv;
create temp table _lv as select '${json}'::jsonb as d;

insert into public.categorias (nome)
select distinct p->>'cat' from _lv, jsonb_array_elements(d) p where p->>'cat' is not null
on conflict (nome) do nothing;

insert into public.produtos (nome, categoria_id, descricao, vendido_por, opcao1_nome, opcao2_nome, opcao3_nome, composto, loyverse_handle)
select p->>'nome', (select id from public.categorias c where c.nome = p->>'cat'), p->>'desc', p->>'vp',
       p->>'o1', p->>'o2', p->>'o3', p ? 'comp', p->>'h'
  from _lv, jsonb_array_elements(d) p
on conflict (loyverse_handle) do update set nome = excluded.nome, categoria_id = excluded.categoria_id, descricao = excluded.descricao,
  vendido_por = excluded.vendido_por, opcao1_nome = excluded.opcao1_nome, opcao2_nome = excluded.opcao2_nome,
  opcao3_nome = excluded.opcao3_nome, composto = excluded.composto;

insert into public.variantes (produto_id, vendido_por, opcao1_valor, opcao2_valor, opcao3_valor, sku, codigo_barras, preco, custo, controla_estoque, estoque_minimo, ordem)
select pr.id, v->>'vp', v->>'v1', v->>'v2', v->>'v3', v->>'sku', v->>'cb', (v->>'preco')::numeric, (v->>'custo')::numeric,
       coalesce((v->>'ctrl')::boolean, false), (v->>'min')::numeric, coalesce((v->>'ordem')::smallint, 0)
  from _lv, jsonb_array_elements(d) p
  join public.produtos pr on pr.loyverse_handle = p->>'h'
  cross join jsonb_array_elements(p->'var') v
on conflict (sku) do update set produto_id = excluded.produto_id, vendido_por = excluded.vendido_por,
  opcao1_valor = excluded.opcao1_valor, opcao2_valor = excluded.opcao2_valor, opcao3_valor = excluded.opcao3_valor,
  codigo_barras = excluded.codigo_barras, preco = excluded.preco, custo = excluded.custo,
  controla_estoque = excluded.controla_estoque, estoque_minimo = excluded.estoque_minimo, ordem = excluded.ordem;

select public.registrar_contagem(va.id, (v->>'est')::numeric, null, 'Importado do Loyverse')
  from _lv, jsonb_array_elements(d) p
  cross join jsonb_array_elements(p->'var') v
  join public.variantes va on va.sku = v->>'sku'
 where v->>'est' is not null and va.controla_estoque;

delete from public.composicao c using _lv, jsonb_array_elements(d) p, public.variantes va, public.produtos pr
 where p ? 'comp' and pr.loyverse_handle = p->>'h' and va.produto_id = pr.id and c.variante_id = va.id;

insert into public.composicao (variante_id, componente_id, quantidade)
select va.id, comp.id, (c->>'quantidade')::numeric
  from _lv, jsonb_array_elements(d) p
  join public.produtos pr on pr.loyverse_handle = p->>'h'
  join public.variantes va on va.produto_id = pr.id
  cross join jsonb_array_elements(coalesce(p->'comp', '[]')) c
  join public.variantes comp on comp.sku = c->>'sku';

drop table _lv;`)

const nVar = produtos.reduce((s, p) => s + p.variantes.length, 0)
const nComp = produtos.filter((p) => p.componentes.length).length
const nCat = new Set(produtos.map((p) => p.categoria).filter(Boolean)).size
console.error(`${produtos.length} produtos, ${nVar} variantes, ${nComp} compostos, ${nCat} categorias`)
for (const a of avisos) console.error('Aviso: ' + a)
