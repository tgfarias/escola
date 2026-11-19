import type { BatchStatus, DocumentCategory, DocumentStatus } from "@app-lanche/contracts";

export const CATEGORY_LABELS: Record<DocumentCategory, string> = {
  declaracao: "Declaração",
  comunicado: "Comunicado",
  autorizacao: "Autorização",
  outro: "Outro",
};

export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = {
  rendering: "Gerando PDFs",
  ready: "Pronto para publicar",
  published: "Publicado",
};

export const DOCUMENT_STATUS_LABELS: Record<DocumentStatus, string> = {
  pending: "Na fila",
  rendering: "Gerando",
  rendered: "Pronto",
  failed: "Falhou",
};
