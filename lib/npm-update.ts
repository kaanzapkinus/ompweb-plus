import packageJson from "../package.json";

export interface NpmUpdateStatus {
  currentVersion: string;
  availableVersion: string | null;
  updateAvailable: boolean;
  updateCommand: string;
  updatesDisabled?: boolean;
}

/** Source releases are never replaced by a package from a registry. Stop the
 * service before running this command in its clean checkout, then restart it. */
export async function checkNpmUpdate(_force = false): Promise<NpmUpdateStatus> {
  void _force; // Retain the check API without making a network request.
  return {
    currentVersion: packageJson.version,
    availableVersion: null,
    updateAvailable: false,
    updateCommand: "git pull --ff-only && npm ci && npm run build",
    updatesDisabled: true,
  };
}
