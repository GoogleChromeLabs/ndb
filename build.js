/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

const fs = require('fs');
const path = require('path');
const removeFolder = require('rimraf');
const util = require('util');

const {ReleaseBuilder} = require('./scripts/build_release_application.js');

const DEVTOOLS_DIR = path.dirname(
    require.resolve('chrome-devtools-frontend/front_end/shell.json'));

(async function main() {
  const outputPath = path.join(__dirname, '.local-frontend');
  if (fs.existsSync(outputPath))
    await util.promisify(removeFolder)(outputPath);
  await util.promisify(fs.mkdir)(outputPath);

  const builder = new ReleaseBuilder([
    path.join(__dirname, 'front_end'),
    DEVTOOLS_DIR,
    __dirname,
    path.join(__dirname, '..', '..')
  ], outputPath);
  await builder.buildApp('ndb_app');
  await builder.buildWorkerApp('heap_snapshot_worker');
  await builder.buildWorkerApp('formatter_worker');
})();
