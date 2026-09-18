/**
 * Copy for the PUBLIC auth pages (/forgot-password, /reset-password).
 *
 * A gym member who tapped a link in a Spanish email lands here, usually on a phone, often
 * without the app installed. The copy therefore
 * defaults to Spanish — matching the reset email — while staying a plain dictionary so
 * another language is a data change rather than a rewrite. Nothing here names a studio;
 * the studio's own name arrives at runtime through branding.
 */

export type PublicAuthLocale = "es" | "en";

export const DEFAULT_PUBLIC_AUTH_LOCALE: PublicAuthLocale = "es";

type ForgotCopy = {
  title: string;
  subtitle: (brand: string) => string;
  emailLabel: string;
  emailPlaceholder: string;
  submit: string;
  submitting: string;
  sentTitle: string;
  /** The server's generic answer — identical whether or not the account exists. */
  sentBody: string;
  sentHint: string;
  backToApp: string;
  emptyEmail: string;
  invalidEmail: string;
  tooMany: string;
  network: string;
  unavailable: string;
};

type ResetCopy = {
  title: string;
  subtitle: (minLength: number) => string;
  passwordLabel: string;
  passwordPlaceholder: (minLength: number) => string;
  confirmLabel: string;
  confirmPlaceholder: string;
  tokenLabel: string;
  tokenPlaceholder: string;
  submit: string;
  submitting: string;
  loading: string;
  successTitle: string;
  successBody: string;
  successNextApp: string;
  successNextWeb: string;
  missingToken: string;
  tooShort: (minLength: number) => string;
  mismatch: string;
  tooMany: string;
  network: string;
  unavailable: string;
  requestNewLink: string;
  openApp: string;
};

export const FORGOT_COPY: Record<PublicAuthLocale, ForgotCopy> = {
  es: {
    title: "¿Olvidaste tu contraseña?",
    subtitle: (brand) => `Te enviaremos un enlace para crear una nueva contraseña de ${brand}.`,
    emailLabel: "Correo",
    emailPlaceholder: "tu@correo.com",
    submit: "Enviar instrucciones",
    submitting: "Enviando…",
    sentTitle: "Revisa tu correo",
    sentBody:
      "Si existe una cuenta asociada a este correo, recibirás instrucciones para restablecer tu contraseña.",
    sentHint:
      "El enlace caduca en 30 minutos y solo puede usarse una vez. Si no lo encuentras, revisa tu carpeta de spam.",
    backToApp: "Volver",
    emptyEmail: "Ingresa tu correo.",
    invalidEmail: "Ingresa un correo válido.",
    tooMany: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.",
    network: "No pudimos enviar el correo. Revisa tu conexión e inténtalo de nuevo.",
    unavailable:
      "El restablecimiento de contraseña no está disponible. Contacta a tu estudio para recuperar tu acceso.",
  },
  en: {
    title: "Forgot your password?",
    subtitle: (brand) => `We'll email you a link to set a new ${brand} password.`,
    emailLabel: "Email",
    emailPlaceholder: "you@email.com",
    submit: "Send instructions",
    submitting: "Sending…",
    sentTitle: "Check your email",
    sentBody:
      "If an account exists for that address, you will receive instructions to reset your password.",
    sentHint:
      "The link expires in 30 minutes and can only be used once. If you don't see it, check your spam folder.",
    backToApp: "Back",
    emptyEmail: "Enter your email.",
    invalidEmail: "Enter a valid email address.",
    tooMany: "Too many attempts. Wait a few minutes and try again.",
    network: "Could not send the email. Check your connection and try again.",
    unavailable: "Password reset is unavailable. Contact your studio to regain access.",
  },
};

export const RESET_COPY: Record<PublicAuthLocale, ResetCopy> = {
  es: {
    title: "Nueva contraseña",
    subtitle: (min) => `Elige una contraseña de al menos ${min} caracteres.`,
    passwordLabel: "Nueva contraseña",
    passwordPlaceholder: (min) => `Mínimo ${min} caracteres`,
    confirmLabel: "Confirmar contraseña",
    confirmPlaceholder: "Repite tu contraseña",
    tokenLabel: "Código del correo",
    tokenPlaceholder: "Pega aquí el código del enlace",
    submit: "Guardar contraseña",
    submitting: "Guardando…",
    loading: "Cargando…",
    successTitle: "Listo",
    successBody: "Tu contraseña se actualizó correctamente.",
    successNextApp: "Abre la app e inicia sesión con tu nueva contraseña.",
    successNextWeb: "Ya puedes iniciar sesión con tu nueva contraseña.",
    openApp: "Abrir la app",
    missingToken: "Falta el código de restablecimiento. Abre el enlace desde tu correo.",
    tooShort: (min) => `La contraseña debe tener al menos ${min} caracteres.`,
    mismatch: "Las contraseñas no coinciden.",
    tooMany: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.",
    network: "No pudimos actualizar tu contraseña. Revisa tu conexión e inténtalo de nuevo.",
    unavailable:
      "El restablecimiento de contraseña no está disponible. Contacta a tu estudio para recuperar tu acceso.",
    requestNewLink: "Solicitar un enlace nuevo",
  },
  en: {
    title: "New password",
    subtitle: (min) => `Choose a password of at least ${min} characters.`,
    passwordLabel: "New password",
    passwordPlaceholder: (min) => `At least ${min} characters`,
    confirmLabel: "Confirm password",
    confirmPlaceholder: "Repeat your password",
    tokenLabel: "Code from your email",
    tokenPlaceholder: "Paste the code from the link",
    submit: "Save password",
    submitting: "Saving…",
    loading: "Loading…",
    successTitle: "Done",
    successBody: "Your password was updated successfully.",
    successNextApp: "Open the app and sign in with your new password.",
    successNextWeb: "You can now sign in with your new password.",
    openApp: "Open the app",
    missingToken: "This link is missing its reset code. Open the link from your email.",
    tooShort: (min) => `Use at least ${min} characters.`,
    mismatch: "The passwords do not match.",
    tooMany: "Too many attempts. Wait a few minutes and try again.",
    network: "Could not update your password. Check your connection and try again.",
    unavailable: "Password reset is unavailable. Contact your studio to regain access.",
    requestNewLink: "Request a new link",
  },
};

/** Shared with the API's policy (PASSWORD_MIN_LENGTH); shown only as guidance. */
export const PUBLIC_MIN_PASSWORD_LENGTH = 8;
