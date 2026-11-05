"use client";

import type { TriMesh } from "@/lib/print3d";

/**
 * Every triangle of a GLB in world space (each mesh's transform applied), read with three.js in the browser. Loaded
 * only when the Print-ready dialog asks for it, so the page doesn't carry three.js.
 */
export async function glbTriangles(url: string): Promise<TriMesh> {
  const [THREE, { GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
    import("three"),
    import("three/examples/jsm/loaders/GLTFLoader.js"),
    import("three/examples/jsm/libs/meshopt_decoder.module.js"),
  ]);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url);
  gltf.scene.updateMatrixWorld(true);
  const positions: number[] = [];
  const indices: number[] = [];
  const v = new THREE.Vector3();
  gltf.scene.traverse((o) => {
    const mesh = o as InstanceType<typeof THREE.Mesh>;
    if (!mesh.isMesh || !mesh.geometry) return;
    const pos = mesh.geometry.getAttribute("position");
    if (!pos) return;
    const base = positions.length / 3;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      positions.push(v.x, v.y, v.z);
    }
    const index = mesh.geometry.getIndex();
    if (index) for (let i = 0; i < index.count; i++) indices.push(base + index.getX(i));
    else for (let i = 0; i < pos.count; i++) indices.push(base + i);
  });
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}
