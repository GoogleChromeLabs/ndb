#!/usr/bin/env node
/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

require('update-notifier')({pkg: require('./package.json')}).notify({isGlobal: true});

if (process.argv.length > 2 && (process.argv[2] === '-v' || process.argv[2] === '--version')) {
  console.log(`v${require('./package.json').version}`);
  process.exit(0);
}

if (process.argv.length > 2 && process.argv[2] === '--help') {
  console.log('Usage:');
  console.log('');
  console.log('Use ndb instead of node command:');
  console.log('\tndb server.js');
  console.log('\tndb node server.js');
  console.log('');
  console.log('Prepend ndb in front of any other binary:');
  console.log('\tndb npm run unit');
  console.log('\tndb mocha');
  console.log('\tndb npx mocha');
  console.log('');
  console.log('Launch ndb as a standalone application:');
  console.log('\tndb .');
  console.log('');
  console.log('More information is available at https://github.com/GoogleChromeLabs/ndb#readme');
  process.exit(0);
}

const {launch} = require('./lib/launcher.js');
launch();
