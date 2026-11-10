/**
 * An output's camera for the few things drawn from it: the minimap, and marks
 * that keep their width at any zoom. The compositor moves cameras itself and
 * reports where they are up to sixty times a second while one is dragged; a
 * feed passes that on a few times a second, to its readers alone, so a pan
 * renders nothing else. While the camera is still it does nothing.
 */

import { useEffect, useSyncExternalStore } from "react";
import { useCamera, type CameraInfo } from "proscenium";

/** How often a moving camera is passed on, in milliseconds. */
const feedInterval = 60;

export interface CameraFeed {
  subscribe: (listener: () => void) => () => void;
  /** The camera as last passed on, in the world; null before the compositor has reported it. */
  camera: () => CameraInfo | null;
  zoom: () => number;
  push: (camera: CameraInfo) => void;
  stop: () => void;
}

export function createCameraFeed(): CameraFeed {
  const listeners = new Set<() => void>();
  let published: CameraInfo | null = null;
  let latest: CameraInfo | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const publish = () => {
    published = latest;
    for (const listener of listeners) listener();
    // Whatever arrives in the meantime waits for this to pass.
    timer = setTimeout(() => {
      timer = undefined;
      if (latest !== published) publish();
    }, feedInterval);
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    camera: () => published,
    zoom: () => published?.zoom ?? 1,
    push: (camera) => {
      latest = camera;
      if (timer === undefined) publish();
    },
    stop: () => {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** Feeds OUTPUT's camera to FEED. It draws nothing, so the reports it wakes for cost no more than itself. */
export function CameraWatcher({ output, feed }: { output: string; feed: CameraFeed }) {
  const camera = useCamera(output);
  useEffect(() => {
    if (camera) feed.push(camera);
  }, [camera, feed]);
  useEffect(() => feed.stop, [feed]);
  return null;
}

/** The camera FEED last passed on. */
export function useFeedCamera(feed: CameraFeed): CameraInfo | null {
  return useSyncExternalStore(feed.subscribe, feed.camera);
}

/** The zoom FEED last passed on: its reader renders again only when the zoom changes. */
export function useFeedZoom(feed: CameraFeed): number {
  return useSyncExternalStore(feed.subscribe, feed.zoom);
}
