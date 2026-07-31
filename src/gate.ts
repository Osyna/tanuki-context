// Filename gate: refuse credential-shaped paths unless override flag is set.

const SENSITIVE_BASENAME =
  /^\.env(\..+)?$|credential|secret|^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$|\.pem$|\.p12$|\.pfx$|\.keystore$|\.jks$|^\.netrc$|^\.npmrc$|^\.pypirc$|\.kdbx$|^known_hosts$|^\.htpasswd$|\.tfstate(\.backup)?$/i;

const SENSITIVE_COMPONENTS: Record<string, true> = { ".aws": true, ".ssh": true, ".gnupg": true, ".kube": true };

export function isSensitivePath(p: string): boolean {
  // basename match (case-insensitive)
  const lastSlash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  const base = lastSlash === -1 ? p : p.slice(lastSlash + 1);
  if (SENSITIVE_BASENAME.test(base.toLowerCase())) return true;

  // path component match (exact)
  const parts = p.split(/[/\\]/);
  for (let i = 0; i < parts.length; i++) {
    if (SENSITIVE_COMPONENTS[parts[i]]) return true;
  }
  return false;
}
