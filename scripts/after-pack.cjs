// electron-builder `afterPack` (runs before the fuses are flipped and before signing): puts the official Node runtime, pinned and
// checksum-checked, into the app as Contents/Resources/node/node. The terminal host (jafferd) and the `jaffer` CLI run on it, so the
// app's own binary never has to run as Node and its RunAsNode fuse can stay off (electron-builder.yml): another program of the user
// can then no longer run code as Jaffer's signed binary and borrow what macOS granted Jaffer.
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Arch } = require('builder-util');

// Change the version and both checksums together, from https://nodejs.org/dist/v<version>/SHASUMS256.txt.
const NODE_VERSION = '24.22.2';
const SHA256 = {
  arm64: 'aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a',
  x64: 'd5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52',
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** The verified archive for `arch`, downloaded once into node_modules/.cache. */
async function archive(arch) {
  const name = `node-v${NODE_VERSION}-darwin-${arch}.tar.gz`;
  const file = path.join(__dirname, '..', 'node_modules', '.cache', 'jaffer-node', name);
  if (fs.existsSync(file) && sha256(fs.readFileSync(file)) === SHA256[arch]) return file;
  const res = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${name}`);
  if (!res.ok) throw new Error(`downloading ${name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== SHA256[arch]) throw new Error(`${name}: sha256 ${got}, expected ${SHA256[arch]}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return file;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const arch = Arch[context.arch];
  if (!SHA256[arch]) throw new Error(`no Node runtime pinned for ${arch}`);
  const tgz = await archive(arch);
  const top = `node-v${NODE_VERSION}-darwin-${arch}`;
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'jaffer-node-'));
  try {
    execFileSync('tar', ['-xzf', tgz, '-C', tmp, `${top}/bin/node`, `${top}/LICENSE`]);
    const dest = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'node');
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(path.join(tmp, top, 'bin', 'node'), path.join(dest, 'node'));
    fs.chmodSync(path.join(dest, 'node'), 0o755);
    fs.copyFileSync(path.join(tmp, top, 'LICENSE'), path.join(dest, 'LICENSE'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};
