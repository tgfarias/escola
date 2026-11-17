import { Route, Routes } from "react-router";

function Home() {
  return (
    <main>
      <h1>App Lanche</h1>
      <p>Abra o link que a escola enviou pelo WhatsApp.</p>
    </main>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="*" element={<Home />} />
    </Routes>
  );
}
