export interface IReadEntireJsonFile {
  collection_name: string;
  create_new?: boolean;
}

export interface MongifyOptions {
  path?: string;
  database_name: string;
}

export interface MongifyDocument {
  [key: string]: any;
}

export interface MongifyQuery {
  [key: string]: any;
}

export interface CollectionOptions {
  limit?: string | number;
  skip?: string | number;
  projection?: Record<string, 0 | 1 | boolean>;
}

export interface UpdateOptions {
  upsert?: boolean;
}

export interface IndexOptions {
  unique?: boolean;
}

export interface CollectionIndex {
  field: string;
  unique: boolean;
}

export interface CreateIndexResult {
  acknowledge: boolean;
  indexesBefore: number;
  indexesAfter: number;
  error?: "exists";
}

export interface Collection {
  find(
    query?: MongifyQuery,
    options?: CollectionOptions,
  ): Promise<MongifyDocument[]>;
  findOne(query?: MongifyQuery): Promise<MongifyDocument | null>;
  update(
    query: MongifyQuery,
    update: MongifyDocument,
    options?: UpdateOptions,
  ): Promise<boolean>;
  insert(document: MongifyDocument): Promise<boolean>;
  insertMany(documentsArray: MongifyDocument[]): Promise<boolean>;
  delete(query: MongifyQuery): Promise<boolean>;
  createIndex(
    field: string,
    options?: IndexOptions,
  ): Promise<CreateIndexResult>;
  dropIndex(field: string): Promise<boolean>;
  listIndexes(): Promise<CollectionIndex[]>;
}
