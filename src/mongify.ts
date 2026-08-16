import { Operations } from "./operations";
import { Helpers } from "./helpers";
import type {
  Collection,
  CollectionOptions,
  MongifyOptions,
  MongifyQuery,
  MongifyDocument,
} from "./types";

class Main {
  private operations: Operations;
  private helpers: Helpers;
  public constructor(args0: MongifyOptions) {
    this.operations = new Operations(args0);
    this.helpers = this.operations.helpers;
    this.helpers._create_database();
  }

  public async createCollection<
    T extends object = MongifyDocument,
  >(collection_name: string): Promise<Collection<T>> {
    await this.helpers._with_collection_lock(collection_name, async () => {
      const names = await this.listCollections();

      if (!names.includes(collection_name)) {
        await this.helpers._create_collection(collection_name);
      }
    });
    return this.getCollection<T>(collection_name);
  }

  public async deleteCollection(collection_name: string): Promise<boolean> {
    return this.helpers._with_collection_lock(collection_name, async () => {
      await this.helpers._delete_collection(collection_name);
      return true;
    });
  }

  public async listCollections(): Promise<string[]> {
    let names = await this.helpers._list_files();
    return names;
  }

  public getCollection<T extends object = MongifyDocument>(
    collection_name: string,
  ): Collection<T> {
    this.helpers._get_collection_path(collection_name);
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

      createIndex: async (field, options) =>
        this.operations.createIndex(field, options, collection),

      dropIndex: async (field) =>
        this.operations.dropIndex(field, collection),

      listIndexes: async () => this.operations.listIndexes(collection),
    } as Collection<T>;
  }
}
export { Main as Mongify };
export type {
  Collection,
  CollectionIndex,
  CollectionOptions,
  CreateIndexResult,
  IndexOptions,
  IndexFields,
  MongifyDocument,
  MongifyOptions,
  MongifyQuery,
  StoredDocument,
  InsertDocument,
  UpdateDocument,
  UpdateOptions,
} from "./types";
