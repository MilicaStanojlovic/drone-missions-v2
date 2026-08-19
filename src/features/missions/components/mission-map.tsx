"use client";

import dynamic from "next/dynamic";

/**
 * The flight map, loaded browser-only.
 *
 * Leaflet reaches for `window`/`document` as soon as it is imported and then
 * drives a real DOM node, so the implementation (`mission-map.view.tsx`) must
 * never be evaluated during a server render. `next/dynamic` with `ssr: false`
 * is this stack's equivalent of the Angular app's "the map only exists in the
 * browser" assumption: the server renders the placeholder below, and the map
 * module is fetched and mounted on the client.
 *
 * Every consumer imports `MissionMap` from here; `mission-map.view.tsx` is an
 * implementation detail. Props and modes are re-exported so a call site needs
 * only this module.
 *
 * SOURCE: drone-missions-frontend/.../components/mission-map/mission-map.component.ts
 */

export type { MissionMapMode, MissionMapProps } from "./mission-map.view";

export const MissionMap = dynamic(
  () => import("./mission-map.view").then((module) => module.MissionMapView),
  {
    ssr: false,
    // Same flat tile-coloured box the map itself sits on (`.map`'s background
    // in the Angular component), so nothing shifts when it swaps in.
    loading: () => <div className="h-full w-full bg-[#eef1ec]" />,
  },
);
