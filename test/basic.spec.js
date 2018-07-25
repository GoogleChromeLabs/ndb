/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const removeFolder = require('rimraf');
const util = require('util');

const {launch} = require('../lib/launcher.js');

const fsMkdtemp = util.promisify(fs.mkdtemp);

module.exports.addTests = function({testRunner}) {
  // eslint-disable-next-line
  const {it, fit, xit} = testRunner;
  it('run configuration', async function() {
    const configDir = await fsMkdtemp(path.join(os.tmpdir(), 'ndb-test-'));
    const frontend = await launch({
      configDir: configDir,
      argv: ['.'],
      cwd: path.join(__dirname, 'assets', 'test-project'),
      debugFrontend: false,
      doNotCopyPreferences: true
    });

    const configItem = await frontend.waitForSelector('body /deep/ .list-item');
    configItem.hover();
    const runButton = await frontend.waitForSelector('body /deep/ .list-item /deep/ [aria-label=Run]', {
      visible: true
    });
    runButton.click();
    const consoleMessage = await frontend.waitForSelector('body /deep/ .console-message-wrapper:nth-child(3) .console-message-text');
    assert.equal('42', await frontend.evaluate(x => x.innerText, consoleMessage));

    await frontend.close();
    await util.promisify(removeFolder)(configDir);
  });

  it('run, pause at start, kill', async function() {
    const configDir = await fsMkdtemp(path.join(os.tmpdir(), 'ndb-test-'));
    const frontend = await launch({
      configDir: configDir,
      argv: ['.'],
      cwd: path.join(__dirname, 'assets', 'test-project'),
      debugFrontend: false,
      doNotCopyPreferences: true
    });

    const [pauseAtStartCheckbox, configItem] = await Promise.all([
      frontend.waitForSelector('body /deep/ #pause-at-start-checkbox'),
      frontend.waitForSelector('body /deep/ .list-item')
    ]);
    await pauseAtStartCheckbox.click();
    configItem.hover();
    const runButton = await frontend.waitForSelector('body /deep/ .list-item /deep/ [aria-label=Run]', {
      visible: true
    });
    runButton.click();
    const executionLine = await frontend.waitForSelector('.cm-execution-line .CodeMirror-line');
    const executionLineText = await frontend.evaluate(x => x.innerText, executionLine);
    assert.equal(executionLineText, 'console.log(42);');

    const processItem = await frontend.waitForSelector('body /deep/ li.selected');
    processItem.hover();

    const killButton = await frontend.waitForSelector('body /deep/ li.selected /deep/ [aria-label=Kill]');
    killButton.click();
    await frontend.waitForSelector('body /deep/ #no-running-nodes-msg', {
      visible: true
    });

    await frontend.close();
    await util.promisify(removeFolder)(configDir);
  });

  it('terminal', async function() {
    const configDir = await fsMkdtemp(path.join(os.tmpdir(), 'ndb-test-'));
    const frontend = await launch({
      configDir: configDir,
      argv: ['.'],
      cwd: path.join(__dirname, 'assets', 'test-project'),
      debugFrontend: false,
      doNotCopyPreferences: true
    });

    const [pauseAtStartCheckbox, terminalTab, resumeButton, consoleTab] = await Promise.all([
      frontend.waitForSelector('body /deep/ #pause-at-start-checkbox'),
      frontend.waitForSelector('body /deep/ #tab-ndb\\.terminal'),
      frontend.waitForSelector('body /deep/ [aria-label="Pause script execution"]'),
      frontend.waitForSelector('body /deep/ #tab-console-view')
    ]);
    await pauseAtStartCheckbox.click();
    terminalTab.click();
    const terminal = await frontend.waitForSelector('body /deep/ .xterm-cursor-layer', {
      visible: true
    });
    await frontend.click('body /deep/ .xterm-cursor-layer');
    await frontend.type('body /deep/ .xterm-cursor-layer', 'node -e "console.log(42)"');
    await terminal.press('Enter');

    const executionLine = await frontend.waitForSelector('.cm-execution-line .CodeMirror-line');
    const executionLineText = await frontend.evaluate(x => x.innerText, executionLine);
    assert.equal(executionLineText, 'console.log(42);');

    resumeButton.click();

    await frontend.waitForSelector('body /deep/ #no-running-nodes-msg', {
      visible: true
    });

    consoleTab.click();
    const consoleMessage = await frontend.waitForSelector('body /deep/ .console-message-wrapper:nth-child(2) .console-message-text');
    assert.equal('42', await frontend.evaluate(x => x.innerText, consoleMessage));

    await frontend.close();
    await util.promisify(removeFolder)(configDir);
  });

  it('terminal exit', async function() {
    const configDir = await fsMkdtemp(path.join(os.tmpdir(), 'ndb-test-'));
    const frontend = await launch({
      configDir: configDir,
      argv: ['.'],
      cwd: path.join(__dirname, 'assets', 'test-project'),
      debugFrontend: false,
      doNotCopyPreferences: true
    });

    const [terminalTab, consoleTab] = await Promise.all([
      frontend.waitForSelector('body /deep/ #tab-ndb\\.terminal'),
      frontend.waitForSelector('body /deep/ #tab-console-view'),
    ]);
    terminalTab.click();
    const terminal = await frontend.waitForSelector('body /deep/ .xterm-cursor-layer', {
      visible: true
    });
    await frontend.click('body /deep/ .xterm-cursor-layer');
    await frontend.type('body /deep/ .xterm-cursor-layer', 'exit');
    await terminal.press('Enter');
    // we need better way to wait until terminal reconnected.
    await new Promise(resolve => setTimeout(resolve, 300));
    await frontend.type('body /deep/ .xterm-cursor-layer', 'node -e "console.log(42)"');
    await terminal.press('Enter');

    consoleTab.click();
    const consoleMessage = await frontend.waitForSelector('body /deep/ .console-message-wrapper:nth-child(2) .console-message-text');
    assert.equal('42', await frontend.evaluate(x => x.innerText, consoleMessage));

    await frontend.close();
    await util.promisify(removeFolder)(configDir);
  });

  it('repl and uncaught error', async function() {
    const configDir = await fsMkdtemp(path.join(os.tmpdir(), 'ndb-test-'));
    const frontend = await launch({
      configDir: configDir,
      argv: ['.'],
      cwd: path.join(__dirname, 'assets', 'test-project'),
      debugFrontend: false,
      doNotCopyPreferences: true
    });
    const consolePrompt = await frontend.waitForSelector('body /deep/ #console-prompt');
    await frontend.type('body /deep/ #console-prompt', 'require("child_process").spawn("!@#$%")');
    await consolePrompt.press('Enter');
    await frontend.type('body /deep/ #console-prompt', 'console.log(42)');
    consolePrompt.press('Enter');
    const consoleMessage = await frontend.waitForSelector('body /deep/ .console-message-wrapper:nth-child(6) .console-message-text');
    assert.equal('42', await frontend.evaluate(x => x.innerText, consoleMessage));
    await frontend.close();
    await util.promisify(removeFolder)(configDir);
  });
};
// eslint-disable-next-line
function sleep() {
  return new Promise(resolve => setTimeout(resolve, 2147483647));
}
