Ndb.ConnectionInterceptor = class {
  constructor() {
    this._onMessage = null;
  }

  /**
   * @param {string} message
   * @return {boolean}
   */
  sendRawMessage(message) {
    throw new Error('Not implemented');
  }

  setOnMessage(onMessage) {
    this._onMessage = onMessage;
  }

  dispatchMessage(message) {
    if (this._onMessage)
      this._onMessage(message);
  }

  disconnect() {
  }
};

Ndb.Connection = class {
  constructor(channel) {
    this._onMessage = null;
    this._onDisconnect = null;
    this._channel = channel;
    this._interceptors = [];
  }

  static async create(channel) {
    const connection = new Ndb.Connection(channel);
    await channel.listen(rpc.handle(connection));
    return connection;
  }

  /**
   * @param {function((!Object|string))} onMessage
   */
  setOnMessage(onMessage) {
    this._onMessage = onMessage;
    for (const interceptor of this._interceptors)
      interceptor.setOnMessage(this._onMessage);
  }

  /**
   * @param {function(string)} onDisconnect
   */
  setOnDisconnect(onDisconnect) {
    this._onDisconnect = onDisconnect;
  }

  /**
   * @param {string} message
   */
  sendRawMessage(message) {
    for (const interceptor of this._interceptors) {
      if (interceptor.sendRawMessage(message))
        return;
    }
    this._channel.send(message);
  }

  addInterceptor(interceptor) {
    this._interceptors.push(interceptor);
    interceptor.setOnMessage(this._onMessage);
  }

  /**
   * @return {!Promise}
   */
  disconnect() {
    this._channel.close();
    for (const interceptor of this._interceptors)
      interceptor.disconnect();
  }

  /**
   * @param {message}
   */
  dispatchMessage(message) {
    if (this._onMessage)
      this._onMessage(message);
  }
};
