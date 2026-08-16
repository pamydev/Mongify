const fs = require("fs-extra");
const path = require("path");
const { v4: uuid } = require("uuid");

class Main {
  private database_path: string;
  private collection: string;

  /**
   *
   * @param {object} [data]
   * @param {string} [data.path] Path of database storage, please be caution
   * on change this, the default location is user home folder, change
   * this setting can broke the application.
   * @param {string} data.database_name The name of database
   */
  constructor(data) {
    //

    const home_dir =
      process.env.APPDATA ||
      (process.platform == "darwin"
        ? process.env.HOME + "/Library/Preferences"
        : process.env.HOME + "/.local/share");
    const database_path = data?.path || home_dir;
    /**@private */
    this.database_path = path.join(
      database_path,
      "/mongify/",
      data.database_name,
    );

    /**@private */
    this.collection = "";

    this.create_database();

    //
  }

  /**
   * Creates a new collection in database
   * @param {string} collection_name New collection name
   * @returns {Promise.<object>} All the method of getCollections
   */
  async createCollection(collection_name) {
    //

    this.collection = path.join(this.database_path, collection_name + ".json");

    await this._purge_and_write_entire_file([]);

    return this.getCollection(collection_name);

    //
  }

  /**
   * Deletes a collection
   * @param {string} collection_name The name of collection to be deleted
   * @returns {Promise.<boolean>}
   */
  async deleteCollection(collection_name) {
    //

    this.collection = path.join(this.database_path, collection_name + ".json");

    await this._delete_file(this.collection);

    return true;

    //
  }

  /**
   * List of database collections
   * @return {Promise.<string[]>} A list of collections name
   */
  async listCollections() {
    //

    let names = await this._list_files();

    return names;

    //
  }

  /**
   * Select the collection
   * @param {string} collection_name The collection name
   */
  getCollection(collection_name) {
    //

    this.collection = path.join(this.database_path, collection_name + ".json");

    return {
      /**
       *
       * @typedef {object} opt
       * @property {string|Number} [opt.limit] The limit of result
       * @property {string|Number} [opt.skip] The skip of result
       *
       * Search in the collection the specified query
       * @param {{}} [query] The query, if empty return entire collection, use limit() for precaution
       * @param {opt} [options] Optional settings for search
       * @returns {Promise.<Array>}
       */
      find: async (query, options) => this.find(query, options),

      /**
       * Search in the collection the specified query
       * and returns the first or unique result
       * @param {{}} query
       * @returns {Promise.<object>}
       */
      findOne: async (query) => this.findOne(query),

      /**
       * Update document
       * @param {{}} query Filter
       * @param {{}} update New entries
       * @param {object} [options]
       * @param {boolean} [options.upsert] Create new if not exist
       * @returns
       */
      update: async (query, update, options) =>
        this.update(query, update, options),

      /**
       * Inserts a new document on collection
       * @param {{}} document The new document to be
       * inserted on selected collection
       * @returns
       */
      insert: async (document) => this.insert(document),

      /**
       * Insert all documents into documentsArray
       * @param {Array.<{}>} documentsArray
       * @returns
       */
      insertMany: async (documentsArray) => this.insertMany(documentsArray),

      /**
       * Delete document matched by query from collection
       * This delete as many as matched
       * @param {{}} query filter
       * @returns
       */
      delete: async (query) => this.delete(query),
    };

    //
  }

  /**@private */
  async delete(query) {
    //

    const { key, value } = this._turn_query_into_search_params(query);

    const file = await this._read_entire_json_file();

    let filtered = this._filter_inverse_array(file, key, value);

    // need to save json
    this._purge_and_write_entire_file(filtered);

    return true;

    //
  }

  /**@private */
  async insert(document) {
    //

    let file = await this._read_entire_json_file(true);

    let new_document = { _id: uuid(), ...document };

    file.push(new_document);

    await this._purge_and_write_entire_file(file);

    return true;

    //
  }

  /**@private */
  async insertMany(documentsArray) {
    //

    let file = await this._read_entire_json_file(true);

    for (let c = 0; c < documentsArray.length; c++) {
      let document = documentsArray[c];

      let new_document = { _id: uuid(), ...document };

      file.push(new_document);
    }

    await this._purge_and_write_entire_file(file);

    return true;

    //
  }

  /**@private */
  async find(query, options) {
    //

    let response = [];
    const file = await this._read_entire_json_file();

    if (!query || Object.keys(query).length === 0) {
      // get all collection

      response = file;
    }

    // if has query =========================

    if (query && Object.keys(query).length > 0) {
      const { key, value } = this._turn_query_into_search_params(query);

      response = this._filter_array(file, key, value);
    }

    // ======================================

    if (options?.limit) {
      response = response.slice(0, parseInt(options.limit));
    }

    return response;

    //
  }

  /**@private */
  async findOne(query, options?: { limit?: number }) {
    //

    let response = [];
    const file = await this._read_entire_json_file();

    if (!query || Object.keys(query).length === 0) {
      // get all collection

      response = file;
    }

    // if has query =========================

    if (query && Object.keys(query).length > 0) {
      const { key, value } = this._turn_query_into_search_params(query);

      response = this._filter_array(file, key, value);
    }

    return response[0] || response;

    //
  }

  /**@private */
  async update(query, update, options) {
    //

    let new_file = [];
    const file = await this._read_entire_json_file();

    const res_query = this._turn_query_into_search_params(query);
    const query_key = res_query.key;
    const query_value = res_query.value;

    let matched = false;

    file.map((obj) => {
      if (obj[query_key] === query_value) {
        matched = true;
        // obj[key_up] = value_up;
        // vai fazer um loop no update
        Object.keys(update).map((update_key) => {
          // agora para cada key irá aplicar
          // a mudança
          obj[update_key] = update[update_key];
        });
      }

      new_file.push(obj);
    });

    if (matched) {
      // need to save json
      this._purge_and_write_entire_file(new_file);
    } else if (options?.upsert) {
      await this.insert({ ...query, ...update });
    }

    return true;

    //
  }

  // LOCAL OPERATIONS =========================

  /**@private */
  async _purge_and_write_entire_file(data?: any) {
    //

    data = JSON.stringify(data || []);

    await fs.writeFile(this.collection, data);

    return true;

    //
  }

  /**@private */
  async _read_entire_json_file(create_new = false) {
    //

    var json;

    try {
      json = await fs.readFile(this.collection, {
        encoding: "utf8",
      });
    } catch (e) {
      if (create_new) {
        /**
         * create new is used
         * on insert operations
         * but not in find ops
         *
         *
         */
        await this._purge_and_write_entire_file();
        json = await fs.readFile(this.collection, {
          encoding: "utf8",
        });
      } else {
        return [];
      }
    }

    let res;

    if (json && json != "") {
      res = JSON.parse(json);
    } else {
      res = [];
    }

    return res;

    //
  }

  /**@private */
  _turn_query_into_search_params(query) {
    //

    let key = Object.keys(query)[0];
    let value = query[key];

    return { key, value };

    //
  }

  /**
   * Return just key with the 'value'
   */
  /**@private */
  _filter_array(arr, key, value) {
    //

    return arr.filter((obj) => obj[key] === value);

    //
  }

  /**
   * Returns all except key with 'value'
   */
  /**@private */
  _filter_inverse_array(arr, key, value) {
    //

    return arr.filter((obj) => obj[key] !== value);

    //
  }

  /**@private */
  async _delete_file(json_name) {
    //

    await fs.unlink(json_name);

    return true;

    //
  }

  /**@private */
  async _list_files() {
    //

    let names = await fs.readdir(this.database_path);

    names = names.map((file) => file.replace(".json", ""));

    return names;

    //
  }

  /**
   * Creates a database directory
   * Uses construtor path or default
   * @private
   * @returns {Promise.<string|boolean>} error or path
   */
  async create_database() {
    //

    if (!fs.existsSync(this.database_path)) {
      try {
        fs.mkdirSync(this.database_path, { recursive: true });
      } catch (e) {
        throw new Error("Error code kl3: " + e);
        return false;
      }
    }

    return this.database_path;

    //
  }

  //
}

exports.Mongify = Main;
