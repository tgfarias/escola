import { buildApp } from "../src/app";
import { adminDb, createSchool, seedFamily, staffCookie } from "./helpers";

/** Escola com secretaria, um responsável (nome completo e CPF) e dois filhos (Léo e Bia) com nome completo e nascimento. */
export async function documentsSetup() {
  const schoolId = await createSchool();
  const { cookies, staffUserId } = await staffCookie(schoolId, "secretaria");
  const fam = await seedFamily(schoolId, ["Léo", "Bia"]);
  const [leo, bia] = fam.studentIds as [string, string];
  await adminDb().updateTable("students").set({ fullName: "Leonardo Souza", birthDate: "2021-03-15" }).where("id", "=", leo).execute();
  await adminDb().updateTable("students").set({ fullName: "Beatriz Souza", birthDate: "2022-07-02" }).where("id", "=", bia).execute();
  await adminDb().updateTable("guardians").set({ fullName: "Ana Paula Souza", cpf: "52998224725" }).where("id", "=", fam.guardianId).execute();
  const app = buildApp();
  const post = (url: string, payload?: unknown, key: string | null = crypto.randomUUID()) =>
    app.inject({ method: "POST", url, cookies, payload: payload as object, headers: key ? { "idempotency-key": key } : {} });
  const get = (url: string) => app.inject({ method: "GET", url, cookies });
  const template = async (bodyMd: string, fields: unknown[] = []) =>
    (await post("/api/admin/v1/document-templates", { name: "Modelo", category: "outro", bodyMd, fields })).json().id as string;
  return { schoolId, staffUserId, cookies, app, post, get, template, guardianId: fam.guardianId, leo, bia };
}
