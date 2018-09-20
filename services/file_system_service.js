/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

const fs = require('fs');
const mime = require('mime');
const { URL } = require('url');

const {ServiceBase} = require('./service_base.js');

class FileSystemService extends ServiceBase {
  /**
   * @param {!{
   *   url: string,
   *   isFile: boolean,
   *   create: boolean,
   *   exclusive: boolean
   * }} options
   * @return {!Promise}
   */
  async getEntry(options) {
    options.url = new URL(options.url);
    const stat = this._stat(options.url);
    if (options.create && options.exclusive) {
      if (stat)
        return this._pathExistsError();
      return this._createEntry(options.url, options.isFile);
    }
    if (options.create && !options.exclusive) {
      if (stat && !options.isFile)
        fs.rmdirSync(options.url);
      return this._createEntry(options.url, options.isFile);
    }
    if (!stat || stat.isDirectory() === options.isFile)
      return this._internalError();
    return {};
  }

  /**
   * @param {string} url
   * @param {boolean} isFile
   */
  _createEntry(url, isFile) {
    try {
      if (!isFile)
        fs.mkdirSync(url);
      else
        fs.writeFileSync(url, '');
      return {};
    } catch (e) {
      return this._internalError();
    }
  }

  /**
   * @param {!{url: string, isFile: boolean}} options
   */
  async remove(options) {
    options.url = new URL(options.url);
    try {
      if (options.isFile)
        fs.unlinkSync(options.url);
      else
        fs.rmdirSync(options.url);
      return {};
    } catch (e) {
      return this._internalError();
    }
  }

  /**
   * @param {!{url: string}} options
   */
  async readEntries(options) {
    options.url = new URL(options.url);
    try {
      const entries = fs.readdirSync(options.url);
      return { entries: entries.map(entry => {
        const url = new URL(options.url + '/' + entry);
        const stat = fs.statSync(url);
        return {name: url.toString(), isDirectory: stat.isDirectory(), size: stat.size};
      })};
    } catch (e) {
      console.log(e.stack);
      return this._internalError();
    }
  }

  /**
   * @param {!{url: string}} options
   */
  async metadata(options) {
    options.url = new URL(options.url);
    const stat = this._stat(options.url);
    if (!stat)
      return this._internalError();
    return {
      mtime: stat.mtime,
      size: stat.size
    };
  }

  /**
   * @param {!{fromURL: string, toURL: string}} options
   */
  async moveTo(options) {
    options.fromURL = new URL(options.fromURL);
    options.toURL = new URL(options.toURL);
    return this._safeCall(() => fs.renameSync(options.fromURL, options.toURL));
  }

  /**
   * @param {!{url: string}} options
   */
  async file(options) {
    const mimeType = mime.getType(options.url) || 'application/octet-stream';
    options.url = new URL(options.url);
    return new Promise(resolve => {
      fs.readFile(options.url, 'base64', (err, data) =>
        resolve(err ? this._internalError() : {data, mimeType}))
    });
  }

  /**
   * @param {!{url: string, content: string}} options
   */
  async write(options) {
    return this._safeCall(() => {
      const content = options.content;
      const buffer = Buffer.from(content.substr(content.indexOf('base64,') + 'base64,'.length), 'base64');
      fs.writeFileSync(options.url, buffer);
    });
  }

  /**
   * @param {!{url: string, size: number}} options
   */
  async truncate(options) {
    return this._safeCall(() => fs.truncateSync(options.url, options.size));
  }

  /**
   * @param {string} url
   * @return {?{}}
   */
  _stat(url) {
    try {
      return fs.statSync(url);
    } catch (e) {
      return null;
    }
  }

  _internalError() {
    return { error: {
      name: 'InternalError',
      message: 'Internal error'
    }};
  }

  _pathExistsError() {
    return { error: {
      name: 'PathExistsError',
      message: 'An attempt was made to create a file or directory where an element already exists.'
    }};
  }

  _safeCall(f) {
    try {
      f();
      return {};
    } catch (e) {
      return this._internalError();
    }
  }
}

module.exports = new FileSystemService();
