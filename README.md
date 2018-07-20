# ndb

<!-- [START badges] -->
[![NPM ndb package](https://img.shields.io/npm/v/ndb.svg)](https://npmjs.org/package/ndb)
<!-- [END badges] -->

<img src="https://raw.githubusercontent.com/ChromeDevTools/devtools-logo/master/192.png" height="200" align="right">

> ndb is improved Chrome DevTools tuned for Node.js. ndb is distributed as npm package and can be installed by one npm  command.

## Installation

```bash
npm install -g ndb
```
Note: ndb works with Node.js >=8.0.0 and works best with latest Node.js 10.

Note: ndb depends on puppeteer, puppeteer downloads a recent version of Chromium (~170Mb Mac, ~282Mb Linux, ~280Mb Win).

Note: installation may fail on Windows during compilation of one of native dependency, following command may help:

```bash
npm install --global --production windows-build-tools
```
## Getting Started
### How to start ndb?
You can start debugging your Node.js application using one of the following ways:
- use ndb instead of node:
```bash
node index.js 🠲 ndb index.js
# if you use some other binary, just prepend ndb.
npm run unit 🠲 ndb npm run unit
```
- run ndb and start debugging any configuration from your package.json, e.g. unit tests, from ndb UI:
```bash
# cd to application folder with package.json file.
ndb .
# go to "Run configuration" sidebar and click "Run" button next to target configuration.
```
- run any node related command from builtin terminal, ndb will connect automatically.

### What can I do?
You can use any JavaScript related Chrome DevTools features:
- debugger (breakpoint, async stacks, async stepping, ...),
- console (eager evaluation (required Node.js 10), object inspection, advanced filtering, ...),
- CPU profiler,
- memory profiler.

There are couple Chrome DevTools Node.js specific features that are available only for ndb:
1. full support for child processes,,
2. you can edit your files from DevTools and save all changes to disk,
3. ndb by default blackbox all scripts outside current working directory, it helps you to focus on debugging your code (this behaviour may be changed by "Blackbox anything outside working dir" setting).
    
## Contributing to ndb

Check out [contributing guide](https://github.com/GoogleChromeLabs/ndb/blob/master/CONTRIBUTING.md) to get an overview of ndb development.

## Thanks to the 'OG' `ndb`

In early 2011, [@smtlaissezfaire](https://github.com/smtlaissezfaire) released the first serious debugger for Node.js, under the `ndb` package name. It's still preserved at [github.com/smtlaissezfaire/ndb](https://github.com/smtlaissezfaire/ndb#readme). We thank Scott for generously donating the package name.
