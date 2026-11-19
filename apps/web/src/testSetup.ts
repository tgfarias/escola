// jsdom não implementa window.scrollTo e registra "Not implemented" a cada chamada: nos testes ele não faz nada.
// Testes que conferem a rolagem trocam por vi.stubGlobal("scrollTo", …).
if (typeof window !== "undefined") window.scrollTo = () => {};

// The full web suite also runs a real Vite build (build/themeScope.test.ts); under that CPU load the default
// 1 s wait of findBy*/waitFor makes screen tests flaky. Wait up to 5 s; passing tests are not slower.
import { configure } from "@testing-library/react";
configure({ asyncUtilTimeout: 5000 });
