import fs from "fs-extra";
import path from "path";
import { Operations } from "./operations";
import { Helpers } from "./helpers";

class Main {
  private operations: Operations;
  private helpers: Helpers;
  public constructor(args0: MongifyOptions) {
    this.operations = new Operations(args0);
    this.helpers = this.operations.helpers;
    this.helpers._create_database();
  }

  public async createCollection(collection_name: string): Promise<Collection> {
    const names = await this.listCollections();

    if (names.includes(collection_name)) {
      return this.getCollection(collection_name);
    }

    await this.helpers._purge_and_write_entire_file(collection_name, []);
    return this.getCollection(collection_name);
  }

  public async deleteCollection(collection_name: string): Promise<boolean> {
    await this.helpers._delete_file(
      this.helpers._get_collection_path(collection_name),
    );
    return true;
  }

  public async listCollections(): Promise<string[]> {
    let names = await this.helpers._list_files();
    return names;
  }

  public getCollection(collection_name: string): Collection {
    const collection = collection_name;

    return {
      find: async (query?: MongifyQuery, options?: CollectionOptions) =>
        this.operations.find(query, options, collection),

      findOne: async (query?: MongifyQuery) =>
        this.operations.findOne(query, undefined, collection),

      update: async (query, update, options) =>
        this.operations.update(query, update, options, collection),

      insert: async (document) => this.operations.insert(document, collection),

      insertMany: async (documentsArray) =>
        this.operations.insertMany(documentsArray, collection),

      delete: async (query) => this.operations.delete(query, collection),
    };
  }
}
export { Main as Mongify };
