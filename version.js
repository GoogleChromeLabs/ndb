const fs = require('fs');

(function main() {
  const version = require('./package.json').version;
  let preload = fs.readFileSync('./lib/preload/ndb/preload.js', 'utf8');
  preload = preload.replace(/process\.versions\['ndb'\] = '[\d+\.]+';/, `process.versions['ndb'] = '${version}';`);
  fs.writeFileSync('./lib/preload/ndb/preload.js', preload, 'utf8');
})();
