const strongIntegrities = new Map();

function preResolution({ wantedLockfile }) {
  strongIntegrities.clear();

  for (const [dependencyPath, packageSnapshot] of Object.entries(
    wantedLockfile.packages ?? {}
  )) {
    const integrity = packageSnapshot.resolution?.integrity;

    if (/^sha(?:256|512)-/.test(integrity ?? "")) {
      strongIntegrities.set(dependencyPath, integrity);
    }
  }
}

function afterAllResolved(lockfile) {
  for (const [dependencyPath, packageSnapshot] of Object.entries(
    lockfile.packages ?? {}
  )) {
    const resolution = packageSnapshot.resolution;

    if (/^sha1-/.test(resolution?.integrity ?? "")) {
      resolution.integrity =
        strongIntegrities.get(dependencyPath) ?? resolution.integrity;
    }

    if (resolution?.tarball && resolution.integrity && !resolution.gitHosted) {
      delete resolution.tarball;
    }
  }

  return lockfile;
}

module.exports = {
  hooks: { preResolution, afterAllResolved },
};
