/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const util = require('util');

const {Services} = require('../services/services.js');
const {FileSystem} = require('../lib/file_system_backend.js');

class ServiceHelper {
  constructor(page, browser) {
    this._page = page;
    this._page.on('console', this._onNotification.bind(this));
    this._eventCallbacks = new Map();
    this._browser = browser;
  }

  static async create() {
    const browser = await puppeteer.launch({pipe: true});
    const page = await browser.newPage();
    const helper = new ServiceHelper(page, browser);
    const services = new Services((serviceId, message) => {
      page.evaluate(function(serviceId, message) {
        console.log(serviceId, message);
      }, serviceId, message);
    });
    await page.exposeFunction('createNdbService', services.createNdbService.bind(services));
    await page.exposeFunction('callNdbService', services.callNdbService.bind(services));
    return helper;
  }

  async createService(name, serviceDir) {
    const {serviceId, error} = await this._page.evaluate(function(name, serviceDir) {
      return createNdbService(name, serviceDir);
    }, name, serviceDir);
    if (error)
      return {error};
    return {
      service: new Proxy({}, { get: (_, method) => {
        const eventPattern = /^on?([A-Z][A-Za-z0-9]+)/;
        const match = eventPattern.exec(method);
        if (!match)
          return options => this._callService(serviceId, method, options);
        const name = match[1].charAt(0).toLowerCase() + match[1].slice(1);
        return (num, filter) => this._waitForEvent(name, serviceId, num || 1, filter);
      }})
    };
  }

  _callService(serviceId, method, options) {
    return this._page.evaluate(function(serviceId, method, options) {
      return callNdbService(serviceId, method, options);
    }, serviceId, method, options);
  }

  _waitForEvent(name, serviceId, num, filter) {
    return new Promise(resolve => this._eventCallbacks.set(`${serviceId}:${name}`, {
      callback: resolve,
      num: num,
      results: [],
      filter: filter
    }));
  }

  async _onNotification(message) {
    const [serviceId, {name, params}] = await Promise.all(message.args().map(arg => arg.jsonValue()));
    const callback = this._eventCallbacks.get(`${serviceId}:${name}`);
    if (callback) {
      if (callback.filter && !callback.filter(params))
        return;
      callback.results.push(params || {});
      if (callback.num === callback.results.length) {
        this._eventCallbacks.delete(message.method);
        if (callback.num === 1)
          callback.callback(callback.results[0]);
        else
          callback.callback(callback.results);
      }
    }
  }

  close() {
    return this._browser.close();
  }
}

describe('Services', function() {
  this.timeout(5000);

  it('basic', async function() {
    const helper = await ServiceHelper.create();
    const {error, service} = await helper.createService('trivial_service', __dirname);
    assert.ifError(error);
    const {result} = await service.sum({a: 1, b: 2});
    assert.equal(3, result);
    const [disposeCall, disposeNotification] = await Promise.all([
      service.dispose(),
      service.onDisposed()
    ]);
    assert.deepStrictEqual({result: {}}, disposeCall);
    assert.deepStrictEqual({}, disposeNotification);
    await helper.close();
  });

  it('serviceNotFound', async function() {
    const helper = await ServiceHelper.create();
    const {error} = await helper.createService('not_existing_service', __dirname);
    assert.equal('Service with given name=not_existing_service not found', error);
    await helper.close();
  });

  it('not cool methods', async function() {
    const helper = await ServiceHelper.create();

    const {error, service} = await helper.createService('trivial_service', __dirname);
    assert.ifError(error);
    const {error: callError} = await service.notFoundMethod();
    assert.equal('Handler for \'notFoundMethod\' is missing.', callError);

    const {error: getMethodError} = await service.getMethodError();
    assert.equal('getMethodError!', getMethodError);

    const {error: throwMethodError} = await service.throwMethod();
    assert.equal(42, throwMethodError);

    await service.dispose();
    await helper.close();
  });
});

describe('NddService', function() {
  const NDD_STORE = path.join(__dirname, '.ndd_store');
  const SERVICE_DIR = path.join(__dirname, '..', 'services');

  this.timeout(5000);
  beforeEach(function() {
    if (!fs.existsSync(NDD_STORE))
      return util.promisify(fs.mkdir)(NDD_STORE);
  });

  afterEach(async function() {
    await util.promisify(fs.rmdir)(NDD_STORE);
  });

  it('kill', async function() {
    const helper = await ServiceHelper.create();
    const {error, service} = await helper.createService('ndd_service', SERVICE_DIR);
    assert.ifError(error);
    await service.start({nddStore: NDD_STORE, cleanupInterval: 100});

    service.run({
      execPath: process.execPath,
      args: ['-e', 'for(;;);'],
      options: { doNotInheritEnv: true }
    });

    const added = await service.onAdded();
    assert(!!added.instanceId);

    service.kill({instanceId: added.instanceId});
    const finished = await service.onFinished();
    assert.equal(added.instanceId, finished.instanceId);

    await service.dispose();
    await helper.close();
  });

  it('detached when process is killed', async function() {
    const helper = await ServiceHelper.create();
    const {error, service} = await helper.createService('ndd_service', SERVICE_DIR);
    assert.ifError(error);
    await service.start({nddStore: NDD_STORE, cleanupInterval: 100});

    service.run({
      execPath: process.execPath,
      args: ['-e', 'for(;;);'],
      options: { doNotInheritEnv: true }
    });

    const added = await service.onAdded();
    assert(!!added.instanceId);

    service.attach({ instanceId: added.instanceId });
    const attached = await service.onAttached();
    assert.equal(added.instanceId, attached.instanceId);

    const debuggerEnabled = service.sendMessage({
      instanceId: added.instanceId,
      message: JSON.stringify({
        id: 1,
        method: 'Debugger.enable'
      })
    });
    const scriptParsed = await service.onMessage();
    assert.equal(added.instanceId, scriptParsed.instanceId);
    assert.equal('Debugger.scriptParsed', JSON.parse(scriptParsed.message).method);
    await debuggerEnabled;

    service.kill({instanceId: added.instanceId});
    const [finished, detached] = await Promise.all([
      service.onFinished(),
      service.onDetached()
    ]);
    assert.equal(added.instanceId, finished.instanceId);
    assert.equal(added.instanceId, detached.instanceId);

    await service.dispose();
    await helper.close();
  });

  it('attach-detach', async function() {
    const helper = await ServiceHelper.create();
    const {error, service} = await helper.createService('ndd_service', SERVICE_DIR);
    assert.ifError(error);
    await service.start({nddStore: NDD_STORE, cleanupInterval: 100});

    service.run({
      execPath: process.execPath,
      args: ['-e', 'for(;;);'],
      options: { doNotInheritEnv: true }
    });

    const added = await service.onAdded();
    assert(!!added.instanceId);

    service.attach({
      instanceId: added.instanceId
    });
    const attached = await service.onAttached();
    assert.equal(added.instanceId, attached.instanceId);

    service.sendMessage({
      instanceId: added.instanceId,
      message: JSON.stringify({
        id: 1,
        method: 'Runtime.enable'
      })
    });
    const contextCreated = await service.onMessage();
    assert.equal(added.instanceId, contextCreated.instanceId);
    assert.equal('Runtime.executionContextCreated', JSON.parse(contextCreated.message).method);

    service.detach({instanceId: added.instanceId });
    const detached = await service.onDetached();
    assert.equal(added.instanceId, detached.instanceId);

    service.kill({instanceId: added.instanceId});
    const finished = await service.onFinished();
    assert.equal(added.instanceId, finished.instanceId);

    await service.dispose();
    await helper.close();
  });

  it('waitAtStart', async function() {
    const helper = await ServiceHelper.create();
    const {error, service} = await helper.createService('ndd_service', SERVICE_DIR);
    assert.ifError(error);
    await service.start({nddStore: NDD_STORE, cleanupInterval: 100});

    const groupId = 'myGroupId';
    service.run({
      execPath: process.execPath,
      args: ['-e', 'console.log(42)'],
      options: {
        waitAtStart: true,
        groupId: groupId,
        doNotInheritEnv: true
      }
    });

    const added = await service.onAdded();
    assert(!!added.instanceId);
    assert.equal(groupId, added.groupId);

    service.attach({
      instanceId: added.instanceId
    });
    const attached = await service.onAttached();
    assert.equal(added.instanceId, attached.instanceId);

    service.sendMessage({
      instanceId: added.instanceId,
      message: JSON.stringify({
        id: 1,
        method: 'Runtime.enable'
      })
    });
    await service.sendMessage({
      instanceId: added.instanceId,
      message: JSON.stringify({
        id: 2,
        method: 'Runtime.evaluate',
        params: {
          expression: 'process.runIfWaitingAtStart()'
        }
      })
    });

    await service.onMessage(1, params => JSON.parse(params.message).method === 'Runtime.executionContextDestroyed');

    service.detach({
      instanceId: added.instanceId
    });

    const finished = await service.onFinished();
    assert.equal(added.instanceId, finished.instanceId);

    await service.dispose();
    await helper.close();
  });

  it('breakAtFirstLine with -e', async function() {
    const helper = await ServiceHelper.create();
    const {error, service} = await helper.createService('ndd_service', SERVICE_DIR);
    assert.ifError(error);
    await service.start({nddStore: NDD_STORE, cleanupInterval: 100});

    const groupId = 'myGroupId';
    service.run({
      execPath: process.execPath,
      args: ['-e', '\n  console.log(42)'],
      options: {
        waitAtStart: true,
        groupId: groupId,
        doNotInheritEnv: true
      }
    });

    const added = await service.onAdded();
    assert(!!added.instanceId);
    assert.equal(groupId, added.groupId);

    service.attach({
      instanceId: added.instanceId
    });
    const attached = await service.onAttached();
    assert.equal(added.instanceId, attached.instanceId);

    service.sendMessage({
      instanceId: added.instanceId,
      message: JSON.stringify({
        id: 1,
        method: 'Debugger.enable'
      })
    });

    service.sendMessage({
      instanceId: added.instanceId,
      message: JSON.stringify({
        id: 2,
        method: 'Runtime.evaluate',
        params: {
          expression: 'process.runIfWaitingAtStart(true)',
          includeCommandLineAPI: true
        }
      })
    });

    const paused = await service.onMessage(1, params => JSON.parse(params.message).method === 'Debugger.paused');
    const location = JSON.parse(paused.message).params.callFrames[0].location;
    assert.equal(3, location.lineNumber);
    assert.equal(2, location.columnNumber);

    service.detach({
      instanceId: added.instanceId
    });

    const finished = await service.onFinished();
    assert.equal(added.instanceId, finished.instanceId);

    await service.dispose();
    await helper.close();
  });

  it('breakAtFirstLine with file', async function() {
    const helper = await ServiceHelper.create();
    const {error, service} = await helper.createService('ndd_service', SERVICE_DIR);
    assert.ifError(error);
    await service.start({nddStore: NDD_STORE, cleanupInterval: 100});

    const groupId = 'myGroupId';
    service.run({
      execPath: process.execPath,
      args: ['test/trivial.js'],
      options: {
        waitAtStart: true,
        groupId: groupId,
        doNotInheritEnv: true
      }
    });

    const added = await service.onAdded();
    assert(!!added.instanceId);
    assert.equal(groupId, added.groupId);

    service.attach({
      instanceId: added.instanceId
    });
    const attached = await service.onAttached();
    assert.equal(added.instanceId, attached.instanceId);

    service.sendMessage({
      instanceId: added.instanceId,
      message: JSON.stringify({
        id: 1,
        method: 'Debugger.enable'
      })
    });

    service.sendMessage({
      instanceId: added.instanceId,
      message: JSON.stringify({
        id: 2,
        method: 'Runtime.evaluate',
        params: {
          expression: 'process.runIfWaitingAtStart(true)',
          includeCommandLineAPI: true
        }
      })
    });

    const paused = await service.onMessage(1, params => JSON.parse(params.message).method === 'Debugger.paused');
    const location = JSON.parse(paused.message).params.callFrames[0].location;
    assert.equal(6, location.lineNumber);
    assert.equal(2, location.columnNumber);

    service.detach({
      instanceId: added.instanceId
    });

    const finished = await service.onFinished();
    assert.equal(added.instanceId, finished.instanceId);

    await service.dispose();
    await helper.close();
  });

  it('breakAtFirstLine with module', async function() {
    const helper = await ServiceHelper.create();
    const {error, service} = await helper.createService('ndd_service', SERVICE_DIR);
    assert.ifError(error);
    await service.start({nddStore: NDD_STORE, cleanupInterval: 100});

    const groupId = 'myGroupId';
    service.run({
      execPath: process.execPath,
      args: ['--experimental-modules', 'test/trivial.mjs'],
      options: {
        waitAtStart: true,
        groupId: groupId,
        doNotInheritEnv: true
      }
    });

    const added = await service.onAdded();
    assert(!!added.instanceId);
    assert.equal(groupId, added.groupId);
    const major = process.version.slice(1).split('.')[0] * 1;
    if (major < 10) {
      console.warn('breakAtFirstLine is not supported for modules before 10');
      service.kill({instanceId: added.instanceId});
      await service.onFinished();
      await service.dispose();
      await helper.close();
      await util.promisify(fs.rmdir)(NDD_STORE);
      this.skip();
      return;
    }

    service.attach({
      instanceId: added.instanceId
    });
    const attached = await service.onAttached();
    assert.equal(added.instanceId, attached.instanceId);

    service.sendMessage({
      instanceId: added.instanceId,
      message: JSON.stringify({
        id: 1,
        method: 'Debugger.enable'
      })
    });

    service.sendMessage({
      instanceId: added.instanceId,
      message: JSON.stringify({
        id: 2,
        method: 'Runtime.evaluate',
        params: {
          expression: 'process.runIfWaitingAtStart(true)',
          includeCommandLineAPI: true
        }
      })
    });

    await service.onMessage(1, params => JSON.parse(params.message).method === 'Debugger.paused');

    service.sendMessage({
      instanceId: added.instanceId,
      message: JSON.stringify({
        id: 3,
        method: 'Debugger.stepInto'
      })
    });

    const paused = await service.onMessage(1, params => JSON.parse(params.message).method === 'Debugger.paused');

    const location = JSON.parse(paused.message).params.callFrames[0].location;
    assert.equal(6, location.lineNumber);
    assert.equal(2, location.columnNumber);

    service.detach({
      instanceId: added.instanceId
    });

    const finished = await service.onFinished();
    assert.equal(added.instanceId, finished.instanceId);

    await service.dispose();
    await helper.close();
  });
});

// eslint-disable-next-line
async function dumpSourceLocation(service, instanceId, messageId,
  {scriptId, lineNumber, columnNumber}) {
  service.sendMessage({
    instanceId: instanceId,
    message: JSON.stringify({
      id: messageId,
      method: 'Debugger.getScriptSource',
      params: {
        scriptId: scriptId
      }
    })
  });
  const scriptSource = await service.onMessage(1, params => JSON.parse(params.message).id === messageId);
  const source = JSON.parse(scriptSource.message).result.scriptSource;
  const lines = source.split('\n');
  const line = lines[lineNumber];
  lines[lineNumber] = line.slice(0, columnNumber) + '#' + (line.slice(columnNumber) || '');
  console.log(lines.join('\n'));
}

describe('FileSystem', function() {
  before(async function() {
    this.browser = await puppeteer.launch({pipe: true});
  });
  after(async function() {
    await this.browser.close();
  });
  beforeEach(async function() {
    this.currentTest.page = await this.browser.newPage();
    this.currentTest.page.on('console', async msg => {
      console.log(...await Promise.all(msg.args().map(arg => arg.jsonValue())));
    });
    const fileSystemScript = require.resolve(path.join(__dirname, '..', 'front_end', 'host', 'FileSystem.js'));
    const fileSystemScriptContent = await util.promisify(fs.readFile)(fileSystemScript, 'utf8');
    await this.currentTest.page.evaluate(fileSystemScriptContent);

    this.currentTest.fs = await FileSystem.create(this.currentTest.page);
    this.currentTest.page.safeEvaluate = this.currentTest.page.evaluate;
  });

  it('root', async function() {
    this.test.fs._registerFileSystem('fs', path.join(__dirname, 'fs'));
    await this.test.page.evaluate(() => { self.fs = new FileSystem('fs'); });
    const root = await this.test.page.evaluate(() => self.fs.root.serializeForTest());
    assert.equal('/', root.fullPath);
    assert.equal(true, root.isDirectory);
    assert.equal(false, root.isFile);
    assert.equal('', root.name);
  });

  it('getFile', async function() {
    this.test.fs._registerFileSystem('fs', path.join(__dirname, 'fs'));
    await this.test.page.evaluate(() => { self.fs = new FileSystem('fs'); });
    const {error: notFoundError} = await this.test.page.evaluate(async() =>
      new Promise(resolve => fs.root.getFile('file2', {}, resolve, err => resolve({error: err}))));
    assert.equal('NotFoundError', notFoundError.name);
    const file1 = await this.test.page.evaluate(async () => {
      return new Promise(resolve => fs.root.getFile('file1', {}, entry => resolve(entry.serializeForTest())));
    });
    assert.equal('/file1', file1.fullPath);
    assert.equal(false, file1.isDirectory);
    assert.equal(true, file1.isFile);
    assert.equal('file1', file1.name);

    const file2 = await this.test.page.evaluate(async () => {
      return new Promise(resolve => fs.root.getFile('folder1/file2', {}, entry => resolve(entry.serializeForTest())));
    });
    assert.equal('/folder1/file2', file2.fullPath);
    assert.equal(false, file2.isDirectory);
    assert.equal(true, file2.isFile);
    assert.equal('file2', file2.name);

    const file2FromFolder1 = await this.test.page.evaluate(async () => {
      const d = await new Promise(resolve => fs.root.getDirectory('folder1', {}, resolve));
      return new Promise(resolve => d.getFile('file2', {}, entry => resolve(entry.serializeForTest())));
    });
    assert.equal('/folder1/file2', file2FromFolder1.fullPath);
    assert.equal(false, file2FromFolder1.isDirectory);
    assert.equal(true, file2FromFolder1.isFile);
    assert.equal('file2', file2FromFolder1.name);
  });

  it('getDirectory', async function() {
    this.test.fs._registerFileSystem('fs', path.join(__dirname, 'fs'));
    await this.test.page.evaluate(() => { self.fs = new FileSystem('fs'); });
    const {error: notFoundError} = await this.test.page.evaluate(async () => {
      return new Promise(resolve => fs.root.getDirectory('folder2', {}, resolve, err => resolve({error: err})));
    });
    assert.equal('NotFoundError', notFoundError.name);
    const folder1 = await this.test.page.evaluate(async () => {
      return new Promise(resolve => fs.root.getDirectory('folder1', {}, entry => resolve(entry.serializeForTest())));
    });
    assert.equal('/folder1', folder1.fullPath);
    assert.equal(true, folder1.isDirectory);
    assert.equal(false, folder1.isFile);
    assert.equal('folder1', folder1.name);

    const folder2 = await this.test.page.evaluate(async () => {
      return new Promise(resolve => fs.root.getDirectory('folder1/folder2', {}, entry => resolve(entry.serializeForTest())));
    });    
    assert.equal('/folder1/folder2', folder2.fullPath);
    assert.equal(true, folder2.isDirectory);
    assert.equal(false, folder2.isFile);
    assert.equal('folder2', folder2.name);    

    const folder2FromFolder1 = await this.test.page.evaluate(async () => {
      const d = await new Promise(resolve => fs.root.getDirectory('folder1', {}, resolve));
      return new Promise(resolve => d.getDirectory('folder2', {}, entry => resolve(entry.serializeForTest())));
    });
    assert.equal('/folder1/folder2', folder2FromFolder1.fullPath);
    assert.equal(true, folder2FromFolder1.isDirectory);
    assert.equal(false, folder2FromFolder1.isFile);
    assert.equal('folder2', folder2FromFolder1.name);    
  });

  it('createReader', async function() {
    this.test.fs._registerFileSystem('fs', path.join(__dirname, 'fs'));
    await this.test.page.evaluate(() => { self.fs = new FileSystem('fs'); });
    const rootContent = await this.test.page.evaluate(async () => {
      const result = await new Promise(resolve => fs.root.createReader().readEntries(resolve));
      return result.map(r => r.serializeForTest());
    });
    rootContent.sort((a,b) => a.fullPath.localeCompare(b.fullPath));
    assert.equal('/file1', rootContent[0].fullPath);
    assert.equal(false, rootContent[0].isDirectory);
    assert.equal(true, rootContent[0].isFile);
    assert.equal('file1', rootContent[0].name);
    assert.equal('/folder1', rootContent[1].fullPath);
    assert.equal(true, rootContent[1].isDirectory);
    assert.equal(false, rootContent[1].isFile);
    assert.equal('folder1', rootContent[1].name);

    const readEntriesTwice = await this.test.page.evaluate(async () => {
      const reader = fs.root.createReader();
      reader.readEntries(() => []);
      const result = await new Promise(resolve => reader.readEntries(resolve));
      return result.map(r => r.serializeForTest());
    });
    assert.equal(0, readEntriesTwice.length);
  });

  it('getParent', async function() {
    this.test.fs._registerFileSystem('fs', path.join(__dirname, 'fs'));
    await this.test.page.evaluate(() => { self.fs = new FileSystem('fs'); });
    const [file3, folder2, folder1, root, rootAgain] = await this.test.page.evaluate(async () => {
      const file3 = await new Promise(resolve => fs.root.getFile('folder1/folder2/file3', {}, resolve));
      return [
        file3.serializeForTest(),
        file3.getParent().serializeForTest(),
        file3.getParent().getParent().serializeForTest(),
        file3.getParent().getParent().getParent().serializeForTest(),
        file3.getParent().getParent().getParent().getParent().serializeForTest()
      ];
    });
    assert.equal('/folder1/folder2/file3', file3.fullPath);
    assert.equal(false, file3.isDirectory);
    assert.equal(true, file3.isFile);
    assert.equal('file3', file3.name);

    assert.equal('/folder1/folder2', folder2.fullPath);
    assert.equal(true, folder2.isDirectory);
    assert.equal(false, folder2.isFile);
    assert.equal('folder2', folder2.name);

    assert.equal('/folder1', folder1.fullPath);
    assert.equal(true, folder1.isDirectory);
    assert.equal(false, folder1.isFile);
    assert.equal('folder1', folder1.name);

    assert.equal('/', root.fullPath);
    assert.equal(true, root.isDirectory);
    assert.equal(false, root.isFile);
    assert.equal('', root.name);

    assert.equal('/', rootAgain.fullPath);
    assert.equal(true, rootAgain.isDirectory);
    assert.equal(false, rootAgain.isFile);
    assert.equal('', rootAgain.name);
  });

  it('getMetadata', async function() {
    this.test.fs._registerFileSystem('fs', path.join(__dirname, 'fs'));
    await this.test.page.evaluate(() => { self.fs = new FileSystem('fs'); });

    const result = await this.test.page.evaluate(async () => {
      const file = await new Promise(resolve => self.fs.root.getFile('file1', {}, resolve));
      const metadata = await new Promise(resolve => file.getMetadata(resolve));
      return {modificationTime: metadata.modificationTime.toString(), size: metadata.size};
    });
    assert(result.modificationTime.length > 0);
    assert.equal(5, result.size);
  });

  it('create file', async function() {
    this.test.fs._registerFileSystem('fs', path.join(__dirname, 'fs'));
    await this.test.page.evaluate(() => { self.fs = new FileSystem('fs'); });

    const newFile = await this.test.page.evaluate(async () => {
      try {
        self.newFile = await new Promise((resolve, reject) => self.fs.root.getFile('new_file', {create: true}, resolve, reject));
        return self.newFile.serializeForTest();
      } catch (e) {
        return e;
      }
    });
    assert.equal('/new_file', newFile.fullPath);
    assert.equal(false, newFile.isDirectory);
    assert.equal(true, newFile.isFile);
    assert.equal('new_file', newFile.name);

    const error = await this.test.page.evaluate(async () => {
      try {
        const file = await new Promise((resolve, reject) => self.fs.root.getFile('new_file', {create: true, exclusive: true}, resolve, reject));
        return file.serializeForTest();
      } catch (e) {
        return e;
      }
    });
    assert.equal('PathExistsError', error.name);

    const removeResult = await this.test.page.evaluate(async () => {
      try {
        await new Promise((resolve, reject) => self.newFile.remove(resolve, reject));
        return {};
      } catch (e) {
        return e;
      }
    });
    assert(!removeResult.error);

    const removedFile = await this.test.page.evaluate(async () => {
      try {
        const file = await new Promise((resolve, reject) => self.fs.root.getFile('new_file', {}, resolve, reject));
        return file.serializeForTest();
      } catch (e) {
        return e;
      }
    });
    assert.equal('NotFoundError', removedFile.name);
  });

  it('create file outside of root', async function() {
    this.test.fs._registerFileSystem('fs', path.join(__dirname, 'fs'));
    await this.test.page.evaluate(() => { self.fs = new FileSystem('fs'); });

    const newFile = await this.test.page.evaluate(async () => {
      try {
        self.newFile = await new Promise((resolve, reject) => self.fs.root.getFile('folder1/new_file', {create: true}, resolve, reject));
        return self.newFile.serializeForTest();
      } catch (e) {
        return e;
      }
    });
    assert.equal('/folder1/new_file', newFile.fullPath);
    assert.equal(false, newFile.isDirectory);
    assert.equal(true, newFile.isFile);
    assert.equal('new_file', newFile.name);

    const error = await this.test.page.evaluate(async () => {
      try {
        const file = await new Promise((resolve, reject) => self.fs.root.getFile('folder1/new_file', {create: true, exclusive: true}, resolve, reject));
        return file.serializeForTest();
      } catch (e) {
        return e;
      }
    });
    assert.equal('PathExistsError', error.name);

    const removeResult = await this.test.page.evaluate(async () => {
      try {
        await new Promise((resolve, reject) => self.newFile.remove(resolve, reject));
        return {};
      } catch (e) {
        return e;
      }
    });
    assert(!removeResult.error);

    const removedFile = await this.test.page.evaluate(async () => {
      try {
        const file = await new Promise((resolve, reject) => self.fs.root.getFile('folder1/new_file', {}, resolve, reject));
        return file.serializeForTest();
      } catch (e) {
        return e;
      }
    });
    assert.equal('NotFoundError', removedFile.name);
  });

  it('create dir', async function() {
    this.test.fs._registerFileSystem('fs', path.join(__dirname, 'fs'));
    await this.test.page.evaluate(() => { self.fs = new FileSystem('fs'); });

    const newFolder = await this.test.page.evaluate(async () => {
      try {
        self.newFolder = await new Promise((resolve, reject) => self.fs.root.getDirectory('new_folder', {create: true}, resolve, reject));
        return self.newFolder.serializeForTest();
      } catch (e) {
        return e;
      }
    });
    assert.equal('/new_folder', newFolder.fullPath);
    assert.equal(true, newFolder.isDirectory);
    assert.equal(false, newFolder.isFile);
    assert.equal('new_folder', newFolder.name);

    const error = await this.test.page.evaluate(async () => {
      try {
        const folder = await new Promise((resolve, reject) => self.fs.root.getDirectory('new_folder', {create: true, exclusive: true}, resolve, reject));
        return folder.serializeForTest();
      } catch (e) {
        return e;
      }
    });
    assert.equal('PathExistsError', error.name);

    const removeResult = await this.test.page.evaluate(async () => {
      try {
        await new Promise((resolve, reject) => self.newFolder.remove(resolve, reject));
        return {};
      } catch (e) {
        return e;
      }
    });
    assert(!removeResult.error);

    const removedDir = await this.test.page.evaluate(async () => {
      try {
        const file = await new Promise((resolve, reject) => self.fs.root.getDirectory('new_folder', {}, resolve, reject));
        return file.serializeForTest();
      } catch (e) {
        return e;
      }
    });
    assert.equal('NotFoundError', removedDir.name);
  });

  it('moveTo file', async function() {
    this.test.fs._registerFileSystem('fs', path.join(__dirname, 'fs'));
    await this.test.page.evaluate(() => { self.fs = new FileSystem('fs'); });

    const entryToMove = await this.test.page.evaluate(async () => {
      try {
        self.newFile = await new Promise((resolve, reject) => self.fs.root.getFile('new_file', {create: true}, resolve, reject));
        return self.newFile.serializeForTest();
      } catch (e) {
        return e;
      }
    });
    const moveResult = await this.test.page.evaluate(async () => {
      try {
        const targetFolder = await new Promise((resolve, reject) => self.fs.root.getDirectory('folder1', {}, resolve, reject));
        self.movedFile = await new Promise((resolve, reject) => self.newFile.moveTo(targetFolder, 'new_file2', resolve, reject));
        await new Promise((resolve, reject) => self.movedFile.remove(resolve, reject));
        return self.movedFile.serializeForTest();
      } catch (e) {
        return e;
      }
    });
    assert.equal('/folder1/new_file2', moveResult.fullPath);
    assert.equal(false, moveResult.isDirectory);
    assert.equal(true, moveResult.isFile);
    assert.equal('new_file2', moveResult.name);
  });

  it('moveTo folder', async function() {
    this.test.fs._registerFileSystem('fs', path.join(__dirname, 'fs'));
    await this.test.page.evaluate(() => { self.fs = new FileSystem('fs'); });

    const entryToMove = await this.test.page.evaluate(async () => {
      try {
        self.newFolder = await new Promise((resolve, reject) => self.fs.root.getDirectory('new_folder', {create: true}, resolve, reject));
      } catch (e) {
        return e;
      }
    });
    const moveResult = await this.test.page.evaluate(async () => {
      try {
        const targetFolder = await new Promise((resolve, reject) => self.fs.root.getDirectory('folder1', {}, resolve, reject));
        self.movedFolder = await new Promise((resolve, reject) => self.newFolder.moveTo(targetFolder, 'new_folder2', resolve, reject));
        await new Promise((resolve, reject) => self.movedFolder.remove(resolve, reject));
        return self.movedFolder.serializeForTest();
      } catch (e) {
        return e;
      }
    });
    assert.equal('/folder1/new_folder2', moveResult.fullPath);
    assert.equal(true, moveResult.isDirectory);
    assert.equal(false, moveResult.isFile);
    assert.equal('new_folder2', moveResult.name);
  });

  it('file', async function() {
    this.test.fs._registerFileSystem('fs', path.join(__dirname, 'fs'));
    await this.test.page.evaluate(() => { self.fs = new FileSystem('fs'); });

    const file1Content = await this.test.page.evaluate(async () => {
      const file1 = await new Promise((resolve, reject) => self.fs.root.getFile('file1', {}, resolve, reject));
      const blob = await new Promise((resolve, reject) => file1.file(resolve, reject));
      const reader = new FileReader();
      const readPromise = new Promise(x => reader.onloadend = x);
      reader.readAsText(blob);
      await readPromise;
      return reader.result;
    });
    assert.equal('file1', file1Content);
  });

  it('createWriter', async function() {
    this.test.fs._registerFileSystem('fs', path.join(__dirname, 'fs'));
    await this.test.page.evaluate(() => { self.fs = new FileSystem('fs'); });

    await this.test.page.evaluate(async () => {
      const file = await new Promise((resolve, reject) => self.fs.root.getFile('new_file', {create: true}, resolve, reject));
      const writer = await new Promise((resolve, reject) => file.createWriter(resolve, reject));
      writeDone = new Promise(resolve => writer.onwriteend = resolve);
      const blob = await (await fetch(`data:application/octet-stream;base64,SGVsbG8sIFdvcmxk`)).blob();
      writer.write(blob);
      await writeDone;
    });

    const newFileContent = await this.test.page.evaluate(async () => {
      const file = await new Promise((resolve, reject) => self.fs.root.getFile('new_file', {}, resolve, reject));
      const blob = await new Promise((resolve, reject) => file.file(resolve, reject));
      const reader = new FileReader();
      const readPromise = new Promise(x => reader.onloadend = x);
      reader.readAsText(blob);
      await readPromise;
      await new Promise((resolve, reject) => file.remove(resolve, reject));
      return reader.result;
    });
    assert.equal('Hello, World', newFileContent);
  });
});
