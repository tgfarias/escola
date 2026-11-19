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
      guardians: [{ id: G1, firstName: "Ana", fullName: "Ana Paula Souza", phone: "+5511999990001", cpfMasked: "***.982.247-**" }],
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

  it("sends an expired session to the login", async () => {
    mockApi({ ...BASE, "GET /api/admin/v1/students": { status: 401, body: { error: { code: "unauthenticated", message: "x" } } } });
    renderPage();
    await screen.findByText("login");
  });
});
