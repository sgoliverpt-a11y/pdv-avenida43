// Gera o SQL de importação dos clientes exportados do Loyverse (Clientes > Exportar).
// Uso: node scripts/importar-clientes-loyverse.ts clientes.csv > clientes.sql
// Importa só nome, telefone e anotação (sem pontos nem valores). Nomes repetidos entram uma vez só,
// e um cliente que já existe com o mesmo nome não é duplicado ao rodar de novo.

import { readFileSync } from 'node:fs'
import { lerCsv } from '../src/lib/loyverse.ts'

const arquivo = process.argv[2]
if (!arquivo) {
  console.error('Uso: node scripts/importar-clientes-loyverse.ts clientes.csv')
  process.exit(1)
}
const [cab, ...linhas] = lerCsv(readFileSync(arquivo, 'utf8'))
const norm = (s: string) => s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
const col = (...nomes: string[]) => cab.map(norm).findIndex((h) => nomes.map(norm).includes(h))
const iNome = col('Nome do cliente', 'Customer name', 'Name')
const iTel = col('Telefone', 'Phone')
const iNota = col('Anotação', 'Note')
if (iNome < 0) {
  console.error('Coluna "Nome do cliente" não encontrada')
  process.exit(1)
}

const vistos = new Set<string>()
const clientes: { nome: string; tel?: string; obs?: string }[] = []
for (const l of linhas) {
  const nome = l[iNome]?.trim()
  if (!nome || vistos.has(nome)) continue
  vistos.add(nome)
  const tel = iTel >= 0 ? l[iTel]?.trim() : ''
  const obs = iNota >= 0 ? l[iNota]?.trim() : ''
  clientes.push({ nome, ...(tel ? { tel } : {}), ...(obs ? { obs } : {}) })
}

const json = JSON.stringify(clientes).replace(/'/g, "''")
console.log(`-- Importação de clientes do Loyverse: ${clientes.length} nomes
insert into public.clientes (nome, telefone, observacao)
select c->>'nome', c->>'tel', c->>'obs'
  from jsonb_array_elements('${json}'::jsonb) c
 where not exists (select 1 from public.clientes x where x.nome = c->>'nome');`)
console.error(`${linhas.length} linhas, ${clientes.length} clientes (${linhas.length - clientes.length} nomes repetidos ignorados)`)
