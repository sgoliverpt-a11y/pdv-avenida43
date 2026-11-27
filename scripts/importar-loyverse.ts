// Gera o SQL de importação a partir do CSV de itens do Loyverse.
// Uso: node scripts/importar-loyverse.ts itens.csv [--com-estoque] > importacao.sql
// Pode rodar de novo: atualiza pelo Handle (produto) e pelo SKU (variante).

import { readFileSync } from 'node:fs'
import { lerItensLoyverse } from '../src/lib/loyverse.ts'

const [arquivo, ...flags] = process.argv.slice(2)
if (!arquivo) {
  console.error('Uso: node scripts/importar-loyverse.ts itens.csv [--com-estoque]')
  process.exit(1)
}
const comEstoque = flags.includes('--com-estoque')
const { produtos, avisos } = lerItensLoyverse(readFileSync(arquivo, 'utf8'))

const q = (v: string | null | undefined) => (v == null ? 'null' : `'${v.replace(/'/g, "''")}'`)
const n = (v: number | null | undefined) => (v == null ? 'null' : String(v))

const out: string[] = ['begin;']

const categorias = [...new Set(produtos.map((p) => p.categoria).filter(Boolean))] as string[]
for (const c of categorias)
  out.push(`insert into public.categorias (nome) values (${q(c)}) on conflict (nome) do nothing;`)

for (const p of produtos) {
  out.push(
    `insert into public.produtos (nome, categoria_id, descricao, vendido_por, opcao1_nome, opcao2_nome, opcao3_nome, composto, loyverse_handle)
values (${q(p.nome)}, (select id from public.categorias where nome = ${q(p.categoria)}), ${q(p.descricao)}, ${q(p.vendidoPor)},
        ${q(p.opcaoNomes[0])}, ${q(p.opcaoNomes[1])}, ${q(p.opcaoNomes[2])}, ${p.componentes.length > 0}, ${q(p.handle)})
on conflict (loyverse_handle) do update set nome = excluded.nome, categoria_id = excluded.categoria_id, descricao = excluded.descricao,
  vendido_por = excluded.vendido_por, opcao1_nome = excluded.opcao1_nome, opcao2_nome = excluded.opcao2_nome,
  opcao3_nome = excluded.opcao3_nome, composto = excluded.composto;`,
  )
  p.variantes.forEach((v, i) => {
    const sku = v.sku ?? `LV-${p.handle}-${i + 1}`
    // Kit não controla estoque próprio: a venda baixa os componentes
    const controla = p.componentes.length > 0 ? false : v.controlaEstoque
    out.push(
      `insert into public.variantes (produto_id, opcao1_valor, opcao2_valor, opcao3_valor, sku, codigo_barras, preco, custo, controla_estoque, estoque_minimo, ordem)
values ((select id from public.produtos where loyverse_handle = ${q(p.handle)}), ${q(v.opcoes[0])}, ${q(v.opcoes[1])}, ${q(v.opcoes[2])},
        ${q(sku)}, ${q(v.codigoBarras)}, ${n(v.preco)}, ${n(v.custo)}, ${controla}, ${n(v.estoqueMinimo)}, ${i})
on conflict (sku) do update set opcao1_valor = excluded.opcao1_valor, opcao2_valor = excluded.opcao2_valor, opcao3_valor = excluded.opcao3_valor,
  codigo_barras = excluded.codigo_barras, preco = excluded.preco, custo = excluded.custo,
  controla_estoque = excluded.controla_estoque, estoque_minimo = excluded.estoque_minimo, ordem = excluded.ordem;`,
    )
    if (comEstoque && controla && v.estoque != null)
      out.push(`select public.registrar_contagem((select id from public.variantes where sku = ${q(sku)}), ${n(v.estoque)}, null, 'Importado do Loyverse');`)
  })
}

// Composição por último, quando todas as variantes já existem
for (const p of produtos) {
  if (!p.componentes.length) continue
  out.push(`delete from public.composicao where variante_id in (select v.id from public.variantes v join public.produtos p on p.id = v.produto_id where p.loyverse_handle = ${q(p.handle)});`)
  for (const c of p.componentes)
    out.push(
      `insert into public.composicao (variante_id, componente_id, quantidade)
select v.id, comp.id, ${n(c.quantidade)} from public.variantes v join public.produtos p on p.id = v.produto_id, public.variantes comp
 where p.loyverse_handle = ${q(p.handle)} and comp.sku = ${q(c.sku)};`,
    )
}

out.push('commit;')
console.log(out.join('\n'))

const nVar = produtos.reduce((s, p) => s + p.variantes.length, 0)
const nComp = produtos.filter((p) => p.componentes.length).length
console.error(`${produtos.length} produtos, ${nVar} variantes, ${nComp} compostos, ${categorias.length} categorias`)
for (const a of avisos) console.error('Aviso: ' + a)
