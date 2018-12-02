/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

const {TestRunner, Reporter, Matchers} = require('../utils/testrunner/');
let parallel = 1;
if (process.env.NDB_PARALLEL_TESTS)
  parallel = parseInt(process.env.NDB_PARALLEL_TESTS.trim(), 10);
const timeout = 10000;
const testRunner = new TestRunner({timeout, parallel});
const {expect} = new Matchers();
addTests(testRunner);
new Reporter(testRunner);
testRunner.run();

const { execFile } = require('child_process');

// Tests for specific Node platform features.
function addTests(testRunner) {
  // eslint-disable-next-line
  const {beforeAll, afterAll} = testRunner;
  // eslint-disable-next-line
  const {it, fit, xit} = testRunner;

  xit('--title flag (fails on Node v8.x)', async function() {
    const result = await new Promise(resolve => execFile(
        process.execPath, ['--title=abc', '-p', 'process.title'], (error, stdout, stderr) => {
      resolve(stdout + stderr);
    }));
    expect(result).toBe('abc\n');
  });
};
