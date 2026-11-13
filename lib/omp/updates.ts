import { getOmpVersion } from "./omp-cli";

export const OMP_RUNTIME_UPDATE_LOCK_REASON = "OMP is maintained from source. Build and install the maintained fork to update this runtime.";

export interface OmpUpdateStatus {
  currentVersion: string | null;
  availableVersion: null;
  updateAvailable: false;
  updateCommand: null;
  updatesDisabled: true;
  reason: "source_managed";
}

/** This web fork requires its paired OMP runtime; refresh only the local version. */
export async function checkOmpUpdate(): Promise<OmpUpdateStatus> {
  return {
    currentVersion: await getOmpVersion(),
    availableVersion: null,
    updateAvailable: false,
    updateCommand: null,
    updatesDisabled: true,
    reason: "source_managed",
  };
}
