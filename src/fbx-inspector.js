import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const loader = new FBXLoader();
const output = document.getElementById('output');
const status = document.getElementById('status');

function inspect(filename, object) {
  const result = {
    filename,
    animations: [],
    meshes: [],
    skeletons: []
  };

  const skeletons = new Set();

  object.traverse(child => {
    if (child.isSkinnedMesh) {
      skeletons.add(child.skeleton);

      result.meshes.push({
        name: child.name,
        type: 'SkinnedMesh',
        vertices: child.geometry.attributes.position?.count,
        boneCount: child.skeleton.bones.length,
        bindMatrix: child.bindMatrix.elements
      });
    } else if (child.isMesh) {
      result.meshes.push({
        name: child.name,
        type: 'Mesh'
      });
    }
  });

  for (const skeleton of skeletons) {
    result.skeletons.push({
      boneCount: skeleton.bones.length,
      bones: skeleton.bones.map((bone, index) => ({
        index,
        name: bone.name,
        parent: bone.parent?.name,
        position: bone.position.toArray(),
        quaternion: bone.quaternion.toArray(),
        scale: bone.scale.toArray(),
        inverseBindMatrix:
          skeleton.boneInverses[index].elements
      }))
    });
  }

  result.animations = object.animations.map((clip, index) => ({
    index,
    name: clip.name,
    duration: clip.duration,
    trackCount: clip.tracks.length,
    tracks: clip.tracks.map(track => ({
      name: track.name,
      type: track.ValueTypeName,
      keyframes: track.times.length,
      valueSize: track.getValueSize()
    }))
  }));

  return result;
}

async function main() {
  const files = [
    'fighter.fbx',
    'idle.fbx',
    'punch.fbx',
    'kick.fbx'
  ];

  const reports = [];

  for (const filename of files) {
    status.textContent = `Loading ${filename}...`;

    try {
      const object = await loader.loadAsync(
        `/models/${filename}`
      );

      const report = inspect(filename, object);
      reports.push(report);

      console.log(`REPORT: ${filename}`, report);
    } catch (error) {
      console.error(`FAILED: ${filename}`, error);

      reports.push({
        filename,
        error: error.message
      });
    }
  }

  window.FBX_REPORT = reports;

  output.textContent = JSON.stringify(reports, null, 2);
  status.textContent = 'All FBX inspection attempts completed.';
}

main();
