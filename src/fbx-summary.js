import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { Vector3 } from 'three';

const loader = new FBXLoader();
const output = document.getElementById('report');

async function load(file) {
  const object = await loader.loadAsync(`/models/${file}`);
  object.updateMatrixWorld(true);

  let body = null;
  object.traverse(child => {
    if (child.isSkinnedMesh && child.name === 'Body') {
      body = child;
    }
  });

  if (!body) throw new Error(`Body mesh not found in ${file}`);

  const bones = body.skeleton.bones.map(bone => ({
    name: bone.name,
    parent: bone.parent?.name || null,
    position: bone.position.toArray(),
    quaternion: bone.quaternion.toArray(),
    scale: bone.scale.toArray(),
    worldPosition: bone.getWorldPosition(
      new Vector3()
    ).toArray()
  }));

  return {
    file,
    boneCount: bones.length,
    bindMatrix: body.bindMatrix.toArray(),
    bindMatrixInverse: body.bindMatrixInverse.toArray(),
    bones
  };
}

async function run() {
  try {
    const punch = await load('punch.fbx');
    const kick = await load('kick.fbx');

    const kickBones = new Map(kick.bones.map(b => [b.name, b]));

    const comparisons = punch.bones.map(a => {
      const b = kickBones.get(a.name);

      if (!b) return {
        bone: a.name,
        status: 'MISSING IN KICK'
      };

      const difference = (x, y) =>
        Math.max(...x.map((value, i) => Math.abs(value - y[i])));

      return {
        bone: a.name,
        parentMatches: a.parent === b.parent,
        positionDifference: difference(a.position, b.position),
        rotationDifference: difference(a.quaternion, b.quaternion),
        scaleDifference: difference(a.scale, b.scale),
        worldPositionDifference: difference(a.worldPosition, b.worldPosition)
      };
    });

    const result = {
      punchBoneCount: punch.boneCount,
      kickBoneCount: kick.boneCount,
      missingInKick: punch.bones.filter(
        b => !kick.bones.some(k => k.name === b.name)
      ).map(b => b.name),
      missingInPunch: kick.bones.filter(
        b => !punch.bones.some(p => p.name === b.name)
      ).map(b => b.name),
      bindMatrixDifference: punch.bindMatrix.map(
        (v, i) => Math.abs(v - kick.bindMatrix[i])
      ),
      comparisons
    };

    output.textContent = JSON.stringify(result, null, 2);
    console.log('SKELETON COMPARISON:', result);
  } catch (error) {
    output.textContent = error.stack || String(error);
    console.error(error);
  }
}

run();
