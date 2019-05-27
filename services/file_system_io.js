const { rpc, rpc_process } = require('carlo/rpc');
const fs = require('fs');
const { URL } = require('url');

class FileSystemIO {
  constructor() {
    require('../lib/process_utility.js')('file_system_io', () => this.dispose());
  }

  /**
   * @param {string} fileURL
   * @param {string} encoding
   */
  readFile(fileURL, encoding) {
    return fs.readFileSync(new URL(fileURL), encoding);
  }

  /**
   * @param {string} fileURL
   * @param {string} content
   * @param {string} encoding
   */
  writeFile(fileURL, content, encoding) {
    if (encoding === 'base64')
      content = Buffer.from(content, 'base64');
    fs.writeFileSync(new URL(fileURL), content, {encoding: encoding});
  }

  /**
   * @param {string} folderURL
   */
  createFile(folderURL) {
    let name = 'NewFile';
    let counter = 1;
    while (fs.existsSync(new URL(folderURL + '/' + name))) {
      name = 'NewFile' + counter;
      ++counter;
    }
    fs.writeFileSync(new URL(folderURL + '/' + name), '');
    return folderURL + '/' + name;
  }

  /**
   * @param {string} fileURL
   */
  deleteFile(fileURL) {
    try {
      fs.unlinkSync(new URL(fileURL));
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * @param {string} fileURL
   * @param {string} newName
   */
  renameFile(fileURL, newName) {
    const newURL = new URL(fileURL.substr(0, fileURL.lastIndexOf('/') + 1) + newName);
    try {
      if (fs.existsSync(newURL)) return false;
      fs.renameSync(new URL(fileURL), newURL);
      return true;
    } catch (e) {
      return false;
    }
  }

  dispose() {
    Promise.resolve().then(() => process.exit(0));
  }
}

rpc_process.init(args => rpc.handle(new FileSystemIO()));
