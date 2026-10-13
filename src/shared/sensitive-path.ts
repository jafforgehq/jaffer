/**
 * A file whose path alone is not to be kept, not even redacted: keys, credentials and secrets (`.ssh/`, `.env*`, `*.pem`, ...). Any part
 * of the path counts, case-insensitively (the Mac's disks are). It runs on the daemon's main thread over a hook payload, so it reads only
 * the first 4096 characters, and each part is matched by an anchored pattern or a fixed ending.
 */
const SENSITIVE_PART = /^(?:\.ssh|\.gnupg|\.aws|\.netrc|\.npmrc|\.pypirc)$|^(?:\.env|id_rsa|id_ed25519|credentials)|\.(?:pem|key)$|\.keychain/i;

export function isSensitivePath(p: string): boolean {
  return p.slice(0, 4096).split('/').some((part) => SENSITIVE_PART.test(part));
}
