const fs = {
  ...require('fs'),
  ...require('fs').promises
};
const os = require('os');
const path = require('path');

/**
 * @typedef {Object} AppDescriptor
 * @property {string} name
 * @property {!Array<!Object>} modules
 * @property {boolean} hasHtml
 * @property {?string} extends
 */

/**
 * @typedef {Object} RawModuleDescriptor
 * @property {!Array} dependencies
 * @property {!Array} scripts
 * @property {!Array} resources
 * @property {!Array} extensions
 * @property {string} experiment
 */

/**
 * @typedef {Object} ModuleDescriptor
 * @property {string} content
 * @property {!Array=} extensions
 * @property {!Array=} dependencies
 * @property {string=} experiment
 */

/**
 * @param {!Array<string>} appNames
 * @param {!Array<string>} pathFolders
 * @return {!Promise<!Map<string, !AppDescriptor>>}
 */
async function loadAppDescriptors(appNames, pathFolders) {
  const descriptors = new Map();
  const descriptorQueue = appNames.slice(0);
  while (descriptorQueue.length) {
    const name = descriptorQueue.shift();
    if (descriptors.has(name))
      continue;
    const source = await loadSource(pathFolders, name + '.json');
    const content = JSON.parse(source);
    const descriptor = {
      name: name,
      modules: content.modules || [],
      hasHtml: content.has_html || false,
    };
    if (content.extends) {
      descriptor.extends = content.extends;
      descriptorQueue.push(descriptor.extends);
    }
    descriptors.set(name, descriptor);
  }
  return descriptors;
}

/**
 * @param {string} moduleName
 * @return {string}
 */
function moduleNamespace(moduleName) {
  const specialCaseNameSpaces = {
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
  return moduleName in specialCaseNameSpaces
    ? specialCaseNameSpaces[moduleName]
    : moduleName.split('_').map(name => name.charAt(0).toUpperCase() + name.substr(1)).join('');
}

/**
 * @param {!Map<string, !AppDescriptor>} appDescriptors
 * @param {!Array<string>} pathFolders
 * @return {!Promise<!Map<string, !ModuleDescriptor>>}
 */
async function loadModules(appDescriptors, pathFolders, customLoadModuleSource) {
  const modules = new Map();
  appDescriptors.forEach(descriptor => descriptor.modules.forEach(module => modules.set(module.name, null)));
  await Promise.all(Array.from(modules).map(async([moduleName, module]) => {
    modules.set(moduleName, await loadModule(pathFolders, moduleName, customLoadModuleSource));
  }));
  return modules;
}

/**
 * @param {!Array<string>} pathFolders
 * @param {string} moduleName
 * @param {!function(!Object):!Promise<string>} customLoadModuleSource
 */
async function loadModule(pathFolders, moduleName, customLoadModuleSource) {
  const { descriptor: rawDescriptor, paths } = await loadRawModule(pathFolders, moduleName, 'module.json');

  let scriptContent = await customLoadModuleSource(rawDescriptor, paths);
  const promises = [];
  if (scriptContent === null) {
    scriptContent = '';
    promises.push(...(rawDescriptor.scripts || []).map(name => loadSource(pathFolders, moduleName, name)));
  }
  promises.push(...(rawDescriptor.resources || []).map(name => loadResource(pathFolders, moduleName, name)));
  scriptContent += (await Promise.all(promises)).join('\n');

  const namespace = moduleNamespace(moduleName);
  const content = `self['${namespace}'] = self['${namespace}'] || {};\n${scriptContent}\n`;

  const descriptor = { content };
  if (rawDescriptor.extensions)
    descriptor.extensions = rawDescriptor.extensions;
  if (rawDescriptor.dependencies)
    descriptor.dependencies = rawDescriptor.dependencies;
  if (rawDescriptor.experiment)
    descriptor.experiment = rawDescriptor.experiment;
  return descriptor;

  /**
   * @param {!Array<string>} pathFolders
   * @param {string} moduleName
   * @param {string} name
   */
  async function loadResource(pathFolders, moduleName, name) {
    const resource = await loadSource(pathFolders, moduleName, name);
    const content = resource.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/'/g, '\\\'');
    return `Runtime.cachedResources['${moduleName}/${name}'] = '${content}';`;
  }
}

/**
 * @param {!Map<string, !ModuleDescriptor>} moduleDescriptors
 * @return {!Promise<!Array<!{content: !Buffer, name: string}>>}
 */
async function loadImages(moduleDescriptors, pathFolders) {
  const images = [];
  const re = /Images\/[\w.-]+/g;
  for (const [, module] of moduleDescriptors) {
    const m = module.content.match(re);
    if (m)
      images.push(...m);
  }
  return Promise.all(Array.from(new Set(images)).map(async image => ({
    content: await fs.readFile(lookupFile(pathFolders, image)[0]),
    name: image
  })));
}

/**
 * @params {!Array<string>} pathFolders
 * @param {!Array<string>} fileNameParts
 * @return {!Array<string>}
 */
function lookupFile(pathFolders, ...fileNameParts) {
  const paths = [];
  for (const pathFolder of pathFolders) {
    const absoluteFileName = path.join(pathFolder, ...fileNameParts);
    if (fs.existsSync(absoluteFileName))
      paths.push(absoluteFileName);
  }
  if (paths.length === 0)
    console.error(`File ${fileNameParts.join(path.sep)} not found in ${pathFolders}`);
  return paths;
}

/**
 * @params {!Array<string>} pathFolders
 * @param {!Array<string>} fileNameParts
 * @return {!Promise<string>}
 */
async function loadSource(pathFolders, ...fileNameParts) {
  const paths = lookupFile(pathFolders, ...fileNameParts).reverse();
  return (await Promise.all(paths.map(name => fs.readFile(name, 'utf8')))).join('\n');
}

/**
 * @params {!Array<string>} pathFolders
 * @param {!Array<string>} fileNameParts
 * @return {!Promise<!{descriptor: !RawModuleDescriptor, paths: !Array<string>}>}
 */
async function loadRawModule(pathFolders, ...fileNameParts) {
  const paths = lookupFile(pathFolders, ...fileNameParts);
  const sources = await Promise.all(paths.map(name => fs.readFile(name, 'utf8')));
  if (paths.length > 1)
    console.error('Module ' + fileNameParts[0] + ' overriden');
  const descriptors = sources.map(data => JSON.parse(data)).reverse();
  const descriptor = {
    dependencies: [],
    scripts: [],
    resources: [],
    extensions: [],
    experiment: '',
    ...descriptors[0]
  };
  return { descriptor, paths: [path[0]] };
}

/**
 * @param {!Array<string>} appNames
 * @param {!Array<string>} pathFolders
 * @param {string} outFolder
 * @param {function(string):string=} minifyJS
 * @return {!Promise}
 */
async function buildApp(appNames, pathFolders, outFolder, minifyJS = code => code, customLoadModuleSource = descriptor => Promise.resolve(null)) {
  const descriptors = await loadAppDescriptors(appNames, pathFolders);
  const modules = await loadModules(descriptors, pathFolders, customLoadModuleSource);
  const fetchedImages = await loadImages(modules, pathFolders);
  const runtime = await loadSource(pathFolders, 'Runtime.js');

  const builtApps = [];
  const notAutoStartModules = new Set();
  for (const appName of appNames) {
    const appDescriptor = { modules: [], hasHtml: false };
    let current = descriptors.get(appName);
    while (current) {
      appDescriptor.modules.push(...current.modules);
      appDescriptor.hasHtml = appDescriptor.hasHtml || current.hasHtml;
      current = current.extends ? descriptors.get(current.extends) : null;
    }

    const moduleDescriptors = appDescriptor.modules.map(module => {
      const moduleName = module.name;
      const moduleDescriptor = modules.get(module.name);
      const descriptor = { name: moduleName, remote: false };
      if (module.type !== 'autostart')
        descriptor.scripts = [`${moduleName}_module.js`];
      if (moduleDescriptor.extensions)
        descriptor.extensions = moduleDescriptor.extensions;
      if (moduleDescriptor.dependencies)
        descriptor.dependencies = moduleDescriptor.dependencies;
      if (moduleDescriptor.experiment)
        descriptor.experiment = moduleDescriptor.experiment;
      return descriptor;
    });

    const autoStartModulesByName = new Map();
    appDescriptor.modules.map(module => {
      if (module.type === 'autostart')
        autoStartModulesByName.set(module.name, module);
      else
        notAutoStartModules.add(module.name);
    });

    const appScript = await loadSource(pathFolders, appName + '.js');

    let scriptContent = '';
    scriptContent += '/* Runtime.js */\n' + runtime + '\n';
    scriptContent += `allDescriptors.push(...${JSON.stringify(moduleDescriptors)});\n`;
    scriptContent += `applicationDescriptor = ${JSON.stringify(appDescriptor)};\n`;
    scriptContent += appScript;
    const visitedModule = new Set();
    for (const [, module] of autoStartModulesByName)
      scriptContent += writeModule(modules, module, autoStartModulesByName, visitedModule);

    let htmlContent = '';
    if (appDescriptor.hasHtml) {
      const content = await loadSource(pathFolders, appName + '.html');
      htmlContent = content.replace(/<script.*?src="Runtime.js"><\/script>/, '<!-- <script src="Runtime.js"></script> -->');
    }

    builtApps.push({
      scriptContent,
      htmlContent,
      name: appName
    });

    function writeModule(modules, module, autoStartModulesByName, visitedModule) {
      if (visitedModule.has(module.name))
        return '';
      visitedModule.add(module.name);
      const builtModule = modules.get(module.name);
      let content = '';
      for (const dep of builtModule.dependencies) {
        const depModule = autoStartModulesByName.get(dep);
        if (!depModule)
          console.error(`Autostart module ${module.name} depends on not autostart module ${dep}`);
        content += writeModule(modules, depModule, autoStartModulesByName, visitedModule);
      }
      return content + builtModule.content;
    }
  }

  const favicon = await fs.readFile(lookupFile(pathFolders, 'favicon.png')[0]);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devtools-frontend-'));
  const promises = [];
  for (const app of builtApps) {
    promises.push(fs.writeFile(path.join(tmpDir, app.name + '.js'), await minifyJS(app.scriptContent)));
    if (app.htmlContent)
      promises.push(fs.writeFile(path.join(tmpDir, app.name + '.html'), app.htmlContent));
  }

  promises.push(...Array.from(notAutoStartModules).map(async moduleName => {
    await fs.mkdir(path.join(tmpDir, moduleName));
    return fs.writeFile(path.join(tmpDir, moduleName, moduleName + '_module.js'), await minifyJS(modules.get(moduleName).content));
  }));

  const createImageFolder = fs.mkdir(path.join(tmpDir, 'Images'));
  promises.push(...fetchedImages.map(async image => {
    await createImageFolder;
    if (image.content)
      return fs.writeFile(path.join(tmpDir, 'Images', image.name.substr('Images/'.length)), image.content);
  }));
  if (favicon)
    promises.push(fs.writeFile(path.join(tmpDir, 'favicon.png'), favicon));
  await Promise.all(promises);

  await fs.rename(tmpDir, outFolder);
}

module.exports = { buildApp };
