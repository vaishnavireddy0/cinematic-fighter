import './style.css';

import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

// =====================================================
// 1. SCENE & CAMERA
// =====================================================

const scene = new THREE.Scene();

scene.background = new THREE.Color(0x0a0a0c);
scene.fog = new THREE.FogExp2(0x0a0a0c, 0.01);

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);

camera.position.set(0, 2.2, 6.5);

const cameraPlayerWorld = new THREE.Vector3();
const cameraOpponentWorld = new THREE.Vector3();
const cameraFocusTarget = new THREE.Vector3();
const cameraDesiredPosition = new THREE.Vector3();
const cameraCurrentLookTarget = new THREE.Vector3();
let cinematicCameraStarted = false;


const renderer = new THREE.WebGLRenderer({
  antialias: true
});

renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

document.body.appendChild(renderer.domElement);

// =====================================================
// 2. LIGHTS & ARENA
// =====================================================

const ambientLight = new THREE.AmbientLight(0xffffff, 1.5);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 2.5);
dirLight.position.set(5, 10, 5);
dirLight.castShadow = true;
scene.add(dirLight);

const gridHelper = new THREE.GridHelper(
  30,
  30,
  0xff0055,
  0x333333
);

scene.add(gridHelper);

const floorGeo = new THREE.PlaneGeometry(50, 50);

const floorMat = new THREE.MeshStandardMaterial({
  color: 0x111115,
  roughness: 0.4,
  metalness: 0.8
});

const floor = new THREE.Mesh(floorGeo, floorMat);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// =====================================================
// 3. CHARACTER & ANIMATION STATE
// =====================================================

let mixer = null;
let characterRoot = null;
let opponentRoot = null;
let opponentMixer = null;
const opponentAnimations = {};
let opponentIsAttacking = false;
let opponentAttackCooldown = 0;
const opponentAttackRange = 2.25;
const opponentAttackInterval = 1.6;

const fighterPosition = new THREE.Vector3(-1.5, 0, 0);

// Opponent AI movement settings
const opponentDirection = new THREE.Vector3();
const opponentStopDistance = 1.8;
const opponentMoveSpeed = 1.4;


const animations = {};

let activeAction = null;
let isPerformingAction = false;

// Actual combat state.
const combatState = {
  playerHealth: 100,
  opponentHealth: 100,
  playerAttack: null,
  opponentAttack: null,
  finished: false
};


const fbxLoader = new FBXLoader();

const keys = {
  w: false,
  a: false,
  s: false,
  d: false
};

// =====================================================
// 4. LOAD CHARACTER + CORRECT ANIMATION CLIPS
// =====================================================

async function loadFighter() {
  try {
    console.log('Loading fighter assets...');

    const [character, idleObject, kickObject] =
      await Promise.all([
        fbxLoader.loadAsync('/models/punch.fbx'),
        fbxLoader.loadAsync('/models/idle.fbx'),
        fbxLoader.loadAsync('/models/kick.fbx')
      ]);

    // Master character model
    characterRoot = character;

    characterRoot.scale.setScalar(0.01);
    characterRoot.position.copy(fighterPosition);
    characterRoot.rotation.y = Math.PI / 2;

    characterRoot.traverse(child => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        child.frustumCulled = false;
      }
    });

    scene.add(characterRoot);

    // Temporary skeleton diagnostics.
    const modelBounds = new THREE.Box3().setFromObject(characterRoot);
    const modelSize = modelBounds.getSize(new THREE.Vector3());

    console.log('FIGHTER MODEL DIMENSIONS:', {
      width: modelSize.x,
      height: modelSize.y,
      depth: modelSize.z
    });

    const boneNames = [];
    characterRoot.traverse(child => {
      if (child.isBone) boneNames.push(child.name);
    });

    console.log('FIGHTER SKELETON BONE COUNT:', boneNames.length);
    console.log('FIGHTER SKELETON BONE NAMES:', boneNames);


    // One mixer for the master character
    mixer = new THREE.AnimationMixer(characterRoot);

    // Find valid clips rather than using empty FBX clips
    const idleClip = idleObject.animations.find(
      clip => clip.tracks.length > 0
    );

    const punchClip = character.animations.find(
      clip => clip.tracks.length > 0
    );

    const kickClip = kickObject.animations.find(
      clip => clip.tracks.length > 0
    );

    if (!idleClip || !punchClip || !kickClip) {
      throw new Error('One or more valid animation clips are missing.');
    }

    console.log('Idle clip:', idleClip.name, idleClip.tracks.length);
    console.log('Punch clip:', punchClip.name, punchClip.tracks.length);
    console.log('Kick clip:', kickClip.name, kickClip.tracks.length);

    // Bind all clips to the SAME master character skeleton
    animations.idle = mixer.clipAction(idleClip, characterRoot);
    animations.punch = mixer.clipAction(punchClip, characterRoot);
    animations.kick = mixer.clipAction(kickClip, characterRoot);

    // Create an independent opponent from the same skinned character.
    opponentRoot = cloneSkeleton(characterRoot);
    opponentRoot.position.set(1.5, 0, 0);
    opponentRoot.rotation.y = -Math.PI / 2;
    opponentRoot.scale.copy(characterRoot.scale);

    opponentRoot.traverse(child => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        child.frustumCulled = false;
      }
    });

    scene.add(opponentRoot);

    // Collect reaction bones from both independent skeletons.
    playerReactionBones = collectReactionBones(characterRoot);
    opponentReactionBones = collectReactionBones(opponentRoot);

    console.log('PLAYER REACTION BONES:', playerReactionBones.length);
    console.log('OPPONENT REACTION BONES:', opponentReactionBones.length);

    // Independent opponent animation actions.
    opponentMixer = new THREE.AnimationMixer(opponentRoot);

    opponentAnimations.idle =
      opponentMixer.clipAction(idleClip, opponentRoot);

    opponentAnimations.punch =
      opponentMixer.clipAction(punchClip, opponentRoot);

    opponentAnimations.idle.setLoop(THREE.LoopRepeat, Infinity);

    opponentAnimations.punch.setLoop(THREE.LoopOnce, 1);
    opponentAnimations.punch.clampWhenFinished = true;

    opponentAnimations.idle.play();

    // Return to idle when the opponent punch finishes.
    opponentMixer.addEventListener('finished', event => {
      if (event.action === opponentAnimations.punch) {
        const idle = opponentAnimations.idle;

        idle.reset();
        idle.enabled = true;
        idle.setEffectiveWeight(1);
        idle.play();

        event.action.crossFadeTo(idle, 0.18, false);
        opponentIsAttacking = false;
        combatState.opponentAttack = null;

        console.log('OPPONENT: Punch finished, returning to idle');
      }
    });

    console.log('OPPONENT READY: independent skeleton and mixer');

    // Idle loops continuously
    animations.idle.setLoop(THREE.LoopRepeat, Infinity);
    animations.idle.clampWhenFinished = false;

    // Combat actions play once
    for (const name of ['punch', 'kick']) {
      animations[name].setLoop(THREE.LoopOnce, 1);
      animations[name].clampWhenFinished = true;
    }

    // Start with actual idle.fbx animation
    activeAction = animations.idle;
    activeAction.reset();
    activeAction.setEffectiveWeight(1);
    activeAction.play();

    // Handle combat animation completion
    mixer.addEventListener('finished', event => {
      if (
        event.action === animations.punch ||
        event.action === animations.kick
      ) {
        console.log('Combat animation finished:', event.action.getClip().name);

        transitionToIdle();
      }
    });

    console.log('FIGHTER READY');
    console.log('Master model: punch.fbx');
    console.log('Idle source: idle.fbx [valid clip]');
    console.log('Punch source: punch.fbx [valid clip]');
    console.log('Kick source: kick.fbx [valid clip]');

  } catch (error) {
    console.error('FIGHTER INITIALIZATION FAILED:', error);
  }
}

// =====================================================
// 5. ANIMATION TRANSITIONS
// =====================================================

function transitionTo(nextAction, duration = 0.15) {
  if (!nextAction || activeAction === nextAction) return;

  const previousAction = activeAction;

  nextAction.reset();
  nextAction.enabled = true;
  nextAction.setEffectiveTimeScale(1);
  nextAction.setEffectiveWeight(1);
  nextAction.play();

  if (previousAction) {
    previousAction.crossFadeTo(
      nextAction,
      duration,
      false
    );
  }

  activeAction = nextAction;
}

function transitionToIdle() {
  if (!animations.idle) return;

  transitionTo(animations.idle, 0.18);

  isPerformingAction = false;
  combatState.playerAttack = null;
}

function playAction(name) {
  if (combatState.finished) return;

  const nextAction = animations[name];

  if (!nextAction || isPerformingAction) return;

  if (activeAction === nextAction) return;

  isPerformingAction = true;

  combatState.playerAttack = {
    name,
    hitRegistered: false
  };

  transitionTo(nextAction, 0.15);

  // Slightly faster combat animation
  nextAction.timeScale = 1.1;

  console.log('Playing action:', name);
}

// =====================================================
// 6. KEYBOARD CONTROLS
// =====================================================

window.addEventListener('keydown', event => {
  const key = event.key.toLowerCase();

  if (key in keys) {
    keys[key] = true;
  }

  if (event.repeat) return;

  if (key === 'j') {
    playAction('punch');
  }

  if (key === 'k') {
    playAction('kick');
  }
});

window.addEventListener('keyup', event => {
  const key = event.key.toLowerCase();

  if (key in keys) {
    keys[key] = false;
  }
});

// =====================================================
// 7. RENDER LOOP
// =====================================================

// =====================================================
// OPPONENT AI
// =====================================================

function updateOpponentAI(delta) {
  if (combatState.finished) return;
  if (opponentHitStun > 0) return;

  if (
    !opponentRoot ||
    !characterRoot ||
    !opponentAnimations.idle ||
    !opponentAnimations.punch
  ) return;

  // Cooldown decreases independently of player controls.
  opponentAttackCooldown = Math.max(
    0,
    opponentAttackCooldown - delta
  );

  // Direction from opponent towards player.
  opponentDirection.subVectors(
    fighterPosition,
    opponentRoot.position
  );

  opponentDirection.y = 0;

  const distance = opponentDirection.length();

  if (distance <= 0.0001) return;

  // Always face the player.
  opponentRoot.rotation.y = Math.atan2(
    opponentDirection.x,
    opponentDirection.z
  );

  // Finish the current attack before starting another action.
  if (opponentIsAttacking) return;

  // Approach the player when outside attack range.
  if (distance > opponentAttackRange) {
    if (distance > opponentStopDistance) {
      opponentDirection.normalize();

      const movement = Math.min(
        opponentMoveSpeed * delta,
        distance - opponentStopDistance
      );

      opponentRoot.position.addScaledVector(
        opponentDirection,
        movement
      );
    }

    return;
  }

  // Attack when the cooldown is ready.
  if (opponentAttackCooldown <= 0) {
    opponentIsAttacking = true;
    opponentAttackCooldown = opponentAttackInterval;

    combatState.opponentAttack = {
      hitRegistered: false
    };

    const idle = opponentAnimations.idle;
    const punch = opponentAnimations.punch;

    punch.reset();
    punch.enabled = true;
    punch.setEffectiveTimeScale(1);
    punch.setEffectiveWeight(1);
    punch.play();

    idle.crossFadeTo(punch, 0.15, false);

    console.log('OPPONENT AI: Punch attack');
  }
}

// =====================================================


// =====================================================
// COMBAT HUD + DAMAGE + HIT DETECTION
// =====================================================

function createCombatHUD() {
  const hud = document.createElement('div');
  hud.id = 'combat-hud';

  hud.innerHTML = `
    <div class="health-panel player-panel">
      <div class="health-heading">
        <span>PLAYER</span>
        <span id="player-health-value">100</span>
      </div>
      <div class="health-track">
        <div id="player-health-fill" class="health-fill"></div>
      </div>
    </div>

    <div id="fight-status">FIGHT</div>
    <div id="combat-feedback"></div>

    <div class="health-panel opponent-panel">
      <div class="health-heading">
        <span>OPPONENT</span>
        <span id="opponent-health-value">100</span>
      </div>
      <div class="health-track">
        <div id="opponent-health-fill" class="health-fill"></div>
      </div>
    </div>
  `;

  document.body.appendChild(hud);
  updateHealthBars();
}

function showCriticalHit(attackerName) {
  const feedback = document.getElementById('combat-feedback');
  if (!feedback) return;

  feedback.textContent = `${attackerName} CRITICAL HIT!`;
  feedback.className = 'critical show';

  clearTimeout(feedback._hideTimer);
  feedback._hideTimer = setTimeout(() => {
    feedback.classList.remove('show');
  }, 850);
}

function updateHealthBars() {
  const playerFill = document.getElementById('player-health-fill');
  const opponentFill = document.getElementById('opponent-health-fill');
  const playerValue = document.getElementById('player-health-value');
  const opponentValue = document.getElementById('opponent-health-value');

  if (!playerFill || !opponentFill) return;

  playerFill.style.width = `${combatState.playerHealth}%`;
  opponentFill.style.width = `${combatState.opponentHealth}%`;

  playerValue.textContent = combatState.playerHealth;
  opponentValue.textContent = combatState.opponentHealth;

  playerFill.classList.toggle('health-low', combatState.playerHealth <= 30);
  opponentFill.classList.toggle('health-low', combatState.opponentHealth <= 30);
}

function getHorizontalDistance(first, second) {
  const dx = first.position.x - second.position.x;
  const dz = first.position.z - second.position.z;

  return Math.sqrt(dx * dx + dz * dz);
}

// Keep the two fighter bodies from overlapping.
const minimumFighterDistance = 1.35;

// Independent knockback physics and hit stun.
const playerKnockback = new THREE.Vector3();
const opponentKnockback = new THREE.Vector3();

const playerBoneReaction = {
  remaining: 0,
  duration: 0.3,
  strength: 0
};

const opponentBoneReaction = {
  remaining: 0,
  duration: 0.3,
  strength: 0
};

let playerReactionBones = [];
let opponentReactionBones = [];

let knockoutState = null;

const reactionBoneNames = new Set([
  'mixamorigSpine1',
  'mixamorigSpine2',
  'mixamorigNeck',
  'mixamorigHead',
  'mixamorigLeftShoulder',
  'mixamorigRightShoulder',
  'mixamorigLeftArm',
  'mixamorigRightArm',
  'mixamorigLeftForeArm',
  'mixamorigRightForeArm'
]);

function collectReactionBones(root) {
  const bones = [];
  const seen = new Set();

  root.traverse(child => {
    if (
      child.isBone &&
      reactionBoneNames.has(child.name) &&
      !seen.has(child)
    ) {
      seen.add(child);
      bones.push(child);
    }
  });

  return bones;
}


function startKnockout(loser) {
  if (knockoutState || !characterRoot || !opponentRoot) return;

  const root = loser === 'player' ? characterRoot : opponentRoot;
  const loserMixer = loser === 'player' ? mixer : opponentMixer;

  if (!root) return;

  // Stop animation and temporary combat reactions.
  if (loserMixer) loserMixer.stopAllAction();

  const reactionState =
    loser === 'player' ? playerBoneReaction : opponentBoneReaction;

  clearBoneHitReaction(reactionState);
  reactionState.remaining = 0;
  reactionState.strength = 0;

  if (loser === 'player') {
    playerKnockback.set(0, 0, 0);
    playerHitStun = 0;
  } else {
    opponentKnockback.set(0, 0, 0);
    opponentHitStun = 0;
  }

  root.updateWorldMatrix(true, true);

  const bones = new Map();

  root.traverse(child => {
    if (child.isBone && !bones.has(child.name)) {
      bones.set(child.name, child);
    }
  });

  const hips = bones.get('mixamorigHips');

  if (!hips) {
    console.error('KNOCKOUT: Pelvis bone not found.');
    return;
  }

  const pivotPosition = hips.getWorldPosition(new THREE.Vector3());

  // Pivot around the pelvis instead of rotating the entire fighter at its feet.
  const pivot = new THREE.Group();
  pivot.name = `${loser}-knockout-pivot`;
  pivot.position.copy(pivotPosition);
  scene.add(pivot);
  pivot.attach(root);
  pivot.updateWorldMatrix(true, true);



  // Mirror the fall direction for the two fighters.
  const side = loser === 'opponent' ? -1 : 1;

  // Each joint has its own start delay and movement duration.
  // This avoids the stiff, simultaneous "plank" movement.
  const pose = [
    ['mixamorigSpine',       [0.12, 0,  0.04 * side], 0.10, 0.95],
    ['mixamorigSpine1',      [0.18, 0,  0.06 * side], 0.16, 1.00],
    ['mixamorigSpine2',      [0.14, 0,  0.08 * side], 0.22, 1.05],
    ['mixamorigNeck',        [-0.12, 0, 0],           0.48, 0.75],
    ['mixamorigHead',        [-0.20, 0, 0],           0.58, 0.70],

    ['mixamorigLeftShoulder',  [0.05, 0,  0.18 * side], 0.24, 0.75],
    ['mixamorigRightShoulder', [0.05, 0, -0.18 * side], 0.24, 0.75],

    ['mixamorigLeftArm',     [-0.12, 0,  0.68 * side], 0.25, 1.10],
    ['mixamorigRightArm',    [-0.12, 0, -0.68 * side], 0.29, 1.10],
    ['mixamorigLeftForeArm', [-0.08, 0, -0.04 * side], 0.48, 0.95],
    ['mixamorigRightForeArm',[-0.08, 0,  0.04 * side], 0.48, 0.95],
    ['mixamorigLeftHand',    [0.10, 0, -0.12 * side], 0.82, 0.65],
    ['mixamorigRightHand',   [0.10, 0,  0.12 * side], 0.82, 0.65],

    ['mixamorigLeftUpLeg',   [0.10, 0, -0.12 * side], 0.12, 0.95],
    ['mixamorigRightUpLeg',  [0.12, 0,  0.12 * side], 0.12, 0.95],
    ['mixamorigLeftLeg',     [0.30, 0, 0],             0.34, 0.90],
    ['mixamorigRightLeg',    [0.28, 0, 0],             0.38, 0.90],
    ['mixamorigLeftFoot',    [-0.22, 0, 0],            0.82, 0.65],
    ['mixamorigRightFoot',   [-0.18, 0, 0],            0.82, 0.65]
  ];

  const bonePoses = [];
  const targetWorldByBone = new Map();

  // Desired world-space directions: downwards, with a slight outward spread.
  const armDirections = {
    mixamorigLeftArm: new THREE.Vector3(0, -0.82, -0.57),
    mixamorigRightArm: new THREE.Vector3(0, -0.82, 0.57),
    mixamorigLeftForeArm: new THREE.Vector3(0, -0.94, -0.34),
    mixamorigRightForeArm: new THREE.Vector3(0, -0.94, 0.34)
  };

  for (const [name, angles, delay, duration] of pose) {
    const bone = bones.get(name);
    if (!bone) continue;

    const original = bone.quaternion.clone();
    const offset = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(...angles, 'XYZ')
    );

    let target = original.clone().multiply(offset);

    const parentWorld = new THREE.Quaternion();

    if (bone.parent) {
      const parentTarget = targetWorldByBone.get(bone.parent);

      if (parentTarget) {
        parentWorld.copy(parentTarget);
      } else {
        bone.parent.getWorldQuaternion(parentWorld);
      }
    }

    const desiredDirection = armDirections[name];

    if (desiredDirection) {
      const childName = {
        mixamorigLeftArm: 'mixamorigLeftForeArm',
        mixamorigRightArm: 'mixamorigRightForeArm',
        mixamorigLeftForeArm: 'mixamorigLeftHand',
        mixamorigRightForeArm: 'mixamorigRightHand'
      }[name];

      const child = bones.get(childName);

      if (child) {
        const start = bone.getWorldPosition(new THREE.Vector3());
        const end = child.getWorldPosition(new THREE.Vector3());
        const currentDirection = end.sub(start).normalize();

        const currentWorld = bone.getWorldQuaternion(
          new THREE.Quaternion()
        );

        const worldDelta = new THREE.Quaternion().setFromUnitVectors(
          currentDirection,
          desiredDirection.clone().normalize()
        );

        const desiredWorld = worldDelta.multiply(currentWorld);

        target = parentWorld.clone()
          .invert()
          .multiply(desiredWorld);
      }
    }

    const targetWorld = parentWorld.clone().multiply(target);
    targetWorldByBone.set(bone, targetWorld);

    bonePoses.push({
      bone,
      original,
      target,
      delay,
      duration
    });
  }

  const startY = pivot.position.y;

  // Smaller root rotation; the joints now create most of the falling pose.
  const targetRotationZ = loser === 'opponent' ? -1.20 : 1.20;
  const originalPivotRotationZ = pivot.rotation.z;

  // Temporarily apply the complete final pose to calculate floor contact.
  pivot.rotation.z = targetRotationZ;

  for (const item of bonePoses) {
    item.bone.quaternion.copy(item.target);
  }

  root.updateWorldMatrix(true, true);

  const finalBounds = new THREE.Box3().setFromObject(root, true);

  const targetY = Number.isFinite(finalBounds.min.y)
    ? pivot.position.y - finalBounds.min.y
    : startY - 1.0;

  // Restore the exact starting pose before animation.
  pivot.rotation.z = originalPivotRotationZ;

  for (const item of bonePoses) {
    item.bone.quaternion.copy(item.original);
  }

  root.updateWorldMatrix(true, true);

  knockoutState = {
    loser,
    root,
    pivot,
    elapsed: 0,
    duration: 2.15,
    startY,
    targetY,
    targetRotationZ,
    bonePoses
  };

  console.log(
    'NATURAL KNOCKOUT STARTED:',
    loser,
    '| Animated joints:',
    bonePoses.length,
    '| Floor target:',
    targetY.toFixed(3)
  );
}

function updateKnockout(delta) {
  if (!knockoutState) return;

  const state = knockoutState;
  state.elapsed = Math.min(state.duration, state.elapsed + delta);

  const smooth = value => {
    const t = THREE.MathUtils.clamp(value, 0, 1);
    return t * t * (3 - 2 * t);
  };

  // Initial recoil, followed by a controlled sideways collapse.
  const fall = smooth((state.elapsed - 0.08) / 1.55);
  const direction = Math.sign(state.targetRotationZ);

  const recoil = state.elapsed < 0.16
    ? Math.sin((state.elapsed / 0.16) * Math.PI) * 0.055
    : 0;

  state.pivot.rotation.z =
    state.targetRotationZ * fall - direction * recoil;

  // Lower the pelvis toward the calculated floor-contact position.
  const impact = smooth((state.elapsed - 1.48) / 0.18);
  const settle = smooth((state.elapsed - 1.68) / 0.35);

  const fallY = THREE.MathUtils.lerp(
    state.startY,
    state.targetY,
    fall
  );

  state.pivot.position.y =
    fallY - 0.045 * impact + 0.045 * settle * impact;

  // Animate every joint independently with staggered timing.
  for (const item of state.bonePoses) {
    const jointProgress = smooth(
      (state.elapsed - item.delay) / item.duration
    );

    item.bone.quaternion
      .copy(item.original)
      .slerp(item.target, jointProgress);
  }

  if (state.elapsed >= state.duration) {
    state.pivot.rotation.z = state.targetRotationZ;
    state.pivot.position.y = state.targetY;

    for (const item of state.bonePoses) {
      item.bone.quaternion.copy(item.target);
    }

    state.root.updateWorldMatrix(true, true);

    let actualBounds = new THREE.Box3().setFromObject(state.root, true);

    // Correct the final landing using the actual animated mesh bounds.
    // The arena floor is at world Y = 0.
    if (Number.isFinite(actualBounds.min.y)) {
      state.pivot.position.y -= actualBounds.min.y;
      state.root.updateWorldMatrix(true, true);
      actualBounds = new THREE.Box3().setFromObject(state.root, true);
    }

    console.log(
      'KNOCKOUT FINAL FLOOR CHECK:',
      'Min Y:', actualBounds.min.y.toFixed(4),
      '| Pivot Y:', state.pivot.position.y.toFixed(4),
      '| Floor gap:', actualBounds.min.y.toFixed(4)
    );

    console.log(
      'NATURAL KNOCKOUT COMPLETE:',
      state.loser,
      '| Final joints:',
      state.bonePoses.length
    );

    knockoutState = null;
  }
}

function clearBoneHitReaction(state) {
  if (!state.appliedOffsets) return;

  for (const [bone, offset] of state.appliedOffsets) {
    bone.quaternion.multiply(offset.clone().invert());
  }

  state.appliedOffsets.clear();
}

function applyBoneHitReaction(bones, state, delta) {
  if (!bones.length || state.remaining <= 0) return;

  state.remaining = Math.max(0, state.remaining - delta);

  const progress = 1 - state.remaining / state.duration;
  const envelope = Math.sin(Math.PI * progress) * state.strength;

  if (envelope < 0.001) return;

  state.appliedOffsets ??= new Map();

  for (const bone of bones) {
    let x = 0;
    let y = 0;
    let z = 0;

    switch (bone.name) {
      case 'mixamorigSpine1':
        z = 0.07 * envelope;
        break;
      case 'mixamorigSpine2':
        z = 0.11 * envelope;
        break;
      case 'mixamorigNeck':
        x = -0.035 * envelope;
        break;
      case 'mixamorigHead':
        x = -0.07 * envelope;
        z = -0.035 * envelope;
        break;
      case 'mixamorigLeftShoulder':
        z = -0.06 * envelope;
        break;
      case 'mixamorigRightShoulder':
        z = 0.06 * envelope;
        break;
      case 'mixamorigLeftArm':
        z = -0.18 * envelope;
        x = 0.08 * envelope;
        break;
      case 'mixamorigRightArm':
        z = 0.18 * envelope;
        x = 0.08 * envelope;
        break;
      case 'mixamorigLeftForeArm':
        z = -0.12 * envelope;
        break;
      case 'mixamorigRightForeArm':
        z = 0.12 * envelope;
        break;
    }

    const offset = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(x, y, z, 'XYZ')
    );

    bone.quaternion.multiply(offset);
    state.appliedOffsets.set(bone, offset.clone());
  }
}

let playerHitStun = 0;
let opponentHitStun = 0;


function resolveFighterCollision() {
  if (combatState.finished || !characterRoot || !opponentRoot) return;

  const dx = fighterPosition.x - opponentRoot.position.x;
  const dz = fighterPosition.z - opponentRoot.position.z;
  const distance = Math.sqrt(dx * dx + dz * dz);

  if (distance >= minimumFighterDistance) return;

  // Determine the direction from opponent to player.
  const nx = distance > 0.0001 ? dx / distance : -1;
  const nz = distance > 0.0001 ? dz / distance : 0;

  // Stop the player at the minimum separation distance.
  fighterPosition.x =
    opponentRoot.position.x + nx * minimumFighterDistance;

  fighterPosition.z =
    opponentRoot.position.z + nz * minimumFighterDistance;

  characterRoot.position.x = fighterPosition.x;
  characterRoot.position.z = fighterPosition.z;
}

function triggerHitReaction(target, attackName, isCritical = false) {
  if (!characterRoot || !opponentRoot) return;

  const isKick = attackName === 'KICK';

  // Stronger impact and longer stun make the reaction readable.
  let force = isKick ? 7.0 : 4.8;
  let stun = isKick ? 0.85 : 0.62;

  if (isCritical) {
    force *= 1.45;
    stun += 0.15;
  }

  const reactionState =
    target === 'player' ? playerBoneReaction : opponentBoneReaction;

  reactionState.duration = isKick ? 0.85 : 0.72;
  reactionState.remaining = reactionState.duration;
  reactionState.strength = (isKick ? 1.5 : 1.25) * (isCritical ? 1.2 : 1);

  const direction = new THREE.Vector3();

  if (target === 'player') {
    direction.subVectors(characterRoot.position, opponentRoot.position);
    playerHitStun = Math.max(playerHitStun, stun);
  } else {
    direction.subVectors(opponentRoot.position, characterRoot.position);
    opponentHitStun = Math.max(opponentHitStun, stun);

    // Break the opponent's attack/guard and force a recovery transition.
    if (opponentIsAttacking && opponentAnimations.idle && opponentAnimations.punch) {
      const idle = opponentAnimations.idle;
      const punch = opponentAnimations.punch;

      idle.reset();
      idle.enabled = true;
      idle.setEffectiveTimeScale(1);
      idle.setEffectiveWeight(1);
      idle.play();
      punch.crossFadeTo(idle, 0.08, false);
    }

    opponentIsAttacking = false;
    combatState.opponentAttack = null;
  }

  if (direction.lengthSq() < 0.0001) {
    direction.set(target === 'player' ? -1 : 1, 0, 0);
  } else {
    direction.normalize();
  }

  if (target === 'player') {
    playerKnockback.addScaledVector(direction, force);
  } else {
    opponentKnockback.addScaledVector(direction, force);
  }

  console.log(
    `STANCE BREAK / HIT REACTION: ${target.toUpperCase()} | ${attackName} | ` +
    `Force: ${force.toFixed(2)} | Stun: ${stun.toFixed(2)}s` +
    (isCritical ? ' | CRITICAL' : '')
  );
}

function updateHitReactions(delta) {
  if (combatState.finished || !characterRoot || !opponentRoot) return;

  playerHitStun = Math.max(0, playerHitStun - delta);
  opponentHitStun = Math.max(0, opponentHitStun - delta);

  // Move player using knockback velocity.
  fighterPosition.x += playerKnockback.x * delta;
  fighterPosition.z += playerKnockback.z * delta;

  playerKnockback.multiplyScalar(Math.exp(-8 * delta));

  characterRoot.position.x = fighterPosition.x;
  characterRoot.position.z = fighterPosition.z;

  // Move opponent independently.
  opponentRoot.position.x += opponentKnockback.x * delta;
  opponentRoot.position.z += opponentKnockback.z * delta;

  opponentKnockback.multiplyScalar(Math.exp(-8 * delta));
}

function applyDamage(target, amount, attackerName, attackName, isCritical = false) {
  if (combatState.finished || target === 'player' && combatState.playerHealth <= 0) {
    return;
  }

  if (target === 'player') {
    combatState.playerHealth = Math.max(
      0,
      combatState.playerHealth - amount
    );
  } else {
    combatState.opponentHealth = Math.max(
      0,
      combatState.opponentHealth - amount
    );
  }

  triggerHitReaction(target, attackName, isCritical);

  if (isCritical) {
    showCriticalHit(attackerName);
  }

  updateHealthBars();

  console.log(
    `${attackerName} HIT: ${attackName} | Damage: ${amount}` +
    (isCritical ? ' | CRITICAL HIT' : '') + ' | ' +
    `Player HP: ${combatState.playerHealth} | ` +
    `Opponent HP: ${combatState.opponentHealth}`
  );

  if (
    combatState.playerHealth <= 0 ||
    combatState.opponentHealth <= 0
  ) {
    combatState.finished = true;
    combatState.playerAttack = null;
    combatState.opponentAttack = null;
    opponentIsAttacking = false;

    const status = document.getElementById('fight-status');

    if (status) {
      status.textContent =
        combatState.playerHealth <= 0
          ? 'KNOCKOUT — OPPONENT WINS'
          : 'KNOCKOUT — PLAYER WINS';

      status.classList.add('fight-over');
    }

    const loser =
      combatState.playerHealth <= 0 ? 'player' : 'opponent';

    startKnockout(loser);

    console.log('FIGHT OVER: KNOCKOUT');
  }
}

function updateCombat() {
  if (
    combatState.finished ||
    !characterRoot ||
    !opponentRoot
  ) return;

  // Player attack impact.
  const playerAttack = combatState.playerAttack;

  if (playerAttack && !playerAttack.hitRegistered) {
    const action = animations[playerAttack.name];

    const impactWindows = {
      punch: { start: 0.28, end: 0.58, damage: 10, range: 2.35 },
      kick: { start: 0.55, end: 1.05, damage: 16, range: 2.7 }
    };

    const impact = impactWindows[playerAttack.name];

    if (action && impact && action.time >= impact.start) {
      // Register this attack only once, even if it misses.
      playerAttack.hitRegistered = true;

      const distance = getHorizontalDistance(
        characterRoot,
        opponentRoot
      );

      if (action.time <= impact.end && distance <= impact.range) {
        const isCritical = Math.random() < 0.20;
        const finalDamage = Math.round(
          impact.damage * (isCritical ? 1.8 : 1)
        );

        applyDamage(
          'opponent',
          finalDamage,
          'PLAYER',
          playerAttack.name.toUpperCase(),
          isCritical
        );
      } else {
        console.log(
          `PLAYER MISS: ${playerAttack.name} | Distance: ${distance.toFixed(2)}`
        );
      }
    }
  }

  if (combatState.finished) return;

  // Opponent punch impact.
  const opponentAttack = combatState.opponentAttack;

  if (opponentAttack && !opponentAttack.hitRegistered) {
    const action = opponentAnimations.punch;

    if (action && action.time >= 0.28) {
      opponentAttack.hitRegistered = true;

      const distance = getHorizontalDistance(
        opponentRoot,
        characterRoot
      );

      if (action.time <= 0.58 && distance <= 2.35) {
        const isCritical = Math.random() < 0.20;
        const finalDamage = Math.round(8 * (isCritical ? 1.8 : 1));

        applyDamage(
          'player',
          finalDamage,
          'OPPONENT',
          'PUNCH',
          isCritical
        );
      } else {
        console.log(
          `OPPONENT MISS: PUNCH | Distance: ${distance.toFixed(2)}`
        );
      }
    }
  }
}

createCombatHUD();

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);

  const delta = clock.getDelta();
  const time = clock.getElapsedTime();

  const speed = 4.0;

  if (!combatState.finished && playerHitStun <= 0) {
    if (keys.w) fighterPosition.z -= speed * delta;
    if (keys.s) fighterPosition.z += speed * delta;
    if (keys.a) fighterPosition.x -= speed * delta;
    if (keys.d) fighterPosition.x += speed * delta;
  }

  if (characterRoot && !combatState.finished) {
    characterRoot.position.x = fighterPosition.x;
    characterRoot.position.z = fighterPosition.z;
  }

  // Update opponent AI independently.
  updateOpponentAI(delta);

  // Apply hit stun and knockback.
  updateHitReactions(delta);

  // Prevent player and opponent bodies from overlapping.
  resolveFighterCollision();

  // Remove previous temporary offsets before updating animations.
  clearBoneHitReaction(playerBoneReaction);
  clearBoneHitReaction(opponentBoneReaction);

  if (mixer) {
    mixer.update(delta);
  }

  if (opponentMixer) {
    opponentMixer.update(delta);
  }

  // Apply the knockout pose after animation mixer updates.
  updateKnockout(delta);

  // Apply fresh reactions over the current animated poses.
  applyBoneHitReaction(playerReactionBones, playerBoneReaction, delta);
  applyBoneHitReaction(opponentReactionBones, opponentBoneReaction, delta);

  // Check attack impact frames after animation updates.
  updateCombat();

  // Cinematic knockout camera, while preserving normal fight follow.
  if (combatState.finished && characterRoot && opponentRoot) {
    characterRoot.getWorldPosition(cameraPlayerWorld);
    opponentRoot.getWorldPosition(cameraOpponentWorld);

    cameraFocusTarget
      .copy(cameraPlayerWorld)
      .add(cameraOpponentWorld)
      .multiplyScalar(0.5);

    cameraFocusTarget.y = 0.85;

    cameraDesiredPosition.set(
      cameraFocusTarget.x,
      2.0,
      cameraFocusTarget.z + 6.0
    );

    if (!cinematicCameraStarted) {
      cameraCurrentLookTarget.set(
        fighterPosition.x + 0.5,
        fighterPosition.y + 1.0,
        fighterPosition.z
      );
      cinematicCameraStarted = true;
    }

    const cameraSmooth = 1 - Math.exp(-delta * 2.0);

    camera.position.lerp(cameraDesiredPosition, cameraSmooth);
    cameraCurrentLookTarget.lerp(cameraFocusTarget, cameraSmooth);
    camera.lookAt(cameraCurrentLookTarget);
  } else {
    cinematicCameraStarted = false;

    camera.position.x =
      fighterPosition.x + Math.sin(time * 0.5) * 0.1;

    camera.position.y = 2.2;
    camera.position.z = fighterPosition.z + 8.0;

    camera.lookAt(
      fighterPosition.x + 0.5,
      fighterPosition.y + 1.0,
      fighterPosition.z
    );
  }

  renderer.render(scene, camera);
}

animate();

// =====================================================
// 8. RESIZE HANDLER
// =====================================================

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();

  renderer.setSize(
    window.innerWidth,
    window.innerHeight
  );
});

// =====================================================
// 9. INITIALIZE
// =====================================================

loadFighter();
