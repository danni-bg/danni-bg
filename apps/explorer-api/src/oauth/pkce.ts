// PKCE (RFC 7636) verification for the OAuth authorization-code flow (spec 063). OAuth 2.1 requires
// PKCE; danni accepts only the S256 method. The authorize request stores the client's
// `code_challenge`; the token request presents the `code_verifier`, and this checks
// base64url(SHA-256(verifier)) === challenge in constant time.

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** Constant-time string comparison (avoids leaking the challenge via timing). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Compute the S256 challenge for a verifier (used to build authorize requests in tests). */
export async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/** Verify a PKCE S256 code_verifier against the stored code_challenge. */
export async function verifyPkceS256(verifier: string, challenge: string): Promise<boolean> {
  if (!verifier || !challenge) return false;
  return timingSafeEqual(await s256Challenge(verifier), challenge);
}
