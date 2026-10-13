import { cancelShare, useShares } from "proscenium";

/** The number of running screen shares, and a function that stops them all. */
export function useSharing(): { count: number; stopAll: () => void } {
  const running = useShares().filter((share) => share.source !== null);
  return {
    count: running.length,
    stopAll: () => running.forEach((share) => cancelShare(share.id)),
  };
}
