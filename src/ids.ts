/**
 * Valide un préfixe d'id (UUID) fourni par le modèle avant un LIKE.
 * Rejette la chaîne vide et les jokers LIKE (% _), exige ≥ 4 caractères hex/tiret.
 */
export function normalizeIdPrefix(raw: string): string | null {
  const p = raw.trim().toLowerCase();
  return /^[0-9a-f-]{4,}$/.test(p) ? p : null;
}
