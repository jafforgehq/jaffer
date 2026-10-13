/**
 * A file whose path alone is not to be kept, not even redacted: keys, credentials and secrets (`.ssh/`, `.env*`, `*.pem`, ...). Any part
 * of the path counts, case-insensitively (the Mac's disks are). It runs on the daemon's main thread over a hook payload, so a path longer
 * than 4096 characters is not read through at all (it counts as sensitive), and each part is matched by an anchored pattern or a fixed
 * ending; the two files known by their folder (`.kube/config`, `.docker/config.json`) start with a fixed text.
 */
const SENSITIVE_PART = /^(?:\.ssh|\.gnupg|\.aws|\.netrc|\.npmrc|\.pypirc|\.git-credentials)$|^(?:\.env|id_rsa|id_ed25519|id_ecdsa|id_dsa|credentials)|\.(?:pem|key|p12|pfx)(?:\.|$)|\.keychain/i;
const SENSITIVE_FILE = /(?:^|\/)(?:\.kube\/config|\.docker\/config\.json)/i;
const MAX_PATH = 4096;

export function isSensitivePath(p: string): boolean {
  if (p.length > MAX_PATH) return true; // fails closed
  return SENSITIVE_FILE.test(p) || p.split('/').some((part) => SENSITIVE_PART.test(part));
}
