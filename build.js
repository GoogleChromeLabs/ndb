const path = require('path');

const Terser = require('terser');
const rimraf = require('rimraf');

const { buildApp } = require('./scripts/builder.js');

const DEVTOOLS_DIR = path.dirname(
    require.resolve('chrome-devtools-frontend/front_end/shell.json'));

(async function main() {
  const outFolder = path.join(__dirname, '.local-frontend');
  await new Promise(resolve => rimraf(outFolder, resolve));

  return buildApp(
      ['ndb', 'heap_snapshot_worker', 'formatter_worker'], [
        path.join(__dirname, 'front_end'),
        DEVTOOLS_DIR,
        path.join(__dirname, 'node_modules'),
      ], outFolder,
      minifyJS);
})();

function minifyJS(code) {
  return Terser.minify(code, {
    mangle: true,
    ecma: 8,
    compress: false
  }).code;
}
