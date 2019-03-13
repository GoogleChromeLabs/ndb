/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const util = require('util');

const Terser = require('terser');

const fsReadFile = util.promisify(fs.readFile);

const DEVTOOLS_DIR = path.dirname(
    require.resolve('chrome-devtools-frontend/front_end/shell.json'));

function minify(code) {
  return Terser.minify(code, {
    mangle: false,
    ecma: 8,
    compress: false
  }).code;
}

async function write(stream, data) {
  let callback;
  const promise = new Promise(resolve => callback = resolve);
  const success = stream.write(data, 'utf8', callback);
  if (!success)
    await new Promise(resolve => stream.once('drain', resolve));
  return promise;
}

class ReleaseBuilder {
  constructor(path, output) {
    this._path = path;
    this._output = output;
    this._specialCaseNameSpaces = {
      'sdk': 'SDK',
      'js_sdk': 'JSSDK',
      'browser_sdk': 'BrowserSDK',
      'ui': 'UI',
      'object_ui': 'ObjectUI',
      'perf_ui': 'PerfUI',
      'har_importer': 'HARImporter',
      'sdk_test_runner': 'SDKTestRunner',
      'cpu_profiler_test_runner': 'CPUProfilerTestRunner'
    };
    this._images = new Set(['popoverArrows.png']);
  }

  async _copyFile(source, destination) {
    if (fs.copyFile)
      await util.promisify(fs.copyFile)(source, destination);
    else
      require('fs-copy-file-sync')(source, destination);
  }

  async _readFile(name) {
    const content = await fsReadFile(name, 'utf8');
    const re = /Images\/[a-zA-Z_.0-9]+/g;
    const m = content.match(re);
    if (m) {
      for (const image of m)
        this._images.add(image.split('/')[1]);
    }
    return content;
  }

  async _loadApp(name) {
    const fullName = this._lookupFile(`${name}.json`);
    const descriptor = JSON.parse(await this._readFile(fullName));
    const modules = descriptor.modules;
    const app = { name };
    let extendsName = descriptor.extends;
    while (extendsName) {
      const fullName = this._lookupFile(`${extendsName}.json`);
      const descriptor = JSON.parse(await this._readFile(fullName));
      modules.push(...descriptor.modules);
      extendsName = descriptor.extends;
    }
    const loadedModules = this._topologicalSort(
        await Promise.all(modules.map(async module => {
          const fullName = this._lookupFile(`${module.name}${path.sep}module.json`);
          const descriptor = JSON.parse(await this._readFile(fullName));
          return {
            ...descriptor,
            ...module
          };
        })));

    app.autoStartModules = loadedModules.filter(({type}) => type === 'autostart');
    app.otherModules = loadedModules.filter(({type}) => type !== 'autostart');
    app.releaseModuleDescriptors = loadedModules.map(module => {
      const descriptor = { name: module.name, remote: false };
      if (module.type !== 'autostart')
        descriptor.scripts = [`${module.name}_module.js`];
      if (module.extensions)
        descriptor.extensions = module.extensions;
      if (module.dependencies)
        descriptor.dependencies = module.dependencies;
      if (module.condition)
        descriptor.condition = module.condition;
      return descriptor;
    });
    app.descriptor = { modules: loadedModules.map(module => {
      const descriptor = { name: module.name };
      if (module.type === 'autostart')
        descriptor.type = 'autostart';
      if (module.condition)
        descriptor.condition = module.condition;
      return descriptor;
    })};
    return app;
  }

  async buildWorkerApp(name) {
    const app = await this._loadApp(name);
    app.hasHTML = false;
    await Promise.all([
      this._buildAppScript(app),
      this._buildDynamicScripts(app),
    ]);
  }

  async buildApp(name) {
    const app = await this._loadApp(name);
    app.hasHTML = true;
    await Promise.all([
      this._buildHtml(app),
      this._buildAppScript(app),
      this._buildDynamicScripts(app),
    ]);
    await this._copyFile(this._lookupFile('favicon.ico'), path.join(this._output, 'favicon.ico'));
    await util.promisify(fs.mkdir)(path.join(this._output, 'Images'));
    await Promise.all(Array.from(this._images)
        .map(image => this._copyFile(this._lookupFile(path.join('Images', image)), path.join(this._output, 'Images', image))));
  }

  _topologicalSort(modules) {
    const moduleByName = new Map(modules.map(module => [module.name, module]));
    const result = [];
    const unvisited = new Set(moduleByName.keys());
    const temp = new Set();
    while (true) {
      const it = unvisited.values().next();
      if (it.done)
        break;
      if (!visit(it.value))
        break;
    }
    return result;

    function visit(name) {
      if (!unvisited.has(name))
        return true;
      if (!moduleByName.has(name))
        return false;
      if (temp.has(name))
        return false;
      temp.add(name);
      const deps = moduleByName.get(name).dependencies || [];
      for (const dep of deps) {
        if (!visit(dep))
          return false;
      }
      unvisited.delete(name);
      temp.delete(name);
      result.push(moduleByName.get(name));
      return true;
    }
  }

  async _buildHtml(app) {
    const htmlName = `${app.name}.html`;
    const output = fs.createWriteStream(path.join(this._output, htmlName));

    const jsFullName = this._lookupFile(`${app.name}.js`);
    const jsContent = await util.promisify(fs.readFile)(jsFullName, 'utf8');

    const htmlFullName = this._lookupFile(htmlName);
    const rl = readline.createInterface({
      input: fs.createReadStream(htmlFullName, {encoding: 'utf8'}),
      crlfDelay: Infinity
    });
    const outputLines = [];
    rl.on('line', line => {
      if (line.includes('<script ') || line.includes('<link '))
        return;
      if (line.includes('</head>')) {
        outputLines.push(`    <script type="text/javascript" src="${app.name}.js"></script>\n`);
        outputLines.push(`    <script>${minify(jsContent)}</script>\n`);
      }
      outputLines.push(`${line}\n`);
    });
    await new Promise(resolve => rl.on('close', resolve));
    rl.close();
    for (const line of outputLines)
      await write(output, line);
    output.close();
  }

  async _buildAppScript(app) {
    const scriptName = `${app.name}.js`;
    const output = fs.createWriteStream(path.join(this._output, scriptName));
    await write(output, '/* Runtime.js */\n');
    const runtimeFullName = this._lookupFile(`Runtime.js`);
    await write(output, minify(await this._readFile(runtimeFullName, 'utf8')));
    await write(output, `allDescriptors.push(...${JSON.stringify(app.releaseModuleDescriptors)});`);
    await write(output, `/* Application descriptor ${app.name} */`);
    await write(output, `applicationDescriptor = ${JSON.stringify(app.descriptor)}`);
    await write(output, '/* Autostart modules */;\n');
    let content = (await Promise.all(app.autoStartModules.map(module => this._writeScripts(module)))).join('\n');
    content = minify(content);
    await write(output, content);
    await write(output, ';\n/* Autostart resources */\n');
    const resources = [];
    for (const module of app.autoStartModules) {
      if (!module.resources) continue;
      resources.push(...module.resources
          .map(resource => path.join(module.name, resource)));
    }
    await this._writeResources(resources, output);
    if (!app.hasHTML) {
      try {
        const jsFile = this._lookupFile(`${app.name}.js`);
        await write(output, minify(await this._readFile(jsFile, 'utf8')));
      } catch (e) {
      }
    }
    await new Promise(resolve => output.end(resolve));
    output.close();
  }

  async _writeScripts(module) {
    if (!module.scripts)
      return '';
    let namespace = module.name
        .split('_')
        .map(name => name.charAt(0).toUpperCase() + name.substr(1)).join('');
    if (module.name in this._specialCaseNameSpaces)
      namespace = this._specialCaseNameSpaces[module.name];
    let result = '';
    result += `\n/* Module ${module.name} */\n`;
    result += `\nself['${namespace}'] = self['${namespace}'] || {};\n`;
    result += (await Promise.all(module.scripts.map(async name => {
      const fullName = this._lookupFile(path.join(module.name,name));
      return await this._readFile(fullName, 'utf8');
    }))).join('\n');
    return result;
  }

  async _writeResources(resources, output) {
    if (!resources)
      return;
    await write(output, (await Promise.all(resources.map(async resource => {
      const fullName = this._lookupFile(resource);
      let content = await this._readFile(fullName, 'utf8');
      content = content.replace(/\\/g, '\\\\');
      content = content.replace(/\r?\n/g, '\\n');
      content = content.replace(/"/g, '\\"');
      return `Runtime.cachedResources["${resource.split(path.sep).join('/')}"] = "${content}";\n`;
    }))).join(''));
  }

  _buildDynamicScripts(app) {
    return Promise.all(app.otherModules.map(async module => {
      const folder = path.join(this._output, module.name);
      if (!fs.existsSync(folder))
        await util.promisify(fs.mkdir)(folder);
      const output = fs.createWriteStream(
          path.join(folder, `${module.name}_module.js`));
      await write(output, minify(await this._writeScripts(module)));
      if (module.resources) {
        await this._writeResources(
            module.resources.map(resource => path.join(module.name, resource)), output);
      }
    }));
  }

  _lookupFile(name) {
    for (const folder of this._path) {
      const fullName = path.join(folder, name);
      if (fs.existsSync(fullName))
        return fullName;
    }
    throw new Error(`File ${name} not found`);
  }
}

module.exports = {ReleaseBuilder};
