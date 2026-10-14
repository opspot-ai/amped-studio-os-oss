/**
 * The deployed commit sha, for health and readiness output.
 *
 * `OPSPOT_KERNEL_VERSION` was pinned to a sha from the old sanitized public repo that does not
 * exist in this repository, so health reported a commit that had never been deployed. The real
 * deployed sha wins over any hand-set value; the env var is only a fallback for environments that
 * set it deliberately, and an honest "development" is preferred over a stale lie.
 */
export function kernelVersion(): string {
  const deployed = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
  if (deployed) return deployed;
  const configured = process.env.OPSPOT_KERNEL_VERSION?.trim();
  if (configured) return configured;
  return "development";
}
