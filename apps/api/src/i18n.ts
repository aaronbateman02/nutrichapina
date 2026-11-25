// Bilingual API error strings. Client renders by code; message is a fallback, never PHI.
type Locale = 'en' | 'es';
const STR: Record<string, { en: string; es: string }> = {
  invalid_input: { en: 'Invalid request.', es: 'Solicitud inválida.' },
  unauthorized: { en: 'Sign in required.', es: 'Debes iniciar sesión.' },
  forbidden: { en: 'Not allowed.', es: 'No permitido.' },
  not_found: { en: 'Not found.', es: 'No encontrado.' },
  conflict: { en: 'Already exists.', es: 'Ya existe.' },
  expired: { en: 'Link expired or already used.', es: 'El enlace expiró o ya se usó.' },
  bad_credentials: { en: 'Email or password is incorrect.', es: 'El correo o la contraseña son incorrectos.' },
  unverified: { en: 'Verify your email first.', es: 'Verifica tu correo primero.' },
  locked: { en: 'Too many attempts. Try again later.', es: 'Demasiados intentos. Inténtalo más tarde.' },
  server_error: { en: 'Something went wrong.', es: 'Algo salió mal.' },
};

export function pickLocale(header: string | undefined, q: string | undefined): Locale {
  const v = (q || header || '').toLowerCase();
  return v.startsWith('es') ? 'es' : 'en';
}

export function msg(code: string, locale: Locale): string {
  return STR[code]?.[locale] ?? STR.server_error[locale];
}
