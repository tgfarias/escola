import { StaffMeResponse } from "@app-lanche/contracts";
import { useEffect, useRef, useState } from "react";
import { Outlet, useNavigate, useOutletContext } from "react-router";
import { Alert } from "reactstrap";
import { z } from "zod";
import { ApiError, apiFetch } from "../../app/api";
import { AppShell } from "../../theme/layout/AppShell";
import { staffErrorMessage } from "../../ui/messages";
import { adminNav, ROLE_LABELS } from "./adminNav";

/** O que o layout passa às páginas pelo Outlet: o usuário de GET /me (null enquanto carrega ou se falhou). */
export type AdminOutletContext = { me: StaffMeResponse | null; meFailed: boolean };

/** Usuário logado, buscado uma vez pelo AdminLayout. */
export function useAdminMe(): AdminOutletContext {
  return useOutletContext<AdminOutletContext>();
}

/** Moldura das páginas do admin: cabeçalho com escola e usuário, menu lateral e "Sair". Busca GET /me uma vez. */
export function AdminLayout() {
  const navigate = useNavigate();
  // useNavigate muda a cada navegação: a busca de /me não pode depender dele, senão repete a cada página.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const [me, setMe] = useState<StaffMeResponse | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/admin/v1/me", StaffMeResponse).then(setMe, (err: unknown) => {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        navigateRef.current("/admin/login", { replace: true });
      } else {
        setMeError(staffErrorMessage(err instanceof ApiError ? err.code : "internal_error"));
      }
    });
  }, []);

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
      {meError && (
        <Alert color="danger" fade={false}>
          {meError}
        </Alert>
      )}
      {logoutError && (
        <Alert color="danger" fade={false}>
          {logoutError}
        </Alert>
      )}
      <Outlet context={{ me, meFailed: meError !== null } satisfies AdminOutletContext} />
    </AppShell>
  );
}
