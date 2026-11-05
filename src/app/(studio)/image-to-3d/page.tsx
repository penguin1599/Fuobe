import type { Metadata } from "next";
import { Model3dStudio, type Model3dInfo } from "@/components/model3d/model3d-studio";
import { ALL_MODELS_3D, MODEL3D_SETUPS, RIG_MODEL } from "@/lib/av/model3d";
import { HI3D_MODEL } from "@/lib/av/hi3d";
import { getModel } from "@/lib/catalog";
import { exampleRow } from "@/lib/examples/catalog";
import { ownSetupsNow } from "@/server/own-setup-live";

export const metadata: Metadata = { title: "Image to 3D" };

/**
 * The page passes the 3D models' names, so the client doesn't load the catalog, and what each extra step needs from a
 * visitor (its own GPU) until its graphs are validated on this studio's GPU.
 */
export default function Page() {
  const info: Record<string, Model3dInfo> = Object.fromEntries([...ALL_MODELS_3D.map((m) => m.id), RIG_MODEL, HI3D_MODEL].map((id) => [id, { name: getModel(id)?.name ?? id }]));
  const keys = Object.keys(MODEL3D_SETUPS) as (keyof typeof MODEL3D_SETUPS)[];
  const now = ownSetupsNow(keys.map((k) => MODEL3D_SETUPS[k]));
  const setups = Object.fromEntries(keys.map((k) => [k, now[MODEL3D_SETUPS[k]]]));
  return <Model3dStudio info={info} setups={setups} examples={exampleRow("tool:image-to-3d")} />;
}
