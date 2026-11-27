-- PDV Avenida 43: esquema inicial
-- Quantidades em kg ou unidade usam numeric(12,3); valores em reais usam numeric(12,2).

create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;

-- Busca sem acento (unaccent não é immutable; este wrapper permite índice)
create or replace function public.sem_acento(t text)
returns text language sql immutable parallel safe
set search_path = ''
as $$ select extensions.unaccent('extensions.unaccent'::regdictionary, lower(coalesce(t, ''))) $$;

-- ---------------------------------------------------------------------------
-- Loja: dispositivos (PDVs), funcionários, configurações
-- ---------------------------------------------------------------------------

create table public.dispositivos (
  id          smallint generated always as identity primary key,
  nome        text not null unique,            -- "PDV 1"
  ativo       boolean not null default true,
  criado_em   timestamptz not null default now()
);

create table public.funcionarios (
  id          uuid primary key default gen_random_uuid(),
  nome        text not null,
  pin_hash    text,                            -- SHA-256 do PIN, conferido também offline
  papel       text not null default 'funcionario' check (papel in ('funcionario', 'gerente', 'dono')),
  ativo       boolean not null default true,
  criado_em   timestamptz not null default now()
);

create table public.configuracoes (
  chave       text primary key,
  valor       jsonb not null,
  atualizado_em timestamptz not null default now()
);

create table public.formas_pagamento (
  id          smallint generated always as identity primary key,
  nome        text not null unique,            -- PIX, Dinheiro, Cartão de crédito...
  tipo        text not null check (tipo in ('pix', 'dinheiro', 'cartao', 'outro')),
  ordem       smallint not null default 0,
  ativo       boolean not null default true
);

-- ---------------------------------------------------------------------------
-- Catálogo: categorias, produtos, variantes, composição
-- Como no Loyverse: o produto agrupa; a variante é o que se vende e tem preço e estoque.
-- Produto sem variações tem exatamente uma variante.
-- ---------------------------------------------------------------------------

create table public.categorias (
  id          uuid primary key default gen_random_uuid(),
  nome        text not null unique,
  cor         text,
  ordem       smallint not null default 0
);

create table public.produtos (
  id            uuid primary key default gen_random_uuid(),
  nome          text not null,
  categoria_id  uuid references public.categorias(id) on delete set null,
  descricao     text,
  vendido_por   text not null default 'unidade' check (vendido_por in ('peso', 'unidade')),
  opcao1_nome   text,                           -- ex.: "Tamanho"
  opcao2_nome   text,
  opcao3_nome   text,
  composto      boolean not null default false, -- vendido como kit; baixa o estoque dos componentes
  ativo         boolean not null default true,
  loyverse_handle text unique,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index produtos_categoria_idx on public.produtos (categoria_id);
create index produtos_nome_busca_idx on public.produtos using gin (public.sem_acento(nome) extensions.gin_trgm_ops);

create table public.variantes (
  id              uuid primary key default gen_random_uuid(),
  produto_id      uuid not null references public.produtos(id) on delete cascade,
  opcao1_valor    text,
  opcao2_valor    text,
  opcao3_valor    text,
  sku             text unique,
  codigo_barras   text,
  preco           numeric(12,2),               -- por kg (peso) ou por unidade; null = preço na hora
  custo           numeric(12,2),
  controla_estoque boolean not null default true,
  estoque_atual   numeric(12,3) not null default 0,  -- mantido pelos movimentos
  estoque_minimo  numeric(12,3),
  ativo           boolean not null default true,
  ordem           smallint not null default 0,
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now()
);
create index variantes_produto_idx on public.variantes (produto_id);
create index variantes_codigo_barras_idx on public.variantes (codigo_barras) where codigo_barras is not null;

create table public.composicao (
  variante_id     uuid not null references public.variantes(id) on delete cascade,  -- o kit
  componente_id   uuid not null references public.variantes(id) on delete restrict,
  quantidade      numeric(12,3) not null check (quantidade > 0),
  primary key (variante_id, componente_id),
  check (variante_id <> componente_id)
);
create index composicao_componente_idx on public.composicao (componente_id);

-- ---------------------------------------------------------------------------
-- Clientes
-- ---------------------------------------------------------------------------

create table public.clientes (
  id          uuid primary key default gen_random_uuid(),  -- gerado no celular (offline)
  nome        text not null,
  telefone    text,
  observacao  text,
  criado_em   timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index clientes_nome_busca_idx on public.clientes using gin (public.sem_acento(nome) extensions.gin_trgm_ops);
create index clientes_telefone_idx on public.clientes (telefone) where telefone is not null;

-- ---------------------------------------------------------------------------
-- Vendas (recibos). O id vem do celular, então reenviar a mesma venda não duplica.
-- ---------------------------------------------------------------------------

create table public.vendas (
  id              uuid primary key,
  tipo            text not null default 'venda' check (tipo in ('venda', 'reembolso')),
  venda_origem_id uuid references public.vendas(id),  -- para reembolso
  dispositivo_id  smallint not null references public.dispositivos(id),
  numero_local    integer not null,                   -- sequência do celular: "2-0145"
  numero          bigint generated always as identity unique,  -- sequência geral do servidor
  cliente_id      uuid references public.clientes(id) on delete set null,
  cliente_nome    text,                               -- cópia do nome no momento da venda
  funcionario_id  uuid references public.funcionarios(id) on delete set null,
  funcionario_nome text,
  subtotal        numeric(12,2) not null,
  desconto        numeric(12,2) not null default 0,
  total           numeric(12,2) not null,
  status          text not null default 'concluida' check (status in ('concluida', 'cancelada')),
  observacao      text,
  criada_em       timestamptz not null,               -- hora no celular
  sincronizada_em timestamptz not null default now(),
  unique (dispositivo_id, numero_local),
  check ((tipo = 'reembolso') = (venda_origem_id is not null))
);
create index vendas_criada_em_idx on public.vendas (criada_em desc);
create index vendas_cliente_idx on public.vendas (cliente_id);
create index vendas_funcionario_idx on public.vendas (funcionario_id);
create index vendas_origem_idx on public.vendas (venda_origem_id) where venda_origem_id is not null;
create index vendas_cliente_nome_busca_idx on public.vendas using gin (public.sem_acento(cliente_nome) extensions.gin_trgm_ops);

create table public.venda_itens (
  id              uuid primary key default gen_random_uuid(),
  venda_id        uuid not null references public.vendas(id) on delete cascade,
  linha           smallint not null,
  variante_id     uuid references public.variantes(id) on delete set null,
  descricao       text not null,                      -- nome + variação no momento da venda
  vendido_por     text not null check (vendido_por in ('peso', 'unidade')),
  quantidade      numeric(12,3) not null check (quantidade > 0),
  preco_unitario  numeric(12,2) not null,
  desconto        numeric(12,2) not null default 0,
  total           numeric(12,2) not null,
  unique (venda_id, linha)
);
create index venda_itens_variante_idx on public.venda_itens (variante_id);

create table public.venda_pagamentos (
  id                 uuid primary key default gen_random_uuid(),
  venda_id           uuid not null references public.vendas(id) on delete cascade,
  forma_pagamento_id smallint references public.formas_pagamento(id),
  forma_nome         text not null,
  valor              numeric(12,2) not null,
  troco              numeric(12,2) not null default 0
);
create index venda_pagamentos_venda_idx on public.venda_pagamentos (venda_id);
create index venda_pagamentos_forma_idx on public.venda_pagamentos (forma_pagamento_id);

-- ---------------------------------------------------------------------------
-- Estoque: todo movimento fica no histórico; o saldo da variante é atualizado por trigger.
-- quantidade é com sinal: entrada/devolução positivas, venda negativa, ajuste qualquer.
-- ---------------------------------------------------------------------------

create table public.estoque_movimentos (
  id              uuid primary key default gen_random_uuid(),
  variante_id     uuid not null references public.variantes(id) on delete cascade,
  tipo            text not null check (tipo in ('entrada', 'venda', 'reembolso', 'cancelamento', 'ajuste', 'perda', 'contagem')),
  quantidade      numeric(12,3) not null check (quantidade <> 0),
  saldo_apos      numeric(12,3),
  custo_unitario  numeric(12,2),
  venda_id        uuid references public.vendas(id) on delete set null,
  funcionario_id  uuid references public.funcionarios(id) on delete set null,
  observacao      text,
  criado_em       timestamptz not null default now()
);
create index estoque_movimentos_variante_idx on public.estoque_movimentos (variante_id, criado_em desc);
create index estoque_movimentos_venda_idx on public.estoque_movimentos (venda_id) where venda_id is not null;
create index estoque_movimentos_funcionario_idx on public.estoque_movimentos (funcionario_id);

create or replace function public.aplicar_movimento_estoque()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  update public.variantes
     set estoque_atual = estoque_atual + new.quantidade,
         atualizado_em = now()
   where id = new.variante_id
  returning estoque_atual into new.saldo_apos;
  return new;
end $$;

create trigger estoque_movimentos_aplicar
  before insert on public.estoque_movimentos
  for each row execute function public.aplicar_movimento_estoque();

-- Contagem: informa o saldo contado e gera o ajuste da diferença
create or replace function public.registrar_contagem(p_variante_id uuid, p_saldo numeric, p_funcionario_id uuid default null, p_observacao text default null)
returns void language plpgsql
set search_path = ''
as $$
declare v_atual numeric;
begin
  select estoque_atual into v_atual from public.variantes where id = p_variante_id for update;
  if v_atual is null then raise exception 'Variante não encontrada'; end if;
  if p_saldo <> v_atual then
    insert into public.estoque_movimentos (variante_id, tipo, quantidade, funcionario_id, observacao)
    values (p_variante_id, 'contagem', p_saldo - v_atual, p_funcionario_id, p_observacao);
  end if;
end $$;

create view public.estoque_baixo with (security_invoker = true) as
select v.id as variante_id, p.nome as produto, v.opcao1_valor, v.opcao2_valor, v.opcao3_valor,
       p.vendido_por, v.estoque_atual, v.estoque_minimo
  from public.variantes v
  join public.produtos p on p.id = v.produto_id
 where v.ativo and p.ativo and v.controla_estoque
   and v.estoque_minimo is not null and v.estoque_atual <= v.estoque_minimo;

-- ---------------------------------------------------------------------------
-- Registrar venda (chamada pela sincronização do celular). Idempotente.
-- p: { id, tipo, venda_origem_id, dispositivo_id, numero_local, cliente_id, cliente_nome,
--      funcionario_id, funcionario_nome, subtotal, desconto, total, observacao, criada_em,
--      itens: [{linha, variante_id, descricao, vendido_por, quantidade, preco_unitario, desconto, total}],
--      pagamentos: [{forma_pagamento_id, forma_nome, valor, troco}] }
-- Baixa o estoque da variante, ou dos componentes quando a variante é um kit.
-- ---------------------------------------------------------------------------

create or replace function public.registrar_venda(p jsonb)
returns bigint language plpgsql
set search_path = ''
as $$
declare
  v_id uuid := (p->>'id')::uuid;
  v_numero bigint;
  v_tipo text := coalesce(p->>'tipo', 'venda');
  v_sinal int := case when v_tipo = 'reembolso' then 1 else -1 end;
  item jsonb;
begin
  select numero into v_numero from public.vendas where id = v_id;
  if found then return v_numero; end if;  -- já sincronizada

  insert into public.vendas (id, tipo, venda_origem_id, dispositivo_id, numero_local, cliente_id, cliente_nome,
                             funcionario_id, funcionario_nome, subtotal, desconto, total, observacao, criada_em)
  values (v_id, v_tipo, (p->>'venda_origem_id')::uuid, (p->>'dispositivo_id')::smallint, (p->>'numero_local')::int,
          (p->>'cliente_id')::uuid, p->>'cliente_nome', (p->>'funcionario_id')::uuid, p->>'funcionario_nome',
          (p->>'subtotal')::numeric, coalesce((p->>'desconto')::numeric, 0), (p->>'total')::numeric,
          p->>'observacao', (p->>'criada_em')::timestamptz)
  returning numero into v_numero;

  for item in select * from jsonb_array_elements(coalesce(p->'itens', '[]'::jsonb)) loop
    insert into public.venda_itens (venda_id, linha, variante_id, descricao, vendido_por, quantidade, preco_unitario, desconto, total)
    values (v_id, (item->>'linha')::smallint, (item->>'variante_id')::uuid, item->>'descricao', item->>'vendido_por',
            (item->>'quantidade')::numeric, (item->>'preco_unitario')::numeric,
            coalesce((item->>'desconto')::numeric, 0), (item->>'total')::numeric);
  end loop;

  insert into public.venda_pagamentos (venda_id, forma_pagamento_id, forma_nome, valor, troco)
  select v_id, (pg->>'forma_pagamento_id')::smallint, pg->>'forma_nome', (pg->>'valor')::numeric, coalesce((pg->>'troco')::numeric, 0)
    from jsonb_array_elements(coalesce(p->'pagamentos', '[]'::jsonb)) pg;

  -- Baixa de estoque: itens simples
  insert into public.estoque_movimentos (variante_id, tipo, quantidade, venda_id, funcionario_id)
  select vi.variante_id, v_tipo, v_sinal * vi.quantidade, v_id, (p->>'funcionario_id')::uuid
    from public.venda_itens vi
    join public.variantes va on va.id = vi.variante_id
   where vi.venda_id = v_id and va.controla_estoque
     and not exists (select 1 from public.composicao c where c.variante_id = vi.variante_id);

  -- Baixa de estoque: componentes dos kits
  insert into public.estoque_movimentos (variante_id, tipo, quantidade, venda_id, funcionario_id, observacao)
  select c.componente_id, v_tipo, v_sinal * vi.quantidade * c.quantidade, v_id, (p->>'funcionario_id')::uuid, vi.descricao
    from public.venda_itens vi
    join public.composicao c on c.variante_id = vi.variante_id
    join public.variantes comp on comp.id = c.componente_id
   where vi.venda_id = v_id and comp.controla_estoque;

  return v_numero;
end $$;

-- Cancelar venda: devolve o estoque que ela baixou
create or replace function public.cancelar_venda(p_venda_id uuid, p_funcionario_id uuid default null, p_motivo text default null)
returns void language plpgsql
set search_path = ''
as $$
begin
  update public.vendas set status = 'cancelada', observacao = coalesce(p_motivo, observacao)
   where id = p_venda_id and status = 'concluida';
  if not found then return; end if;

  insert into public.estoque_movimentos (variante_id, tipo, quantidade, venda_id, funcionario_id, observacao)
  select variante_id, 'cancelamento', -quantidade, p_venda_id, p_funcionario_id, p_motivo
    from public.estoque_movimentos
   where venda_id = p_venda_id and tipo in ('venda', 'reembolso');
end $$;

-- ---------------------------------------------------------------------------
-- Impressoras e fila de impressão compartilhada
-- Uma impressora Bluetooth aceita uma conexão por vez. O celular que vai imprimir
-- pega o próximo trabalho com pegar_trabalho_impressao(); os outros esperam a vez.
-- ---------------------------------------------------------------------------

create table public.impressoras (
  id          smallint generated always as identity primary key,
  nome        text not null unique,            -- "Balcão", "Separação"
  funcao      text not null check (funcao in ('recibo', 'separacao', 'ambos')),
  ble_nome    text,                            -- nome anunciado pelo Bluetooth
  ativo       boolean not null default true
);

create table public.fila_impressao (
  id              uuid primary key default gen_random_uuid(),
  impressora_id   smallint not null references public.impressoras(id),
  venda_id        uuid references public.vendas(id) on delete cascade,
  tipo            text not null check (tipo in ('recibo', 'separacao', 'teste')),
  conteudo        text,                         -- texto já formatado (opcional)
  status          text not null default 'pendente' check (status in ('pendente', 'imprimindo', 'impresso', 'erro')),
  pedido_por      smallint references public.dispositivos(id),
  impresso_por    smallint references public.dispositivos(id),
  tentativas      smallint not null default 0,
  erro            text,
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now()
);
create index fila_impressao_pendentes_idx on public.fila_impressao (impressora_id, criado_em) where status in ('pendente', 'imprimindo');
create index fila_impressao_venda_idx on public.fila_impressao (venda_id);
create index fila_impressao_pedido_por_idx on public.fila_impressao (pedido_por);
create index fila_impressao_impresso_por_idx on public.fila_impressao (impresso_por);

-- Pega o próximo trabalho pendente da impressora (ou um travado há mais de 60 s)
create or replace function public.pegar_trabalho_impressao(p_impressora_id smallint, p_dispositivo_id smallint)
returns setof public.fila_impressao language plpgsql
set search_path = ''
as $$
begin
  return query
  update public.fila_impressao f
     set status = 'imprimindo', impresso_por = p_dispositivo_id, tentativas = f.tentativas + 1, atualizado_em = now()
   where f.id = (
     select id from public.fila_impressao
      where impressora_id = p_impressora_id
        and (status = 'pendente' or (status = 'imprimindo' and atualizado_em < now() - interval '60 seconds'))
      order by criado_em
      limit 1
      for update skip locked)
  returning f.*;
end $$;

-- ---------------------------------------------------------------------------
-- atualizado_em automático
-- ---------------------------------------------------------------------------

create or replace function public.tocar_atualizado_em()
returns trigger language plpgsql
set search_path = ''
as $$ begin new.atualizado_em := now(); return new; end $$;

create trigger produtos_atualizado before update on public.produtos for each row execute function public.tocar_atualizado_em();
create trigger clientes_atualizado before update on public.clientes for each row execute function public.tocar_atualizado_em();
create trigger configuracoes_atualizado before update on public.configuracoes for each row execute function public.tocar_atualizado_em();
create trigger fila_impressao_atualizado before update on public.fila_impressao for each row execute function public.tocar_atualizado_em();

-- ---------------------------------------------------------------------------
-- Segurança: só usuários autenticados (a conta da loja) acessam. Sem restrição por funcionário por enquanto.
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['dispositivos','funcionarios','configuracoes','formas_pagamento','categorias','produtos',
                           'variantes','composicao','clientes','vendas','venda_itens','venda_pagamentos',
                           'estoque_movimentos','impressoras','fila_impressao']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "loja autenticada" on public.%I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

revoke execute on function public.registrar_venda(jsonb) from public, anon;
revoke execute on function public.cancelar_venda(uuid, uuid, text) from public, anon;
revoke execute on function public.registrar_contagem(uuid, numeric, uuid, text) from public, anon;
revoke execute on function public.pegar_trabalho_impressao(smallint, smallint) from public, anon;
grant execute on function public.registrar_venda(jsonb) to authenticated;
grant execute on function public.cancelar_venda(uuid, uuid, text) to authenticated;
grant execute on function public.registrar_contagem(uuid, numeric, uuid, text) to authenticated;
grant execute on function public.pegar_trabalho_impressao(smallint, smallint) to authenticated;

-- Realtime para a fila de impressão (celulares avisados de novos trabalhos)
alter publication supabase_realtime add table public.fila_impressao;

-- ---------------------------------------------------------------------------
-- Dados iniciais
-- ---------------------------------------------------------------------------

insert into public.dispositivos (nome) values ('PDV 1'), ('PDV 2'), ('PDV 3'), ('PDV 4');
insert into public.formas_pagamento (nome, tipo, ordem) values
  ('PIX', 'pix', 1), ('Dinheiro', 'dinheiro', 2), ('Cartão de débito', 'cartao', 3), ('Cartão de crédito', 'cartao', 4);
insert into public.impressoras (nome, funcao) values ('Recibo', 'recibo'), ('Separação', 'separacao');
insert into public.configuracoes (chave, valor) values
  ('loja', '{"nome": "Avenida 43", "subtitulo": "Casa Albinel de Legumes", "whatsapp": "(21) 3890 4370", "retirada": "Retirar na Loja"}'),
  ('recibo', '{"rodape": "Obrigado pela preferencia!", "imprimir_separacao": true}');
