Ndb.Connection = class {
  constructor(channel) {
    this._onMessage = null;
    this._onDisconnect = null;
    this._channel = channel;
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
    this._channel.send(message);
  }

  /**
   * @return {!Promise}
   */
  disconnect() {
    this._channel.close();
  }

  /**
   * @param {message}
   */
  dispatchMessage(message) {
    if (this._onMessage)
      this._onMessage(message);
  }
};
