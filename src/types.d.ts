interface IReadEntireJsonFile {
  collection_name: string;
  create_new?: boolean;
}
interface MongifyOptions {
  path?: string;
  database_name: string;
}
interface MongifyDocument {
  [key: string]: any;
}
interface MongifyQuery {
  [key: string]: any;
}
interface CollectionOptions {
  limit?: string | number;
  skip?: string | number;
}
interface UpdateOptions {
  upsert?: boolean;
}
interface Collection {
  find(
    query?: MongifyQuery,
    options?: CollectionOptions,
  ): Promise<MongifyDocument[]>;
  findOne(query?: MongifyQuery): Promise<MongifyDocument | MongifyDocument[]>;
  update(
    query: MongifyQuery,
    update: MongifyDocument,
    options?: UpdateOptions,
  ): Promise<boolean>;
  insert(document: MongifyDocument): Promise<boolean>;
  insertMany(documentsArray: MongifyDocument[]): Promise<boolean>;
  delete(query: MongifyQuery): Promise<boolean>;
}
