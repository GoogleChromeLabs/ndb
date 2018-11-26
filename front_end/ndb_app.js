// Copyright 2018 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

(async function(appName) {
  // copy of startApplication to get opportunity to hack sources module..
  console.timeStamp('Runtime.startApplication');

  const allDescriptorsByName = {};
  for (let i = 0; i < allDescriptors.length; ++i) {
    const d = allDescriptors[i];
    allDescriptorsByName[d['name']] = d;
  }

  if (!applicationDescriptor) {
    let data = await Runtime.loadResourcePromise(appName + '.json');
    // eslint-disable-next-line no-implicit-globals
    applicationDescriptor = JSON.parse(data);
    let descriptor = applicationDescriptor;
    while (descriptor.extends) {
      data = await Runtime.loadResourcePromise(descriptor.extends + '.json');
      descriptor = JSON.parse(data);
      applicationDescriptor.modules = descriptor.modules.concat(applicationDescriptor.modules);
    }
  }

  const configuration = applicationDescriptor.modules;
  const moduleJSONPromises = [];
  const coreModuleNames = [];
  for (let i = 0; i < configuration.length; ++i) {
    const descriptor = configuration[i];
    const name = descriptor['name'];
    const moduleJSON = allDescriptorsByName[name];
    if (moduleJSON)
      moduleJSONPromises.push(Promise.resolve(moduleJSON));
    else
      moduleJSONPromises.push(Runtime.loadResourcePromise(name + '/module.json').then(JSON.parse.bind(JSON)));
    if (descriptor['type'] === 'autostart')
      coreModuleNames.push(name);
  }

  const moduleDescriptors = await Promise.all(moduleJSONPromises);

  for (let i = 0; i < moduleDescriptors.length; ++i) {
    moduleDescriptors[i].name = configuration[i]['name'];
    moduleDescriptors[i].condition = configuration[i]['condition'];
    moduleDescriptors[i].remote = configuration[i]['type'] === 'remote';
  }

  // hacks to remove redundant sources extensions..
  const sourcesModule = moduleDescriptors.find(module => module.name === 'sources');
  const extensions = sourcesModule.extensions;
  // ndb navigator files view does not contain add workspace folder button
  const navigatorFilesIndex = extensions.findIndex(extension => extension.id === 'navigator-files');
  if (navigatorFilesIndex !== -1)
    extensions.splice(navigatorFilesIndex, 1);
  // ndb replaces threads view with own node processes view
  const threadsViewIndex = extensions.findIndex(extension => extension.className === 'Sources.ThreadsSidebarPane');
  if (threadsViewIndex !== -1)
    extensions.splice(threadsViewIndex, 1);

  self.runtime = new Runtime(moduleDescriptors);
  if (coreModuleNames)
    return /** @type {!Promise<undefined>} */ (self.runtime._loadAutoStartModules(coreModuleNames));
})('ndb_app');
