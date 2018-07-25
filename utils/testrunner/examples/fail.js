/**
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const {TestRunner, Reporter, Matchers} = require('..');

const runner = new TestRunner();
const reporter = new Reporter(runner);
const {expect} = new Matchers();

const {describe, xdescribe, fdescribe} = runner;
const {it, fit, xit} = runner;
const {beforeAll, beforeEach, afterAll, afterEach} = runner;

describe('testsuite', () => {
  it('toBe', async (state) => {
    expect(2 + 2).toBe(5);
  });
  it('toBeFalsy', async (state) => {
    expect(true).toBeFalsy();
  });
  it('toBeTruthy', async (state) => {
    expect(false).toBeTruthy();
  });
  it('toBeGreaterThan', async (state) => {
    expect(2).toBeGreaterThan(3);
  });
  it('toBeNull', async (state) => {
    expect(2).toBeNull();
  });
  it('toContain', async (state) => {
    expect('asdf').toContain('e');
  });
  it('not.toContain', async (state) => {
    expect('asdf').not.toContain('a');
  });
  it('toEqual', async (state) => {
    expect([1,2,3]).toEqual([1,2,3,4]);
  });
});

runner.run();
