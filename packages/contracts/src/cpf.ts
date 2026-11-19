import { z } from "zod";

/** 11 dígitos com os dois verificadores corretos; sequências repetidas (111…) são inválidas. */
export function isValidCpf(digits: string): boolean {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  const n = [...digits].map(Number);
  const check = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i += 1) sum += n[i]! * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return check(9) === n[9] && check(10) === n[10];
}

/** Aceita "529.982.247-25" ou "52998224725"; devolve só os dígitos. */
export const Cpf = z
  .string()
  .transform((s) => s.replace(/[.\-\s]/g, ""))
  .pipe(z.string().regex(/^\d{11}$/).refine(isValidCpf, "invalid cpf"));

export function maskCpf(digits: string): string {
  return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`;
}

export function formatCpf(digits: string): string {
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
}
