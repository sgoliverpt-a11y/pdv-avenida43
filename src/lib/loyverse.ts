// Leitura do CSV de itens exportado pelo Loyverse (Itens > Lista de itens > Exportar).
// Cada linha é uma variante; linhas com o mesmo "Handle" são o mesmo produto.
// Itens compostos trazem linhas extras com "SKU of included item" e "Quantity of included item".

export interface VarianteImportada {
  sku: string | null
  vendidoPor: 'peso' | 'unidade'
  codigoBarras: string | null
  opcoes: [string | null, string | null, string | null]
  preco: number | null
  custo: number | null
  controlaEstoque: boolean
  estoque: number | null
  estoqueMinimo: number | null
}

export interface ProdutoImportado {
  handle: string
  nome: string
  categoria: string | null
  descricao: string | null
  vendidoPor: 'peso' | 'unidade'
  opcaoNomes: [string | null, string | null, string | null]
  variantes: VarianteImportada[]
  componentes: { sku: string; quantidade: number }[] // só para itens compostos
}

/** CSV no padrão RFC 4180 (aspas, vírgulas e quebras de linha dentro de campos). */
export function lerCsv(texto: string): string[][] {
  const linhas: string[][] = []
  let campo = ''
  let linha: string[] = []
  let aspas = false
  const t = texto.replace(/^﻿/, '')
  const sep = detectarSeparador(t)
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (aspas) {
      if (c === '"' && t[i + 1] === '"') { campo += '"'; i++ }
      else if (c === '"') aspas = false
      else campo += c
    } else if (c === '"') aspas = true
    else if (c === sep) { linha.push(campo); campo = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++
      linha.push(campo); campo = ''
      if (linha.some((x) => x !== '')) linhas.push(linha)
      linha = []
    } else campo += c
  }
  linha.push(campo)
  if (linha.some((x) => x !== '')) linhas.push(linha)
  return linhas
}

function detectarSeparador(t: string): string {
  const primeira = t.slice(0, t.search(/\r?\n|$/))
  return (primeira.match(/;/g)?.length ?? 0) > (primeira.match(/,/g)?.length ?? 0) ? ';' : ','
}

const norm = (s: string) => s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

function numero(s: string | undefined): number | null {
  if (s == null) return null
  let v = s.trim().replace(/\s|R\$/g, '')
  if (v === '' || v.toLowerCase() === 'variable' || v.toLowerCase() === 'variavel') return null
  // "1.234,56" → 1234.56 ; "1234.56" fica como está
  if (v.includes(',')) v = v.replace(/\./g, '').replace(',', '.')
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// "Kg", "Prata Kg", "Kg Media" são por peso; "Caixa", "Saco 12 Kg", "Rede 1 Kg", "Dúzia" são por unidade
const EMBALAGEM = /\b(caixa|cx|saco|sc|rede|bandeja|bdj|duzia|und|unid|unidade|cartela|molho|meia)\b/
const PESO = /(\bkg\b|\bquilo|\bkilo)/
export function vendidoPorVariante(produtoPorPeso: boolean, opcoes: (string | null)[]): 'peso' | 'unidade' {
  const v = norm(opcoes.filter(Boolean).join(' '))
  if (!v) return produtoPorPeso ? 'peso' : 'unidade'
  if (EMBALAGEM.test(v)) return 'unidade'
  if (PESO.test(v)) return 'peso'
  return 'unidade'
}

const semHtml = (s: string | null) => (s ? s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || null : null)

const sim = (s: string | undefined) => ['y', 'yes', 's', 'sim', 'true', '1'].includes(norm(s ?? ''))
const texto = (s: string | undefined) => (s && s.trim() !== '' ? s.trim() : null)

export function lerItensLoyverse(csv: string): { produtos: ProdutoImportado[]; avisos: string[] } {
  const [cab, ...linhas] = lerCsv(csv)
  if (!cab) return { produtos: [], avisos: ['Arquivo vazio'] }
  const h = cab.map(norm)

  // Procura a coluna por nome exato ou por prefixo (colunas por loja: "Price [Loja]")
  const col = (...nomes: string[]) => {
    for (const n of nomes.map(norm)) {
      const i = h.findIndex((x) => x === n)
      if (i >= 0) return i
    }
    for (const n of nomes.map(norm)) {
      const i = h.findIndex((x) => x.startsWith(n))
      if (i >= 0) return i
    }
    return -1
  }
  const C = {
    handle: col('handle', 'identificador'),
    sku: col('sku', 'referencia'),
    nome: col('name', 'nome'),
    categoria: col('category', 'categoria'),
    descricao: col('description', 'descricao'),
    peso: col('sold by weight', 'vendido por peso'),
    op1n: col('option 1 name', 'opcao 1 nome'), op1v: col('option 1 value', 'opcao 1 valor'),
    op2n: col('option 2 name', 'opcao 2 nome'), op2v: col('option 2 value', 'opcao 2 valor'),
    op3n: col('option 3 name', 'opcao 3 nome'), op3v: col('option 3 value', 'opcao 3 valor'),
    precoPadrao: col('default price', 'preco padrao'),
    custo: col('cost', 'custo'),
    barras: col('barcode', 'codigo de barras'),
    compSku: col('sku of included item', 'sku do item incluido'),
    compQtd: col('quantity of included item', 'quantidade do item incluido'),
    estoqueCtrl: col('track stock', 'controlar estoque', 'rastrear estoque'),
    precoLoja: col('price [', 'preco ['),
    estoqueLoja: col('in stock [', 'em estoque ['),
    minimoLoja: col('low stock [', 'estoque baixo ['),
  }
  const avisos: string[] = []
  if (C.handle < 0 || C.nome < 0) avisos.push('Colunas "Handle" e "Name" não encontradas. Confira se é o CSV de itens do Loyverse.')

  const get = (l: string[], i: number) => (i >= 0 ? l[i] : undefined)
  const porHandle = new Map<string, ProdutoImportado>()

  for (const l of linhas) {
    const handle = texto(get(l, C.handle)) ?? texto(get(l, C.nome))
    if (!handle) continue
    let p = porHandle.get(handle)
    const nome = texto(get(l, C.nome))
    if (!p) {
      if (!nome) { avisos.push(`Linha sem nome para "${handle}" ignorada`); continue }
      p = {
        handle, nome,
        categoria: texto(get(l, C.categoria)),
        descricao: semHtml(texto(get(l, C.descricao))),
        vendidoPor: sim(get(l, C.peso)) ? 'peso' : 'unidade',
        opcaoNomes: [texto(get(l, C.op1n)), texto(get(l, C.op2n)), texto(get(l, C.op3n))],
        variantes: [], componentes: [],
      }
      porHandle.set(handle, p)
    }

    const compSku = texto(get(l, C.compSku))
    if (compSku) {
      const q = numero(get(l, C.compQtd))
      if (q && q > 0) p.componentes.push({ sku: compSku, quantidade: q })
      else avisos.push(`"${p.nome}": componente ${compSku} sem quantidade`)
    }

    // A linha descreve uma variante quando tem SKU próprio ou valor de opção
    const sku = texto(get(l, C.sku))
    const ops: [string | null, string | null, string | null] = [texto(get(l, C.op1v)), texto(get(l, C.op2v)), texto(get(l, C.op3v))]
    const ehVariante = (sku && !p.variantes.some((v) => v.sku === sku)) || ops.some(Boolean) || p.variantes.length === 0
    if (ehVariante && (nome || sku || ops.some(Boolean))) {
      p.variantes.push({
        sku,
        vendidoPor: vendidoPorVariante(p.vendidoPor === 'peso', ops),
        codigoBarras: texto(get(l, C.barras)),
        opcoes: ops,
        preco: numero(get(l, C.precoLoja)) ?? numero(get(l, C.precoPadrao)),
        custo: numero(get(l, C.custo)) || null, // Loyverse exporta 0.00 quando não há custo
        controlaEstoque: C.estoqueCtrl < 0 ? true : sim(get(l, C.estoqueCtrl)),
        estoque: numero(get(l, C.estoqueLoja)),
        estoqueMinimo: numero(get(l, C.minimoLoja)),
      })
    }
  }

  const produtos = [...porHandle.values()]
  for (const p of produtos) {
    if (p.componentes.length && p.variantes.length > 1)
      avisos.push(`"${p.nome}" é composto e tem ${p.variantes.length} variações; a composição foi aplicada a todas`)
  }
  return { produtos, avisos }
}
