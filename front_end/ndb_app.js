// Copyright 2018 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// TODO: expose Carlo's RPC world params to userland.
const carloRpcWorldParams = new Promise(resolve => self.load = backend => {
  delete self.load;
  resolve(backend);
});

Runtime.startApplication('ndb_app');
