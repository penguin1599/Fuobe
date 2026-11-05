"use client";

import { createContext, useContext } from "react";
import { useIsOwner } from "@/lib/api";
import type { Model3dSetupKey } from "@/lib/av/model3d";
import type { OwnSetup } from "@/lib/own-setup";

/**
 * What Image to 3D's extra steps need from a visitor, as the page read it (ownSetupsNow): a step whose graphs are
 * validated on this studio's GPU has none, so its label has left.
 */
export type Model3dSetups = Partial<Record<Model3dSetupKey, OwnSetup | null>>;

const Setups = createContext<Model3dSetups>({});

export const Model3dSetupsProvider = Setups.Provider;

/** A step's label for this viewer: null for the owner (today's view), and once the step needs nothing more. */
export function useModel3dSetup(key: Model3dSetupKey): OwnSetup | null {
  const owner = useIsOwner();
  const setups = useContext(Setups);
  return owner ? null : (setups[key] ?? null);
}
