import { DocumentDownloadResponse, GuardianDocumentListResponse } from "@app-lanche/contracts";
import { useEffect, useState } from "react";
import { ApiError, apiFetch } from "../../app/api";
import { formatInstantDate } from "../../ui/dates";
import { errorMessage } from "../../ui/messages";

type Doc = GuardianDocumentListResponse["documents"][number];
const codeOf = (err: unknown) => (err instanceof ApiError ? err.code : "internal_error");

export function DocumentsPage() {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ id: string; url: string } | null>(null);

  useEffect(() => {
    apiFetch("/api/v1/documents", GuardianDocumentListResponse).then(
      (r) => setDocs(r.documents),
      (err) => setError(errorMessage(codeOf(err))),
    );
  }, []);

  async function open(doc: Doc) {
    setError(null);
    try {
      const r = await apiFetch(`/api/v1/documents/${doc.id}/download`, DocumentDownloadResponse, { method: "POST" });
      setOpened({ id: doc.id, url: r.url });
      setDocs((ds) => ds?.map((d) => (d.id === doc.id ? { ...d, viewed: true } : d)) ?? ds);
      window.open(r.url, "_blank", "noopener");
    } catch (err) {
      setError(codeOf(err) === "not_found" ? "Documento não encontrado." : errorMessage(codeOf(err)));
    }
  }

  if (!docs) return <main>{error ? <p role="alert">{error}</p> : <p>Carregando…</p>}</main>;

  return (
    <main>
      <h1>Documentos</h1>
      {error && <p role="alert">{error}</p>}
      {docs.length === 0 ? (
        <p>Nenhum documento publicado por enquanto.</p>
      ) : (
        <ul>
          {docs.map((d) => (
            <li key={d.id}>
              <strong>{d.title}</strong> — {d.studentFirstName} · publicado em {formatInstantDate(d.publishedAt)}
              {!d.viewed && <> · <span>novo</span></>}{" "}
              <button type="button" aria-label={`Abrir ${d.title} de ${d.studentFirstName}`} onClick={() => void open(d)}>Abrir</button>
              {opened?.id === d.id && (
                <a href={opened.url} target="_blank" rel="noopener">Se o PDF não abriu, toque aqui</a>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
