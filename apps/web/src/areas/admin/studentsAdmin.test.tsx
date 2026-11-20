import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudentsAdmin } from "./StudentsAdmin";
import { filterStudents } from "./studentFilter";

type Reply = { status: number; body?: unknown };

function mockApi(replies: Record<string, Reply>) {
  const fn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const reply = replies[key];
    if (!reply) throw new Error(`unexpected request ${key}`);
    return reply.status === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function bodyOf(fn: ReturnType<typeof mockApi>, key: string): unknown {
  const call = fn.mock.calls.find((c) => `${c[1]?.method ?? "GET"} ${c[0]}` === key);
  return call ? JSON.parse(call[1]!.body as string) : undefined;
}

const U = (n: number) => `0193a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const [C1, C2, S1, S2, G1] = [U(1), U(2), U(3), U(4), U(5)];
const CLASSES = { classes: [{ id: C1, name: "Infantil 3A" }, { id: C2, name: "Infantil 4B" }] };
const STUDENTS = {
  students: [
    {
      id: S1, externalCode: "A1", firstName: "Léo", fullName: "Leonardo Souza", birthDate: "2021-03-15", classId: C1, className: "Infantil 3A",
      guardians: [{ id: G1, firstName: "Ana", fullName: "Ana Paula Souza", phone: "+5511999990001", cpfMasked: "***.982.247-**", financial: true }],
    },
    { id: S2, externalCode: "B1", firstName: "Caio", fullName: null, birthDate: null, classId: C2, className: "Infantil 4B", guardians: [] },
  ],
};
const BASE: Record<string, Reply> = {
  "GET /api/admin/v1/students": { status: 200, body: STUDENTS },
  "GET /api/admin/v1/classes": { status: 200, body: CLASSES },
};
const GUARDIAN: Reply = { status: 200, body: { id: G1, firstName: "Ana", fullName: "Ana Paula Souza", cpf: "52998224725" } };

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/admin/alunos"]}>
      <Routes>
        <Route path="/admin/alunos" element={<StudentsAdmin />} />
        <Route path="/admin/login" element={<p>login</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("filterStudents", () => {
  it("filters by class and by an accent-insensitive name", () => {
    expect(filterStudents(STUDENTS.students, { classId: C2, query: "" }).map((s) => s.id)).toEqual([S2]);
    expect(filterStudents(STUDENTS.students, { classId: "", query: "leo" }).map((s) => s.id)).toEqual([S1]);
    expect(filterStudents(STUDENTS.students, { classId: "", query: " SOUZA " }).map((s) => s.id)).toEqual([S1]);
  });
});

describe("students admin", () => {
  it("lists students with the CPF masked and filters them", async () => {
    mockApi(BASE);
    renderPage();
    await screen.findByText("Leonardo Souza");
    expect(screen.getByRole("heading", { level: 1, name: "Alunos e responsáveis" })).toBeTruthy();
    expect(screen.getByText("15/03/2021")).toBeTruthy();
    expect(screen.getByText(/\*\*\*\.982\.247-\*\*/)).toBeTruthy();
    expect(screen.getByText("Nenhum responsável")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Turma"), { target: { value: C2 } });
    expect(screen.queryByText("Leonardo Souza")).toBeNull();
    expect(screen.getByText("Caio")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Turma"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Buscar por nome"), { target: { value: "leo" } });
    expect(screen.queryByText("Caio")).toBeNull();
  });

  it("edits a student's full name and birth date", async () => {
    const fn = mockApi({ ...BASE, [`PUT /api/admin/v1/students/${S2}`]: { status: 204 } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Editar aluno Caio" }));
    fireEvent.change(screen.getByLabelText("Nome completo"), { target: { value: " Caio Lima " } });
    fireEvent.change(screen.getByLabelText("Data de nascimento"), { target: { value: "2020-05-08" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await screen.findByText("Dados salvos.");
    expect(screen.getByRole("status").textContent).toBe("Dados salvos.");
    expect(bodyOf(fn, `PUT /api/admin/v1/students/${S2}`)).toEqual({ fullName: "Caio Lima", birthDate: "2020-05-08" });
  });

  it("edits a guardian, showing the full CPF only inside the form", async () => {
    const fn = mockApi({ ...BASE, [`GET /api/admin/v1/guardians/${G1}`]: GUARDIAN, [`PUT /api/admin/v1/guardians/${G1}`]: { status: 204 } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Editar responsável Ana" }));
    const cpf = (await screen.findByLabelText("CPF")) as HTMLInputElement;
    await waitFor(() => expect(cpf.value).toBe("529.982.247-25"));
    fireEvent.change(cpf, { target: { value: "111.444.777-35" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await screen.findByText("Dados salvos.");
    expect(bodyOf(fn, `PUT /api/admin/v1/guardians/${G1}`)).toEqual({ fullName: "Ana Paula Souza", cpf: "111.444.777-35" });
  });

  it("shows the validation message when the server refuses the CPF", async () => {
    mockApi({
      ...BASE,
      [`GET /api/admin/v1/guardians/${G1}`]: GUARDIAN,
      [`PUT /api/admin/v1/guardians/${G1}`]: { status: 400, body: { error: { code: "validation_failed", message: "x" } } },
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Editar responsável Ana" }));
    await waitFor(() => expect((screen.getByLabelText("CPF") as HTMLInputElement).value).toBe("529.982.247-25"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await screen.findByText("Confira os dados e tente de novo.");
  });

  it("clears the error on a new submit, on cancel and after a save", async () => {
    let attempt = 0;
    const fn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) => {
      const key = `${init?.method ?? "GET"} ${url}`;
      if (key === "GET /api/admin/v1/students") return new Response(JSON.stringify(STUDENTS), { status: 200 });
      if (key === "GET /api/admin/v1/classes") return new Response(JSON.stringify(CLASSES), { status: 200 });
      if (key === `PUT /api/admin/v1/students/${S2}`) {
        attempt += 1;
        // A segunda tentativa fica pendurada até o teste conferir que o erro sumiu ao enviar.
        if (attempt === 2) return new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(null, { status: 204 })), 50));
        return new Response(JSON.stringify({ error: { code: "validation_failed", message: "x" } }), { status: 400 });
      }
      throw new Error(`unexpected request ${key}`);
    });
    vi.stubGlobal("fetch", fn);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Editar aluno Caio" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await screen.findByText("Confira os dados e tente de novo.");
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(screen.queryByText("Confira os dados e tente de novo.")).toBeNull();
    await screen.findByText("Dados salvos.");
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Editar aluno Caio" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await screen.findByText("Confira os dados e tente de novo.");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says when the guardian cannot be loaded", async () => {
    mockApi({ ...BASE, [`GET /api/admin/v1/guardians/${G1}`]: { status: 500, body: { error: { code: "internal_error", message: "x" } } } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Editar responsável Ana" }));
    await screen.findByText("Não foi possível carregar o responsável.");
    expect(screen.queryByText("Carregando…")).toBeNull();
  });

  it("keeps all CPF digits of a pasted value with punctuation and spaces", async () => {
    const fn = mockApi({ ...BASE, [`GET /api/admin/v1/guardians/${G1}`]: { status: 200, body: { id: G1, firstName: "Ana", fullName: null, cpf: null } }, [`PUT /api/admin/v1/guardians/${G1}`]: { status: 204 } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Editar responsável Ana" }));
    const cpf = (await screen.findByLabelText("CPF")) as HTMLInputElement;
    expect(cpf.maxLength).toBe(-1);
    fireEvent.change(cpf, { target: { value: "  CPF 111.444.777-35  " } });
    expect(cpf.value).toBe("111.444.777-35");
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await screen.findByText("Dados salvos.");
    expect(bodyOf(fn, `PUT /api/admin/v1/guardians/${G1}`)).toEqual({ fullName: null, cpf: "111.444.777-35" });
  });

  it("sends an expired session to the login", async () => {
    mockApi({ ...BASE, "GET /api/admin/v1/students": { status: 401, body: { error: { code: "unauthenticated", message: "x" } } } });
    renderPage();
    await screen.findByText("login");
  });
  it("makes another guardian the financial one", async () => {
    const twoGuardians = {
      students: [
        {
          ...STUDENTS.students[0]!,
          guardians: [
            { ...STUDENTS.students[0]!.guardians[0]!, financial: true },
            { id: U(6), firstName: "Rui", fullName: null, phone: "+5511999990002", cpfMasked: null, financial: false },
          ],
        },
      ],
    };
    const fn = mockApi({
      ...BASE,
      "GET /api/admin/v1/students": { status: 200, body: twoGuardians },
      [`PUT /api/admin/v1/students/${S1}/financial-guardian`]: { status: 204 },
    });
    renderPage();
    expect(await screen.findByText("financeiro")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Tornar Rui responsável financeiro de Leonardo Souza" }));
    await waitFor(() => expect(bodyOf(fn, `PUT /api/admin/v1/students/${S1}/financial-guardian`)).toEqual({ guardianId: U(6) }));
  });
});

describe("import inside the students page", () => {
  it("opens the CSV panel, imports and reloads the list", async () => {
    const fetchMock = mockApi({
      ...BASE,
      "POST /api/admin/v1/import/students": { status: 200, body: { applied: true, errors: [], classes: 2, students: 30, guardians: 41 } },
    });
    renderPage();
    await screen.findByText("Leonardo Souza");
    expect(screen.queryByLabelText("Conteúdo do CSV")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Adicionar / importar" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("importar");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.change(screen.getByLabelText("Conteúdo do CSV"), { target: { value: "a,b\n1,2" } });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    await screen.findByText("Importação concluída: 2 turmas, 30 alunos, 41 responsáveis.");
    expect(bodyOf(fetchMock, "POST /api/admin/v1/import/students")).toEqual({ csv: "a,b\n1,2" });
    await waitFor(() => expect(fetchMock.mock.calls.filter((c) => c[0] === "/api/admin/v1/students")).toHaveLength(2));
    expect((screen.getByLabelText("Conteúdo do CSV") as HTMLTextAreaElement).value).toBe("");
    fireEvent.click(toggle);
    expect(screen.queryByLabelText("Conteúdo do CSV")).toBeNull();
  });

  it("lists the refused lines and imports nothing", async () => {
    mockApi({
      ...BASE,
      "POST /api/admin/v1/import/students": {
        status: 200,
        body: { applied: false, errors: [{ line: 3, message: "telefone inválido" }], classes: 0, students: 0, guardians: 0 },
      },
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Adicionar / importar" }));
    fireEvent.change(screen.getByLabelText("Conteúdo do CSV"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    await screen.findByText("Nada foi importado. Corrija as linhas abaixo e envie de novo.");
    expect(screen.getByText("Linha 3: telefone inválido")).toBeTruthy();
  });

  it("tells staff without permission that they have no access", async () => {
    mockApi({ ...BASE, "POST /api/admin/v1/import/students": { status: 403, body: { error: { code: "insufficient_scope", message: "x" } } } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Adicionar / importar" }));
    fireEvent.change(screen.getByLabelText("Conteúdo do CSV"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    await screen.findByText("Você não tem acesso a esta área.");
  });

  it("sends an expired session to the login from the import", async () => {
    mockApi({ ...BASE, "POST /api/admin/v1/import/students": { status: 401, body: { error: { code: "unauthenticated", message: "x" } } } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Adicionar / importar" }));
    fireEvent.change(screen.getByLabelText("Conteúdo do CSV"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    await screen.findByText("login");
  });
});
