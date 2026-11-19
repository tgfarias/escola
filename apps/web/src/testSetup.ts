// jsdom não implementa window.scrollTo e registra "Not implemented" a cada chamada: nos testes ele não faz nada.
// Testes que conferem a rolagem trocam por vi.stubGlobal("scrollTo", …).
if (typeof window !== "undefined") window.scrollTo = () => {};
