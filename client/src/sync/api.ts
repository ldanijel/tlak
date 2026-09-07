export interface AuthState { token: string; email: string; sessionId: string }

const KEY = 'tlak.auth';

export function loadAuth(): AuthState | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as AuthState) : null;
  } catch {
    return null;
  }
}
export function saveAuth(a: AuthState | null): void {
  try {
    if (a) localStorage.setItem(KEY, JSON.stringify(a));
    else localStorage.removeItem(KEY);
  } catch { /* privatni način rada */ }
}

export class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

export const ERROR_TEXT: Record<string, string> = {
  bad_credentials: 'Neispravna e-pošta ili lozinka.',
  email_taken: 'Račun s tom e-poštom već postoji.',
  invalid_credentials_format: 'Unesite ispravnu e-poštu i lozinku od najmanje 8 znakova.',
  registration_disabled: 'Registracija novih računa nije dopuštena na ovom poslužitelju.',
  bad_invite_code: 'Pozivni kod nije ispravan.',
  too_many_attempts: 'Previše pokušaja. Pokušajte ponovno za 15 minuta.',
  unauthorized: 'Sesija je istekla. Prijavite se ponovno.',
  network: 'Nema veze s poslužiteljem.',
  server_error: 'Greška poslužitelja.',
};

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return ERROR_TEXT[e.code] || `Greška (${e.status}).`;
  return ERROR_TEXT.network;
}

export async function api<T>(method: string, path: string, body?: unknown, token?: string | null): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network');
  }
  let json: { error?: string } & T;
  try {
    json = (await res.json()) as typeof json;
  } catch {
    throw new ApiError(res.status, 'server_error');
  }
  if (!res.ok) throw new ApiError(res.status, json?.error || 'server_error');
  return json;
}

export function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Preglednik';
}
