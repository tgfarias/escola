import { StaffMeResponse } from "@app-lanche/contracts";
import { useEffect, useState } from "react";
import { Outlet, useNavigate } from "react-router";
import { Alert } from "reactstrap";
import { z } from "zod";
import { ApiError, apiFetch } from "../../app/api";
import { AppShell } from "../../theme/layout/AppShell";
import { staffErrorMessage } from "../../ui/messages";
import { adminNav, ROLE_LABELS } from "./adminNav";

/** Moldura das páginas do admin: cabeçalho com escola e usuário, menu lateral e "Sair". */
export function AdminLayout() {
  const navigate = useNavigate();
  const [me, setMe] = useState<StaffMeResponse | null>(null);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/admin/v1/me", StaffMeResponse).then(setMe, (err: unknown) => {
      // Sem sessão: mesmo destino da página inicial. Outros erros ficam com as páginas, que mostram os seus.
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) navigate("/admin/login", { replace: true });
    });
  }, [navigate]);

  async function logout() {
    setLogoutError(null);
    try {
      await apiFetch("/api/admin/v1/auth/logout", z.undefined(), { method: "POST" });
      navigate("/admin/login", { replace: true });
    } catch (err) {
      setLogoutError(staffErrorMessage(err instanceof ApiError ? err.code : "internal_error"));
    }
  }

  return (
    <AppShell
      nav={adminNav(me?.role)}
      schoolName={me?.schoolName}
      user={me ? { email: me.email, roleLabel: ROLE_LABELS[me.role] } : undefined}
      onLogout={() => void logout()}
    >
      {logoutError && (
        <Alert color="danger" fade={false}>
          {logoutError}
        </Alert>
      )}
      <Outlet />
    </AppShell>
  );
}
