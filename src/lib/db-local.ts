// Banco local do celular (IndexedDB). Guarda o catálogo para vender sem internet
// e as vendas que ainda não subiram para o Supabase.
import Dexie, { type EntityTable } from 'dexie'

export interface VendaPendente {
  id: string            // mesmo uuid usado no servidor
  payload: unknown      // corpo enviado para registrar_venda
  criadaEm: string
  tentativas: number
  erro?: string
}

export interface Parametro { chave: string; valor: unknown }

export const dbLocal = new Dexie('pdv-avenida43') as Dexie & {
  vendasPendentes: EntityTable<VendaPendente, 'id'>
  parametros: EntityTable<Parametro, 'chave'>
}

dbLocal.version(1).stores({
  vendasPendentes: 'id, criadaEm',
  parametros: 'chave',
})
