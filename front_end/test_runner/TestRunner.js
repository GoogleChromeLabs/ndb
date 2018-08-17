/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

/**
 * @fileoverview using private properties isn't a Closure violation in tests.
 * @suppress {accessControls}
 */

/* eslint-disable no-console */

TestRunner.debuggerModel = {
  debuggerEnabled: _ => true
};

TestRunner.addResult = _ => undefined;

/**
 * @param {!Object} receiver
 * @param {string} methodName
 * @param {!Function} override
 * @param {boolean=} opt_sticky
 */
TestRunner.addSniffer = function(receiver, methodName, override, opt_sticky) {
  override = TestRunner.safeWrap(override);

  const original = receiver[methodName];
  if (typeof original !== 'function')
    throw new Error('Cannot find method to override: ' + methodName);

  receiver[methodName] = function(var_args) {
    let result;
    try {
      result = original.apply(this, arguments);
    } finally {
      if (!opt_sticky)
        receiver[methodName] = original;
    }
    // In case of exception the override won't be called.
    try {
      Array.prototype.push.call(arguments, result);
      override.apply(this, arguments);
    } catch (e) {
      throw new Error('Exception in overriden method \'' + methodName + '\': ' + e);
    }
    return result;
  };
};

/**
 * @param {!Object} receiver
 * @param {string} methodName
 * @return {!Promise<*>}
 */
TestRunner.addSnifferPromise = function(receiver, methodName) {
  return new Promise(function(resolve, reject) {
    const original = receiver[methodName];
    if (typeof original !== 'function') {
      reject('Cannot find method to override: ' + methodName);
      return;
    }

    receiver[methodName] = function(var_args) {
      let result;
      try {
        result = original.apply(this, arguments);
      } finally {
        receiver[methodName] = original;
      }
      // In case of exception the override won't be called.
      try {
        Array.prototype.push.call(arguments, result);
        resolve.apply(this, arguments);
      } catch (e) {
        reject('Exception in overridden method \'' + methodName + '\': ' + e);
        TestRunner.completeTest();
      }
      return result;
    };
  });
};

/** @type {function():void} */
TestRunner._resolveOnFinishInits;

/**
 * @param {string} module
 * @return {!Promise<undefined>}
 */
TestRunner.loadModule = async function(module) {
  const promise = new Promise(resolve => TestRunner._resolveOnFinishInits = resolve);
  await self.runtime.loadModulePromise(module);
  if (!TestRunner._pendingInits)
    return;
  return promise;
};

/**
 * @param {string} panel
 * @return {!Promise.<?UI.Panel>}
 */
TestRunner.showPanel = function(panel) {
  return UI.viewManager.showView(panel);
};

/**
 * @param {!Function|undefined} func
 * @param {!Function=} onexception
 * @return {!Function}
 */
TestRunner.safeWrap = function(func, onexception) {
  /**
   * @this {*}
   */
  function result() {
    if (!func)
      return;
    const wrapThis = this;
    try {
      return func.apply(wrapThis, arguments);
    } catch (e) {
      TestRunner.addResult('Exception while running: ' + func + '\n' + (e.stack || e));
      if (onexception)
        TestRunner.safeWrap(onexception)();
      else
        TestRunner.completeTest();
    }
  }
  return result;
};

/**
 * @param {!Node} node
 * @return {string}
 */
TestRunner.textContentWithLineBreaks = function(node) {
  function padding(currentNode) {
    let result = 0;
    while (currentNode && currentNode !== node) {
      if (currentNode.nodeName === 'OL' &&
          !(currentNode.classList && currentNode.classList.contains('object-properties-section')))
        ++result;
      currentNode = currentNode.parentNode;
    }
    return Array(result * 4 + 1).join(' ');
  }

  let buffer = '';
  let currentNode = node;
  let ignoreFirst = false;
  while (currentNode.traverseNextNode(node)) {
    currentNode = currentNode.traverseNextNode(node);
    if (currentNode.nodeType === Node.TEXT_NODE) {
      buffer += currentNode.nodeValue;
    } else if (currentNode.nodeName === 'LI' || currentNode.nodeName === 'TR') {
      if (!ignoreFirst)
        buffer += '\n' + padding(currentNode);
      else
        ignoreFirst = false;
    } else if (currentNode.nodeName === 'STYLE') {
      currentNode = currentNode.traverseNextNode(node);
      continue;
    } else if (currentNode.classList && currentNode.classList.contains('object-properties-section')) {
      ignoreFirst = true;
    }
  }
  return buffer;
};

/**
 * @param {!Node} node
 * @return {string}
 */
TestRunner.textContentWithoutStyles = function(node) {
  let buffer = '';
  let currentNode = node;
  while (currentNode.traverseNextNode(node)) {
    currentNode = currentNode.traverseNextNode(node);
    if (currentNode.nodeType === Node.TEXT_NODE)
      buffer += currentNode.nodeValue;
    else if (currentNode.nodeName === 'STYLE')
      currentNode = currentNode.traverseNextNode(node);
  }
  return buffer;
};

TestRunner.deprecatedInitAsync = _ => 0;

/**
 * @param {!Function} callback
 */
TestRunner.deprecatedRunAfterPendingDispatches = function(callback) {
  const targets = SDK.targetManager.targets();
  const promises = targets.map(target => new Promise(resolve => target._deprecatedRunAfterPendingDispatches(resolve)));
  Promise.all(promises).then(TestRunner.safeWrap(callback));
};

/**
 * @param {string} title
 */
TestRunner.markStep = function(title) {
  TestRunner.addResult('\nRunning: ' + title);
};

/**
 * @param {string} url
 * @param {string} content
 * @param {!SDK.ResourceTreeFrame} frame
 */
TestRunner.addScriptForFrame = function(url, content, frame) {
  content += '\n//# sourceURL=' + url;
  const executionContext = TestRunner.runtimeModel.executionContexts().find(context => context.frameId === frame.id);
  TestRunner.RuntimeAgent.evaluate(content, 'console', false, false, executionContext.id);
};

TestRunner.formatters = {};

/**
 * @param {*} value
 * @return {string}
 */
TestRunner.formatters.formatAsTypeName = function(value) {
  return '<' + typeof value + '>';
};

/**
 * @param {*} value
 * @return {string}
 */
TestRunner.formatters.formatAsTypeNameOrNull = function(value) {
  if (value === null)
    return 'null';
  return TestRunner.formatters.formatAsTypeName(value);
};

/**
 * @param {*} value
 * @return {string|!Date}
 */
TestRunner.formatters.formatAsRecentTime = function(value) {
  if (typeof value !== 'object' || !(value instanceof Date))
    return TestRunner.formatters.formatAsTypeName(value);
  const delta = Date.now() - value;
  return 0 <= delta && delta < 30 * 60 * 1000 ? '<plausible>' : value;
};

/**
 * @param {string} value
 * @return {string}
 */
TestRunner.formatters.formatAsURL = function(value) {
  if (!value)
    return value;
  const lastIndex = value.lastIndexOf('devtools/');
  if (lastIndex < 0)
    return value;
  return '.../' + value.substr(lastIndex);
};

/**
 * @param {string} value
 * @return {string}
 */
TestRunner.formatters.formatAsDescription = function(value) {
  if (!value)
    return value;
  return '"' + value.replace(/^function [gs]et /, 'function ') + '"';
};

/**
 * @typedef {!Object<string, string>}
 */
TestRunner.CustomFormatters;

/**
 * @param {!Object} object
 * @param {!TestRunner.CustomFormatters=} customFormatters
 * @param {string=} prefix
 * @param {string=} firstLinePrefix
 */
TestRunner.addObject = function(object, customFormatters, prefix, firstLinePrefix) {
  prefix = prefix || '';
  firstLinePrefix = firstLinePrefix || prefix;
  TestRunner.addResult(firstLinePrefix + '{');
  const propertyNames = Object.keys(object);
  propertyNames.sort();
  for (let i = 0; i < propertyNames.length; ++i) {
    const prop = propertyNames[i];
    if (!object.hasOwnProperty(prop))
      continue;
    const prefixWithName = '    ' + prefix + prop + ' : ';
    const propValue = object[prop];
    if (customFormatters && customFormatters[prop]) {
      const formatterName = customFormatters[prop];
      if (formatterName !== 'skip') {
        const formatter = TestRunner.formatters[formatterName];
        TestRunner.addResult(prefixWithName + formatter(propValue));
      }
    } else {
      TestRunner.dump(propValue, customFormatters, '    ' + prefix, prefixWithName);
    }
  }
  TestRunner.addResult(prefix + '}');
};

/**
 * @param {!Array} array
 * @param {!TestRunner.CustomFormatters=} customFormatters
 * @param {string=} prefix
 * @param {string=} firstLinePrefix
 */
TestRunner.addArray = function(array, customFormatters, prefix, firstLinePrefix) {
  prefix = prefix || '';
  firstLinePrefix = firstLinePrefix || prefix;
  TestRunner.addResult(firstLinePrefix + '[');
  for (let i = 0; i < array.length; ++i)
    TestRunner.dump(array[i], customFormatters, prefix + '    ');
  TestRunner.addResult(prefix + ']');
};

/**
 * @param {!Node} node
 */
TestRunner.dumpDeepInnerHTML = function(node) {
  /**
   * @param {string} prefix
   * @param {!Node} node
   */
  function innerHTML(prefix, node) {
    const openTag = [];
    if (node.nodeType === Node.TEXT_NODE) {
      if (!node.parentElement || node.parentElement.nodeName !== 'STYLE')
        TestRunner.addResult(node.nodeValue);
      return;
    }
    openTag.push('<' + node.nodeName);
    const attrs = node.attributes;
    for (let i = 0; attrs && i < attrs.length; ++i)
      openTag.push(attrs[i].name + '=' + attrs[i].value);

    openTag.push('>');
    TestRunner.addResult(prefix + openTag.join(' '));
    for (let child = node.firstChild; child; child = child.nextSibling)
      innerHTML(prefix + '    ', child);
    if (node.shadowRoot)
      innerHTML(prefix + '    ', node.shadowRoot);
    TestRunner.addResult(prefix + '</' + node.nodeName + '>');
  }
  innerHTML('', node);
};

/**
 * @param {!Node} node
 * @return {string}
 */
TestRunner.deepTextContent = function(node) {
  if (!node)
    return '';
  if (node.nodeType === Node.TEXT_NODE && node.nodeValue)
    return !node.parentElement || node.parentElement.nodeName !== 'STYLE' ? node.nodeValue : '';
  let res = '';
  const children = node.childNodes;
  for (let i = 0; i < children.length; ++i)
    res += TestRunner.deepTextContent(children[i]);
  if (node.shadowRoot)
    res += TestRunner.deepTextContent(node.shadowRoot);
  return res;
};

/**
 * @param {*} value
 * @param {!TestRunner.CustomFormatters=} customFormatters
 * @param {string=} prefix
 * @param {string=} prefixWithName
 */
TestRunner.dump = function(value, customFormatters, prefix, prefixWithName) {
  prefixWithName = prefixWithName || prefix;
  if (prefixWithName && prefixWithName.length > 80) {
    TestRunner.addResult(prefixWithName + 'was skipped due to prefix length limit');
    return;
  }
  if (value === null)
    TestRunner.addResult(prefixWithName + 'null');
  else if (value && value.constructor && value.constructor.name === 'Array')
    TestRunner.addArray(/** @type {!Array} */ (value), customFormatters, prefix, prefixWithName);
  else if (typeof value === 'object')
    TestRunner.addObject(/** @type {!Object} */ (value), customFormatters, prefix, prefixWithName);
  else if (typeof value === 'string')
    TestRunner.addResult(prefixWithName + '"' + value + '"');
  else
    TestRunner.addResult(prefixWithName + value);
};

/**
 * @param {!UI.TreeElement} treeElement
 */
TestRunner.dumpObjectPropertyTreeElement = function(treeElement) {
  const expandedSubstring = treeElement.expanded ? '[expanded]' : '[collapsed]';
  TestRunner.addResult(expandedSubstring + ' ' + treeElement.listItemElement.deepTextContent());

  for (let i = 0; i < treeElement.childCount(); ++i) {
    const property = treeElement.childAt(i).property;
    const key = property.name;
    const value = property.value._description;
    TestRunner.addResult('    ' + key + ': ' + value);
  }
};

/**
 * @param {symbol} event
 * @param {!Common.Object} obj
 * @param {function(?):boolean=} condition
 * @return {!Promise}
 */
TestRunner.waitForEvent = function(event, obj, condition) {
  condition = condition || function() {
    return true;
  };
  return new Promise(resolve => {
    obj.addEventListener(event, onEventFired);

    /**
     * @param {!Common.Event} event
     */
    function onEventFired(event) {
      if (!condition(event.data))
        return;
      obj.removeEventListener(event, onEventFired);
      resolve(event.data);
    }
  });
};

/**
 * @param {function(!SDK.Target):boolean} filter
 * @return {!Promise<!SDK.Target>}
 */
TestRunner.waitForTarget = function(filter) {
  filter = filter || (target => true);
  for (const target of SDK.targetManager.targets()) {
    if (filter(target))
      return Promise.resolve(target);
  }
  return new Promise(fulfill => {
    const observer = /** @type {!SDK.TargetManager.Observer} */ ({
      targetAdded: function(target) {
        if (filter(target)) {
          SDK.targetManager.unobserveTargets(observer);
          fulfill(target);
        }
      },
      targetRemoved: function() {},
    });
    SDK.targetManager.observeTargets(observer);
  });
};

/**
 * @param {!SDK.RuntimeModel} runtimeModel
 * @return {!Promise}
 */
TestRunner.waitForExecutionContext = function(runtimeModel) {
  if (runtimeModel.executionContexts().length)
    return Promise.resolve(runtimeModel.executionContexts()[0]);
  return runtimeModel.once(SDK.RuntimeModel.Events.ExecutionContextCreated);
};

/**
 * @param {!SDK.ExecutionContext} context
 * @return {!Promise}
 */
TestRunner.waitForExecutionContextDestroyed = function(context) {
  const runtimeModel = context.runtimeModel;
  if (runtimeModel.executionContexts().indexOf(context) === -1)
    return Promise.resolve();
  return TestRunner.waitForEvent(
      SDK.RuntimeModel.Events.ExecutionContextDestroyed, runtimeModel,
      destroyedContext => destroyedContext === context);
};

/**
 * @param {!Object} receiver
 * @param {string} methodName
 * @param {!Function} override
 * @param {boolean=} opt_sticky
 * @return {!Function}
 */
TestRunner.override = function(receiver, methodName, override, opt_sticky) {
  override = TestRunner.safeWrap(override);

  const original = receiver[methodName];
  if (typeof original !== 'function')
    throw new Error('Cannot find method to override: ' + methodName);

  receiver[methodName] = function(var_args) {
    try {
      return override.apply(this, arguments);
    } catch (e) {
      throw new Error('Exception in overriden method \'' + methodName + '\': ' + e);
    } finally {
      if (!opt_sticky)
        receiver[methodName] = original;
    }
  };

  return original;
};

/**
 * @param {string} text
 * @return {string}
 */
TestRunner.clearSpecificInfoFromStackFrames = function(text) {
  let buffer = text.replace(/\(file:\/\/\/(?:[^)]+\)|[\w\/:-]+)/g, '(...)');
  buffer = buffer.replace(/\(http:\/\/(?:[^)]+\)|[\w\/:-]+)/g, '(...)');
  buffer = buffer.replace(/\(test:\/\/(?:[^)]+\)|[\w\/:-]+)/g, '(...)');
  buffer = buffer.replace(/\(<anonymous>:[^)]+\)/g, '(...)');
  buffer = buffer.replace(/VM\d+/g, 'VM');
  return buffer.replace(/\s*at[^()]+\(native\)/g, '');
};

TestRunner.StringOutputStream = class {
  /**
   * @param {function(string):void} callback
   */
  constructor(callback) {
    this._callback = callback;
    this._buffer = '';
  }

  /**
   * @param {string} fileName
   * @return {!Promise<boolean>}
   */
  async open(fileName) {
    return true;
  }

  /**
   * @param {string} chunk
   */
  async write(chunk) {
    this._buffer += chunk;
  }

  async close() {
    this._callback(this._buffer);
  }
};

/**
 * @template V
 */
TestRunner.MockSetting = class {
  /**
   * @param {V} value
   */
  constructor(value) {
    this._value = value;
  }

  /**
   * @return {V}
   */
  get() {
    return this._value;
  }

  /**
   * @param {V} value
   */
  set(value) {
    this._value = value;
  }
};

/**
 * @return {!Array<!Runtime.Module>}
 */
TestRunner.loadedModules = function() {
  return self.runtime._modules.filter(module => module._loadedForTest)
      .filter(module => module.name().indexOf('test_runner') === -1);
};

/**
 * @param {!Array<!Runtime.Module>} relativeTo
 * @return {!Array<!Runtime.Module>}
 */
TestRunner.dumpLoadedModules = function(relativeTo) {
  const previous = new Set(relativeTo || []);
  function moduleSorter(left, right) {
    return String.naturalOrderComparator(left._descriptor.name, right._descriptor.name);
  }

  TestRunner.addResult('Loaded modules:');
  const loadedModules = TestRunner.loadedModules().sort(moduleSorter);
  for (const module of loadedModules) {
    if (previous.has(module))
      continue;
    TestRunner.addResult('    ' + module._descriptor.name);
  }
  return loadedModules;
};

/**
 * @param {string} urlSuffix
 * @param {!Workspace.projectTypes=} projectType
 * @return {!Promise}
 */
TestRunner.waitForUISourceCode = function(urlSuffix, projectType) {
  /**
   * @param {!Workspace.UISourceCode} uiSourceCode
   * @return {boolean}
   */
  function matches(uiSourceCode) {
    if (projectType && uiSourceCode.project().type() !== projectType)
      return false;
    if (!projectType && uiSourceCode.project().type() === Workspace.projectTypes.Service)
      return false;
    if (urlSuffix && !uiSourceCode.url().endsWith(urlSuffix))
      return false;
    return true;
  }

  for (const uiSourceCode of Workspace.workspace.uiSourceCodes()) {
    if (urlSuffix && matches(uiSourceCode))
      return Promise.resolve(uiSourceCode);
  }

  return TestRunner.waitForEvent(Workspace.Workspace.Events.UISourceCodeAdded, Workspace.workspace, matches);
};

/**
 * @param {!Function} callback
 */
TestRunner.waitForUISourceCodeRemoved = function(callback) {
  Workspace.workspace.once(Workspace.Workspace.Events.UISourceCodeRemoved).then(callback);
};

/**
 * @param {string} str
 * @param {string} mimeType
 * @return {!Promise.<undefined>}
 * @suppressGlobalPropertiesCheck
 */
TestRunner.dumpSyntaxHighlight = function(str, mimeType) {
  const node = document.createElement('span');
  node.textContent = str;
  const javascriptSyntaxHighlighter = new UI.SyntaxHighlighter(mimeType, false);
  return javascriptSyntaxHighlighter.syntaxHighlightNode(node).then(dumpSyntax);

  function dumpSyntax() {
    const node_parts = [];

    for (let i = 0; i < node.childNodes.length; i++) {
      if (node.childNodes[i].getAttribute)
        node_parts.push(node.childNodes[i].getAttribute('class'));
      else
        node_parts.push('*');
    }

    TestRunner.addResult(str + ': ' + node_parts.join(', '));
  }
};
