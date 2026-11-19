import { Navigate, Route, Routes } from "react-router";
import "../../theme/styles";
import { AdminHome } from "./AdminHome";
import { AdminLayout } from "./AdminLayout";
import { AdminLogin } from "./AdminLogin";
import { BatchPage } from "./BatchPage";
import { DocumentsAdmin } from "./DocumentsAdmin";
import { GenerateBatch } from "./GenerateBatch";
import { StudentsAdmin } from "./StudentsAdmin";
import { TemplateEditor } from "./TemplateEditor";

/** Área admin inteira num chunk carregado sob demanda: o tema (CSS e layout) fica fora do pacote dos responsáveis. */
export default function AdminArea() {
  return (
    <Routes>
      <Route path="login" element={<AdminLogin />} />
      <Route element={<AdminLayout />}>
        <Route index element={<AdminHome />} />
        <Route path="alunos" element={<StudentsAdmin />} />
        <Route path="documentos" element={<DocumentsAdmin />} />
        <Route path="documentos/modelos/novo" element={<TemplateEditor />} />
        <Route path="documentos/modelos/:id" element={<TemplateEditor />} />
        <Route path="documentos/gerar/:templateId" element={<GenerateBatch />} />
        <Route path="documentos/lotes/:id" element={<BatchPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/admin" replace />} />
    </Routes>
  );
}
