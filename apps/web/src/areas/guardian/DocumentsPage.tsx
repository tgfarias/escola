import { DocumentDownloadResponse, GuardianDocumentListResponse } from "@app-lanche/contracts";
import { useEffect, useState } from "react";
import { ApiError, apiFetch } from "../../app/api";
import { formatInstantDate } from "../../ui/dates";
import { errorMessage } from "../../ui/messages";
import { GuardianPending, GuardianShell } from "./GuardianShell";

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

  if (!docs) return <GuardianPending error={error} />;

  return (
    <GuardianShell>
      <h1>Documentos</h1>
      {error && (
        <p role="alert" className="g-alert">
          {error}
        </p>
      )}
      {docs.length === 0 ? (
        <p className="g-card g-muted">Nenhum documento publicado por enquanto.</p>
      ) : (
        <section className="g-card py-0">
          <ul className="g-list">
            {docs.map((d) => (
              <li key={d.id}>
                <div className="d-flex align-items-center justify-content-between gap-2">
                  <span>
                    <strong>{d.title}</strong>
                    {!d.viewed && <span className="g-tag g-tag--warn">novo</span>}
                    <br />
                    <span className="g-muted">
                      {d.studentFirstName} · publicado em {formatInstantDate(d.publishedAt)}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-primary"
                    aria-label={`Abrir ${d.title} de ${d.studentFirstName}`}
                    onClick={() => void open(d)}
                  >
                    Abrir
                  </button>
                </div>
                {opened?.id === d.id && (
                  <a className="d-inline-block mt-2" href={opened.url} target="_blank" rel="noopener">
                    Se o PDF não abriu, toque aqui
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </GuardianShell>
  );
}
