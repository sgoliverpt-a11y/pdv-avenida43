import { Link, Navigate, Route, Routes } from 'react-router-dom'
import { supabaseConfigurado } from './lib/supabase'

function Inicio() {
  return (
    <main className="inicio">
      <h1>PDV Avenida 43</h1>
      <p>Casa Albinel de Legumes</p>
      {!supabaseConfigurado && <p className="aviso">Supabase ainda não configurado (.env).</p>}
      <nav>
        <Link className="botao" to="/pdv">Abrir PDV (celular)</Link>
        <Link className="botao secundario" to="/admin">Back office (PC)</Link>
      </nav>
    </main>
  )
}

function EmBreve({ titulo }: { titulo: string }) {
  return (
    <main className="inicio">
      <h1>{titulo}</h1>
      <p>Em construção.</p>
      <Link to="/">Voltar</Link>
    </main>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Inicio />} />
      <Route path="/pdv/*" element={<EmBreve titulo="PDV" />} />
      <Route path="/admin/*" element={<EmBreve titulo="Back office" />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
