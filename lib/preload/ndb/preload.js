/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

try {
  const inspector = require('inspector');
  const { writeFileSync, unlinkSync } = require('fs');
  inspector.open(0, undefined, false);
  const sep = process.platform === 'win32' ? '\\' : '/';
  const fileName = `${process.env.NDD_STORE}${sep}${process.pid}`;
  writeFileSync(fileName, inspector.url());
  process.once('exit', _ => unlinkSync(fileName));
  inspector.open(0, undefined, true);
} catch (e) {
}
// eslint-disable-next-line spaced-comment
//# sourceURL=internal/preload.js
